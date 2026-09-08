#!/usr/bin/env -S npx tsx
/**
 * weekly_revenue.ts -- pull orders via the Trading API's GetOrders call and
 * summarise revenue per ISO week (Mon-Sun), so week-over-week swings can be
 * compared and drilled into.
 *
 * Usage:
 *   export EBAY_ACCESS_TOKEN="your-token"
 *   npx tsx src/weekly_revenue.ts [WEEKS] [--json out.json]
 *
 * WEEKS defaults to 8 (complete weeks back from the most recent Monday).
 */

import { findText, findErrors, findBlocks } from "./xml_util.ts";

const API = "https://api.ebay.com/ws/api.dll";

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

function num(s: string | undefined): number {
  const n = parseFloat(s ?? "");
  return Number.isFinite(n) ? n : 0;
}

/** Strip the currencyID attribute wrapper: `<Total currencyID="USD">12.34</Total>`. */
function money(block: string, tag: string): { amount: number; currency: string } {
  const re = new RegExp(`<(?:\\w+:)?${tag}[^>]*currencyID="([^"]*)"[^>]*>([\\s\\S]*?)</(?:\\w+:)?${tag}>`);
  const m = block.match(re);
  if (!m) return { amount: num(findText(block, tag)), currency: "" };
  return { amount: num(m[2]), currency: m[1] };
}

async function getOrdersPage(token: string, from: Date, to: Date, page: number): Promise<{ xml: string; more: boolean }> {
  const xmlBody = `<?xml version="1.0" encoding="utf-8"?>
<GetOrdersRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <CreateTimeFrom>${from.toISOString()}</CreateTimeFrom>
  <CreateTimeTo>${to.toISOString()}</CreateTimeTo>
  <OrderRole>Seller</OrderRole>
  <OrderStatus>All</OrderStatus>
  <DetailLevel>ReturnAll</DetailLevel>
  <Pagination>
    <EntriesPerPage>100</EntriesPerPage>
    <PageNumber>${page}</PageNumber>
  </Pagination>
</GetOrdersRequest>`;

  const resp = await fetch(API, {
    method: "POST",
    headers: {
      "Content-Type": "text/xml",
      "X-EBAY-API-SITEID": "0",
      "X-EBAY-API-COMPATIBILITY-LEVEL": "1193",
      "X-EBAY-API-CALL-NAME": "GetOrders",
      "X-EBAY-API-IAF-TOKEN": token,
    },
    body: xmlBody,
  });
  const xml = await resp.text();
  const ack = findText(xml, "Ack") ?? "Unknown";
  if (ack !== "Success" && ack !== "Warning") {
    for (const err of findErrors(xml)) console.error(`  [${err.severity}] ${err.short} -- ${err.long}`);
    throw new Error(`GetOrders failed (HTTP ${resp.status}, Ack ${ack})`);
  }
  const hasMore = (findText(xml, "HasMoreOrders") ?? "false") === "true";
  return { xml, more: hasMore };
}

function parseOrders(xml: string): Order[] {
  return findBlocks(xml, "Order").map((o) => {
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
  });
}

async function main() {
  const weeks = parseInt(process.argv[2] ?? "8", 10);
  const jsonIdx = process.argv.indexOf("--json");
  const jsonOut = jsonIdx > -1 ? process.argv[jsonIdx + 1] : undefined;

  const token = process.env.EBAY_ACCESS_TOKEN;
  if (!token) {
    console.error('ERROR: set EBAY_ACCESS_TOKEN first, e.g.\n  export EBAY_ACCESS_TOKEN="your-token"');
    process.exit(1);
  }

  const now = new Date();
  // Most recent Monday 00:00 UTC (start of the in-progress week).
  const thisMonday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const dow = (thisMonday.getUTCDay() + 6) % 7; // 0 = Monday
  thisMonday.setUTCDate(thisMonday.getUTCDate() - dow);
  const start = new Date(thisMonday);
  start.setUTCDate(start.getUTCDate() - weeks * 7);

  // GetOrders windows are capped at 30 days, so walk the range in chunks.
  const all: Order[] = [];
  const seen = new Set<string>();
  for (let cursor = new Date(start); cursor < now; ) {
    const chunkEnd = new Date(Math.min(cursor.getTime() + 29 * 864e5, now.getTime()));
    for (let page = 1; ; page++) {
      const { xml, more } = await getOrdersPage(token, cursor, chunkEnd, page);
      for (const o of parseOrders(xml)) {
        if (!seen.has(o.orderId)) {
          seen.add(o.orderId);
          all.push(o);
        }
      }
      if (!more) break;
    }
    cursor = chunkEnd;
  }

  all.sort((a, b) => (a.created < b.created ? -1 : 1));
  console.error(`fetched ${all.length} orders from ${start.toISOString().slice(0, 10)} to today`);

  if (jsonOut) {
    const fs = await import("node:fs");
    fs.writeFileSync(jsonOut, JSON.stringify({ start: start.toISOString(), fetched: now.toISOString(), orders: all }, null, 2));
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

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
