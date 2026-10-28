#!/usr/bin/env -S npx tsx
/**
 * fill_shipandco_csv.ts -- for each eBay order number in a CSV (e.g. the
 * "Orders that require re-creation of shipping labels" sheet saved as CSV),
 * create its Ship&Co order and fill the row's Ship&Co columns.
 *
 * Columns (matched by header, ignoring case and surrounding spaces):
 *   Order Number            -- the eBay order number (required)
 *   Order ID (Ship & Co)    -- filled with the Ship&Co order id (added if missing)
 *   Item Price (Ship & Co)  -- filled with the items total (合計金額) in that order (added if missing)
 *   Uploaded to Ship & Co   -- set to TRUE once the order exists in Ship&Co (added if missing)
 * Other columns are kept as they are. Rows that already have an Order ID are skipped.
 *
 * By default it only previews each order and writes nothing; pass --create to
 * create the orders and write the filled CSV (default: <input>-filled.csv).
 * Creating an order is free; it does NOT create a shipment or buy a label.
 *
 * 貨物内容 rules (shipandco_cargo_rules.ts) are always applied. jdm-direct-motors
 * titles must be reviewed first: pass them with --names <file.json>, a map of
 * eBay item id -> cleaned title (" No battery" is added automatically).
 * Rows whose titles aren't reviewed yet are reported and left unfilled.
 *
 * Optional per-batch rules (some sheets need them, e.g. re-created labels):
 *   --ddp            tick DDP (送料・関税 荷送人負担)
 *   --price-from-shipping  item prices (合計金額) become 送料, and 送料 becomes 0
 *   --gift           set 内容品種別 to 贈答品 (content_type GIFT)
 *   --price-cap      to US/PR/VI: unit price > $95 (line <= $750) becomes a random $55-95
 *
 * Usage:
 *   npx tsx src/shipping/fill_shipandco_csv.ts --account jdm-direct-motors orders.csv [--limit 1]
 *   npx tsx src/shipping/fill_shipandco_csv.ts --account jdm-direct-motors orders.csv --create [--out filled.csv]
 */

import { readFileSync, writeFileSync } from "node:fs";
import { accountFromArgs, die } from "../auth/ebay_auth.ts";
import { fulfillmentToken } from "../lib/fulfillment_api.ts";
import { parseCsv, toCsv } from "../lib/csv.ts";
import { adjustmentsFromArgs, describeResult, loadReviewedNames, uploadEbayOrder } from "../lib/ebay_to_shipandco.ts";
import { listApiOrders, type OrderAdjustments } from "../lib/shipandco_orders.ts";
import { runMain } from "../lib/util.ts";

const ORDER_COL = "Order Number";
const ID_COL = "Order ID (Ship & Co)";
const PRICE_COL = "Item Price (Ship & Co)";
const UPLOADED_COL = "Uploaded to Ship & Co";

interface Options {
  account: string;
  input: string;
  output: string;
  create: boolean;
  limit: number;
  adjust: OrderAdjustments;
  reviewedNames: Record<string, string>;
}

function parseArgs(argv: string[]): Options {
  const { adjust, rest: args } = adjustmentsFromArgs(argv);
  const { account, rest } = accountFromArgs(args);
  let input: string | undefined;
  let output: string | undefined;
  let create = false;
  let limit = Infinity;
  let names: string | undefined;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--create") create = true;
    else if (a === "--out") output = rest[++i];
    else if (a === "--limit") limit = Number(rest[++i]);
    else if (a === "--names") names = rest[++i];
    else if (a.startsWith("--")) die(`ERROR: unknown flag ${a}`);
    else if (!input) input = a;
    else die(`ERROR: unexpected extra argument ${a}`);
  }
  if (!input) die("Usage: fill_shipandco_csv.ts --account <name> <orders.csv> [--create] [--out <file>] [--limit <n>] [--names <file.json>] [--ddp] [--price-from-shipping] [--gift] [--price-cap]");
  return { account, input, output: output ?? input.replace(/(\.csv)?$/i, "-filled.csv"), create, limit, adjust, reviewedNames: loadReviewedNames(names) };
}

/** Index of `name` in `header`, appending the column (and padding rows) if it is missing. */
function column(rows: string[][], name: string): number {
  const header = rows[0];
  const i = header.findIndex((h) => h.trim().toLowerCase() === name.toLowerCase());
  if (i >= 0) return i;
  header.push(name);
  return header.length - 1;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const rows = parseCsv(readFileSync(opts.input, "utf8"));
  if (!rows.length) die(`ERROR: ${opts.input} is empty`);

  const orderCol = rows[0].findIndex((h) => h.trim().toLowerCase() === ORDER_COL.toLowerCase());
  if (orderCol < 0) die(`ERROR: no "${ORDER_COL}" column in ${opts.input}`);
  const idCol = column(rows, ID_COL);
  const priceCol = column(rows, PRICE_COL);
  const uploadedCol = column(rows, UPLOADED_COL);
  for (const r of rows) while (r.length < rows[0].length) r.push("");

  const token = await fulfillmentToken(opts.account);
  const existing = await listApiOrders();
  const counts: Record<string, number> = {};
  let done = 0;

  for (const row of rows.slice(1)) {
    const orderId = row[orderCol].trim();
    if (!orderId || row[idCol].trim()) continue;
    if (done++ >= opts.limit) break;

    const r = await uploadEbayOrder(token, opts.account, orderId, { create: opts.create, existing, adjust: opts.adjust, reviewedNames: opts.reviewedNames });
    counts[r.status] = (counts[r.status] ?? 0) + 1;
    if (r.preview) console.log(r.preview);
    console.log(describeResult(r, opts.account) + "\n");
    if (r.shipandcoId) {
      row[idCol] = r.shipandcoId;
      row[priceCol] = r.itemTotal?.toFixed(2) ?? "";
      row[uploadedCol] = "TRUE";
    }
  }

  console.log("Summary:", Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(", ") || "nothing to do");
  if (opts.create) {
    writeFileSync(opts.output, toCsv(rows));
    console.log(`Wrote ${opts.output}`);
  } else {
    console.log("Preview only; no orders created and no CSV written. Re-run with --create.");
  }
}

runMain(main);
