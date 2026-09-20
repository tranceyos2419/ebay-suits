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
import { findBlocks, findErrors, findText } from "./xml_util.ts";
import { accountFromArgs, authnAuthToken } from "./ebay_auth.ts";

async function getItem(token: string, itemId: string): Promise<string> {
  const xmlBody = `<?xml version="1.0" encoding="utf-8"?>
<GetItemRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <ItemID>${itemId}</ItemID>
  <DetailLevel>ReturnAll</DetailLevel>
</GetItemRequest>`;
  const resp = await fetch("https://api.ebay.com/ws/api.dll", {
    method: "POST",
    headers: {
      "Content-Type": "text/xml",
      "X-EBAY-API-SITEID": "0",
      "X-EBAY-API-COMPATIBILITY-LEVEL": "1193",
      "X-EBAY-API-CALL-NAME": "GetItem",
      "X-EBAY-API-IAF-TOKEN": token,
    },
    body: xmlBody,
  });
  return resp.text();
}

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
  if (!outDir || !csvPath) {
    console.error("Usage: npx tsx src/fetch_listing_images.ts --account <name> --out <dir> [--all] <input.csv>");
    process.exit(1);
  }
  mkdirSync(outDir, { recursive: true });

  const ids = readFileSync(csvPath, "utf8")
    .split(/\r?\n/)
    .slice(1)
    .map((line) => line.split(",")[0].trim())
    .filter(Boolean);

  const token = authnAuthToken(account);
  for (const id of ids) {
    const body = await getItem(token, id);
    const ack = findText(body, "Ack") ?? "Unknown";
    const errs = findErrors(body);
    if (ack !== "Success" && ack !== "Warning") {
      console.log(`${id}\t-\t${ack}\t0\t${errs.map((e) => e.short).join("; ")}`);
      continue;
    }
    const seller = findText(findBlocks(body, "Seller")[0] ?? "", "UserID") ?? "?";
    const title = findText(body, "Title") ?? "";
    const pictureBlock = findBlocks(body, "PictureDetails")[0] ?? "";
    const urls = [...pictureBlock.matchAll(/<PictureURL>([^<]+)<\/PictureURL>/g)].map((m) => m[1].replace(/&amp;/g, "&"));
    const wanted = all ? urls : urls.slice(0, 1);
    for (let n = 0; n < wanted.length; n++) {
      // eBay image URLs accept a size suffix; s-l1600 gives the full-size photo.
      const full = wanted[n].replace(/s-l\d+/, "s-l1600");
      const img = await fetch(full);
      if (img.ok) writeFileSync(join(outDir, `${id}_${n + 1}.jpg`), Buffer.from(await img.arrayBuffer()));
    }
    console.log(`${id}\t${seller}\t${ack}\t${urls.length}\t${title}`);
  }
}

main();
