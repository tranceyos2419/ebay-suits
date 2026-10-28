#!/usr/bin/env -S npx tsx
/**
 * revise_item_quantity.ts -- set the available quantity of one or more of our
 * fixed-price listings through the GraphQL Listing API's bulkUpdateInventory
 * mutation (scope sell.listing).
 * Each item is revised in its own call so one failure doesn't block the rest.
 *
 * Usage:
 *   npx tsx src/listings/revise_item_quantity.ts --account <name> --quantity <N> <ITEM_ID> [ITEM_ID ...]
 */

import { accountFromArgs, die } from "../auth/ebay_auth.ts";
import { listingToken, updateInventory } from "../lib/listing_api.ts";
import { runMain } from "../lib/util.ts";

const USAGE =
  "Usage: npx tsx src/listings/revise_item_quantity.ts --account <name> --quantity <N> <ITEM_ID> [ITEM_ID ...]";

async function reviseQuantity(token: string, itemId: string, quantity: number): Promise<boolean> {
  const r = await updateInventory(token, { listingId: itemId }, { quantity });
  console.log(`${itemId}: ${r.ok ? "Success" : "Failure"}${r.ok ? ` (quantity now ${quantity})` : ""}`);
  for (const e of r.errors) console.log(`  [Error] ${e}`);
  for (const w of r.warnings) console.log(`  [Warning] ${w}`);
  return r.ok;
}

async function main() {
  const { account, rest } = accountFromArgs(process.argv.slice(2));
  const qIdx = rest.indexOf("--quantity");
  if (qIdx === -1) die(USAGE);
  const quantity = Number(rest[qIdx + 1]);
  const itemIds = rest.filter((_, i) => i !== qIdx && i !== qIdx + 1);
  if (!Number.isInteger(quantity) || quantity < 0 || itemIds.length === 0) die(USAGE);

  const token = await listingToken(account);
  let failures = 0;
  for (const itemId of itemIds) {
    if (!(await reviseQuantity(token, itemId, quantity))) failures++;
  }
  console.log(`\n${itemIds.length - failures}/${itemIds.length} items set to quantity ${quantity}.`);
  if (failures) process.exit(1);
}

runMain(main);
