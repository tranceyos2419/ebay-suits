#!/usr/bin/env -S npx tsx
/**
 * find_return_by_tracking.ts -- given a return shipping tracking number, find
 * the eBay return it belongs to and report that return's order number.
 *
 * eBay's Post-Order API has no "search returns by tracking number" filter, so
 * this walks the seller's returns and inspects each return's detail record for
 * tracking numbers. Note the search MUST be given an explicit creation date
 * range: with no range eBay quietly returns only about the last 30 days (44
 * returns on jdm-direct-motors, vs 256 over two years), which silently misses
 * older returns. Hence --days, defaulting to two years.
 * Tracking can show up in several places depending on who bought the label --
 * returnShipmentInfo, the response history, refund detail -- so rather than
 * guessing one path we collect every tracking-shaped field in the record.
 *
 * Usage:
 *   npx tsx src/find_return_by_tracking.ts <tracking-number> --account jdm-direct-motors
 *   npx tsx src/find_return_by_tracking.ts --account jdm-direct-motors --list --days 365
 *
 * Auth: pass --account <name> to read credentials.json, or set
 * EBAY_ACCESS_TOKEN yourself. The Auth'n'Auth tokens in credentials.json work
 * here -- the Post-Order API takes them as `Authorization: TOKEN <token>`.
 */

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const CREDS_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "credentials.json");
const BASE = "https://api.ebay.com/post-order/v2";
const PAGE_LIMIT = 50;
const CONCURRENCY = 5;

interface Options {
  tracking?: string;
  account?: string;
  marketplace: string;
  list: boolean;
  days: number;
}

interface ReturnSummary {
  returnId: string;
  orderId?: string;
  state?: string;
  buyerLoginName?: string;
  itemId?: string;
  transactionId?: string;
  creationDate?: string;
}

interface TrackingHit {
  path: string;
  value: string;
  carrier?: string;
}

/** Strip formatting so "1Z 999 AA1" and "1z999aa1" compare equal. */
function normalize(s: string): string {
  return s.replace(/[^0-9a-z]/gi, "").toUpperCase();
}

function parseArgs(argv: string[]): Options {
  const opts: Options = { marketplace: "EBAY_US", list: false, days: 730 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--account") opts.account = argv[++i];
    else if (a === "--marketplace") opts.marketplace = argv[++i];
    else if (a === "--list") opts.list = true;
    else if (a === "--days") {
      opts.days = Number(argv[++i]);
      if (!Number.isFinite(opts.days) || opts.days <= 0) {
        console.error("ERROR: --days needs a positive number");
        process.exit(1);
      }
    }
    else if (a.startsWith("--")) {
      console.error(`ERROR: unknown flag ${a}`);
      process.exit(1);
    } else if (opts.tracking === undefined) opts.tracking = a;
    else {
      console.error(`ERROR: unexpected extra argument ${a}`);
      process.exit(1);
    }
  }
  if (!opts.tracking && !opts.list) {
    console.error(
      "Usage: npx tsx src/find_return_by_tracking.ts <tracking-number> --account <name> [--days N]\n" +
        "       npx tsx src/find_return_by_tracking.ts --account <name> --list [--days N]"
    );
    process.exit(1);
  }
  return opts;
}

function tokenFor(account?: string): string {
  const fromEnv = process.env.EBAY_ACCESS_TOKEN;
  if (!account) {
    if (fromEnv) return fromEnv;
    console.error("ERROR: pass --account <name>, or set EBAY_ACCESS_TOKEN.");
    process.exit(1);
  }
  if (!existsSync(CREDS_PATH)) {
    console.error(`ERROR: no credentials.json found at ${CREDS_PATH}`);
    process.exit(1);
  }
  const creds: Record<string, { token?: string }> = JSON.parse(readFileSync(CREDS_PATH, "utf8"));
  const token = creds[account]?.token;
  if (!token) {
    console.error(
      `ERROR: no usable token for '${account}'. Known accounts: ${Object.keys(creds).join(", ")}`
    );
    process.exit(1);
  }
  return token;
}

