#!/usr/bin/env -S npx tsx
/**
 * check_lowest.ts -- for each of our listings, compare our price with Japanese
 * sellers' prices (shipping excluded) from the same search as the CCURL, using
 * the Browse API with an application token.
 *
 * Input (stdin or file arg), TSV with header: eBay Item Id, Brand, Identity, CCURL,
 *   (col 5 unused), Our Shipping fee
 * Output (stdout), JSON { output, excluded }:
 *   output rows: eBay Item Id, Brand, Identity, CCURL, Our Price, Our Shipping fee,
 *     Lowest Rank, Lowest page price, Diff btw Our Page and Lowest, Lowest Page Shipping fee,
 *     Shipping diff, Lowest Seller (username), Lowest item id, Lowest page URL,
 *     Lower Page URLs, Exclusion Page URLs
 *   excluded rows (one per excluded page): our item, page item id, seller, page price,
 *     page shipping, reason, page URL, Identity, our shipping, shipping diff
 *
 * A page's shipping fee is its cheapest shipping option (Browse API, default US destination).
 * Only competitor pages whose shipping fee is within +/-20% of ours are compared
 * (ours $100 -> $80..$120; free shipping -> free only). Pages priced below us that fail
 * the shipping test, or whose shipping fee is unknown, are listed in Exclusion Page URLs.
 *
 * Lowest Rank = 1 + number of distinct other Japanese sellers priced strictly
 * below us (1 = we are the lowest). Our own accounts are excluded from the comparison.
 *
 * Usage:
 *   npx tsx src/check_lowest.ts input.tsv > output.json
 */

import { readFileSync } from "node:fs";
import { appToken, browse, getLegacyItem, shippingFee } from "./browse_api.ts";
import { runMain } from "./util.ts";

const OUR_SELLERS = new Set(["jdm-direct-motors", "love-of-japan"]);
const SHIPPING_TOLERANCE = 0.2;

async function ourPrice(itemId: string, token: string): Promise<{ price: number; shipping?: number } | undefined> {
  const { item } = await getLegacyItem(itemId, token);
  return item ? { price: Number(item.price?.value), shipping: shippingFee(item) } : undefined;
}

/** Their shipping fee is known and within +/-SHIPPING_TOLERANCE of ours. */
function shippingWithinTolerance(ours: number, theirs: number | undefined): boolean {
  return theirs !== undefined && Math.abs(theirs - ours) <= ours * SHIPPING_TOLERANCE + 1e-9;
}

// Same search as the CCURL: category, keyword, min price, Buy It Now, New.
async function japaneseListings(ccurl: string, token: string): Promise<any[]> {
  const u = new URL(ccurl);
  const q = u.searchParams.get("_nkw") ?? "";
  const cat = u.pathname.match(/\/sch\/(\d+)\//)?.[1];
  const filters = ["itemLocationCountry:JP", "priceCurrency:USD"];
  const udlo = u.searchParams.get("_udlo");
  if (udlo) filters.push(`price:[${udlo}..]`);
  if (u.searchParams.get("LH_BIN") === "1") filters.push("buyingOptions:{FIXED_PRICE}");
  const cond = u.searchParams.get("LH_ItemCondition");
  if (cond) filters.push(`conditionIds:{${cond}}`);
  const out: any[] = [];
  for (let offset = 0; offset < 1000; offset += 200) {
    const p = `item_summary/search?q=${encodeURIComponent(q)}${cat ? `&category_ids=${cat}` : ""}&filter=${encodeURIComponent(filters.join(","))}&sort=price&limit=200&offset=${offset}`;
    const r = await browse(p, token);
    const items: any[] = r.body.itemSummaries ?? [];
    out.push(...items);
    if (items.length < 200) break;
  }
  return out.filter((i) => i.itemLocation?.country === "JP");
}

const usd = (n: number) => `$${n.toFixed(2)}`;
const signed = (n: number, plus: boolean) => `${n < 0 ? "-" : plus ? "+" : ""}$${Math.abs(n).toFixed(2)}`;
const itemUrl = (i: any) => `https://www.ebay.com/itm/${i.legacyItemId}`;

async function main() {
  const file = process.argv[2];
  const lines = readFileSync(file ?? 0, "utf8").split("\n").map((l) => l.replace(/\r$/, "")).filter((l) => l.trim());
  const rows = lines.slice(1).map((l) => l.split("\t"));
  const token = await appToken();
  const output: (string | number)[][] = [];
  const excluded: string[][] = [];
  for (const r of rows) {
    const [id, brand, identity, ccurl] = r;
    const ourShip = Number((r[5] ?? "").replace(/[$,]/g, ""));
    const ours = await ourPrice(id, token);
    if (ours === undefined || Number.isNaN(ourShip)) {
      output.push([id, brand, identity, ccurl, "", "", "ERROR: our price/shipping not found"]);
      continue;
    }
    const mine = ours.price;
    const others = (await japaneseListings(ccurl, token)).filter(
      (i) => !OUR_SELLERS.has(i.seller?.username) && i.legacyItemId !== id,
    );
    const lower = others.filter((i) => Number(i.price.value) < mine).sort((a, b) => Number(a.price.value) - Number(b.price.value));
    const kept: any[] = [];
    const dropped: any[] = [];
    for (const i of lower) {
      (shippingWithinTolerance(ourShip, shippingFee(i)) ? kept : dropped).push(i);
    }
    for (const i of dropped) {
      const ship = shippingFee(i);
      excluded.push([
        id, i.legacyItemId, i.seller?.username ?? "", usd(Number(i.price.value)),
        ship === undefined ? "" : usd(ship),
        ship === undefined ? "Shipping unknown" : "Shipping outside 20% of ours",
        itemUrl(i), identity, usd(ourShip),
        ship === undefined ? "" : signed(ship - ourShip, true),
      ]);
    }
    const sellers = new Set(kept.map((i) => i.seller?.username));
    const row: (string | number)[] = [id, brand, identity, ccurl, usd(mine), usd(ourShip), 1 + sellers.size];
    if (kept.length) {
      const low = kept[0];
      const lp = Number(low.price.value);
      const ls = shippingFee(low)!;
      row.push(usd(lp), usd(mine - lp), usd(ls), signed(ourShip - ls, false), low.seller?.username ?? "", low.legacyItemId,
        itemUrl(low), kept.map(itemUrl).join(","));
    } else {
      row.push("", "", "", "", "", "", "", "");
    }
    row.push(dropped.map(itemUrl).join(","));
    output.push(row);
  }
  console.log(JSON.stringify({ output, excluded }));
}

runMain(main);
