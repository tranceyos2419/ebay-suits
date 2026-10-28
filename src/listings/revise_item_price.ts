#!/usr/bin/env -S npx tsx
/**
 * revise_item_price.ts -- set the fixed price of one of our single-SKU
 * listings through the GraphQL Listing API's updateListing mutation
 * (scope sell.listing).
 *
 * --validate asks eBay to check the change without applying it.
 *
 * Usage:
 *   npx tsx src/listings/revise_item_price.ts --account <name> [--validate] <ITEM_ID> <NEW_PRICE>
 */

import { accountFromArgs, die } from "../auth/ebay_auth.ts";
import { listingToken, updatePrice } from "../lib/listing_api.ts";
import { runMain } from "../lib/util.ts";

async function main() {
  const { account, rest: args } = accountFromArgs(process.argv.slice(2));
  const validateOnly = args.includes("--validate");
  const rest = args.filter((a) => a !== "--validate");
  const [itemId, newPrice] = rest;
  if (!itemId || !newPrice || rest.length !== 2 || !(Number(newPrice) > 0)) {
    die("Usage: npx tsx src/listings/revise_item_price.ts --account <name> [--validate] <ITEM_ID> <NEW_PRICE>");
  }

  const r = await updatePrice(await listingToken(account), itemId, newPrice, { validateOnly });
  console.log(`Result: ${r.ok ? "Success" : "Failure"}${validateOnly ? " (validate only)" : ""}`);
  for (const e of r.errors) console.log(`  [Error] ${e}`);
  for (const w of r.warnings) console.log(`  [Warning] ${w}`);

  if (r.ok) {
    console.log(validateOnly ? `Item ${itemId}: price ${newPrice} is valid (not applied).` : `Item ${itemId} revised. Price: ${newPrice}`);
  } else {
    process.exit(1);
  }
}

runMain(main);
