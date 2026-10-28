#!/usr/bin/env -S npx tsx
/**
 * ebay_shipping_policy_tool.ts
 *
 * Small CLI to:
 *   1. List your eBay store's shipping (fulfillment) policies  [Account API]
 *   2. Reassign a shipping policy to specific listings  [GraphQL Listing API updateListing]
 *
 * APIs and auth
 * -------------
 * Every command needs --account <name>; tokens come from src/auth/ebay_auth.ts
 * (OAuth user tokens, refreshed automatically; the account needs an OAuth
 * sign-in first, src/auth/ebay_login.ts):
 *   - Account API (REST, scope sell.account): list-policies, swap-rate-table,
 *     and the policy NAMES shown elsewhere (the Listing API returns only a
 *     listing's policy id).
 *   - GraphQL Listing API (scope sell.listing, src/lib/listing_api.ts):
 *     reading listings (getListing / active-listing search) and changing their
 *     shipping policy (updateListing; validate-only for check-access).
 * With --sandbox, credentials.json isn't used (it holds Production tokens): put a
 * Sandbox user token (with both scopes) in EBAY_SANDBOX_TOKEN instead of
 * --account, and calls go to the Sandbox REST and GraphQL endpoints.
 *
 * Usage
 * -----
 *   # 1. See your policies and their IDs
 *   npx tsx src/listings/ebay_shipping_policy_tool.ts --account jdm-direct-motors list-policies
 *
 *   # 2. Confirm you can read listings, and that an edit WOULD succeed, without
 *   #    changing anything (uses getListing [read] + updateListing in VALIDATE mode).
 *   npx tsx src/listings/ebay_shipping_policy_tool.ts --account jdm-direct-motors check-access \
 *       --item-ids 110123456789 110987654321 \
 *       --policy-id 123456789012
 *
 *   # 3. Apply a policy to specific listings (dry run first!)
 *   npx tsx src/listings/ebay_shipping_policy_tool.ts --account jdm-direct-motors revise-items \
 *       --policy-id 123456789012 \
 *       --item-ids 110123456789 110987654321 \
 *       --dry-run
 *
 *   # Then actually apply it:
 *   npx tsx src/listings/ebay_shipping_policy_tool.ts --account jdm-direct-motors revise-items \
 *       --policy-id 123456789012 \
 *       --item-ids 110123456789 110987654321
 *
 *   # 4. Scan ALL active listings, find the ones on one or more given
 *   #    "source" policies (e.g. a generic "Express" policy, or every
 *   #    "Copy" decoy policy -- pass as many --from-policy-id values as you
 *   #    like, space-separated, in one run instead of one full-store scan
 *   #    per policy), and work out which price-range policy (a policy
 *   #    literally named "$<min> - $<max>", nothing else) each one's
 *   #    CURRENT price falls into -- not the tier implied by the source
 *   #    policy's own name, which may be stale. Writes a CSV report; makes
 *   #    NO changes to eBay.
 *   # --items-file is a scraped "itemId,price" per line list (no header) --
 *   # e.g. from the Seller Hub "active listings filtered by shippingPolicy"
 *   # page. --ranges-file is a JSON policy catalog -- see
 *   # data/policy-ranges/*.json for the format and a real example, captured
 *   # from the account's Business Policies page (bp/manage). Both flags are
 *   # optional and independent; omitting either falls back to a full-store
 *   # scan of every active listing for that part (Listing API search, read
 *   # in start-time slices to get past its 50,000-result cap; ~0.4 s per
 *   # 200 listings, so ~3-4 min on a 100k-listing store).
 *   npx tsx src/listings/ebay_shipping_policy_tool.ts --account jdm-direct-motors migrate-by-price \
 *       --from-policy-id 273300062012 272284104012 272285920012 \
 *       --report-out reports/copy-cleanup.csv \
 *       --items-file express_items.csv \
 *       --ranges-file data/policy-ranges/jdm-direct-motors.json
 *
 *   # 5. Apply the moves from a previously written report (only rows marked
 *   #    MATCH are revised; NO_MATCH rows are always left alone). No need to
 *   #    repeat --from-policy-id here -- the source policy for each row is
 *   #    read back from the report itself.
 *   npx tsx src/listings/ebay_shipping_policy_tool.ts --account jdm-direct-motors migrate-by-price \
 *       --report-out reports/copy-cleanup.csv \
 *       --apply
 *
 *   # 6. Discover every shipping policy actually in use on active listings
 *   #    (id, name, and how many scanned listings currently sit on it) --
 *   #    e.g. to find the policyId of a decoy/"Copy" policy you only know by
 *   #    name, so it can be passed as --from-policy-id above. Same full-store
 *   #    scan as migrate-by-price's fallback path. Optional --name-contains
 *   #    filters the printed list (case-insensitive substring on the policy
 *   #    name); omit it to see everything found.
 *   npx tsx src/listings/ebay_shipping_policy_tool.ts --account jdm-direct-motors scan-policies --name-contains copy
 *
 * Flags
 * -----
 *   --account        Seller account in credentials.json (required unless --sandbox).
 *   --sandbox        Use eBay Sandbox endpoints instead of Production.
 *   --marketplace    Marketplace ID for the Account API (default EBAY_US).
 *                     Listing updates always use each listing's own
 *                     marketplace (e.g. EBAY_AU), read from the listing.
 *   --site-id        Ignored (was the Trading API SiteID); kept so old
 *                     command lines still run.
 *   --from-policy-id Source fulfillment policy ID (migrate-by-price).
 *   --report-out     CSV report path (migrate-by-price).
 *   --items-file     Scraped "itemId,price" list, one per line, no header
 *                     (migrate-by-price dry-run). Omit to fall back to a
 *                     full-store scan.
 *   --ranges-file    JSON price-tier policy catalog, see
 *                     data/policy-ranges/*.json (migrate-by-price dry-run).
 *                     Omit to fall back to discovering ranges from a listing
 *                     scan instead (won't find a catch-all tier with a name
 *                     that isn't "$min - $max", e.g. a "MAX" policy).
 *   --apply          Apply moves from an existing report instead of scanning
 *                     and writing a fresh dry-run report (migrate-by-price).
 *   --name-contains  Case-insensitive substring filter on policy name
 *                     (scan-policies).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { accountFromArgs, die, oauthToken } from "../auth/ebay_auth.ts";
import { csvCell, parseCsv } from "../lib/csv.ts";
import { useGraphqlSandbox } from "../lib/graphql_api.ts";
import {
  countActiveListings,
  getListing,
  listingToken,
  MAX_SEARCH_RESULTS,
  searchActiveListings,
  updateShippingPolicy,
  type UpdateResult,
} from "../lib/listing_api.ts";
import { runMain, sleep } from "../lib/util.ts";

type Env = "prod" | "sandbox";

const ACCOUNT_API_HOST: Record<Env, string> = {
  prod: "https://api.ebay.com",
  sandbox: "https://api.sandbox.ebay.com",
};
const ACCOUNT_API_SCOPE = "sell.account";

/** Seller account from --account; set once in main(). */
let account = "";

