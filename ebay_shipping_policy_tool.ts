#!/usr/bin/env -S npx tsx
/**
 * ebay_shipping_policy_tool.ts
 *
 * Small CLI to:
 *   1. List your eBay store's shipping (fulfillment) policies  [Account API]
 *   2. Reassign a shipping policy to specific classic listings  [Trading API ReviseItem]
 *
 * Auth
 * ----
 * This script expects a User OAuth access token in the environment variable
 * EBAY_ACCESS_TOKEN. Get one from:
 *   developer.ebay.com -> My Account -> Application Keys -> your app -> "User Tokens"
 *   tab -> select scopes (sell.account, sell.inventory) -> "Sign in to Production"
 *   (or Sandbox) -> approve -> copy the Access Token shown.
 *
 * That token is short-lived (~2 hrs). There's also a Refresh Token shown at the
 * same time, valid ~18 months, which you can use to mint new access tokens
 * without logging in again (see refresh_token.ts).
 *
 * NEVER commit your token or paste it into shared/public places. Treat it like
 * a password.
 *
 * Usage
 * -----
 *   export EBAY_ACCESS_TOKEN="v^1.1#i^1#..."
 *
 *   # 1. See your policies and their IDs
 *   npx tsx ebay_shipping_policy_tool.ts list-policies
 *
 *   # 2. Confirm you can read listings, and that an edit WOULD succeed, without
 *   #    changing anything (uses GetItem [read] + VerifyReviseItem [validate-only]).
 *   npx tsx ebay_shipping_policy_tool.ts check-access \
 *       --item-ids 110123456789 110987654321 \
 *       --policy-id 123456789012
 *
 *   # 3. Apply a policy to specific listings (dry run first!)
 *   npx tsx ebay_shipping_policy_tool.ts revise-items \
 *       --policy-id 123456789012 \
 *       --item-ids 110123456789 110987654321 \
 *       --dry-run
 *
 *   # Then actually apply it:
 *   npx tsx ebay_shipping_policy_tool.ts revise-items \
 *       --policy-id 123456789012 \
 *       --item-ids 110123456789 110987654321
 *
 * Flags
 * -----
 *   --sandbox        Use eBay Sandbox endpoints instead of Production.
 *   --marketplace    Marketplace ID for the Account API (default EBAY_US).
 *   --site-id        Trading API SiteID (default 0 = US).
 */

import { findText, findErrors } from "./xml_util.ts";

type Env = "prod" | "sandbox";

const ACCOUNT_API_HOST: Record<Env, string> = {
  prod: "https://api.ebay.com",
  sandbox: "https://api.sandbox.ebay.com",
};
const TRADING_API_HOST: Record<Env, string> = {
  prod: "https://api.ebay.com/ws/api.dll",
  sandbox: "https://api.sandbox.ebay.com/ws/api.dll",
};

const TRADING_API_COMPATIBILITY_LEVEL = "1193";

function getToken(): string {
  const token = process.env.EBAY_ACCESS_TOKEN;
  if (!token) {
    console.error(
      "ERROR: EBAY_ACCESS_TOKEN environment variable is not set.\n" +
        "Get a token from developer.ebay.com -> your app -> User Tokens tab, then:\n" +
        '  export EBAY_ACCESS_TOKEN="..."'
    );
    process.exit(1);
  }
  return token;
}

async function listPolicies(env: Env, marketplaceId: string) {
  const host = ACCOUNT_API_HOST[env];
  const url = `${host}/sell/account/v1/fulfillment_policy?marketplace_id=${marketplaceId}`;
  const resp = await fetch(url, {
    headers: {
      Authorization: `Bearer ${getToken()}`,
      Accept: "application/json",
    },
  });

  if (!resp.ok) {
    const body = await resp.text();
    console.error(`ERROR ${resp.status} fetching policies:\n${body}`);
    process.exit(1);
  }

  const data = (await resp.json()) as {
    fulfillmentPolicies?: Array<{ fulfillmentPolicyId?: string; name?: string; marketplaceId?: string }>;
  };
  const policies = data.fulfillmentPolicies ?? [];

  if (policies.length === 0) {
    console.log("No fulfillment policies found for marketplace", marketplaceId);
    return;
  }

  console.log(`${"Policy ID".padEnd(20)} ${"Name".padEnd(40)} Marketplace`);
  console.log("-".repeat(80));
  for (const p of policies) {
    console.log(`${(p.fulfillmentPolicyId ?? "").padEnd(20)} ${(p.name ?? "").padEnd(40)} ${p.marketplaceId ?? ""}`);
  }
}

