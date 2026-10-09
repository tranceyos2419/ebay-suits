#!/usr/bin/env -S npx tsx
/**
 * revise_item_price.ts -- update the StartPrice/BuyItNowPrice of a fixed-price
 * listing via the Trading API's ReviseItem call.
 *
 * Usage:
 *   npx tsx src/revise_item_price.ts --account <name> <ITEM_ID> <NEW_PRICE>
 */

import { findText } from "./xml_util.ts";
import { accountFromArgs, authnAuthToken, die } from "./ebay_auth.ts";
import { printErrors, tradingCall } from "./trading_api.ts";
import { runMain } from "./util.ts";

async function main() {
  const { account, rest } = accountFromArgs(process.argv.slice(2));
  const [itemId, newPrice] = rest;
  if (!itemId || !newPrice || rest.length !== 2) {
    die("Usage: npx tsx src/revise_item_price.ts --account <name> <ITEM_ID> <NEW_PRICE>");
  }

  const r = await tradingCall(
    authnAuthToken(account),
    "ReviseItem",
    `  <Item>
    <ItemID>${itemId}</ItemID>
    <StartPrice>${newPrice}</StartPrice>
  </Item>`
  );
  console.log(`Ack: ${r.ack}`);
  printErrors(r.errors);

  if (r.ok) {
    const fees = findText(r.xml, "Fee") ?? "";
    console.log(`Item ${itemId} revised. StartPrice: ${newPrice}${fees ? ` (fee: ${fees})` : ""}`);
  }
}

runMain(main);