function sandboxToken(): string {
  return process.env.EBAY_SANDBOX_TOKEN ?? die("ERROR: --sandbox needs a Sandbox user token in EBAY_SANDBOX_TOKEN.");
}

/** OAuth user token for the Account API (REST). */
async function accountApiToken(env: Env): Promise<string> {
  return env === "sandbox" ? sandboxToken() : oauthToken(account, [ACCOUNT_API_SCOPE]);
}

/** OAuth user token for the GraphQL Listing API. */
async function listingApiToken(env: Env): Promise<string> {
  return env === "sandbox" ? sandboxToken() : listingToken(account);
}

/** Fetch every fulfillment policy for a marketplace via the Account API
 * (GET /sell/account/v1/fulfillment_policy) -- the full representation for
 * each policy, including shippingOptions/rateTableId, not just id+name. */
async function getAllFulfillmentPolicies(env: Env, marketplaceId: string): Promise<any[]> {
  const host = ACCOUNT_API_HOST[env];
  const url = `${host}/sell/account/v1/fulfillment_policy?marketplace_id=${marketplaceId}`;
  const resp = await fetch(url, {
    headers: {
      Authorization: `Bearer ${await accountApiToken(env)}`,
      Accept: "application/json",
    },
  });
  if (!resp.ok) {
    const body = await resp.text();
    console.error(`ERROR ${resp.status} fetching policies:\n${body}`);
    process.exit(1);
  }
  const data = (await resp.json()) as { fulfillmentPolicies?: any[] };
  return data.fulfillmentPolicies ?? [];
}

