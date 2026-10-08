#!/usr/bin/env -S npx tsx
/**
 * check_lowest.ts -- for each of our listings, compare our price with Japanese
 * sellers' prices (shipping excluded) from the same search as the CCURL, using
 * the Browse API with an application token.
 *
 * Input (stdin or file arg), TSV with header: eBay Item Id, Brand, Identity, CCURL
 * Output TSV (Output-sheet layout): eBay Item Id, Brand, Identity, CCURL,
 *   Our Price, Our Shipping fee, Lowest Rank, Lowest page price, Lowest Seller (username),
 *   Diff btw Our Page and Lowest, Lower Page URLs, Exclusion Page URLs, Lowest Page Shipping fee
 *
 * A page's shipping fee is its cheapest shipping option (Browse API, default US destination).
 * Only competitor pages whose shipping fee is within +/-20% of ours are compared
 * (ours $100 -> $80..$120; free shipping -> free only). Pages priced below us that fail
 * the shipping test, or whose shipping fee is unknown, are listed in Exclusion Page URLs.
 *
 * With a second file argument, also writes one TSV row per excluded page (our item, page URL,
 * seller, page price, page shipping, reason) for the summary's exclusion section.
 *
 * Lowest Rank = 1 + number of distinct other Japanese sellers priced strictly
 * below us (1 = we are the lowest). Our own accounts are excluded from the comparison.
 *
 * Usage:
 *   npx tsx src/check_lowest.ts input.tsv [exclusions.tsv] > output.tsv
 */

import { readFileSync, writeFileSync } from "node:fs";
import { requestToken } from "./ebay_auth.ts";

const BROWSE = "https://api.ebay.com/buy/browse/v1";
const OUR_SELLERS = new Set(["jdm-direct-motors", "love-of-japan"]);

async function api(path: string, token: string): Promise<{ status: number; body: any }> {
  for (let attempt = 0; ; attempt++) {
    const resp = await fetch(`${BROWSE}/${path}`, {
      headers: { Authorization: `Bearer ${token}`, "X-EBAY-C-MARKETPLACE-ID": "EBAY_US" },
    });
    if (resp.status === 429 && attempt < 3) {
      await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
      continue;
    }
    return { status: resp.status, body: await resp.json().catch(() => ({})) };
  }
}

const SHIPPING_TOLERANCE = 0.2;

// Cheapest shipping option's cost, or undefined when the listing reports none.
function shippingFee(item: any): number | undefined {
  const costs = (item?.shippingOptions ?? [])
    .map((o: any) => Number(o.shippingCost?.value))
    .filter((n: number) => !Number.isNaN(n));
  return costs.length ? Math.min(...costs) : undefined;
}

async function ourPrice(itemId: string, token: string): Promise<{ price: number; shipping?: number } | undefined> {
  const r = await api(`item/get_item_by_legacy_id?legacy_item_id=${itemId}`, token);
  if (r.status === 200) return { price: Number(r.body.price?.value), shipping: shippingFee(r.body) };
  if (r.body.errors?.some((e: any) => e.errorId === 11006)) {
    const g = await api(`item/get_items_by_item_group?item_group_id=${itemId}`, token);
    const items: any[] = (g.body.items ?? []).filter((i: any) => !Number.isNaN(Number(i.price?.value)));
    if (items.length) {
      const low = items.reduce((a, b) => (Number(b.price.value) < Number(a.price.value) ? b : a));
      return { price: Number(low.price.value), shipping: shippingFee(low) };
    }
  }
  return undefined;
}

function shippingWithinTolerance(ours: number, theirs: number | undefined): boolean {
  if (theirs === undefined) return false;
  const eps = 1e-9;
  return theirs >= ours * (1 - SHIPPING_TOLERANCE) - eps && theirs <= ours * (1 + SHIPPING_TOLERANCE) + eps;
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
    const r = await api(p, token);
    const items: any[] = r.body.itemSummaries ?? [];
    out.push(...items);
    if (items.length < 200) break;
  }
  return out.filter((i) => i.itemLocation?.country === "JP");
}

const usd = (n: number) => `$${n.toFixed(2)}`;
const signed = (n: number, plus: boolean) => `${n < 0 ? "-" : plus ? "+" : ""}$${Math.abs(n).toFixed(2)}`;
const SHIP_TOLERANCE = 0.2;

function shippingOf(i: any): number | undefined {
  const v = (i.shippingOptions ?? []).map((o: any) => Number(o.shippingCost?.value)).filter((n: number) => !Number.isNaN(n));
  return v.length ? Math.min(...v) : undefined;
}

async function main() {
  const file = process.argv[2];
  const lines = readFileSync(file ?? 0, "utf8").split("\n").map((l) => l.replace(/\r$/, "")).filter((l) => l.trim());
  const rows = lines.slice(1).map((l) => l.split("\t"));
  const t = await requestToken({ grant_type: "client_credentials", scope: "https://api.ebay.com/oauth/api_scope" });
  const token = t.access_token;
  const output: (string | number)[][] = [];
  const excluded: string[][] = [];
  for (const r of rows) {
    const [id, brand, identity, ccurl] = r;
    const ourShip = Number((r[5] ?? "").replace(/[$,]/g, ""));
    const mine = await ourPrice(id, token);
    if (mine === undefined || Number.isNaN(ourShip)) {
      output.push([id, brand, identity, ccurl, "", "", "ERROR: our price/shipping not found"]);
      continue;
    }
    const others = (await japaneseListings(ccurl, token)).filter(
      (i) => !OUR_SELLERS.has(i.seller?.username) && i.legacyItemId !== id,
    );
    const lower = others.filter((i) => Number(i.price.value) < mine).sort((a, b) => Number(a.price.value) - Number(b.price.value));
    const kept: any[] = [];
    const dropped: any[] = [];
    for (const i of lower) {
      const ship = shippingOf(i);
      (ship !== undefined && Math.abs(ship - ourShip) <= ourShip * SHIP_TOLERANCE + 1e-9 ? kept : dropped).push(i);
    }
    for (const i of dropped) {
      const ship = shippingOf(i);
      excluded.push([
        id, i.legacyItemId, i.seller?.username ?? "", usd(Number(i.price.value)),
        ship === undefined ? "" : usd(ship),
        ship === undefined ? "Shipping unknown" : "Shipping outside 20% of ours",
        `https://www.ebay.com/itm/${i.legacyItemId}`, identity, usd(ourShip),
        ship === undefined ? "" : signed(ship - ourShip, true),
      ]);
    }
    const sellers = new Set(kept.map((i) => i.seller?.username));
    const row: (string | number)[] = [id, brand, identity, ccurl, usd(mine), usd(ourShip), 1 + sellers.size];
    if (kept.length) {
      const low = kept[0];
      const lp = Number(low.price.value);
      const ls = shippingOf(low)!;
      row.push(usd(lp), usd(mine - lp), usd(ls), signed(ourShip - ls, false), low.seller?.username ?? "", low.legacyItemId,
        `https://www.ebay.com/itm/${low.legacyItemId}`, kept.map((i) => `https://www.ebay.com/itm/${i.legacyItemId}`).join(","));
    } else {
      row.push("", "", "", "", "", "", "", "");
    }
    row.push(dropped.map((i) => `https://www.ebay.com/itm/${i.legacyItemId}`).join(","));
    output.push(row);
  }
  console.log(JSON.stringify({ output, excluded }));
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
