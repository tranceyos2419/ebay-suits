#!/usr/bin/env -S npx tsx
/**
 * check_item.ts -- minimal read-only test of Trading API access.
 *
 * Calls GetItem for one Item ID and prints the title + current shipping
 * profile. Makes no changes.
 *
 * Usage:
 *   npx tsx src/listings/check_item.ts --account jdm-direct-motors 397429202355
 */

import { findText } from "../lib/xml_util.ts";
import { accountFromArgs, authnAuthToken, die } from "../auth/ebay_auth.ts";
import { printErrors, tradingCall } from "../lib/trading_api.ts";
import { runMain } from "../lib/util.ts";

async function main() {
  const { account, rest } = accountFromArgs(process.argv.slice(2));
  const itemId = rest[0];
  if (!itemId || rest.length !== 1) die("Usage: npx tsx src/listings/check_item.ts --account <name> <ITEM_ID>");

  const r = await tradingCall(
    authnAuthToken(account),
    "GetItem",
    `  <ItemID>${itemId}</ItemID>
  <DetailLevel>ReturnAll</DetailLevel>`
  );
  console.log(`Ack: ${r.ack}`);
  printErrors(r.errors);

  if (r.ok) {
    console.log(`Title: ${findText(r.xml, "Title") ?? "(no title)"}`);
    console.log(`Price: ${findText(r.xml, "CurrentPrice") ?? ""}`);
    console.log(`Current ShippingProfileID: ${findText(r.xml, "ShippingProfileID") ?? "(none)"} (${findText(r.xml, "ShippingProfileName") ?? ""})`);
  }
}

runMain(main);
