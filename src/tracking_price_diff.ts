#!/usr/bin/env -S npx tsx
/**
 * tracking_price_diff.ts -- build the "Tracking Page Price" and "Deactivate"
 * sheets (as CSV) from a "key pages ... from ebay price tracker.csv" export.
 *
 * Reads every key page (price col "[KeyPage] Price") and its TrackingPage 01-20
 * item IDs, looks up each tracking page's current price with the Browse API
 * (application token, works for any seller), and writes:
 *   <out>-tracking-page-price.csv  all tracking pages: TrackingPage id/price, KeyPage id/price, difference, Deactivate, Comment
 *   <out>-deactivate.csv           only rows where tracking price - key price < threshold
 * Prices are cached in <out>-price-cache.json so a re-run only looks up what is missing.
 *
 * Usage:
 *   npx tsx src/tracking_price_diff.ts <input.csv> [--threshold 2] [--out reports/name-prefix]
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { requestToken } from "./ebay_auth.ts";

const BROWSE = "https://api.ebay.com/buy/browse/v1/item";

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], cur = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') q = false;
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === ",") { row.push(cur); cur = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cur); cur = ""; rows.push(row); row = [];
    } else cur += c;
  }
  if (cur || row.length) { row.push(cur); rows.push(row); }
  return rows.filter((r) => r.some((v) => v !== ""));
}

const csvCell = (v: string | number) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
const toCsv = (rows: (string | number)[][]) => rows.map((r) => r.map(csvCell).join(",")).join("\n") + "\n";

type Price = { price?: number; note?: string };

async function appToken(): Promise<string> {
  const t = await requestToken({ grant_type: "client_credentials", scope: "https://api.ebay.com/oauth/api_scope" });
  return t.access_token;
}

async function browse(path: string, token: string): Promise<{ status: number; body: any }> {
  for (let attempt = 0; ; attempt++) {
    const resp = await fetch(`${BROWSE}/${path}`, {
      headers: { Authorization: `Bearer ${token}`, "X-EBAY-C-MARKETPLACE-ID": "EBAY_US" },
    });
    if ((resp.status === 429 || resp.status >= 500) && attempt < 4) {
      await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
      continue;
    }
    return { status: resp.status, body: await resp.json().catch(() => ({})) };
  }
}

async function getPrice(itemId: string, token: string): Promise<Price> {
  const single = await browse(`get_item_by_legacy_id?legacy_item_id=${itemId}`, token);
  if (single.status === 200) {
    const v = Number(single.body.price?.value);
    return Number.isNaN(v) ? { note: "no price in response" } : { price: v };
  }
  if (single.body.errors?.some((e: any) => e.errorId === 11006)) {
    const group = await browse(`get_items_by_item_group?item_group_id=${itemId}`, token);
    const prices = ((group.body.items ?? []) as any[]).map((i) => Number(i.price?.value)).filter((n) => !Number.isNaN(n));
    if (prices.length) return { price: Math.min(...prices), note: "variations: lowest" };
  }
  if (single.status === 404) return { note: "Listing Completed" };
  return { note: single.body.errors?.[0]?.message ?? `HTTP ${single.status}` };
}

async function main() {
  const args = process.argv.slice(2);
  const opt = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
  const threshold = Number(opt("--threshold") ?? 2);
  const optVals = new Set(["--threshold", "--out"].map(opt).filter(Boolean));
  const file = args.filter((a) => !a.startsWith("--") && !optVals.has(a))[0];
  if (!file || !existsSync(file)) {
    console.error("Usage: npx tsx src/tracking_price_diff.ts <input.csv> [--threshold 2] [--out reports/prefix]");
    process.exit(1);
  }
  const out = opt("--out") ?? "reports/tracking-price-diff";

  const [header, ...data] = parseCsv(readFileSync(file, "utf8"));
  const idCol = header.indexOf("[KeyPage] ebay_item_id");
  const priceCol = header.indexOf("[KeyPage] Price");
  const trackCols = header.map((h, i) => (/^\[TrackingPage \d+\] ebay_item_id$/.test(h) ? i : -1)).filter((i) => i >= 0);

  const pairs: { track: string; key: string; keyPrice: number }[] = [];
  const seen = new Set<string>();
  for (const r of data) {
    if (!r[idCol]) continue;
    for (const c of trackCols) {
      const track = r[c]?.trim();
      if (!track || seen.has(track)) continue;
      seen.add(track);
      pairs.push({ track, key: r[idCol], keyPrice: Number(r[priceCol]) });
    }
  }

  const cachePath = `${out}-price-cache.json`;
  const cache: Record<string, Price> = existsSync(cachePath) ? JSON.parse(readFileSync(cachePath, "utf8")) : {};
  const todo = pairs.filter((p) => !cache[p.track]);
  console.log(`${pairs.length} tracking pages, ${todo.length} to look up`);

  const token = await appToken();
  let next = 0, done = 0;
  await Promise.all(
    Array.from({ length: 2 }, async () => {
      while (next < todo.length) {
        const p = todo[next++];
        const res = await getPrice(p.track, token);
        if (!/Too many requests/.test(res.note ?? "")) cache[p.track] = res; // keep rate-limited ones out of the cache so a re-run retries them
        if (++done % 250 === 0) {
          writeFileSync(cachePath, JSON.stringify(cache));
          console.log(`  ${done}/${todo.length}`);
        }
      }
    }),
  );
  writeFileSync(cachePath, JSON.stringify(cache));

  const head = ["[TrackingPage] ebay_item_id", "[TrackingPage] Price", "[KeyPage] ebay_item_id", "[KeyPage] Price", "The price difference", "Deactivate", "Comment"];
  const all: (string | number)[][] = [head];
  const deact: (string | number)[][] = [head];
  let failed = 0;
  for (const p of pairs) {
    const res = cache[p.track];
    if (res.price === undefined) {
      failed++;
      all.push([p.track, "", p.key, p.keyPrice, "", "", res.note ?? ""]);
      continue;
    }
    const diff = Math.round((res.price - p.keyPrice) * 100) / 100;
    const yes = diff < threshold;
    const row = [p.track, res.price, p.key, p.keyPrice, diff, yes ? "Yes" : "", res.note ?? ""];
    all.push(row);
    if (yes) deact.push(row);
  }
  writeFileSync(`${out}-tracking-page-price.csv`, toCsv(all));
  writeFileSync(`${out}-deactivate.csv`, toCsv(deact));
  console.log(`${pairs.length} rows, ${deact.length - 1} with difference < ${threshold}, ${failed} without a price`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
