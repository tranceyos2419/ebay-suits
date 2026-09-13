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
 *   npx tsx src/find_order_by_tracking.ts <tracking-number> --month 2026-07
 *   npx tsx src/find_order_by_tracking.ts <tracking-number> --from 2026-06-20 --to 2026-08-10
 *   npx tsx src/find_order_by_tracking.ts <tracking-number> --account jdm-direct-motors --month 2026-07
 *
 * With no --account, every account in credentials.json is searched.
 *
 * Auth: pass --account <name> to read credentials.json, or set
 * EBAY_ACCESS_TOKEN yourself (Auth'n'Auth token -- Trading API takes it via
 * the X-EBAY-API-IAF-TOKEN header, same as weekly_revenue.ts).
 */

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { findText, findErrors, findBlocks } from "./xml_util.ts";

const CREDS_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "credentials.json");
const API = "https://api.ebay.com/ws/api.dll";
const CHUNK_DAYS = 29;

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

/** Strip formatting so "1Z 999 AA1" and "1z999aa1" compare equal. */
function normalize(s: string): string {
  return s.replace(/[^0-9a-z]/gi, "").toUpperCase();
}

function num(s: string | undefined): number {
  const n = parseFloat(s ?? "");
  return Number.isFinite(n) ? n : 0;
}

function money(block: string, tag: string): { amount: number; currency: string } {
  const re = new RegExp(`<(?:\\w+:)?${tag}[^>]*currencyID="([^"]*)"[^>]*>([\\s\\S]*?)</(?:\\w+:)?${tag}>`);
  const m = block.match(re);
  if (!m) return { amount: num(findText(block, tag)), currency: "" };
  return { amount: num(m[2]), currency: m[1] };
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
    else if (a.startsWith("--")) {
      console.error(`ERROR: unknown flag ${a}`);
      process.exit(1);
    } else if (tracking === undefined) tracking = a;
    else {
      console.error(`ERROR: unexpected extra argument ${a}`);
      process.exit(1);
    }
  }

  if (!tracking) {
    console.error(
      "Usage: npx tsx src/find_order_by_tracking.ts <tracking-number> [--account <name>] (--month YYYY-MM | --from <date> --to <date>)"
    );
    process.exit(1);
  }

  if (month) {
    const m = /^(\d{4})-(\d{2})$/.exec(month);
    if (!m) {
      console.error("ERROR: --month expects YYYY-MM");
      process.exit(1);
    }
    const year = Number(m[1]);
    const mon = Number(m[2]);
    from = new Date(Date.UTC(year, mon - 1, 1));
    to = new Date(Date.UTC(year, mon, 1));
  }

  if (!from || !to || Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
    console.error("ERROR: pass --month YYYY-MM, or both --from and --to");
    process.exit(1);
  }

  return { tracking, account, from, to };
}

function accountsToSearch(explicit?: string): { name: string; token: string }[] {
  if (!existsSync(CREDS_PATH)) {
    if (process.env.EBAY_ACCESS_TOKEN) return [{ name: "(env token)", token: process.env.EBAY_ACCESS_TOKEN }];
    console.error(`ERROR: no credentials.json found at ${CREDS_PATH}, and no EBAY_ACCESS_TOKEN set.`);
    process.exit(1);
  }
  const creds: Record<string, { token?: string }> = JSON.parse(readFileSync(CREDS_PATH, "utf8"));
  if (explicit) {
    const token = creds[explicit]?.token;
    if (!token) {
      console.error(`ERROR: no usable token for '${explicit}'. Known accounts: ${Object.keys(creds).join(", ")}`);
      process.exit(1);
    }
    return [{ name: explicit, token }];
  }
  return Object.entries(creds)
    .filter(([, v]) => !!v.token)
    .map(([name, v]) => ({ name, token: v.token! }));
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

function parseOrders(xml: string): OrderRecord[] {
  return findBlocks(xml, "Order").map((o) => {
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
  });
}

async function fetchOrders(token: string, from: Date, to: Date): Promise<OrderRecord[]> {
  const all: OrderRecord[] = [];
  const seen = new Set<string>();
  for (let cursor = new Date(from); cursor < to; ) {
    const chunkEnd = new Date(Math.min(cursor.getTime() + CHUNK_DAYS * 864e5, to.getTime()));
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
  return all;
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
    const orders = await fetchOrders(token, opts.from, opts.to);
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

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
