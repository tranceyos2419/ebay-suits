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
 *   # 4. Scan ALL active listings, find the ones on a given "source" policy
 *   #    (e.g. a generic "Express" policy), and work out which price-range
 *   #    policy (a policy literally named "$<min> - $<max>", nothing else)
 *   #    each one's current price falls into. Writes a CSV report; makes NO
 *   #    changes to eBay.
 *   # --items-file is a scraped "itemId,price" per line list (no header) --
 *   # e.g. from the Seller Hub "active listings filtered by shippingPolicy"
 *   # page. --ranges-file is a JSON policy catalog -- see
 *   # data/policy-ranges/*.json for the format and a real example, captured
 *   # from the account's Business Policies page (bp/manage). Both flags are
 *   # optional and independent; omitting either falls back to a full-store
 *   # scan for that part, which is capped at 25,000 active listings by
 *   # GetMyeBaySelling (see the NOTE above scanActiveListings in the source
 *   # for why that matters on a larger store).
 *   npx tsx ebay_shipping_policy_tool.ts migrate-by-price \
 *       --from-policy-id 273300062012 \
 *       --report-out reports/express-migration.csv \
 *       --items-file express_items.csv \
 *       --ranges-file data/policy-ranges/jdm-direct-motors.json
 *
 *   # 5. Apply the moves from a previously written report (only rows marked
 *   #    MATCH are revised; NO_MATCH rows are always left alone).
 *   npx tsx ebay_shipping_policy_tool.ts migrate-by-price \
 *       --from-policy-id 273300062012 \
 *       --report-out reports/express-migration.csv \
 *       --apply
 *
 * Flags
 * -----
 *   --sandbox        Use eBay Sandbox endpoints instead of Production.
 *   --marketplace    Marketplace ID for the Account API (default EBAY_US).
 *   --site-id        Trading API SiteID (default 0 = US).
 *   --from-policy-id Source fulfillment policy ID (migrate-by-price).
 *   --report-out     CSV report path (migrate-by-price).
 *   --items-file     Scraped "itemId,price" list, one per line, no header
 *                     (migrate-by-price dry-run). Omit to fall back to a
 *                     full-store scan (see warning above -- undercounts on
 *                     stores over ~25,000 active listings).
 *   --ranges-file    JSON price-tier policy catalog, see
 *                     data/policy-ranges/*.json (migrate-by-price dry-run).
 *                     Omit to fall back to discovering ranges from a listing
 *                     scan instead (won't find a catch-all tier with a name
 *                     that isn't "$min - $max", e.g. a "MAX" policy).
 *   --apply          Apply moves from an existing report instead of scanning
 *                     and writing a fresh dry-run report (migrate-by-price).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { findText, findErrors, findBlocks } from "./xml_util.ts";

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
async function callTradingApi(
  env: Env,
  callName: string,
  xmlBody: string,
  siteId: number,
  extraHeaders?: Record<string, string>
): Promise<string> {
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
      ...extraHeaders,
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

// ---- migrate-by-price: move listings off a source policy (e.g. "Express")
// into whichever price-range policy ("$<min> - $<max>", nothing else) their
// current price falls into. ----
//
// NOTE on approach: an earlier version of this discovered both the item list
// and the policy catalog by paging through GetMyeBaySelling (Trading API) for
// every active listing. That's unreliable for a large store: GetMyeBaySelling
// hard-caps at 25,000 returned entries. On a store with more active listings
// than that, a meaningful tail (skewed toward newer items -- exactly where a
// recently-introduced policy tends to concentrate) is structurally
// unreachable through that call, regardless of pagination or sort order.
// Confirmed live against jdm-direct-motors (~32,000+ active listings): the
// capped scan found only 78-80 of a source policy's listings against a true
// count of 215 per eBay's own Seller Hub filter.
//
// So on a large store, prefer sourcing both inputs from the seller's own UI
// instead, which applies filters server-side and isn't subject to that cap:
//   - the price-tier catalog as a small JSON file read from disk via
//     --ranges-file (see loadRangesFile and data/policy-ranges/*.json for the
//     format and an example, captured from the account's Business Policies
//     page at bp/manage);
//   - the source-policy item list from the Seller Hub "active listings
//     filtered by shippingPolicy" page, scraped and passed via --items-file
//     (itemId,price per line -- see readItemsFile).
// Both flags are optional and independent -- omit either to fall back to
// scanActiveListings' full-store scan for that input, which is fine on a
// smaller store (under ~25,000 active listings) but should not be trusted
// blindly above that.
// GetItem/ReviseItem (Trading API) are still used to fetch each item's title
// (and re-confirm it's still on the source policy) and to apply the moves --
// those single-item calls aren't subject to the list-cap at all.

/** Matches ONLY a clean "$<min> - $<max>" name -- excludes anything with a
 * suffix (e.g. "$200 - $225 Copy_(3)" or "$125 - $150 / 7836 / JP / ..."). */
