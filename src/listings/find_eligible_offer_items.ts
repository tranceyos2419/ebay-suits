#!/usr/bin/env -S npx tsx
/**
 * find_eligible_offer_items.ts -- list every active listing that eBay will let
 * us send a "Send offer to interested buyers" offer on, i.e. the listings that
 * have at least one interested buyer (watcher, or abandoned-cart buyer).
 *
 * This is the Negotiation API's findEligibleItems call:
 *   GET https://api.ebay.com/sell/negotiation/v1/find_eligible_items
 * It returns listing IDs only, so they are enriched with title / price /
 * quantity / SKU through the GraphQL Listing API's active-listing search
 * (src/lib/listing_api.ts, 100 IDs per call; skip with --no-details).
 *
 * WATCH COUNTS are not shown any more: the Modernized APIs don't return a
 * listing's watch count (the Listing API can only sort by it, and the Browse
 * API doesn't have it). So rows come in the order eBay's findEligibleItems
 * returns them, and the old --source watchers mode (GetSellerList watch-count
 * scan) is gone -- src/legacy/listings/find_eligible_offer_items.ts still has
 * both, on the Trading API.
 *
 * TOKENS -- both OAuth user tokens from src/auth/ebay_auth.ts for --account,
 * refreshed automatically (the account needs an OAuth sign-in,
 * src/auth/ebay_login.ts):
 *   findEligibleItems   scope sell.inventory (the Negotiation API has no
 *                       scope of its own)
 *   listing details     scope sell.listing
 *
 * Usage:
 *   npx tsx src/listings/find_eligible_offer_items.ts --account <name> [options]
 *
 * Options:
 *   --marketplace ID   eBay marketplace for findEligibleItems (default EBAY_US)
 *   --no-details       listing IDs only, no Listing API enrichment (fast)
 *   --csv PATH         also write a CSV (default reports/<account>-eligible-offer-items.csv)
 *   --no-csv           don't write the CSV
 *   --json PATH        also write the raw joined data as JSON
 *   --max N            stop after N eligible listings (for a quick look)
 *
 * CSV columns: ListingID, Title, Price, Currency, QuantityAvailable,
 * ListingType (FixedPriceItem / Chinese), Site (the listing's marketplace,
 * e.g. EBAY_US, EBAY_MOTORS_US, EBAY_AU), BestOfferEnabled, SKU, URL.
 *
 * Read-only: it sends no offers. Sending is a separate call
 * (sendOfferToInterestedBuyers) and is deliberately not implemented here.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { accountFromArgs, die, oauthToken } from "../auth/ebay_auth.ts";
import { csvCell } from "../lib/csv.ts";
import { listingToken, MAX_SEARCH_LISTING_IDS, searchActiveListings, type ListingInfo } from "../lib/listing_api.ts";
import { runMain, sleep } from "../lib/util.ts";

const NEGOTIATION_BASE = "https://api.ebay.com/sell/negotiation/v1";
const PAGE_LIMIT = 200; // findEligibleItems max page size
const DETAIL_DELAY_MS = 120; // be gentle between API pages
// The Negotiation API has no scope of its own; it takes sell.inventory.
const NEGOTIATION_SCOPE = "sell.inventory";

interface Options {
  marketplace: string;
  details: boolean;
  csvPath: string | undefined;
  jsonPath: string | undefined;
  max: number | undefined;
}

interface ItemDetail {
  listingId: string;
  title: string;
  price: number;
  currency: string;
  quantityAvailable: number;
  listingType: string;
  site: string;
  bestOfferEnabled: boolean;
  sku: string;
  viewUrl: string;
}

/** A row for a listing whose details are unknown. */
function blankItem(listingId: string): ItemDetail {
  return {
    listingId,
    title: "",
    price: NaN,
    currency: "",
    quantityAvailable: NaN,
    listingType: "",
    site: "",
    bestOfferEnabled: false,
    sku: "",
    viewUrl: `https://www.ebay.com/itm/${listingId}`,
  };
}

function parseArgs(account: string, argv: string[]): Options {
  const opts: Options = {
    marketplace: "EBAY_US",
    details: true,
    csvPath: `reports/${account}-eligible-offer-items.csv`,
    jsonPath: undefined,
    max: undefined,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) {
        die(`ERROR: ${arg} needs a value`);
      }
      return v;
    };
    switch (arg) {
      case "--source":
        if (next() === "negotiation") break; // the only source left
      // falls through
      case "--site":
      case "--days":
      case "--concurrency":
        die(
          `ERROR: ${arg} was for the Trading API watch-count scan, which the Modernized APIs can't do ` +
            "(no watch counts). Use src/legacy/listings/find_eligible_offer_items.ts for it."
        );
      case "--marketplace":
        opts.marketplace = next();
        break;
      case "--no-details":
        opts.details = false;
        break;
      case "--csv":
        opts.csvPath = next();
        break;
      case "--no-csv":
        opts.csvPath = undefined;
        break;
      case "--json":
        opts.jsonPath = next();
        break;
      case "--max":
        opts.max = parseInt(next(), 10);
        break;
      case "-h":
      case "--help":
        console.log("See the header comment in src/listings/find_eligible_offer_items.ts for usage.");
        process.exit(0);
      default:
        die(`ERROR: unknown argument '${arg}'`);
    }
  }
  return opts;
}

