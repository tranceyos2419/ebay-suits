#!/usr/bin/env -S npx tsx
/**
 * reissue_us_territory_orders.ts -- for eBay-synced Ship&Co orders to a US
 * territory (Puerto Rico, US Virgin Islands, Guam, ...) that show no Zonos rate
 * because Ship&Co got the country as "PR"/"VI": create an API order that copies
 * the synced one as it was filled in (宛先, 貨物内容 with prices and HS codes,
 * 送料, DDP, 内容品種別, parcels) but with country "US" and the territory code
 * as province, so Zonos (DDP) is offered. Ship the new API-XXXX order.
 *
 * The Ship&Co API cannot edit an order, and the synced order is left as it is
 * (delete or ignore it in Ship&Co). The eBay order number goes in ref_number;
 * orders that already have an API order with that ref_number are skipped.
 * Creating an order is free; it does NOT create a shipment or buy a label.
 *
 * By default it only prints a preview; pass --create to create the orders.
 *
 * Usage:
 *   npx tsx src/shipping/reissue_us_territory_orders.ts 15-15211-47416 [more eBay order ids...] [--create]
 */

import { shipandcoRequest } from "../lib/shipandco_api.ts";
import {
  createShipandcoOrder,
  findOrdersByRef,
  itemsTotal,
  listApiOrders,
  shipandcoCountry,
  shipandcoProvince,
  type ShipandcoOrderBody,
} from "../lib/shipandco_orders.ts";
import { die } from "../auth/ebay_auth.ts";
import { runMain } from "../lib/util.ts";

/** Ship&Co orders of every source (eBay-synced too) from the last 2 months, keyed by id. */
async function listAllOrders(): Promise<Map<string, any>> {
  const byId = new Map<string, any>();
  const since = new Date(Date.now() - 60 * 86_400_000).toISOString();
  for (let page = 1; ; page++) {
    let r: any;
    try {
      r = await shipandcoRequest("GET", `/orders?scope=all&limit=100&page=${page}&created_after=${since}`);
    } catch (e) {
      if (String(e).includes("NO_ORDERS")) break;
      throw e;
    }
    for (const o of r.orders) byId.set(o.id, o);
    if (page >= r.pages) break;
  }
  return byId;
}

/** The POST /v1/orders body copying a synced order, with the US-territory address fixed. */
function reissueBody(o: any): ShipandcoOrderBody & { parcels?: unknown[] } {
  const a = o.to_address ?? {};
  const toAddress: Record<string, string> = {
    full_name: a.full_name || [a.first_name, a.last_name].filter(Boolean).join(" ") || a.company,
    address1: a.address1,
    address2: a.address2 ?? "",
    city: a.city,
    province: shipandcoProvince(a.country, a.province ?? "", a.zip ?? ""),
    zip: a.zip,
    country: shipandcoCountry(a.country, a.province ?? "", a.zip ?? ""),
    phone: a.phone,
  };
  if (a.extra) toAddress.extra = a.extra;
  if (a.email) toAddress.email = a.email;
  const keep = ["name", "item_id", "sku", "quantity", "price", "hs_code", "hs_description", "origin_country"];
  const products = (o.products ?? [])
    .filter((p: any) => p.selected !== false)
    .map((p: any) => Object.fromEntries(keep.filter((k) => p[k] !== undefined && p[k] !== "").map((k) => [k, p[k]])));
  const customs: Record<string, unknown> = {};
  if (o.customs?.duty_paid !== undefined) customs.duty_paid = o.customs.duty_paid;
  if (o.customs?.content_type) customs.content_type = o.customs.content_type;
  const body: ShipandcoOrderBody & { parcels?: unknown[] } = {
    to_address: toAddress,
    products,
    setup: { currency: o.setup?.currency ?? "USD", shipping_fee: o.setup?.shipping_fee ?? 0, ref_number: o.id },
    customs,
  };
  if (o.parcels?.length) body.parcels = o.parcels.map(({ id, ...p }: any) => p);
  return body;
}

async function main() {
  const args = process.argv.slice(2);
  const create = args.includes("--create");
  const ids = args.filter((a) => a !== "--create");
  if (!ids.length) die("Usage: reissue_us_territory_orders.ts <ebay-order-id>... [--create]");

  const all = await listAllOrders();
  const existing = await listApiOrders();
  for (const id of ids) {
    const synced = all.get(id);
    if (!synced) {
      console.log(`=== ${id}\n  -> no eBay-synced Ship&Co order with this id (use create_shipandco_order.ts)\n`);
      continue;
    }
    const body = reissueBody(synced);
    const a = synced.to_address;
    const b = body.to_address;
    console.log(`=== ${id}  (Ship&Co state: ${synced.state})`);
    console.log(`  国/州: ${a.country}/${a.province} -> ${b.country}/${b.province}    郵便番号: ${b.zip}   都市: ${b.city}`);
    console.log(`  送料: ${body.setup.shipping_fee} ${body.setup.currency}   合計金額: ${itemsTotal(body).toFixed(2)}   DDP: ${body.customs?.duty_paid ? "on" : "off"}   内容品種別: ${body.customs?.content_type ?? "-"}`);
    for (const p of body.products) console.log(`  - ${p.name}  ${p.price} x ${p.quantity}  HS ${p.hs_code ?? "-"}`);

    if (b.country === a.country) {
      console.log(`  -> not a US-territory address that needs fixing; skipped\n`);
      continue;
    }
    const dup = (await findOrdersByRef(id, existing))[0];
    if (dup) {
      console.log(`  -> already reissued as ${dup.id}; not created again\n`);
      continue;
    }
    if (!create) {
      console.log(`  -> preview only\n`);
      continue;
    }
    const created = await createShipandcoOrder(body);
    existing.push(created);
    console.log(`  -> created Ship&Co order ${created.id}\n`);
  }
  if (!create) console.log("Preview only. Re-run with --create to create these orders in Ship&Co.");
}

runMain(main);
