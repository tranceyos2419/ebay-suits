#!/usr/bin/env -S npx tsx
/**
 * check_item.ts -- minimal read-only test of Trading API access.
 *
 * Calls GetItem for one Item ID and prints the title + current shipping
 * profile. Makes no changes.
 *
 * Usage:
 *   export EBAY_ACCESS_TOKEN="your-token"
 *   npx tsx check_item.ts 397429202355
 */

import { findText, findErrors } from "./xml_util.ts";

async function main() {
  const itemId = process.argv[2];
  if (!itemId || process.argv.length !== 3) {
    console.error("Usage: npx tsx check_item.ts <ITEM_ID>");
    process.exit(1);
  }

  const token = process.env.EBAY_ACCESS_TOKEN;
  if (!token) {
    console.error('ERROR: set EBAY_ACCESS_TOKEN first, e.g.\n  export EBAY_ACCESS_TOKEN="your-token"');
    process.exit(1);
  }

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
