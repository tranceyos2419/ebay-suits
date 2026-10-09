#!/usr/bin/env -S npx tsx
/**
 * find_order_by_tracking.ts -- given an outbound shipment tracking number,
 * find the eBay order(s) it belongs to and report every line item on the
 * order (title, quantity, price), so a single tracking number covering a
 * multi-item / combined-payment order can be checked against how many units
 * it actually represents.
 *
 * Unlike find_return_by_tracking.ts (which walks the Post-Order API's
 * *return* records), this walks regular orders via the Trading API's
 * GetOrders and inspects each order's (and each transaction's, since
 * multi-leg/dropship orders can carry a tracking number per line item)
 * ShipmentTrackingDetails.
 *
 * GetOrders' CreateTimeFrom/CreateTimeTo window is capped at 30 days, so a
 * wider ask (e.g. a whole month) is walked in 30-day chunks.
 *
 * Usage:
 *   npx tsx src/sales/find_order_by_tracking.ts <tracking-number> --month 2026-07
 *   npx tsx src/sales/find_order_by_tracking.ts <tracking-number> --from 2026-06-20 --to 2026-08-10
 *   npx tsx src/sales/find_order_by_tracking.ts <tracking-number> --account jdm-direct-motors --month 2026-07
 *
 * With no --account, every account in credentials.json is searched (each
 * with its own Auth'n'Auth token, via src/auth/ebay_auth.ts).
 */

import { findBlocks, findText } from "../lib/xml_util.ts";
import { accountNames, authnAuthToken, die, useAccount } from "../auth/ebay_auth.ts";
import { fetchOrderBlocks, money, num } from "../lib/trading_api.ts";
import { normalizeTracking as normalize, runMain } from "../lib/util.ts";

interface Options {
  tracking: string;
  account?: string;
  from: Date;
  to: Date;
}

interface LineItem {
  itemId: string;
  transactionId: string;
  title: string;
  sku: string;
  qty: number;
  price: number;
  currency: string;
  trackingNumbers: string[];
}

interface OrderRecord {
  orderId: string;
  created: string;
  status: string;
  cancelStatus: string;
  buyer: string;
  total: number;
  currency: string;
  trackingNumbers: string[]; // order-level
  items: LineItem[];
}

function trackingNumbersIn(block: string): string[] {
  return findBlocks(block, "ShipmentTrackingDetails")
    .map((d) => findText(d, "ShipmentTrackingNumber"))
    .filter((v): v is string => !!v && v.trim().length > 0);
}

function parseArgs(argv: string[]): Options {
  let tracking: string | undefined;
  let account: string | undefined;
  let from: Date | undefined;
  let to: Date | undefined;
  let month: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--account") account = argv[++i];
    else if (a === "--from") from = new Date(argv[++i]);
    else if (a === "--to") to = new Date(argv[++i]);
    else if (a === "--month") month = argv[++i];
    else if (a.startsWith("--")) die(`ERROR: unknown flag ${a}`);
    else if (tracking === undefined) tracking = a;
    else die(`ERROR: unexpected extra argument ${a}`);
  }

  if (!tracking) {
    die(
      "Usage: npx tsx src/sales/find_order_by_tracking.ts <tracking-number> [--account <name>] (--month YYYY-MM | --from <date> --to <date>)"
    );
  }

  if (month) {
    const m = /^(\d{4})-(\d{2})$/.exec(month);
    if (!m) die("ERROR: --month expects YYYY-MM");
    const year = Number(m[1]);
    const mon = Number(m[2]);
    from = new Date(Date.UTC(year, mon - 1, 1));
    to = new Date(Date.UTC(year, mon, 1));
  }

  if (!from || !to || Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
    die("ERROR: pass --month YYYY-MM, or both --from and --to");
  }

  return { tracking, account, from, to };
}

function accountsToSearch(explicit?: string): { name: string; token: string }[] {
  const names = explicit ? [useAccount(explicit)] : accountNames();
  return names.map((name) => ({ name, token: authnAuthToken(name) }));
}

function parseOrder(o: string): OrderRecord {
  const total = money(o, "Total");
  const items: LineItem[] = findBlocks(o, "Transaction").map((t) => ({
    itemId: findText(t, "ItemID") ?? "",
    transactionId: findText(t, "TransactionID") ?? "",
    title: findText(t, "Title") ?? "",
    sku: findText(t, "SKU") ?? "",
    qty: num(findText(t, "QuantityPurchased")) || 1,
    price: money(t, "TransactionPrice").amount,
    currency: money(t, "TransactionPrice").currency,
    trackingNumbers: trackingNumbersIn(t),
  }));
  return {
    orderId: findText(o, "OrderID") ?? "",
    created: findText(o, "CreatedTime") ?? "",
    status: findText(o, "OrderStatus") ?? "",
    cancelStatus: findText(o, "CancelStatus") ?? "",
    buyer: findText(o, "BuyerUserID") ?? "",
    total: total.amount,
    currency: total.currency,
    trackingNumbers: trackingNumbersIn(o),
  items,
  };
}

function describe(account: string, o: OrderRecord, target: string): string {
  const totalQty = o.items.reduce((s, i) => s + i.qty, 0);
  const lines = [
    `[${account}] Order ${o.orderId}`,
    `  Created:      ${o.created}`,
    `  Status:       ${o.status}${o.cancelStatus && o.cancelStatus !== "NotApplicable" ? ` (cancel: ${o.cancelStatus})` : ""}`,
    `  Buyer:        ${o.buyer}`,
    `  Order total:  ${o.total.toFixed(2)} ${o.currency}`,
    `  Line items (${o.items.length}), total units purchased: ${totalQty}`,
  ];
  for (const it of o.items) {
    const mark = it.trackingNumbers.some((t) => normalize(t) === target) ? " <-- this tracking number" : "";
    lines.push(
      `    - qty ${it.qty}  ${it.price.toFixed(2)} ${it.currency}  itemId ${it.itemId}  "${it.title}"${it.sku ? `  sku=${it.sku}` : ""}${mark}`
    );
    if (it.trackingNumbers.length) lines.push(`        tracking: ${it.trackingNumbers.join(", ")}`);
  }
  if (o.trackingNumbers.length) lines.push(`  Order-level tracking: ${o.trackingNumbers.join(", ")}`);
  lines.push(`  Order page: https://www.ebay.com/mesh/ord/details?orderid=${encodeURIComponent(o.orderId)}`);
  return lines.join("\n");
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const target = normalize(opts.tracking);
  const accounts = accountsToSearch(opts.account);

  let anyMatch = false;
  for (const { name, token } of accounts) {
    console.error(
      `Scanning ${name}: orders created ${opts.from.toISOString().slice(0, 10)} .. ${opts.to.toISOString().slice(0, 10)}...`
    );
    const orders = (await fetchOrderBlocks(token, opts.from, opts.to)).map(parseOrder);
    console.error(`  ${orders.length} orders fetched.`);

    const matches = orders.filter((o) => {
      const allTracking = [...o.trackingNumbers, ...o.items.flatMap((i) => i.trackingNumbers)];
      return allTracking.some((t) => normalize(t) === target);
    });

    for (const o of matches) {
      anyMatch = true;
      console.log("\n" + describe(name, o, target));
    }
  }

  if (!anyMatch) {
    console.log(`\nNo order (in the given date range, on the searched account(s)) carries tracking number ${opts.tracking}.`);
    process.exit(2);
  }
}

runMain(main);