/** PUT a full fulfillment policy body back (Account API updateFulfillmentPolicy). */
async function updateFulfillmentPolicy(
  env: Env,
  policyId: string,
  body: unknown
): Promise<{ ok: boolean; status: number; text: string }> {
  const host = ACCOUNT_API_HOST[env];
  const url = `${host}/sell/account/v1/fulfillment_policy/${policyId}`;
  const resp = await fetch(url, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${await accountApiToken(env)}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(body),
  });
  const text = await resp.text();
  return { ok: resp.ok, status: resp.status, text };
}

/** Swap a rate table (e.g. an international-shipping rate table like "EU -
 * Expedited") for another (e.g. "EU - Customs + Mexico") across every
 * fulfillment policy on the account that currently references it. Reads the
 * live policy list from the Account API, edits only the matching
 * shippingOptions[].rateTableId field in each affected policy, and PUTs the
 * full policy back -- everything else about the policy (shipping services,
 * costs, handling time, regions) is left untouched. */
async function swapRateTable(
  env: Env,
  marketplaceId: string,
  fromRateTableId: string,
  toRateTableId: string,
  dryRun: boolean
) {
  console.log(`Fetching fulfillment policies for ${marketplaceId}...`);
  const policies = await getAllFulfillmentPolicies(env, marketplaceId);
  const toUpdate = policies.filter((p) =>
    (p.shippingOptions ?? []).some((o: any) => o.rateTableId === fromRateTableId)
  );

  console.log(`${policies.length} total polic(y/ies); ${toUpdate.length} use rate table ${fromRateTableId}.\n`);

  const results: Array<{ name: string; id: string; ok: boolean }> = [];
  for (const p of toUpdate) {
    const updated = JSON.parse(JSON.stringify(p));
    for (const opt of updated.shippingOptions ?? []) {
      if (opt.rateTableId === fromRateTableId) opt.rateTableId = toRateTableId;
    }
    const { fulfillmentPolicyId, ...body } = updated;

    if (dryRun) {
      console.log(`[DRY RUN] Would update "${p.name}" (${fulfillmentPolicyId}) -> rateTableId ${toRateTableId}`);
      continue;
    }

    const result = await updateFulfillmentPolicy(env, fulfillmentPolicyId, body);
    console.log(`"${p.name}" (${fulfillmentPolicyId}): ${result.ok ? "OK" : `FAILED (${result.status})`}`);
    if (!result.ok) console.log(`  ${result.text}`);
    results.push({ name: p.name, id: fulfillmentPolicyId, ok: result.ok });
    await sleep(PAGE_DELAY_MS);
  }

  if (!dryRun) {
    const failed = results.filter((r) => !r.ok);
    console.log(`\n${results.length - failed.length}/${results.length} polic(y/ies) updated successfully.`);
    if (failed.length > 0) {
      console.log(`Failed: ${failed.map((f) => `${f.name} (${f.id})`).join(", ")}`);
      process.exit(1);
    }
  }
}

