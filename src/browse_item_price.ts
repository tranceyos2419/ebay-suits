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
import { requestToken } from "./ebay_auth.ts";

const BROWSE = "https://api.ebay.com/buy/browse/v1/item";

async function appToken(): Promise<string> {
  const t = await requestToken({ grant_type: "client_credentials", scope: "https://api.ebay.com/oauth/api_scope" });
  return t.access_token;
}

async function browse(path: string, token: string): Promise<{ status: number; body: any }> {
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

async function getPrice(itemId: string, token: string): Promise<{ price?: string; currency?: string; note?: string }> {
  const single = await browse(`get_item_by_legacy_id?legacy_item_id=${itemId}`, token);
  if (single.status === 200) {
    return { price: single.body.price?.value, currency: single.body.price?.currency };
  }
  // 11006: the listing has variations -- fetch the group and take the lowest price.
  if (single.body.errors?.some((e: any) => e.errorId === 11006)) {
    const group = await browse(`get_items_by_item_group?item_group_id=${itemId}`, token);
    const items: any[] = group.body.items ?? [];
    const prices = items.map((i) => Number(i.price?.value)).filter((n) => !Number.isNaN(n));
    if (prices.length) {
      return { price: Math.min(...prices).toFixed(2), currency: items[0].price?.currency, note: "variations: lowest" };
    }
  }
  return { note: single.body.errors?.[0]?.message ?? `HTTP ${single.status}` };
}

async function main() {
  let ids = process.argv.slice(2);
  if (!ids.length) ids = readFileSync(0, "utf8").split(/\s+/);
  ids = ids.map((s) => s.trim()).filter((s) => /^\d+$/.test(s));
  if (!ids.length) {
    console.error("Usage: npx tsx src/browse_item_price.ts <itemId> [itemId ...]");
    process.exit(1);
  }
  const token = await appToken();
  console.log(["itemId", "price", "currency", "note"].join("\t"));
  for (const id of ids) {
    const r = await getPrice(id, token);
    console.log([id, r.price ?? "", r.currency ?? "", r.note ?? ""].join("\t"));
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
