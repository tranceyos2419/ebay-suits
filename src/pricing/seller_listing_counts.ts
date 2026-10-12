#!/usr/bin/env -S npx tsx
/**
 * seller_listing_counts.ts -- how many active eBay Motors listings each seller has,
 * from a Browse API search (category 6000, filtered to the seller) with an application token.
 *
 * Input: seller usernames as arguments, or one per line on stdin.
 * Output (stdout), TSV with header: Seller, Active listings (eBay Motors), Checked (YYYY-MM-DD)
 *   The count is blank when the search fails.
 *
 * Usage:
 *   npx tsx src/pricing/seller_listing_counts.ts japan_store spice-japan
 */

import { readFileSync } from "node:fs";
import { appToken, browse } from "../lib/browse_api.ts";
import { mapLimit, runMain } from "../lib/util.ts";

const EBAY_MOTORS = "6000";

async function main() {
  const args = process.argv.slice(2);
  const sellers = (args.length ? args : readFileSync(0, "utf8").split("\n")).map((s) => s.trim()).filter(Boolean);
  const token = await appToken();
  const counts = await mapLimit(sellers, 4, async (s) => {
    const filter = encodeURIComponent(`sellers:{${s}}`);
    const r = await browse(`item_summary/search?category_ids=${EBAY_MOTORS}&filter=${filter}&limit=1`, token);
    return r.status === 200 ? String(r.body.total ?? 0) : "";
  });
  const today = new Date().toISOString().slice(0, 10);
  console.log(["Seller", "Active listings (eBay Motors)", "Checked"].join("\t"));
  sellers.forEach((s, i) => console.log([s, counts[i], today].join("\t")));
}

runMain(main);
