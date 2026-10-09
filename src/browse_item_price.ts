#!/usr/bin/env -S npx tsx
/**
 * browse_item_price.ts -- look up listings' current item price (shipping not
 * included) with the Browse API getItemByLegacyId, using an application token
 * (client credentials), so it works for any seller's listing.
 *
 * Prints TSV: itemId, price, currency, note (multi-variation listings report
 * the lowest variation price).
 *
 * Usage:
 *   npx tsx src/browse_item_price.ts <itemId> [itemId ...]
 *   npx tsx src/browse_item_price.ts < ids.txt      (one id per line)
 */

import { readFileSync } from "node:fs";
import { die } from "./ebay_auth.ts";
import { appToken, getLegacyItem } from "./browse_api.ts";
import { runMain } from "./util.ts";

async function getPrice(itemId: string, token: string): Promise<{ price?: string; currency?: string; note?: string }> {
  const r = await getLegacyItem(itemId, token);
  if (!r.item) return { note: r.error ?? `HTTP ${r.status}` };
  const { value, currency } = r.item.price ?? {};
  return r.variations
    ? { price: Number(value).toFixed(2), currency, note: "variations: lowest" }
    : { price: value, currency };
}

async function main() {
  let ids = process.argv.slice(2);
  if (!ids.length) ids = readFileSync(0, "utf8").split(/\s+/);
  ids = ids.map((s) => s.trim()).filter((s) => /^\d+$/.test(s));
  if (!ids.length) die("Usage: npx tsx src/browse_item_price.ts <itemId> [itemId ...]");
  const token = await appToken();
  console.log(["itemId", "price", "currency", "note"].join("\t"));
  for (const id of ids) {
    const r = await getPrice(id, token);
    console.log([id, r.price ?? "", r.currency ?? "", r.note ?? ""].join("\t"));
  }
}

runMain(main);
