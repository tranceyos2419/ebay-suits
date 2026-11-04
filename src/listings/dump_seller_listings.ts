#!/usr/bin/env -S npx tsx
/**
 * dump_seller_listings.ts -- read-only. Pages through the Buy Browse API for
 * every active listing of one seller and writes item id / title / main image
 * URL to a CSV, so the images can be checked for banners.
 *
 * Browse caps a single query at 10,000 results, so the scan is split into
 * price bands (--band-from/--band-to, repeatable) when the store is bigger.
 * Each band is a separate query with its own offset paging.
 *
 * Usage:
 *   npx tsx src/listings/dump_seller_listings.ts --account jdm-direct-motors \
 *     --seller jdm-direct-motors --out <file.csv> [--max 200] [--band 0:50] [--band 50:200]
 *
 * Output CSV columns: itemId, title, imageUrl
 * Progress goes to stderr.
 */

import { writeFileSync } from "node:fs";
import { accountFromArgs, die } from "../auth/ebay_auth.ts";
import { appToken, browse } from "../lib/browse_api.ts";
import { runMain, sleep } from "../lib/util.ts";

const PAGE = 200;
const BROWSE_LIMIT = 10000;

function csvCell(v: string): string {
  return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

async function main() {
  const { rest } = accountFromArgs(process.argv.slice(2));
  let seller = "";
  let out = "";
  let max = 0;
  let category = "6000";
  let countOnly = false;
  const bands: Array<[number, number]> = [];
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "--seller") seller = rest[++i];
    else if (rest[i] === "--out") out = rest[++i];
    else if (rest[i] === "--max") max = Number(rest[++i]);
    else if (rest[i] === "--category") category = rest[++i];
    else if (rest[i] === "--count-only") countOnly = true;
    else if (rest[i] === "--band") {
      const [a, b] = rest[++i].split(":");
      bands.push([Number(a), Number(b)]);
    }
  }
  if (!seller || !out) die("Usage: npx tsx src/listings/dump_seller_listings.ts --account <name> --seller <name> --out <file.csv> [--max N] [--band a:b]");

  const token = await appToken();
  const rows: string[] = ["itemId,title,imageUrl"];
  const seen = new Set<string>();

  const queries = bands.length ? bands : [[0, 0] as [number, number]];
  for (const [lo, hi] of queries) {
    const priceFilter = hi > 0 ? `,price:[${lo}..${hi}],priceCurrency:USD` : "";
    let offset = 0;
    while (true) {
      if (max && seen.size >= max) break;
      const filter = encodeURIComponent(`sellers:{${seller}}${priceFilter}`);
      const r = await browse(`item_summary/search?category_ids=${category}&filter=${filter}&limit=${PAGE}&offset=${offset}`, token);
      if (r.status !== 200) {
        console.error(`band ${lo}-${hi} offset ${offset}: HTTP ${r.status} ${r.body?.errors?.[0]?.message ?? ""}`);
        break;
      }
      const items: any[] = r.body.itemSummaries ?? [];
      if (countOnly) {
        console.log(`band ${lo}-${hi}: ${r.body?.total ?? "?"} listings`);
        break;
      }
      const total = Number(r.body.total ?? 0);
      for (const it of items) {
        const itemId = String(it.itemId ?? "").split("|")[1] ?? String(it.itemId ?? "");
        if (!itemId || seen.has(itemId)) continue;
        seen.add(itemId);
        const imageUrl = it.image?.imageUrl ?? "";
        rows.push([itemId, csvCell(String(it.title ?? "")), imageUrl].join(","));
        if (max && seen.size >= max) break;
      }
      console.error(`band ${lo}-${hi} offset ${offset}: +${items.length} (${seen.size} total, reported ${total})`);
      if (items.length < PAGE || offset + PAGE >= Math.min(total, BROWSE_LIMIT)) break;
      offset += PAGE;
      await sleep(120);
    }
  }

  writeFileSync(out, rows.join("\n") + "\n");
  console.log(`${seen.size} listings -> ${out}`);
}

runMain(main);
