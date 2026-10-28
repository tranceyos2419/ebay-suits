#!/usr/bin/env -S npx tsx
/**
 * fetch_listing_images.ts -- read-only. For every eBay Item id in a CSV
 * (first column), looks the listing up with the Buy Browse API (app token, so
 * any seller's listing works) and downloads its main photo (and any others
 * with --all) so each can be inspected for banners/watermarks.
 * Makes no changes to eBay. Browse only returns live listings; for a
 * multi-variation listing it reports the lowest-priced variation's photos.
 *
 * Usage:
 *   npx tsx src/listings/fetch_listing_images.ts --account jdm-direct-motors \
 *     --out <dir> [--all] <input.csv>
 *
 * Writes <dir>/<itemId>_<n>.jpg and prints one line per item:
 *   itemId <TAB> seller <TAB> ack <TAB> pictureCount <TAB> title
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { accountFromArgs, die } from "../auth/ebay_auth.ts";
import { appToken, getLegacyItem } from "../lib/browse_api.ts";
import { parseCsv } from "../lib/csv.ts";
import { runMain } from "../lib/util.ts";

async function main() {
  // --account is still required for consistency, though Browse uses an app token.
  const { rest } = accountFromArgs(process.argv.slice(2));
  let outDir: string | undefined;
  let all = false;
  let csvPath: string | undefined;
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "--out") outDir = rest[++i];
    else if (rest[i] === "--all") all = true;
    else csvPath = rest[i];
  }
  if (!outDir || !csvPath) die("Usage: npx tsx src/listings/fetch_listing_images.ts --account <name> --out <dir> [--all] <input.csv>");
  mkdirSync(outDir, { recursive: true });

  const ids = parseCsv(readFileSync(csvPath, "utf8"))
    .slice(1)
    .map((row) => (row[0] ?? "").trim())
    .filter(Boolean);

  const token = await appToken();
  for (const id of ids) {
    const r = await getLegacyItem(id, token);
    if (!r.item) {
      console.log(`${id}\t-\tFailure\t0\t${r.error ?? `HTTP ${r.status}`}`);
      continue;
    }
    const seller = r.item.seller?.username ?? "?";
    const title = r.item.title ?? "";
    const urls: string[] = [r.item.image, ...(r.item.additionalImages ?? [])].map((i: any) => i?.imageUrl).filter(Boolean);
    const wanted = all ? urls : urls.slice(0, 1);
    for (let n = 0; n < wanted.length; n++) {
      // eBay image URLs accept a size suffix; s-l1600 gives the full-size photo.
      const full = wanted[n].replace(/s-l\d+/, "s-l1600");
      const img = await fetch(full);
      if (img.ok) writeFileSync(join(outDir, `${id}_${n + 1}.jpg`), Buffer.from(await img.arrayBuffer()));
    }
    console.log(`${id}\t${seller}\tSuccess\t${urls.length}\t${title}`);
  }
}

runMain(main);
