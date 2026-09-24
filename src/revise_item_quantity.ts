#!/usr/bin/env -S npx tsx
/**
 * revise_item_quantity.ts -- set the available quantity of one or more
 * fixed-price listings via the Trading API's ReviseInventoryStatus call.
 * Each item is revised in its own call so one failure doesn't block the rest.
 *
 * Usage:
 *   npx tsx src/revise_item_quantity.ts --account <name> --quantity <N> <ITEM_ID> [ITEM_ID ...]
 */

import { findText, findErrors } from "./xml_util.ts";
import { accountFromArgs, authnAuthToken } from "./ebay_auth.ts";

const USAGE =
  "Usage: npx tsx src/revise_item_quantity.ts --account <name> --quantity <N> <ITEM_ID> [ITEM_ID ...]";

async function reviseQuantity(token: string, itemId: string, quantity: number): Promise<boolean> {
  const xmlBody = `<?xml version="1.0" encoding="utf-8"?>
<ReviseInventoryStatusRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <InventoryStatus>
    <ItemID>${itemId}</ItemID>
    <Quantity>${quantity}</Quantity>
  </InventoryStatus>
</ReviseInventoryStatusRequest>`;

  const resp = await fetch("https://api.ebay.com/ws/api.dll", {
    method: "POST",
    headers: {
      "Content-Type": "text/xml",
      "X-EBAY-API-SITEID": "0",
      "X-EBAY-API-COMPATIBILITY-LEVEL": "1193",
      "X-EBAY-API-CALL-NAME": "ReviseInventoryStatus",
      "X-EBAY-API-IAF-TOKEN": token,
    },
    body: xmlBody,
  });

  const body = await resp.text();
  const ack = findText(body, "Ack") ?? `HTTP ${resp.status}`;
  const ok = ack === "Success" || ack === "Warning";
  const newQty = findText(body, "Quantity");
  console.log(`${itemId}: ${ack}${ok && newQty ? ` (quantity now ${newQty})` : ""}`);
  for (const err of findErrors(body)) {
    console.log(`  [${err.severity}] ${err.short} -- ${err.long}`);
  }
  return ok;
}

async function main() {
  const { account, rest } = accountFromArgs(process.argv.slice(2));
  const qIdx = rest.indexOf("--quantity");
  if (qIdx === -1) {
    console.error(USAGE);
    process.exit(1);
  }
  const quantity = Number(rest[qIdx + 1]);
  const itemIds = rest.filter((_, i) => i !== qIdx && i !== qIdx + 1);
  if (!Number.isInteger(quantity) || quantity < 0 || itemIds.length === 0) {
    console.error(USAGE);
    process.exit(1);
  }

  const token = authnAuthToken(account);
  let failures = 0;
  for (const itemId of itemIds) {
    if (!(await reviseQuantity(token, itemId, quantity))) failures++;
  }
  console.log(`\n${itemIds.length - failures}/${itemIds.length} items set to quantity ${quantity}.`);
  if (failures) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
