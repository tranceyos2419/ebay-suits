#!/usr/bin/env -S npx tsx
/**
 * revise_item_price.ts -- update the StartPrice/BuyItNowPrice of a fixed-price
 * listing via the Trading API's ReviseItem call.
 *
 * Usage:
 *   npx tsx src/revise_item_price.ts --account <name> <ITEM_ID> <NEW_PRICE>
 */

import { findText, findErrors } from "./xml_util.ts";
import { accountFromArgs, authnAuthToken } from "./ebay_auth.ts";

async function main() {
  const { account, rest } = accountFromArgs(process.argv.slice(2));
  const [itemId, newPrice] = rest;
  if (!itemId || !newPrice || rest.length !== 2) {
    console.error("Usage: npx tsx src/revise_item_price.ts --account <name> <ITEM_ID> <NEW_PRICE>");
    process.exit(1);
  }

  const token = authnAuthToken(account);

  const xmlBody = `<?xml version="1.0" encoding="utf-8"?>
<ReviseItemRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <Item>
    <ItemID>${itemId}</ItemID>
    <StartPrice>${newPrice}</StartPrice>
  </Item>
</ReviseItemRequest>`;

  const resp = await fetch("https://api.ebay.com/ws/api.dll", {
    method: "POST",
    headers: {
      "Content-Type": "text/xml",
      "X-EBAY-API-SITEID": "0",
      "X-EBAY-API-COMPATIBILITY-LEVEL": "1193",
      "X-EBAY-API-CALL-NAME": "ReviseItem",
      "X-EBAY-API-IAF-TOKEN": token,
    },
    body: xmlBody,
  });

  if (!resp.ok) {
    console.log(`HTTP ${resp.status}`);
  }
  const body = await resp.text();

  const ack = findText(body, "Ack") ?? "Unknown";
  console.log(`Ack: ${ack}`);

  for (const err of findErrors(body)) {
    console.log(`  [${err.severity}] ${err.short} -- ${err.long}`);
  }

  if (ack === "Success" || ack === "Warning") {
    const fees = findText(body, "Fee") ?? "";
    console.log(`Item ${itemId} revised. StartPrice: ${newPrice}${fees ? ` (fee: ${fees})` : ""}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
