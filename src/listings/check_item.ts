#!/usr/bin/env -S npx tsx
/**
 * check_item.ts -- minimal read-only check of one of our listings.
 *
 * Reads the listing through the GraphQL Listing API (scope sell.listing) and
 * prints the title, price and current shipping policy; the policy's name
 * comes from the Account API (scope sell.account). Makes no changes.
 *
 * Usage:
 *   npx tsx src/listings/check_item.ts --account jdm-direct-motors 397429202355
 */

import { accountFromArgs, die, oauthToken } from "../auth/ebay_auth.ts";
import { getListing, listingToken } from "../lib/listing_api.ts";
import { runMain } from "../lib/util.ts";

/** Name of fulfillment policy `policyId`, or "" when the Account API doesn't list it. */
async function shippingPolicyName(account: string, policyId: string): Promise<string> {
  const resp = await fetch("https://api.ebay.com/sell/account/v1/fulfillment_policy?marketplace_id=EBAY_US", {
    headers: { Authorization: `Bearer ${await oauthToken(account, ["sell.account"])}`, Accept: "application/json" },
  });
  if (!resp.ok) return "";
  const data = (await resp.json()) as { fulfillmentPolicies?: { fulfillmentPolicyId: string; name: string }[] };
  return data.fulfillmentPolicies?.find((p) => p.fulfillmentPolicyId === policyId)?.name ?? "";
}

async function main() {
  const { account, rest } = accountFromArgs(process.argv.slice(2));
  const itemId = rest[0];
  if (!itemId || rest.length !== 1) die("Usage: npx tsx src/listings/check_item.ts --account <name> <ITEM_ID>");

  const listing = await getListing(await listingToken(account), itemId);
  if (!listing) die(`Listing ${itemId} not found (wrong ID, not this account's, or no longer available).`);

  console.log(`Title: ${listing.title || "(no title)"}`);
  console.log(`Price: ${Number.isFinite(listing.price) ? listing.price.toFixed(2) : ""}`);
  const policyId = listing.shippingPolicyId;
  const policyName = policyId ? await shippingPolicyName(account, policyId) : "";
  console.log(`Current ShippingProfileID: ${policyId || "(none)"} (${policyName})`);
}

runMain(main);