function buildReviseItemXml(itemId: string, policyId: string): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<ReviseItemRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <Item>
    <ItemID>${itemId}</ItemID>
    <SellerProfiles>
      <SellerShippingProfile>
        <ShippingProfileID>${policyId}</ShippingProfileID>
      </SellerShippingProfile>
    </SellerProfiles>
  </Item>
</ReviseItemRequest>`;
}

/** POST an arbitrary Trading API call and return the raw XML response text. */
async function callTradingApi(env: Env, callName: string, xmlBody: string, siteId: number): Promise<string> {
  const url = TRADING_API_HOST[env];
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "text/xml",
      "X-EBAY-API-SITEID": String(siteId),
      "X-EBAY-API-COMPATIBILITY-LEVEL": TRADING_API_COMPATIBILITY_LEVEL,
      "X-EBAY-API-CALL-NAME": callName,
      // OAuth user token passed via IAF header for Trading API calls.
      "X-EBAY-API-IAF-TOKEN": getToken(),
    },
    body: xmlBody,
  });
  return resp.text();
}

function printErrors(xml: string): boolean {
  let ok = true;
  for (const err of findErrors(xml)) {
    console.log(`  [${err.severity}] ${err.short} -- ${err.long}`);
    if (err.severity === "Error") {
      ok = false;
    }
  }
  return ok;
}

async function reviseItem(env: Env, itemId: string, policyId: string, siteId: number, dryRun: boolean): Promise<boolean> {
  const xmlBody = buildReviseItemXml(itemId, policyId);

  if (dryRun) {
    console.log(`[DRY RUN] Would revise Item ${itemId} -> ShippingProfileID ${policyId}`);
    console.log(xmlBody);
    console.log();
    return true;
  }

  const xml = await callTradingApi(env, "ReviseItem", xmlBody, siteId);
  const ack = findText(xml, "Ack") ?? "Unknown";
  console.log(`Item ${itemId}: Ack=${ack}`);
  const noHardErrors = printErrors(xml);
  return (ack === "Success" || ack === "Warning") && noHardErrors;
}

/** Read-only: fetch an item's title and current shipping profile. Proves read access. */
async function getItem(env: Env, itemId: string, siteId: number): Promise<string | null> {
  const xmlBody = `<?xml version="1.0" encoding="utf-8"?>
<GetItemRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <ItemID>${itemId}</ItemID>
  <DetailLevel>ReturnAll</DetailLevel>
