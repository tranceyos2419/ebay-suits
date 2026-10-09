#!/usr/bin/env -S npx tsx
/**
 * tracking_price_diff.ts -- build the "Tracking Page Price" and "Deactivate"
 * sheets (as CSV) from a "key pages ... from ebay price tracker.csv" export.
 *
 * Reads every key page (price col "[KeyPage] Price") and its TrackingPage 01-20
 * item IDs, looks up each tracking page's current price with the Browse API
 * (application token, works for any seller), and writes:
 *   <out>-tracking-page-price.csv  all tracking pages: TrackingPage id/price, KeyPage id/price, difference, Deactivate, Comment
 *   <out>-deactivate.csv           only rows where tracking price - key price < threshold
 * Prices are cached in <out>-price-cache.json so a re-run only looks up what is missing.
 *
 * Usage:
 *   npx tsx src/pricing/tracking_price_diff.ts <input.csv> [--threshold 2] [--out reports/name-prefix]
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { die } from "../auth/ebay_auth.ts";
import { appToken, getLegacyItem } from "../lib/browse_api.ts";
import { parseCsv, toCsv, type CsvValue } from "../lib/csv.ts";
import { mapLimit, runMain } from "../lib/util.ts";

type Price = { price?: number; note?: string };

async function getPrice(itemId: string, token: string): Promise<Price> {
  const r = await getLegacyItem(itemId, token);
  if (r.item) {
    const v = Number(r.item.price?.value);
    if (Number.isNaN(v)) return { note: "no price in response" };
    return r.variations ? { price: v, note: "variations: lowest" } : { price: v };
  }
  if (r.status === 404) return { note: "Listing Completed" };
  return { note: r.error ?? `HTTP ${r.status}` };
}

async function main() {
  const args = process.argv.slice(2);
  const opt = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
  const threshold = Number(opt("--threshold") ?? 2);
  const optVals = new Set(["--threshold", "--out"].map(opt).filter(Boolean));
  const file = args.filter((a) => !a.startsWith("--") && !optVals.has(a))[0];
  if (!file || !existsSync(file)) die("Usage: npx tsx src/pricing/tracking_price_diff.ts <input.csv> [--threshold 2] [--out reports/prefix]");
  const out = opt("--out") ?? "reports/tracking-price-diff";

  const [header, ...data] = parseCsv(readFileSync(file, "utf8"));
  const idCol = header.indexOf("[KeyPage] ebay_item_id");
  const priceCol = header.indexOf("[KeyPage] Price");
  const trackCols = header.map((h, i) => (/^\[TrackingPage \d+\] ebay_item_id$/.test(h) ? i : -1)).filter((i) => i >= 0);

  const pairs: { track: string; key: string; keyPrice: number }[] = [];
  const seen = new Set<string>();
  for (const r of data) {
    if (!r[idCol]) continue;
    for (const c of trackCols) {
      const track = r[c]?.trim();
      if (!track || seen.has(track)) continue;
      seen.add(track);
      pairs.push({ track, key: r[idCol], keyPrice: Number(r[priceCol]) });
    }
  }

  const cachePath = `${out}-price-cache.json`;
  const cache: Record<string, Price> = existsSync(cachePath) ? JSON.parse(readFileSync(cachePath, "utf8")) : {};
  const todo = pairs.filter((p) => !cache[p.track]);
  console.log(`${pairs.length} tracking pages, ${todo.length} to look up`);

  const token = await appToken();
  let done = 0;
  await mapLimit(todo, 2, async (p) => {
    const res = await getPrice(p.track, token);
    if (!/Too many requests/.test(res.note ?? "")) cache[p.track] = res; // keep rate-limited ones out of the cache so a re-run retries them
    if (++done % 250 === 0) {
      writeFileSync(cachePath, JSON.stringify(cache));
      console.log(`  ${done}/${todo.length}`);
    }
  });
  writeFileSync(cachePath, JSON.stringify(cache));

  const head = ["[TrackingPage] ebay_item_id", "[TrackingPage] Price", "[KeyPage] ebay_item_id", "[KeyPage] Price", "The price difference", "Deactivate", "Comment"];
  const all: CsvValue[][] = [head];
  const deact: CsvValue[][] = [head];
  let failed = 0;
  for (const p of pairs) {
    const res = cache[p.track];
    if (res.price === undefined) {
      failed++;
      all.push([p.track, "", p.key, p.keyPrice, "", "", res.note ?? ""]);
      continue;
    }
    const diff = Math.round((res.price - p.keyPrice) * 100) / 100;
    const yes = diff < threshold;
    const row = [p.track, res.price, p.key, p.keyPrice, diff, yes ? "Yes" : "", res.note ?? ""];
    all.push(row);
    if (yes) deact.push(row);
  }
  writeFileSync(`${out}-tracking-page-price.csv`, toCsv(all));
  writeFileSync(`${out}-deactivate.csv`, toCsv(deact));
  console.log(`${pairs.length} rows, ${deact.length - 1} with difference < ${threshold}, ${failed} without a price`);
}

runMain(main);