const PRICE_RANGE_RE = /^\$([\d,]+(?:\.\d+)?)\s*-\s*\$([\d,]+(?:\.\d+)?)$/;

interface PolicyRange {
  policyId: string;
  name: string;
  min: number;
  max: number;
}

interface SourceItem {
  itemId: string;
  title: string;
  price: number;
}

interface ReportRow {
  itemId: string;
  title: string;
  currentPrice: number;
  targetPolicyId: string;
  targetPolicyName: string;
  status: "MATCH" | "NO_MATCH";
}

/** Load a price-tier policy catalog from a JSON file (see
 * data/policy-ranges/*.json for the format and a real example). `max: null`
 * in the file means "no upper bound" (a catch-all tier like "MAX") and is
 * converted to Infinity here, since JSON has no Infinity literal. Meant for
 * a catalog hand-captured from the account's Business Policies page
 * (bp/manage) -- see the module-level NOTE above for why that beats
 * discovering it from a listing scan on a large store. */
function loadRangesFile(path: string): Map<string, PolicyRange> {
  const parsed = JSON.parse(readFileSync(path, "utf8")) as {
    ranges: Array<{ policyId: string; name: string; min: number; max: number | null }>;
  };
  return new Map(
    parsed.ranges.map((r) => [r.policyId, { policyId: r.policyId, name: r.name, min: r.min, max: r.max ?? Infinity }])
  );
}

/** Read a scraped "itemId,price" per line file (no header) -- see the
 * module-level NOTE above for where this comes from. Title is filled in
 * later via GetItem. */
function readItemsFile(path: string): Array<{ itemId: string; price: number }> {
  const text = readFileSync(path, "utf8").trim();
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .map((line) => {
      const [itemId, priceStr] = line.split(",");
      return { itemId: itemId.trim(), price: parseFloat(priceStr) };
    });
}

const GET_MY_EBAY_SELLING_OUTPUT_SELECTOR = [
  "ActiveList.PaginationResult.TotalNumberOfPages",
  "ActiveList.ItemArray.Item.ItemID",
  "ActiveList.ItemArray.Item.Title",
  "ActiveList.ItemArray.Item.SellingStatus.CurrentPrice",
  "ActiveList.ItemArray.Item.SellerProfiles.SellerShippingProfile.ShippingProfileID",
  "ActiveList.ItemArray.Item.SellerProfiles.SellerShippingProfile.ShippingProfileName",
].join(",");

function buildGetMyeBaySellingXml(pageNumber: number, entriesPerPage: number): string {
  // Explicit, stable sort is required: GetMyeBaySelling's default order relates
  // to TimeLeft, which keeps changing (GTC listings' countdowns), so items can
  // drift between pages -- and get silently skipped -- across a scan that
  // spans many sequential requests. ItemID is static, so sorting by it keeps
  // page boundaries stable for the whole scan.
  //
  // NOTE: even with this fix, GetMyeBaySelling still hard-caps at 25,000
  // entries -- see the module-level NOTE above. scanActiveListings() below is
  // kept only as a fallback for smaller stores; migrate-by-price defaults to
  // --items-file instead.
  return `<?xml version="1.0" encoding="utf-8"?>
<GetMyeBaySellingRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <ActiveList>
    <Include>true</Include>
    <Sort>ItemIDAscending</Sort>
    <Pagination>
      <EntriesPerPage>${entriesPerPage}</EntriesPerPage>
      <PageNumber>${pageNumber}</PageNumber>
    </Pagination>
  </ActiveList>
</GetMyeBaySellingRequest>`;
}

/** One page of active listings: total page count plus each item's price and
 * current shipping profile id/name. */
