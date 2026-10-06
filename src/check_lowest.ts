#!/usr/bin/env -S npx tsx
/**
 * check_lowest.ts -- for each of our listings, compare our price with Japanese
 * sellers' prices (shipping excluded) from the same search as the CCURL, using
 * the Browse API with an application token.
 *
 * Input (stdin or file arg), TSV with header: eBay Item Id, Brand, Identity, CCURL
 * Output TSV (Output-sheet layout): eBay Item Id, Brand, Identity, CCURL,
 *   Our Price, Lowest Rank, Lowest page price, Diff btw Our Page and Lowest, Lower Page URLs, Lowest Seller (username)
 *
 * Lowest Rank = 1 + number of distinct other Japanese sellers priced strictly
 * below us (1 = we are the lowest). Our own accounts are excluded from the comparison.
 *
 * Usage:
 *   npx tsx src/check_lowest.ts input.tsv > output.tsv
 */

import { readFileSync } from "node:fs";
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

async function ourPrice(itemId: string, token: string): Promise<number | undefined> {
  const r = await api(`item/get_item_by_legacy_id?legacy_item_id=${itemId}`, token);
  if (r.status === 200) return Number(r.body.price?.value);
  if (r.body.errors?.some((e: any) => e.errorId === 11006)) {
    const g = await api(`item/get_items_by_item_group?item_group_id=${itemId}`, token);
    const prices = (g.body.items ?? []).map((i: any) => Number(i.price?.value)).filter((n: number) => !Number.isNaN(n));
    if (prices.length) return Math.min(...prices);
  }
  return undefined;
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

async function main() {
  const file = process.argv[2];
  const lines = readFileSync(file ?? 0, "utf8").split("\n").map((l) => l.replace(/\r$/, "")).filter((l) => l.trim());
  const rows = lines.slice(1).map((l) => l.split("\t"));
  const t = await requestToken({ grant_type: "client_credentials", scope: "https://api.ebay.com/oauth/api_scope" });
  const token = t.access_token;
  console.log(["eBay Item Id", "Brand", "Identity", "CCURL", "Our Price", "Lowest Rank", "Lowest page price", "Diff btw Our Page and Lowest", "Lower Page URLs", "Lowest Seller"].join("\t"));
  for (const [id, brand, identity, ccurl] of rows) {
    const mine = await ourPrice(id, token);
    if (mine === undefined) {
      console.log([id, brand, identity, ccurl, "", "ERROR: our price not found"].join("\t"));
      continue;
    }
    const others = (await japaneseListings(ccurl, token)).filter(
      (i) => !OUR_SELLERS.has(i.seller?.username) && i.legacyItemId !== id,
    );
    const lower = others.filter((i) => Number(i.price.value) < mine).sort((a, b) => Number(a.price.value) - Number(b.price.value));
    const sellers = new Set(lower.map((i) => i.seller?.username));
    const cols = [id, brand, identity, ccurl, usd(mine), String(1 + sellers.size)];
    if (lower.length) {
      const low = Number(lower[0].price.value);
      cols.push(usd(low), usd(mine - low), lower.map((i) => `https://www.ebay.com/itm/${i.legacyItemId}`).join(","), lower[0].seller?.username ?? "");
    }
    console.log(cols.join("\t"));
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
