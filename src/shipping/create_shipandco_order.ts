#!/usr/bin/env -S npx tsx
/**
 * create_shipandco_order.ts -- create Ship&Co orders (POST /v1/orders) from
 * eBay order numbers given on the command line, for orders Ship&Co's own
 * eBay sync no longer imports (e.g. ones that already have an eBay label).
 * Creating an order is free; it does NOT create a shipment or buy a label.
 *
 * By default it only prints a preview; pass --create to create the orders.
 * Orders that already have a Ship&Co order (same ref_number) are skipped.
 * For a CSV of order numbers, use fill_shipandco_csv.ts.
 *
 * 貨物内容 rules (shipandco_cargo_rules.ts) are always applied. jdm-direct-motors
 * titles must be reviewed first: pass them with --names <file.json>, a map of
 * eBay item id -> cleaned title (" No battery" is added automatically).
 *
 * Optional per-batch rules:
 *   --ddp            tick DDP (送料・関税 荷送人負担)
 *   --price-from-shipping  item prices (合計金額) become 送料, and 送料 becomes 0
 *   --gift           set 内容品種別 to 贈答品 (content_type GIFT)
 *
 * Usage:
 *   npx tsx src/shipping/create_shipandco_order.ts --account jdm-direct-motors 26-15152-00011 [more ids...]
 *   npx tsx src/shipping/create_shipandco_order.ts --account jdm-direct-motors 26-15152-00011 --create
 */

import { accountFromArgs, authnAuthToken, die } from "../auth/ebay_auth.ts";
import { adjustmentsFromArgs, describeResult, loadReviewedNames, uploadEbayOrder } from "../lib/ebay_to_shipandco.ts";
import { listApiOrders } from "../lib/shipandco_orders.ts";
import { runMain } from "../lib/util.ts";

async function main() {
  const { adjust, rest: args } = adjustmentsFromArgs(process.argv.slice(2));
  const { account, rest } = accountFromArgs(args);
  const create = rest.includes("--create");
  const namesAt = rest.indexOf("--names");
  const reviewedNames = loadReviewedNames(namesAt >= 0 ? rest[namesAt + 1] : undefined);
  const orderIds = rest.filter((a, i) => a !== "--create" && (namesAt < 0 || (i !== namesAt && i !== namesAt + 1)));
  if (!orderIds.length) die("Usage: create_shipandco_order.ts --account <name> <ebay-order-id>... [--create] [--names <file.json>] [--ddp] [--price-from-shipping] [--gift]");
  const token = authnAuthToken(account);
  const existing = await listApiOrders();

  for (const id of orderIds) {
    const r = await uploadEbayOrder(token, account, id, { create, existing, adjust, reviewedNames });
    if (r.preview) console.log(r.preview);
    console.log(describeResult(r, account) + "\n");
  }
  if (!create) console.log("Preview only. Re-run with --create to create these orders in Ship&Co.");
}

runMain(main);