async function getJson(url: string, token: string): Promise<any> {
  const resp = await fetch(url, {
    headers: {
      Authorization: `TOKEN ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json",
      "X-EBAY-C-MARKETPLACE-ID": process.env.EBAY_MARKETPLACE ?? "EBAY_US",
    },
  });
  const text = await resp.text();
  if (!resp.ok) {
    console.error(`ERROR ${resp.status} from ${url}\n${text.slice(0, 1000)}`);
    process.exit(1);
  }
  return JSON.parse(text);
}

/**
 * Every return on the account, open and closed.
 *
 * Two eBay quirks make the naive version wrong, and both fail *silently*:
 *   1. With no creation date range the search returns only ~the last 30 days.
 *   2. Its `offset` paging is unreliable over a wide range -- it re-serves
 *      records, so a loop that counts rows against totalEntries stops early
 *      and drops returns that really are in range.
 * So: walk the range in 30-day windows, page inside each, and dedupe by
 * returnId, stopping a window only once a page yields nothing new.
 */
async function fetchAllReturns(
  token: string,
  marketplace: string,
  days: number
): Promise<ReturnSummary[]> {
  const byId = new Map<string, ReturnSummary>();
  const WINDOW_DAYS = 30;

  for (let start = 0; start < days; start += WINDOW_DAYS) {
    const to = new Date(Date.now() - start * 86_400_000).toISOString();
    const from = new Date(Date.now() - Math.min(start + WINDOW_DAYS, days) * 86_400_000).toISOString();

    for (let offset = 0; ; ) {
      const url =
        `${BASE}/return/search?role=SELLER&limit=${PAGE_LIMIT}&offset=${offset}` +
        `&marketplace_id=${marketplace}` +
        `&creation_date_range_from=${encodeURIComponent(from)}` +
        `&creation_date_range_to=${encodeURIComponent(to)}`;
      const body = await getJson(url, token);
      const members: any[] = body.members ?? [];
      if (members.length === 0) break;

      let added = 0;
      for (const m of members) {
        const id = String(m.returnId);
        if (byId.has(id)) continue;
        added++;
        byId.set(id, {
          returnId: id,
          orderId: m.orderId,
          state: m.state,
          buyerLoginName: m.buyerLoginName,
          itemId: m.creationInfo?.item?.itemId,
          transactionId: m.creationInfo?.item?.transactionId,
          creationDate: m.creationInfo?.creationDate?.value,
        });
      }
      offset += members.length;
      const total: number = body.paginationOutput?.totalEntries ?? 0;
      if (added === 0 || offset >= total) break;
    }
  }
  return [...byId.values()];
}

/**
 * Pull every tracking-shaped value out of a return detail record. Matches
 * either a `*track*` key holding a string, or any object exposing a
 * `trackingNumber` (which is how shipment entries are shaped).
 */
function collectTracking(node: unknown, path = ""): TrackingHit[] {
  const hits: TrackingHit[] = [];
  if (node === null || typeof node !== "object") return hits;

  if (Array.isArray(node)) {
    node.forEach((v, i) => hits.push(...collectTracking(v, `${path}[${i}]`)));
    return hits;
  }

  const obj = node as Record<string, unknown>;
  const num = obj.trackingNumber;
  if (typeof num === "string" && num.trim()) {
    hits.push({
      path: `${path}.trackingNumber`,
      value: num.trim(),
      carrier: typeof obj.carrierUsed === "string" ? obj.carrierUsed
        : typeof obj.carrierEnum === "string" ? obj.carrierEnum
        : typeof obj.carrierName === "string" ? obj.carrierName
        : undefined,
    });
  }
  for (const [k, v] of Object.entries(obj)) {
    if (k !== "trackingNumber" && /track/i.test(k) && typeof v === "string" && v.trim()) {
      hits.push({ path: `${path}.${k}`, value: v.trim() });
    }
    hits.push(...collectTracking(v, `${path}.${k}`));
  }
  return hits;
}

/** Run `worker` over `items`, at most CONCURRENCY in flight at once. */
async function mapLimit<T, R>(items: T[], worker: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(CONCURRENCY, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await worker(items[i]);
    }
  });
  await Promise.all(runners);
  return results;
}

function describe(r: ReturnSummary, hits: TrackingHit[], rawMatch: boolean): string {
  const lines = [
    `  Order number:   ${r.orderId ?? "(none)"}`,
    `  Return ID:      ${r.returnId}`,
    `  Return state:   ${r.state ?? "?"}`,
    `  Buyer:          ${r.buyerLoginName ?? "?"}`,
    `  Item ID:        ${r.itemId ?? "?"}`,
    `  Transaction ID: ${r.transactionId ?? "?"}`,
    `  Return opened:  ${r.creationDate ?? "?"}`,
    `  Return page:    https://www.ebay.com/rt/ReturnDetails?returnId=${r.returnId}`,
  ];
  for (const h of hits) {
    lines.push(`  Tracking:       ${h.value}${h.carrier ? ` (${h.carrier})` : ""}  [${h.path}]`);
  }
  if (rawMatch && hits.length === 0) {
    lines.push("  Tracking:       matched inside the return record (not in a tracking field)");
  }
  return lines.join("\n");
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const token = tokenFor(opts.account);
  process.env.EBAY_MARKETPLACE = opts.marketplace;
  const target = opts.tracking ? normalize(opts.tracking) : undefined;

  const returns = await fetchAllReturns(token, opts.marketplace, opts.days);
  console.error(
    `Scanning ${returns.length} returns on ${opts.account ?? "this account"} (last ${opts.days} days)...`
  );

  const scanned = await mapLimit(returns, async (r) => {
    const detail = await getJson(`${BASE}/return/${r.returnId}`, token);
    const hits = collectTracking(detail);
    // Belt and braces: also look at the raw record, in case eBay parks the
    // number somewhere without "tracking" in the key name.
    const rawMatch = target ? normalize(JSON.stringify(detail)).includes(target) : false;
    return { r, hits, rawMatch };
  });

  if (opts.list) {
    for (const { r, hits } of scanned) {
      const t = hits.length ? hits.map((h) => h.value).join(", ") : "(no tracking on record)";
      console.log(`${r.returnId}  order ${r.orderId ?? "?"}  ${(r.state ?? "").padEnd(28)}  ${t}`);
    }
    if (!target) return;
  }

  const matches = scanned.filter(
    ({ hits, rawMatch }) => rawMatch || hits.some((h) => normalize(h.value) === target)
  );

  if (matches.length === 0) {
    console.log(`\nNo return on this account carries tracking number ${opts.tracking}.`);
    console.log(`Scanned ${returns.length} returns (open and closed) over the last ${opts.days} days.`);
    process.exit(2);
  }

  console.log(`\nFound ${matches.length === 1 ? "1 return" : `${matches.length} returns`} for tracking ${opts.tracking}:\n`);
  for (const { r, hits, rawMatch } of matches) {
    const relevant = hits.filter((h) => normalize(h.value) === target);
    console.log(describe(r, relevant.length ? relevant : hits, rawMatch));
    console.log("");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