</GetItemRequest>`;
  const xml = await callTradingApi(env, "GetItem", xmlBody, siteId);
  const ack = findText(xml, "Ack") ?? "Unknown";
  if (ack !== "Success" && ack !== "Warning") {
    console.log(`  READ  Item ${itemId}: Ack=${ack} (could not read this item)`);
    printErrors(xml);
    return null;
  }
  const title = findText(xml, "Title") ?? "(no title)";
  const currentProfileId = findText(xml, "ShippingProfileID") ?? "(none)";
  const currentProfileName = findText(xml, "ShippingProfileName") ?? "";
  console.log(`  READ  Item ${itemId}: "${title}" -- current ShippingProfileID=${currentProfileId} (${currentProfileName})`);
  return currentProfileId;
}

/** Validate-only: ask eBay whether this revision WOULD succeed, without applying it. */
async function verifyReviseItem(env: Env, itemId: string, policyId: string, siteId: number): Promise<boolean> {
  const xmlBody = buildReviseItemXml(itemId, policyId);
  const xml = await callTradingApi(env, "VerifyReviseItem", xmlBody, siteId);
  const ack = findText(xml, "Ack") ?? "Unknown";
  console.log(`  VERIFY Item ${itemId} -> ShippingProfileID ${policyId}: Ack=${ack} (no change was made)`);
  const ok = printErrors(xml);
  return (ack === "Success" || ack === "Warning") && ok;
}

async function checkAccess(env: Env, itemIds: string[], policyId: string | undefined, siteId: number) {
  console.log("Checking read access (GetItem) and, if --policy-id given, edit capability (VerifyReviseItem)...\n");
  let allOk = true;
  for (const itemId of itemIds) {
    const currentProfileId = await getItem(env, itemId, siteId);
    if (currentProfileId === null) {
      allOk = false;
      continue;
    }
    if (policyId) {
      const ok = await verifyReviseItem(env, itemId, policyId, siteId);
      allOk = allOk && ok;
    }
    console.log();
  }
  if (allOk) {
    console.log("All checks passed. Nothing was changed on eBay.");
  } else {
    console.log("Some checks failed -- see errors above. Nothing was changed on eBay.");
    process.exit(1);
  }
}

// ---- tiny argv parser (mirrors the subset of argparse actually used) ----

interface ParsedArgs {
  sandbox: boolean;
  command: "list-policies" | "check-access" | "revise-items";
  marketplace: string;
  itemIds: string[];
  policyId?: string;
  siteId: number;
  dryRun: boolean;
}

function die(msg: string): never {
  console.error(msg);
  process.exit(1);
}

function parseArgs(argv: string[]): ParsedArgs {
  const args: ParsedArgs = {
    sandbox: false,
    command: "list-policies",
    marketplace: "EBAY_US",
    itemIds: [],
    policyId: undefined,
    siteId: 0,
    dryRun: false,
  };

  const rest: string[] = [];
  for (const a of argv) {
    if (a === "--sandbox") {
      args.sandbox = true;
    } else {
      rest.push(a);
    }
  }

  const command = rest.shift();
  if (command !== "list-policies" && command !== "check-access" && command !== "revise-items") {
    die(
      "Usage: ebay_shipping_policy_tool.ts [--sandbox] <list-policies|check-access|revise-items> [options]"
    );
  }
  args.command = command;

  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    switch (a) {
      case "--marketplace":
        args.marketplace = rest[++i];
        break;
      case "--item-ids": {
        const ids: string[] = [];
        while (rest[i + 1] && !rest[i + 1].startsWith("--")) {
          ids.push(rest[++i]);
        }
        args.itemIds = ids;
        break;
      }
      case "--policy-id":
        args.policyId = rest[++i];
        break;
      case "--site-id":
        args.siteId = parseInt(rest[++i], 10);
        break;
      case "--dry-run":
        args.dryRun = true;
        break;
      default:
        die(`Unknown option: ${a}`);
    }
  }

  if (args.command === "check-access" && args.itemIds.length === 0) {
    die("--item-ids is required for check-access");
  }
  if (args.command === "revise-items") {
    if (args.itemIds.length === 0) die("--item-ids is required for revise-items");
    if (!args.policyId) die("--policy-id is required for revise-items");
  }

  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const env: Env = args.sandbox ? "sandbox" : "prod";

  if (args.command === "list-policies") {
    await listPolicies(env, args.marketplace);
  } else if (args.command === "check-access") {
    await checkAccess(env, args.itemIds, args.policyId, args.siteId);
  } else if (args.command === "revise-items") {
    const results: Array<[string, boolean]> = [];
    for (const itemId of args.itemIds) {
      const ok = await reviseItem(env, itemId, args.policyId!, args.siteId, args.dryRun);
      results.push([itemId, ok]);
    }
    if (!args.dryRun) {
      const failed = results.filter(([, ok]) => !ok).map(([id]) => id);
      if (failed.length > 0) {
        console.log(`\n${failed.length} item(s) failed: ${JSON.stringify(failed)}`);
        process.exit(1);
      }
      console.log(`\nAll ${results.length} item(s) revised successfully.`);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
