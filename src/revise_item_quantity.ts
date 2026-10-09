#!/usr/bin/env -S npx tsx
/**
 * revise_item_quantity.ts -- set the available quantity of one or more
 * fixed-price listings via the Trading API's ReviseInventoryStatus call.
 * Each item is revised in its own call so one failure doesn't block the rest.
 *
 * Usage:
 *   npx tsx src/revise_item_quantity.ts --account <name> --quantity <N> <ITEM_ID> [ITEM_ID ...]
 */

import { findText } from "./xml_util.ts";
import { accountFromArgs, authnAuthToken, die } from "./ebay_auth.ts";
import { printErrors, tradingCall } from "./trading_api.ts";
import { runMain } from "./util.ts";

const USAGE =
  "Usage: npx tsx src/revise_item_quantity.ts --account <name> --quantity <N> <ITEM_ID> [ITEM_ID ...]";

async function reviseQuantity(token: string, itemId: string, quantity: number): Promise<boolean> {
  const r = await tradingCall(
    token,
    "ReviseInventoryStatus",
    `  <InventoryStatus>
    <ItemID>${itemId}</ItemID>
    <Quantity>${quantity}</Quantity>
  </InventoryStatus>`
  );
  const newQty = findText(r.xml, "Quantity");
  console.log(`${itemId}: ${r.ack}${r.ok && newQty ? ` (quantity now ${newQty})` : ""}`);
  printErrors(r.errors);
  return r.ok;
}

async function main() {
  const { account, rest } = accountFromArgs(process.argv.slice(2));
  const qIdx = rest.indexOf("--quantity");
  if (qIdx === -1) die(USAGE);
  const quantity = Number(rest[qIdx + 1]);
  const itemIds = rest.filter((_, i) => i !== qIdx && i !== qIdx + 1);
  if (!Number.isInteger(quantity) || quantity < 0 || itemIds.length === 0) die(USAGE);

  const token = authnAuthToken(account);
  let failures = 0;
  for (const itemId of itemIds) {
    if (!(await reviseQuantity(token, itemId, quantity))) failures++;
  }
  console.log(`\n${itemIds.length - failures}/${itemIds.length} items set to quantity ${quantity}.`);
  if (failures) process.exit(1);
}

runMain(main);
