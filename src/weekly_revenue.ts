#!/usr/bin/env -S npx tsx
/**
 * weekly_revenue.ts -- pull orders via the Trading API's GetOrders call and
 * summarise revenue per ISO week (Mon-Sun), so week-over-week swings can be
 * compared and drilled into.
 *
 * Usage:
 *   npx tsx src/weekly_revenue.ts --account <name> [WEEKS] [--json out.json]
 *
 * WEEKS defaults to 8 (complete weeks back from the most recent Monday).
 */

import { writeFileSync } from "node:fs";
import { findBlocks, findText } from "./xml_util.ts";
import { accountFromArgs, authnAuthToken } from "./ebay_auth.ts";
import { fetchOrderBlocks, money, num } from "./trading_api.ts";
import { runMain } from "./util.ts";

interface Txn {
  itemId: string;
  title: string;
  qty: number;
  price: number;
  sku: string;
}

interface Order {
  orderId: string;
  created: string; // ISO
  paid: string;
  status: string;
  cancelStatus: string;
  total: number;
  currency: string;
  subtotal: number;
  shipping: number;
  buyerCountry: string;
  txns: Txn[];
}

function parseOrder(o: string): Order {
  const total = money(o, "Total");
  const subtotal = money(o, "Subtotal");
  const shipping = money(o, "ShippingServiceCost");
  const txns: Txn[] = findBlocks(o, "Transaction").map((t) => ({
    itemId: findText(t, "ItemID") ?? "",
    title: findText(t, "Title") ?? "",
    qty: num(findText(t, "QuantityPurchased")) || 1,
    price: money(t, "TransactionPrice").amount,
    sku: findText(t, "SKU") ?? "",
  }));
  return {
    orderId: findText(o, "OrderID") ?? "",
    created: findText(o, "CreatedTime") ?? "",
    paid: findText(o, "PaidTime") ?? "",
    status: findText(o, "OrderStatus") ?? "",
    cancelStatus: findText(o, "CancelStatus") ?? "",
    total: total.amount,
    currency: total.currency,
    subtotal: subtotal.amount,
    shipping: shipping.amount,
    buyerCountry: findText(o, "CountryName") ?? findText(o, "Country") ?? "",
  txns,
  };
}

async function main() {
  const { account, rest } = accountFromArgs(process.argv.slice(2));
  const weeks = parseInt(rest[0] ?? "8", 10);
  const jsonIdx = rest.indexOf("--json");
  const jsonOut = jsonIdx > -1 ? rest[jsonIdx + 1] : undefined;

  const token = authnAuthToken(account);

  const now = new Date();
  // Most recent Monday 00:00 UTC (start of the in-progress week).
  const thisMonday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const dow = (thisMonday.getUTCDay() + 6) % 7; // 0 = Monday
  thisMonday.setUTCDate(thisMonday.getUTCDate() - dow);
  const start = new Date(thisMonday);
  start.setUTCDate(start.getUTCDate() - weeks * 7);

  const all = (await fetchOrderBlocks(token, start, now)).map(parseOrder);
  all.sort((a, b) => (a.created < b.created ? -1 : 1));
  console.error(`fetched ${all.length} orders from ${start.toISOString().slice(0, 10)} to today`);

  if (jsonOut) {
    writeFileSync(jsonOut, JSON.stringify({ start: start.toISOString(), fetched: now.toISOString(), orders: all }, null, 2));
    console.error(`wrote ${jsonOut}`);
  }

  // Weekly buckets
  const buckets = new Map<string, Order[]>();
  for (const o of all) {
    const d = new Date(o.created);
    const wk = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
    wk.setUTCDate(wk.getUTCDate() - ((wk.getUTCDay() + 6) % 7));
    const key = wk.toISOString().slice(0, 10);
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key)!.push(o);
  }

  const keys = [...buckets.keys()].sort();
  console.log("week (Mon, UTC)  orders   items   revenue   cancelled  avg order");
  for (const k of keys) {
    const os = buckets.get(k)!;
    const live = os.filter((o) => o.cancelStatus !== "CancelClosed" && o.status !== "Cancelled");
    const rev = live.reduce((s, o) => s + o.total, 0);
    const items = live.reduce((s, o) => s + o.txns.reduce((t, x) => t + x.qty, 0), 0);
    const cancelled = os.length - live.length;
    const avg = live.length ? rev / live.length : 0;
    console.log(
      `${k}    ${String(live.length).padStart(5)}  ${String(items).padStart(5)}  ${rev.toFixed(2).padStart(9)}  ${String(cancelled).padStart(8)}  ${avg.toFixed(2).padStart(8)}`,
    );
  }
}

runMain(main);