async function listPolicies(env: Env, marketplaceId: string) {
  const host = ACCOUNT_API_HOST[env];
  const url = `${host}/sell/account/v1/fulfillment_policy?marketplace_id=${marketplaceId}`;
  const resp = await fetch(url, {
    headers: {
      Authorization: `Bearer ${await accountApiToken(env)}`,
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

// ---- policy names: the Listing API returns only a listing's policy id, so
// names come from the Account API, one fetch per marketplace seen. ----

const policyNames = new Map<string, string>();
const policyMarketplacesFetched = new Set<string>();

/** Name of fulfillment policy `policyId` ("" if unknown), looking it up in
 * the policies of `marketplace` (the listing's own, e.g. EBAY_AU) on first
 * use. A failed lookup is reported once and leaves the name blank. */
async function policyName(env: Env, marketplace: string, policyId: string): Promise<string> {
  if (!policyId) return "";
  if (!policyNames.has(policyId) && marketplace && !policyMarketplacesFetched.has(marketplace)) {
    policyMarketplacesFetched.add(marketplace);
    const url = `${ACCOUNT_API_HOST[env]}/sell/account/v1/fulfillment_policy?marketplace_id=${marketplace}`;
    const resp = await fetch(url, {
      headers: { Authorization: `Bearer ${await accountApiToken(env)}`, Accept: "application/json" },
    });
    if (resp.ok) {
      const data = (await resp.json()) as { fulfillmentPolicies?: Array<{ fulfillmentPolicyId?: string; name?: string }> };
      for (const p of data.fulfillmentPolicies ?? []) {
        if (p.fulfillmentPolicyId) policyNames.set(p.fulfillmentPolicyId, (p.name ?? "").trim());
      }
    } else {
      console.error(`WARNING: could not read ${marketplace} policy names (HTTP ${resp.status}); names left blank.`);
    }
  }
  return policyNames.get(policyId) ?? "";
}

// ---- reading listings and moving them to a policy (GraphQL Listing API) ----

/** The updateListing input that moves a listing to a shipping policy (for --dry-run output). */
function updateListingInput(itemId: string, policyId: string, marketplace: string) {
  return {
    listingIdentifier: { listingId: itemId },
    marketplace,
    listingTerms: { fulfillmentTerms: { shippingTerms: { businessPolicy: { businessPolicyId: policyId } } } },
  };
}

/** Trading-style Ack for an update result, to keep the old output format. */
function ackOf(r: UpdateResult): string {
  return !r.ok ? "Failure" : r.warnings.length ? "Warning" : "Success";
}

/** Print an update's warnings/errors; true unless there was an error. */
function printUpdateMessages(r: UpdateResult): boolean {
  for (const w of r.warnings) console.log(`  [Warning] ${w}`);
  for (const e of r.errors) console.log(`  [Error] ${e.trim()}`);
  return r.ok;
}

/** Move one listing to `policyId` -- or, with validateOnly, ask eBay whether
 * that WOULD succeed without applying it. Reads the listing first for its
 * marketplace (updates must name it). */
async function updateItemPolicy(
  env: Env,
  itemId: string,
  policyId: string,
  validateOnly: boolean
): Promise<UpdateResult> {
  const token = await listingApiToken(env);
  const listing = await getListing(token, itemId);
  if (!listing) return { ok: false, errors: [`listing ${itemId} not found (wrong ID, not ours, or no longer available)`], warnings: [] };
  return updateShippingPolicy(token, itemId, policyId, { validateOnly, marketplace: listing.marketplace || "EBAY_US" });
}

async function reviseItem(env: Env, itemId: string, policyId: string, dryRun: boolean): Promise<boolean> {
  if (dryRun) {
    console.log(`[DRY RUN] Would revise Item ${itemId} -> ShippingProfileID ${policyId}`);
    console.log(`updateListing input: ${JSON.stringify(updateListingInput(itemId, policyId, "<listing's marketplace>"))}`);
    console.log();
    return true;
  }

  const r = await updateItemPolicy(env, itemId, policyId, false);
  console.log(`Item ${itemId}: Ack=${ackOf(r)}`);
  return printUpdateMessages(r);
}

/** Read-only: fetch an item's title and current shipping profile. Proves read access. */
async function getItem(env: Env, itemId: string): Promise<string | null> {
  let listing;
  try {
    listing = await getListing(await listingApiToken(env), itemId);
  } catch (err) {
    console.log(`  READ  Item ${itemId}: Ack=Failure (could not read this item)`);
    console.log(`  [Error] ${(err as Error).message}`);
    return null;
  }
  if (!listing) {
    console.log(`  READ  Item ${itemId}: Ack=Failure (could not read this item)`);
    console.log(`  [Error] not found (wrong ID, not ours, or no longer available)`);
    return null;
  }
  const title = listing.title || "(no title)";
  const currentProfileId = listing.shippingPolicyId || "(none)";
  const currentProfileName = await policyName(env, listing.marketplace, listing.shippingPolicyId);
  console.log(`  READ  Item ${itemId}: "${title}" -- current ShippingProfileID=${currentProfileId} (${currentProfileName})`);
  return currentProfileId;
}

/** Validate-only: ask eBay whether this revision WOULD succeed, without applying it. */
async function verifyReviseItem(env: Env, itemId: string, policyId: string): Promise<boolean> {
  const r = await updateItemPolicy(env, itemId, policyId, true);
  console.log(`  VERIFY Item ${itemId} -> ShippingProfileID ${policyId}: Ack=${ackOf(r)} (no change was made)`);
  return printUpdateMessages(r);
}

async function checkAccess(env: Env, itemIds: string[], policyId: string | undefined) {
  console.log("Checking read access (getListing) and, if --policy-id given, edit capability (updateListing, validate-only)...\n");
  let allOk = true;
  for (const itemId of itemIds) {
    const currentProfileId = await getItem(env, itemId);
    if (currentProfileId === null) {
      allOk = false;
      continue;
    }
    if (policyId) {
      const ok = await verifyReviseItem(env, itemId, policyId);
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
// NOTE on approach: this used to page Trading GetMyeBaySelling for the item
// list and the policy catalog, which hard-caps at 25,000 entries -- on
// jdm-direct-motors it found only 78-80 of a source policy's 215 listings.
// The Listing API's active-listing search caps one search at 50,000 results,
// so scanStore reads the store in start-time slices below that; the
// full-store scan (scanActiveListings) then sees every active listing.
//
// The two optional inputs still work and skip that scan:
//   - --ranges-file: the price-tier catalog as a small JSON file (see
//     loadRangesFile and data/policy-ranges/*.json, captured from the
//     account's Business Policies page at bp/manage). Recommended anyway: a
//     scan can't discover a catch-all tier like "MAX" (see below).
//   - --items-file: the source-policy item list (itemId,price per line, e.g.
//     scraped from the Seller Hub "active listings filtered by
//     shippingPolicy" page -- see readItemsFile).
// Each --items-file item is re-read (getListing) for its title and to confirm
// it's still on a source policy; moves are applied with updateListing.

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
  sourcePolicyId: string;
  sourcePolicyName: string;
}

interface ReportRow {
  itemId: string;
  title: string;
  currentPrice: number;
  sourcePolicyId: string;
  sourcePolicyName: string;
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
 * later via getListing. */
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

interface ScannedListing {
  itemId: string;
  title: string;
  price: number;
  profileId: string;
  profileName: string;
}

// A single search stops at MAX_SEARCH_RESULTS (50,000) listings, so the store
// is cut into start-time slices small enough to page through completely.
const SLICE_TARGET = 40_000;
const SCAN_FROM = Date.parse("2000-01-01T00:00:00Z");

type TimeSlice = { from: string; to: string; count: number };

/** Disjoint [from, to) start-time slices covering every active listing, each
 * holding at most SLICE_TARGET of them (bisecting until they fit). */
async function startTimeSlices(token: string, from: number, to: number, count?: number): Promise<{ slices: TimeSlice[]; total: number }> {
  const range = { from: new Date(from).toISOString(), to: new Date(to).toISOString() };
  const n = count ?? (await countActiveListings(token, { startAtRange: range }));
  if (n === 0) return { slices: [], total: 0 };
  if (n <= SLICE_TARGET || to - from < 60_000) {
    if (n > MAX_SEARCH_RESULTS) console.log(`WARNING: ${n} listings started within one minute; only ${MAX_SEARCH_RESULTS} can be read.`);
    return { slices: [{ ...range, count: n }], total: n };
  }
  const mid = Math.floor((from + to) / 2);
  const left = await startTimeSlices(token, from, mid);
  const right = await startTimeSlices(token, mid, to, n - left.total);
  return { slices: [...left.slices, ...right.slices], total: left.total + right.total };
}

/** Every active listing once (Listing API search, by start-time slice, LISTING_ID
 * order within each), with its price and current shipping policy id/name,
 * printing progress per page of 200. */
async function* scanStore(env: Env, progress: () => string): AsyncGenerator<ScannedListing> {
  const token = await listingApiToken(env);
  const { slices, total } = await startTimeSlices(token, SCAN_FROM, Date.now() + 86_400_000);
  const pages = Math.max(1, slices.reduce((sum, sl) => sum + Math.ceil(sl.count / 200), 0));
  console.log(`  ${total} active listing(s), read in ${slices.length} start-time slice(s) of <= ${SLICE_TARGET}`);

  const seenIds = new Set<string>();
  let page = 0;
  for (const slice of slices) {
    const onPage = () => console.log(`  page ${++page}/${pages}, ${progress()}`);
    const listings = searchActiveListings(token, { startAtRange: { from: slice.from, to: slice.to } }, onPage, { sort: { field: "LISTING_ID", order: "ASC" } });
    for await (const l of listings) {
      // Skip a listing seen before, should pages or slices ever overlap.
      if (seenIds.has(l.listingId)) continue;
      seenIds.add(l.listingId);
      yield {
        itemId: l.listingId,
        title: l.title,
        price: l.price,
        profileId: l.shippingPolicyId,
        profileName: await policyName(env, l.marketplace, l.shippingPolicyId),
      };
    }
  }
}

const PAGE_DELAY_MS = 250;

/** Scan every active listing once: collect the price-range policy catalog
 * (from clean "$min - $max" policy names seen anywhere) and every listing
 * currently on any policy in `fromPolicyIds`. One pass covers both, since a
 * range only used by a later page must still be known before matching, and
 * covers every source policy at once rather than one full store scan per
 * source policy. */
async function scanActiveListings(
  env: Env,
  fromPolicyIds: Set<string>
): Promise<{ ranges: Map<string, PolicyRange>; sourceItems: SourceItem[] }> {
  const ranges = new Map<string, PolicyRange>();
  const sourceItemsById = new Map<string, SourceItem>();

  for await (const item of scanStore(env, () => `${sourceItemsById.size} source-policy item(s) so far`)) {
    const m = PRICE_RANGE_RE.exec(item.profileName);
    if (m && !ranges.has(item.profileId)) {
      ranges.set(item.profileId, {
        policyId: item.profileId,
        name: item.profileName,
        min: parseFloat(m[1].replace(/,/g, "")),
        max: parseFloat(m[2].replace(/,/g, "")),
      });
    }
    if (fromPolicyIds.has(item.profileId)) {
      sourceItemsById.set(item.itemId, {
        itemId: item.itemId,
        title: item.title,
        price: item.price,
        sourcePolicyId: item.profileId,
        sourcePolicyName: item.profileName,
      });
    }
  }

  // NOTE: a catch-all tier above the top "$min - $max" policy (e.g. a "MAX"
  // policy for anything over $1,000) can never be discovered this way -- by
  // definition it doesn't follow the pure-range name pattern, and it may have
  // zero listings on it yet. Pass --ranges-file with such a tier included
  // (max: null in the JSON) if the account has one; see loadRangesFile.

  return { ranges, sourceItems: [...sourceItemsById.values()] };
}

/** Full-store scan (same as scanActiveListings) that records EVERY distinct
 * shipping policy id/name pair seen, with how many active listings currently
 * sit on it -- unlike scanActiveListings, which only keeps names matching the
 * clean price-range pattern. Used by scan-policies to find a policy's id from
 * its name (e.g. a "Copy" decoy policy) without visiting the Business
 * Policies page. */
async function scanAllPolicies(env: Env): Promise<Map<string, { name: string; count: number }>> {
  const seen = new Map<string, { name: string; count: number }>();
  for await (const item of scanStore(env, () => `${seen.size} distinct polic(y/ies) so far`)) {
    const existing = seen.get(item.profileId);
    if (existing) {
      existing.count++;
    } else {
      seen.set(item.profileId, { name: item.profileName, count: 1 });
    }
  }
  return seen;
}

async function scanPolicies(env: Env, nameContains: string | undefined) {
  console.log(`Scanning all active listings for distinct shipping policies... (this can take a few minutes)`);
  const seen = await scanAllPolicies(env);

  const needle = nameContains?.toLowerCase();
  const rows = [...seen.entries()]
    .map(([policyId, { name, count }]) => ({ policyId, name, count }))
    .filter((r) => !needle || r.name.toLowerCase().includes(needle))
    .sort((a, b) => b.count - a.count);

  console.log();
  if (nameContains) {
    console.log(`Policies with "${nameContains}" in the name (${rows.length} of ${seen.size} distinct polic(y/ies)):`);
  } else {
    console.log(`${rows.length} distinct polic(y/ies) found:`);
  }
  console.log(`${"Policy ID".padEnd(16)} ${"Scanned listing count".padEnd(22)} Name`);
  console.log("-".repeat(80));
  for (const r of rows) {
    console.log(`${r.policyId.padEnd(16)} ${String(r.count).padEnd(22)} ${r.name}`);
  }
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
      sourcePolicyId: item.sourcePolicyId,
      sourcePolicyName: item.sourcePolicyName,
      targetPolicyId: match?.policyId ?? "",
      targetPolicyName: match?.name ?? "",
      status: match ? "MATCH" : "NO_MATCH",
    };
  });
}

function writeReportCsv(path: string, rows: ReportRow[]) {
  const dir = dirname(path);
  if (dir && dir !== "." && !existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  const header = "itemId,title,currentPrice,sourcePolicyId,sourcePolicyName,targetPolicyId,targetPolicyName,status";
  const lines = rows.map((r) =>
    [
      r.itemId,
      csvCell(r.title),
      r.currentPrice,
      r.sourcePolicyId,
      csvCell(r.sourcePolicyName),
      r.targetPolicyId,
      csvCell(r.targetPolicyName),
      r.status,
    ].join(",")
  );
  writeFileSync(path, [header, ...lines].join("\n") + "\n", "utf8");
}

function readReportCsv(path: string): ReportRow[] {
  const [, ...rows] = parseCsv(readFileSync(path, "utf8"));
  return rows.map(([itemId, title, currentPrice, sourcePolicyId, sourcePolicyName, targetPolicyId, targetPolicyName, status]) => ({
    itemId,
    title,
    currentPrice: parseFloat(currentPrice),
    sourcePolicyId,
    sourcePolicyName,
    targetPolicyId,
    targetPolicyName,
    status: status as "MATCH" | "NO_MATCH",
  }));
}

function printRangeCatalog(ranges: Map<string, PolicyRange>) {
  console.log("\nPrice-range policies in use:");
  const sorted = [...ranges.values()].sort((a, b) => a.min - b.min);
  for (const r of sorted) {
    console.log(`  ${r.policyId.padEnd(16)} ${r.name.padEnd(20)} [${r.min}, ${r.max})`);
  }
}

/** Fetch an item's title and current shipping profile id/name via getListing,
 * without the console logging getItem() does (used for the bulk items-file
 * path, which would otherwise print 215 lines of noise). Also serves as a
 * re-confirmation that the item is still on one of the source policies at
 * report time -- an --items-file list can go stale between when it was
 * scraped and when this runs. */
async function fetchItemDetails(
  env: Env,
  itemId: string
): Promise<{ title: string; profileId: string; profileName: string } | null> {
  let listing;
  try {
    listing = await getListing(await listingApiToken(env), itemId);
  } catch {
    return null;
  }
  if (!listing) return null;
  return {
    title: listing.title,
    profileId: listing.shippingPolicyId,
    profileName: await policyName(env, listing.marketplace, listing.shippingPolicyId),
  };
}

async function migrateByPrice(
  env: Env,
  fromPolicyIds: string[],
  reportOut: string,
  apply: boolean,
  itemsFile: string | undefined,
  rangesFile: string | undefined
) {
  if (!apply) {
    const fromPolicyIdSet = new Set(fromPolicyIds);
    let ranges: Map<string, PolicyRange> | undefined = rangesFile ? loadRangesFile(rangesFile) : undefined;
    let sourceItems: SourceItem[] | undefined;

    if (itemsFile) {
      // The item list comes from a UI scrape (Seller Hub filtered by
      // shippingPolicy) -- quicker than a full-store scan on a big store.
      const raw = readItemsFile(itemsFile);
      console.log(`Fetching title + current policy for ${raw.length} item(s) from ${itemsFile}...`);
      sourceItems = [];
      let stale = 0;
      for (let i = 0; i < raw.length; i++) {
        const details = await fetchItemDetails(env, raw[i].itemId);
        if (!details) {
          console.log(`  WARNING: could not read item ${raw[i].itemId} (skipped)`);
          continue;
        }
        if (!fromPolicyIdSet.has(details.profileId)) {
          stale++;
          console.log(
            `  NOTE: item ${raw[i].itemId} is no longer on a source policy (now ${details.profileId}) -- skipped`
          );
          continue;
        }
        sourceItems.push({
          itemId: raw[i].itemId,
          title: details.title,
          price: raw[i].price,
          sourcePolicyId: details.profileId,
          sourcePolicyName: details.profileName,
        });
        if ((i + 1) % 25 === 0) console.log(`  ${i + 1}/${raw.length} checked...`);
        await sleep(PAGE_DELAY_MS);
      }
      if (stale > 0) {
        console.log(`${stale} item(s) from ${itemsFile} were already moved off their source policy since the scrape.`);
      }
    }

    if (!ranges || !sourceItems) {
      console.log(`Scanning all active listings for ${fromPolicyIds.length} source polic(y/ies)... (this can take a few minutes)`);
      const scanned = await scanActiveListings(env, fromPolicyIdSet);
      ranges = ranges ?? scanned.ranges;
      sourceItems = sourceItems ?? scanned.sourceItems;
    }

    printRangeCatalog(ranges);

    const rows = buildReport(sourceItems, ranges);
    writeReportCsv(reportOut, rows);

    const matched = rows.filter((r) => r.status === "MATCH").length;
    const noMatch = rows.length - matched;
    console.log(`\nFound ${rows.length} listing(s) across ${fromPolicyIds.length} source polic(y/ies).`);
    console.log(`  ${matched} matched a price-range policy.`);
    console.log(`  ${noMatch} did NOT match any known range (left as-is, listed in the report).`);

    const bySource = new Map<string, number>();
    for (const r of rows) {
      bySource.set(r.sourcePolicyName, (bySource.get(r.sourcePolicyName) ?? 0) + 1);
    }
    console.log(`\nBy source policy:`);
    for (const [name, count] of [...bySource.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${String(count).padEnd(6)} ${name}`);
    }

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
    const ok = await reviseItem(env, row.itemId, row.targetPolicyId, false);
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
  command: "list-policies" | "check-access" | "revise-items" | "migrate-by-price" | "scan-policies" | "swap-rate-table";
  marketplace: string;
  itemIds: string[];
  policyId?: string;
  dryRun: boolean;
  fromPolicyIds: string[];
  reportOut?: string;
  apply: boolean;
  itemsFile?: string;
  rangesFile?: string;
  nameContains?: string;
  fromRateTableId?: string;
  toRateTableId?: string;
}

function parseArgs(argv: string[]): ParsedArgs {
  const args: ParsedArgs = {
    sandbox: false,
    command: "list-policies",
    marketplace: "EBAY_US",
    itemIds: [],
    policyId: undefined,
    dryRun: false,
    fromPolicyIds: [],
    reportOut: undefined,
    apply: false,
    itemsFile: undefined,
    rangesFile: undefined,
    nameContains: undefined,
    fromRateTableId: undefined,
    toRateTableId: undefined,
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
    command !== "migrate-by-price" &&
    command !== "scan-policies" &&
    command !== "swap-rate-table"
  ) {
    die(
      "Usage: ebay_shipping_policy_tool.ts (--account <name> | --sandbox) <list-policies|check-access|revise-items|migrate-by-price|scan-policies|swap-rate-table> [options]"
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
        i++; // ignored: listing updates use each listing's own marketplace
        break;
      case "--dry-run":
        args.dryRun = true;
        break;
      case "--from-policy-id": {
        const ids: string[] = [];
        while (rest[i + 1] && !rest[i + 1].startsWith("--")) {
          ids.push(rest[++i]);
        }
        args.fromPolicyIds = ids;
        break;
      }
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
      case "--name-contains":
        args.nameContains = rest[++i];
        break;
      case "--from-rate-table-id":
        args.fromRateTableId = rest[++i];
        break;
      case "--to-rate-table-id":
        args.toRateTableId = rest[++i];
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
    if (!args.apply && args.fromPolicyIds.length === 0) {
      die("--from-policy-id (one or more ids) is required for migrate-by-price (unless --apply)");
    }
    if (!args.reportOut) die("--report-out is required for migrate-by-price");
  }
  if (args.command === "swap-rate-table") {
    if (!args.fromRateTableId) die("--from-rate-table-id is required for swap-rate-table");
    if (!args.toRateTableId) die("--to-rate-table-id is required for swap-rate-table");
  }

  return args;
}

async function main() {
  const argv = process.argv.slice(2);
  let rest = argv;
  if (!argv.includes("--sandbox")) ({ account, rest } = accountFromArgs(argv));
  const args = parseArgs(rest);
  const env: Env = args.sandbox ? "sandbox" : "prod";
  useGraphqlSandbox(env === "sandbox");

  if (args.command === "list-policies") {
    await listPolicies(env, args.marketplace);
  } else if (args.command === "check-access") {
    await checkAccess(env, args.itemIds, args.policyId);
  } else if (args.command === "revise-items") {
    const results: Array<[string, boolean]> = [];
    for (const itemId of args.itemIds) {
      const ok = await reviseItem(env, itemId, args.policyId!, args.dryRun);
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
    await migrateByPrice(env, args.fromPolicyIds, args.reportOut!, args.apply, args.itemsFile, args.rangesFile);
  } else if (args.command === "scan-policies") {
    await scanPolicies(env, args.nameContains);
  } else if (args.command === "swap-rate-table") {
    await swapRateTable(env, args.marketplace, args.fromRateTableId!, args.toRateTableId!, args.dryRun);
  }
}

runMain(main);