async function fetchActiveListingsPage(
  env: Env,
  siteId: number,
  pageNumber: number,
  entriesPerPage: number
): Promise<{
  totalPages: number;
  items: Array<{ itemId: string; title: string; price: number; profileId: string; profileName: string }>;
}> {
  const xml = await callTradingApi(
    env,
    "GetMyeBaySelling",
    buildGetMyeBaySellingXml(pageNumber, entriesPerPage),
    siteId,
    { "X-EBAY-API-OUTPUT-SELECTOR": GET_MY_EBAY_SELLING_OUTPUT_SELECTOR }
  );

  const ack = findText(xml, "Ack") ?? "Unknown";
  if (ack !== "Success" && ack !== "Warning") {
    console.error(`GetMyeBaySelling page ${pageNumber}: Ack=${ack}`);
    printErrors(xml);
    process.exit(1);
  }

  const totalPages = parseInt(findText(xml, "TotalNumberOfPages") ?? "1", 10);
  const items = findBlocks(xml, "Item").map((block) => ({
    itemId: findText(block, "ItemID") ?? "",
    title: findText(block, "Title") ?? "",
    price: parseFloat(findText(block, "CurrentPrice") ?? "NaN"),
    profileId: findText(block, "ShippingProfileID") ?? "",
    profileName: (findText(block, "ShippingProfileName") ?? "").trim(),
  }));

  return { totalPages, items };
}

const PAGE_DELAY_MS = 250;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Scan every active listing once: collect the price-range policy catalog
 * (from clean "$min - $max" policy names seen anywhere) and every listing
 * currently on `fromPolicyId`. One pass covers both, since a range only used
 * by a later page must still be known before matching. */
async function scanActiveListings(
  env: Env,
  siteId: number,
  fromPolicyId: string
): Promise<{ ranges: Map<string, PolicyRange>; sourceItems: SourceItem[] }> {
  const ranges = new Map<string, PolicyRange>();
  const sourceItemsById = new Map<string, SourceItem>();
  const entriesPerPage = 200;

  const recordPage = (items: Awaited<ReturnType<typeof fetchActiveListingsPage>>["items"]) => {
    for (const item of items) {
      const m = PRICE_RANGE_RE.exec(item.profileName);
      if (m && !ranges.has(item.profileId)) {
        ranges.set(item.profileId, {
          policyId: item.profileId,
          name: item.profileName,
          min: parseFloat(m[1].replace(/,/g, "")),
          max: parseFloat(m[2].replace(/,/g, "")),
        });
      }
      // Keyed by itemId (not pushed to an array) so that if pagination ever
      // overlaps -- the same item showing up on two pages -- it's only
      // counted once instead of skewing the report.
      if (item.profileId === fromPolicyId) {
        sourceItemsById.set(item.itemId, { itemId: item.itemId, title: item.title, price: item.price });
      }
    }
  };

  const first = await fetchActiveListingsPage(env, siteId, 1, entriesPerPage);
  const totalPages = first.totalPages;
  recordPage(first.items);
  console.log(`  page 1/${totalPages}, ${sourceItemsById.size} source-policy item(s) so far`);

  for (let page = 2; page <= totalPages; page++) {
    await sleep(PAGE_DELAY_MS);
    const { items } = await fetchActiveListingsPage(env, siteId, page, entriesPerPage);
    recordPage(items);
    console.log(`  page ${page}/${totalPages}, ${sourceItemsById.size} source-policy item(s) so far`);
  }

  // NOTE: a catch-all tier above the top "$min - $max" policy (e.g. a "MAX"
  // policy for anything over $1,000) can never be discovered this way -- by
  // definition it doesn't follow the pure-range name pattern, and it may have
  // zero listings on it yet. Pass --ranges-file with such a tier included
  // (max: null in the JSON) if the account has one; see loadRangesFile.

  return { ranges, sourceItems: [...sourceItemsById.values()] };
}

/** [min, max) -- inclusive low end, exclusive high end (confirmed boundary rule). */
function matchRange(price: number, ranges: Map<string, PolicyRange>): PolicyRange | undefined {
  for (const range of ranges.values()) {
    if (price >= range.min && price < range.max) {
      return range;
    }
  }
  return undefined;
}

function buildReport(sourceItems: SourceItem[], ranges: Map<string, PolicyRange>): ReportRow[] {
  return sourceItems.map((item) => {
    const match = matchRange(item.price, ranges);
    return {
      itemId: item.itemId,
      title: item.title,
      currentPrice: item.price,
      targetPolicyId: match?.policyId ?? "",
      targetPolicyName: match?.name ?? "",
      status: match ? "MATCH" : "NO_MATCH",
    };
  });
}

