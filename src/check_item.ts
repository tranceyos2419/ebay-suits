#!/usr/bin/env -S npx tsx
/**
 * check_item.ts -- minimal read-only test of Trading API access.
 *
 * Calls GetItem for one Item ID and prints the title + current shipping
 * profile. Makes no changes.
 *
 * Usage:
 *   npx tsx src/check_item.ts --account jdm-direct-motors 397429202355
 */

import { findText, findErrors } from "./xml_util.ts";
import { accountFromArgs, authnAuthToken } from "./ebay_auth.ts";

async function main() {
  const { account, rest } = accountFromArgs(process.argv.slice(2));
  const itemId = rest[0];
  if (!itemId || rest.length !== 1) {
    console.error("Usage: npx tsx src/check_item.ts --account <name> <ITEM_ID>");
    process.exit(1);
  }

  const token = authnAuthToken(account);

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
    const title = findText(body, "Title") ?? "(no title)";
    const price = findText(body, "CurrentPrice") ?? "";
    const profileId = findText(body, "ShippingProfileID") ?? "(none)";
    const profileName = findText(body, "ShippingProfileName") ?? "";
    console.log(`Title: ${title}`);
    console.log(`Price: ${price}`);
    console.log(`Current ShippingProfileID: ${profileId} (${profileName})`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
