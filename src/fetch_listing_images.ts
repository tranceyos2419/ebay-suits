#!/usr/bin/env -S npx tsx
/**
 * fetch_listing_images.ts -- read-only. For every eBay Item id in a CSV
 * (first column), calls GetItem and downloads the listing's main photo (and
 * any others with --all) so each can be inspected for banners/watermarks.
 * Makes no changes to eBay.
 *
 * Usage:
 *   npx tsx src/fetch_listing_images.ts --account jdm-direct-motors \
 *     --out <dir> [--all] <input.csv>
 *
 * Writes <dir>/<itemId>_<n>.jpg and prints one line per item:
 *   itemId <TAB> seller <TAB> ack <TAB> pictureCount <TAB> title
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { findBlocks, findText } from "./xml_util.ts";
import { accountFromArgs, authnAuthToken, die } from "./ebay_auth.ts";
import { parseCsv } from "./csv.ts";
import { tradingCall } from "./trading_api.ts";
import { runMain } from "./util.ts";

async function main() {
  const { account, rest } = accountFromArgs(process.argv.slice(2));
  let outDir: string | undefined;
  let all = false;
  let csvPath: string | undefined;
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "--out") outDir = rest[++i];
    else if (rest[i] === "--all") all = true;
    else csvPath = rest[i];
  }
  if (!outDir || !csvPath) die("Usage: npx tsx src/fetch_listing_images.ts --account <name> --out <dir> [--all] <input.csv>");
  mkdirSync(outDir, { recursive: true });

  const ids = parseCsv(readFileSync(csvPath, "utf8"))
    .slice(1)
    .map((row) => (row[0] ?? "").trim())
    .filter(Boolean);

  const token = authnAuthToken(account);
  for (const id of ids) {
    const r = await tradingCall(token, "GetItem", `  <ItemID>${id}</ItemID>\n  <DetailLevel>ReturnAll</DetailLevel>`);
    if (!r.ok) {
      console.log(`${id}\t-\t${r.ack}\t0\t${r.errors.map((e) => e.short).join("; ")}`);
      continue;
    }
    const seller = findText(findBlocks(r.xml, "Seller")[0] ?? "", "UserID") ?? "?";
    const title = findText(r.xml, "Title") ?? "";
    const pictureBlock = findBlocks(r.xml, "PictureDetails")[0] ?? "";
    const urls = [...pictureBlock.matchAll(/<PictureURL>([^<]+)<\/PictureURL>/g)].map((m) => m[1].replace(/&amp;/g, "&"));
    const wanted = all ? urls : urls.slice(0, 1);
    for (let n = 0; n < wanted.length; n++) {
      // eBay image URLs accept a size suffix; s-l1600 gives the full-size photo.
      const full = wanted[n].replace(/s-l\d+/, "s-l1600");
      const img = await fetch(full);
      if (img.ok) writeFileSync(join(outDir, `${id}_${n + 1}.jpg`), Buffer.from(await img.arrayBuffer()));
    }
    console.log(`${id}\t${seller}\t${r.ack}\t${urls.length}\t${title}`);
  }
}

runMain(main);