function csvEscape(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

function writeReportCsv(path: string, rows: ReportRow[]) {
  const dir = dirname(path);
  if (dir && dir !== "." && !existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  const header = "itemId,title,currentPrice,targetPolicyId,targetPolicyName,status";
  const lines = rows.map((r) =>
    [r.itemId, csvEscape(r.title), r.currentPrice, r.targetPolicyId, csvEscape(r.targetPolicyName), r.status].join(",")
  );
  writeFileSync(path, [header, ...lines].join("\n") + "\n", "utf8");
}

function readReportCsv(path: string): ReportRow[] {
  const text = readFileSync(path, "utf8").trim();
  const [, ...lines] = text.split("\n");
  return lines
    .filter((l) => l.length > 0)
    .map((line) => {
      // Simple CSV split good enough for our own escaped output (titles may
      // contain commas but are always quoted by writeReportCsv above).
      const fields: string[] = [];
      let cur = "";
      let inQuotes = false;
      for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (inQuotes) {
          if (c === '"' && line[i + 1] === '"') {
            cur += '"';
            i++;
          } else if (c === '"') {
            inQuotes = false;
          } else {
            cur += c;
          }
        } else if (c === '"') {
          inQuotes = true;
        } else if (c === ",") {
          fields.push(cur);
          cur = "";
        } else {
          cur += c;
        }
      }
      fields.push(cur);
      const [itemId, title, currentPrice, targetPolicyId, targetPolicyName, status] = fields;
      return {
        itemId,
        title,
        currentPrice: parseFloat(currentPrice),
        targetPolicyId,
        targetPolicyName,
        status: status as "MATCH" | "NO_MATCH",
      };
    });
}

function printRangeCatalog(ranges: Map<string, PolicyRange>) {
  console.log("\nPrice-range policies in use:");
  const sorted = [...ranges.values()].sort((a, b) => a.min - b.min);
  for (const r of sorted) {
    console.log(`  ${r.policyId.padEnd(16)} ${r.name.padEnd(20)} [${r.min}, ${r.max})`);
  }
}

/** Fetch an item's title and current ShippingProfileID via GetItem, without
 * the console logging getItem() does (used for the bulk items-file path,
 * which would otherwise print 215 lines of noise). Also serves as a
 * re-confirmation that the item is still on `fromPolicyId` at report time --
 * an --items-file list can go stale between when it was scraped and when
 * this runs. */
async function fetchItemDetails(
  env: Env,
  itemId: string,
  siteId: number
): Promise<{ title: string; profileId: string } | null> {
  const xmlBody = `<?xml version="1.0" encoding="utf-8"?>
<GetItemRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <ItemID>${itemId}</ItemID>
  <DetailLevel>ReturnAll</DetailLevel>
</GetItemRequest>`;
  const xml = await callTradingApi(env, "GetItem", xmlBody, siteId);
  const ack = findText(xml, "Ack") ?? "Unknown";
  if (ack !== "Success" && ack !== "Warning") {
    return null;
  }
  return {
    title: findText(xml, "Title") ?? "",
    profileId: findText(xml, "ShippingProfileID") ?? "",
  };
}

async function migrateByPrice(
  env: Env,
  siteId: number,
  fromPolicyId: string,
  reportOut: string,
  apply: boolean,
  itemsFile: string | undefined,
  rangesFile: string | undefined
) {
  if (!apply) {
    let ranges: Map<string, PolicyRange> | undefined = rangesFile ? loadRangesFile(rangesFile) : undefined;
    let sourceItems: SourceItem[] | undefined;

    if (itemsFile) {
      // Preferred path -- see the module-level NOTE above scanActiveListings:
      // the item list comes from a UI scrape (Seller Hub filtered by
      // shippingPolicy), not a full-store API scan, since the latter is
      // capped at 25,000 entries and misses items on large stores.
      const raw = readItemsFile(itemsFile);
      console.log(`Fetching title + current policy for ${raw.length} item(s) from ${itemsFile}...`);
      sourceItems = [];
      let stale = 0;
      for (let i = 0; i < raw.length; i++) {
        const details = await fetchItemDetails(env, raw[i].itemId, siteId);
        if (!details) {
          console.log(`  WARNING: could not read item ${raw[i].itemId} (skipped)`);
          continue;
        }
        if (details.profileId !== fromPolicyId) {
          stale++;
          console.log(
            `  NOTE: item ${raw[i].itemId} is no longer on ${fromPolicyId} (now ${details.profileId}) -- skipped`
          );
          continue;
        }
        sourceItems.push({ itemId: raw[i].itemId, title: details.title, price: raw[i].price });
        if ((i + 1) % 25 === 0) console.log(`  ${i + 1}/${raw.length} checked...`);
        await sleep(PAGE_DELAY_MS);
      }
      if (stale > 0) {
        console.log(`${stale} item(s) from ${itemsFile} were already moved off ${fromPolicyId} since the scrape.`);
      }
    }

    if (!ranges || !sourceItems) {
      console.log(`Scanning all active listings for policy ${fromPolicyId}... (this can take a few minutes)`);
      console.log(`WARNING: this scan is capped at 25,000 active listings by GetMyeBaySelling and may undercount`);
      console.log(`on a larger store -- prefer --ranges-file/--items-file with UI-sourced data when possible.`);
      const scanned = await scanActiveListings(env, siteId, fromPolicyId);
      ranges = ranges ?? scanned.ranges;
      sourceItems = sourceItems ?? scanned.sourceItems;
    }

    printRangeCatalog(ranges);

    const rows = buildReport(sourceItems, ranges);
    writeReportCsv(reportOut, rows);

    const matched = rows.filter((r) => r.status === "MATCH").length;
    const noMatch = rows.length - matched;
    console.log(`\nFound ${rows.length} listing(s) on source policy ${fromPolicyId}.`);
    console.log(`  ${matched} matched a price-range policy.`);
    console.log(`  ${noMatch} did NOT match any known range (left as-is, listed in the report).`);
    console.log(`\nReport written to ${reportOut}. Review it, then re-run with --apply to move the MATCH rows.`);
    return;
  }

  if (!existsSync(reportOut)) {
    die(`ERROR: report file not found: ${reportOut}\nRun migrate-by-price without --apply first to generate it.`);
  }
  const rows = readReportCsv(reportOut).filter((r) => r.status === "MATCH");
  console.log(`Applying ${rows.length} matched move(s) from ${reportOut}...`);

  const failed: string[] = [];
  for (const row of rows) {
    const ok = await reviseItem(env, row.itemId, row.targetPolicyId, siteId, false);
    if (!ok) failed.push(row.itemId);
    await sleep(PAGE_DELAY_MS);
  }

  if (failed.length > 0) {
    console.log(`\n${failed.length} of ${rows.length} move(s) failed: ${JSON.stringify(failed)}`);
    process.exit(1);
  }
  console.log(`\nAll ${rows.length} move(s) applied successfully.`);
}

// ---- tiny argv parser (mirrors the subset of argparse actually used) ----

interface ParsedArgs {
  sandbox: boolean;
  command: "list-policies" | "check-access" | "revise-items" | "migrate-by-price";
  marketplace: string;
  itemIds: string[];
  policyId?: string;
  siteId: number;
  dryRun: boolean;
  fromPolicyId?: string;
  reportOut?: string;
  apply: boolean;
  itemsFile?: string;
  rangesFile?: string;
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
    fromPolicyId: undefined,
    reportOut: undefined,
    apply: false,
    itemsFile: undefined,
    rangesFile: undefined,
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
  if (
    command !== "list-policies" &&
    command !== "check-access" &&
    command !== "revise-items" &&
    command !== "migrate-by-price"
  ) {
    die(
      "Usage: ebay_shipping_policy_tool.ts [--sandbox] <list-policies|check-access|revise-items|migrate-by-price> [options]"
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
      case "--from-policy-id":
        args.fromPolicyId = rest[++i];
        break;
      case "--report-out":
        args.reportOut = rest[++i];
        break;
      case "--apply":
        args.apply = true;
        break;
      case "--items-file":
        args.itemsFile = rest[++i];
        break;
      case "--ranges-file":
        args.rangesFile = rest[++i];
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
  if (args.command === "migrate-by-price") {
    if (!args.fromPolicyId) die("--from-policy-id is required for migrate-by-price");
    if (!args.reportOut) die("--report-out is required for migrate-by-price");
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
  } else if (args.command === "migrate-by-price") {
    await migrateByPrice(env, args.siteId, args.fromPolicyId!, args.reportOut!, args.apply, args.itemsFile, args.rangesFile);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