/** One page of eligible listing ids. */
async function fetchEligiblePage(
  token: string,
  marketplace: string,
  offset: number
): Promise<{ listingIds: string[]; total: number }> {
  const url = `${NEGOTIATION_BASE}/find_eligible_items?limit=${PAGE_LIMIT}&offset=${offset}`;
  const resp = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      "X-EBAY-C-MARKETPLACE-ID": marketplace,
      Accept: "application/json",
    },
  });

  const text = await resp.text();
  if (!resp.ok) {
    console.error(`ERROR ${resp.status} from find_eligible_items:\n${text}`);
    if (resp.status === 401 || resp.status === 403) {
      console.error(
        "\nThis call needs an OAuth user token granted the sell.inventory scope.\n" +
          "Check the account's sign-in with: npx tsx src/auth/ebay_auth.ts status"
      );
    }
    process.exit(1);
  }

  const body = JSON.parse(text) as {
    total?: number;
    eligibleItems?: Array<{ listingId?: string }>;
  };
  return {
    listingIds: (body.eligibleItems ?? []).map((it) => it.listingId ?? "").filter(Boolean),
    total: body.total ?? 0,
  };
}

/** Every eligible listing id, walking the pagination. */
async function fetchAllEligible(token: string, opts: Options): Promise<string[]> {
  const ids: string[] = [];
  let offset = 0;
  let total = 0;

  for (;;) {
    const page = await fetchEligiblePage(token, opts.marketplace, offset);
    if (offset === 0) {
      total = page.total;
      console.error(`eBay reports ${total} listing(s) eligible for offers to interested buyers.`);
    }
    ids.push(...page.listingIds);
    if (opts.max !== undefined && ids.length >= opts.max) return ids.slice(0, opts.max);
    if (page.listingIds.length === 0 || ids.length >= total) return ids;
    offset += PAGE_LIMIT;
    await sleep(DETAIL_DELAY_MS);
  }
}

/** Trading-style ListingType names, so the CSV keeps its old values. */
const LISTING_TYPE: Record<string, string> = { FIXED_PRICE: "FixedPriceItem", AUCTION: "Chinese" };

function toItemDetail(l: ListingInfo): ItemDetail {
  return {
    listingId: l.listingId,
    title: l.title,
    price: l.price,
    currency: l.currency,
    quantityAvailable: l.quantityAvailable,
    listingType: LISTING_TYPE[l.listingFormat] ?? l.listingFormat,
    site: l.marketplace,
    bestOfferEnabled: l.acceptBestOffer,
    sku: l.sku,
    viewUrl: `https://www.ebay.com/itm/${l.listingId}`,
  };
}

/**
 * Title / price / quantity for each listing via the Listing API's active
 * listing search, MAX_SEARCH_LISTING_IDS ids per call. Rows keep the order of
 * `listingIds`; a listing eBay doesn't return (e.g. ended since) stays blank.
 */
async function fetchItemDetails(token: string, listingIds: string[]): Promise<ItemDetail[]> {
  const found = new Map<string, ItemDetail>();
  for (let i = 0; i < listingIds.length; i += MAX_SEARCH_LISTING_IDS) {
    const batch = listingIds.slice(i, i + MAX_SEARCH_LISTING_IDS);
    for await (const l of searchActiveListings(token, { listingIds: batch })) found.set(l.listingId, toItemDetail(l));
    const done = Math.min(i + MAX_SEARCH_LISTING_IDS, listingIds.length);
    if (done % 500 === 0 || done === listingIds.length) console.error(`  ${done}/${listingIds.length}`);
    await sleep(DETAIL_DELAY_MS);
  }
  const missing = listingIds.filter((id) => !found.has(id));
  if (missing.length) console.error(`  ${missing.length} listing(s) not returned as active (details left blank): ${missing.slice(0, 10).join(" ")}${missing.length > 10 ? " ..." : ""}`);
  return listingIds.map((id) => found.get(id) ?? blankItem(id));
}

function writeCsv(path: string, rows: ItemDetail[], details: boolean): void {
  mkdirSync(dirname(path), { recursive: true });
  const header = details
    ? ["ListingID", "Title", "Price", "Currency", "QuantityAvailable", "ListingType", "Site", "BestOfferEnabled", "SKU", "URL"]
    : ["ListingID", "URL"];
  const lines = [header.join(",")];
  for (const r of rows) {
    const cells: Array<string | number | boolean> = details
      ? [r.listingId, r.title, r.price, r.currency, r.quantityAvailable, r.listingType, r.site, r.bestOfferEnabled, r.sku, r.viewUrl]
      : [r.listingId, r.viewUrl];
    lines.push(cells.map(csvCell).join(","));
  }
  writeFileSync(path, lines.join("\n") + "\n");
  console.error(`wrote ${rows.length} row(s) to ${path}`);
}

async function main() {
  const { account, rest } = accountFromArgs(process.argv.slice(2));
  const opts = parseArgs(account, rest);

  const listingIds = await fetchAllEligible(await oauthToken(account, [NEGOTIATION_SCOPE]), opts);
  if (listingIds.length === 0) {
    console.log("No listings currently have an interested buyer to send an offer to.");
    return;
  }

  let rows = listingIds.map(blankItem);
  if (opts.details) {
    console.error(`fetching details for ${listingIds.length} listing(s)...`);
    rows = await fetchItemDetails(await listingToken(account), listingIds);
  }

  for (const r of rows) {
    if (opts.details) {
      const price = Number.isNaN(r.price) ? "?" : `${r.currency} ${r.price.toFixed(2)}`;
      console.log(`${r.listingId}  ${price.padStart(12)}  ${r.title}`);
    } else {
      console.log(r.listingId);
    }
  }
  console.log(`\n${rows.length} listing(s) eligible for offers to interested buyers.`);

  if (opts.csvPath) writeCsv(opts.csvPath, rows, opts.details);
  if (opts.jsonPath) {
    mkdirSync(dirname(opts.jsonPath), { recursive: true });
    writeFileSync(opts.jsonPath, JSON.stringify(rows, null, 2) + "\n");
    console.error(`wrote JSON to ${opts.jsonPath}`);
  }
}

runMain(main);
