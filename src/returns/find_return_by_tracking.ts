#!/usr/bin/env -S npx tsx
/**
 * find_return_by_tracking.ts -- given a return shipping tracking number, find
 * the eBay return it belongs to and report that return's order number.
 *
 * eBay's GraphQL Return API has no "search returns by tracking number"
 * filter, so this walks the seller's returns (open and closed, over --days,
 * default two years) and checks each return's tracking: the latest package
 * event per return shipment, plus any return label the seller provided
 * (src/lib/return_api.ts). The search returns that detail inline, so no
 * per-return lookups are needed. Returns the Return API can't link to an
 * order (some old ones) get their order number from the Fulfillment API.
 *
 * Only tracking eBay still holds for the return shipment is visible: for a
 * return that closed without the buyer ever shipping it, the label's
 * tracking number isn't exposed any more.
 *
 * Usage:
 *   npx tsx src/returns/find_return_by_tracking.ts <tracking-number> --account jdm-direct-motors
 *   npx tsx src/returns/find_return_by_tracking.ts --account jdm-direct-motors --list --days 365
 *
 * Auth: --account <name> (required) -- uses that account's OAuth token
 * (sell.return scope) from src/auth/ebay_auth.ts.
 */

import { accountFromArgs, die } from "../auth/ebay_auth.ts";
import { fulfillmentToken } from "../lib/fulfillment_api.ts";
import {
  fillMissingOrders,
  type ReturnRecord,
  type ReturnTracking,
  returnToken,
  searchReturns,
} from "../lib/return_api.ts";
import { DAY_MS, normalizeTracking as normalize, runMain } from "../lib/util.ts";

interface Options {
  tracking?: string;
  marketplace: string;
  list: boolean;
  days: number;
}

function parseArgs(argv: string[]): Options {
  const opts: Options = { marketplace: "EBAY_US", list: false, days: 730 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--marketplace") opts.marketplace = argv[++i];
    else if (a === "--list") opts.list = true;
    else if (a === "--days") {
      opts.days = Number(argv[++i]);
      if (!Number.isFinite(opts.days) || opts.days <= 0) die("ERROR: --days needs a positive number");
    } else if (a.startsWith("--")) die(`ERROR: unknown flag ${a}`);
    else if (opts.tracking === undefined) opts.tracking = a;
    else die(`ERROR: unexpected extra argument ${a}`);
  }
  if (!opts.tracking && !opts.list) {
    die(
      "Usage: npx tsx src/returns/find_return_by_tracking.ts <tracking-number> --account <name> [--days N]\n" +
        "       npx tsx src/returns/find_return_by_tracking.ts --account <name> --list [--days N]"
    );
  }
  return opts;
}

function describe(r: ReturnRecord, hits: ReturnTracking[], rawMatch: boolean): string {
  const lines = [
    `  Order number:   ${r.orderId || "(none)"}`,
    `  Return ID:      ${r.returnId}`,
    `  Return state:   ${r.statusCode || "?"} (${r.preset})`,
    `  Buyer:          ${r.buyer || "?"}`,
    `  Item ID:        ${r.itemId || "?"}`,
    `  Transaction ID: ${r.orderLineItemId || "?"}`,
    `  Return opened:  ${r.requestedAt || "?"}`,
    `  Return page:    https://www.ebay.com/rt/ReturnDetails?returnId=${r.returnId}`,
  ];
  for (const h of hits) {
    lines.push(`  Tracking:       ${h.trackingNumber}${h.carrier ? ` (${h.carrier})` : ""}  [${h.source}]`);
  }
  if (rawMatch && hits.length === 0) {
    lines.push("  Tracking:       matched inside the return record (not in a tracking field)");
  }
  return lines.join("\n");
}

async function main() {
  const { account, rest } = accountFromArgs(process.argv.slice(2));
  const opts = parseArgs(rest);
  const token = await returnToken(account);
  const target = opts.tracking ? normalize(opts.tracking) : undefined;

  const returns = await searchReturns(token, {
    from: new Date(Date.now() - opts.days * DAY_MS),
    marketplace: opts.marketplace,
  });
  console.error(`Scanning ${returns.length} returns on ${account} (last ${opts.days} days)...`);

  const scanned = returns.map((r) => ({
    r,
    hits: r.tracking,
    // Belt and braces: also look at the whole record, in case the number sits
    // somewhere other than a tracking field.
    rawMatch: target ? normalize(JSON.stringify(r)).includes(target) : false,
  }));

  // Fill in order numbers eBay's Return API couldn't resolve -- for every
  // return when listing, else just for the matches.
  const fillOrders = async (rs: ReturnRecord[]) => {
    if (rs.some((r) => !r.orderId)) await fillMissingOrders(await fulfillmentToken(account), rs);
  };

  if (opts.list) {
    await fillOrders(returns);
    for (const { r, hits } of scanned) {
      const t = hits.length ? hits.map((h) => h.trackingNumber).join(", ") : "(no tracking on record)";
      console.log(`${r.returnId}  order ${r.orderId || "?"}  ${r.statusCode.padEnd(28)}  ${t}`);
    }
    if (!target) return;
  }

  const matches = scanned.filter(
    ({ hits, rawMatch }) => rawMatch || hits.some((h) => normalize(h.trackingNumber) === target)
  );

  await fillOrders(matches.map((m) => m.r));

  if (matches.length === 0) {
    console.log(`\nNo return on this account carries tracking number ${opts.tracking}.`);
    console.log(`Scanned ${returns.length} returns (open and closed) over the last ${opts.days} days.`);
    process.exit(2);
  }

  console.log(`\nFound ${matches.length === 1 ? "1 return" : `${matches.length} returns`} for tracking ${opts.tracking}:\n`);
  for (const { r, hits, rawMatch } of matches) {
    const relevant = hits.filter((h) => normalize(h.trackingNumber) === target);
    console.log(describe(r, relevant.length ? relevant : hits, rawMatch));
    console.log("");
  }
}

runMain(main);
