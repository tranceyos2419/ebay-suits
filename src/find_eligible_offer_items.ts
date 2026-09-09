#!/usr/bin/env -S npx tsx
/**
 * find_eligible_offer_items.ts -- list every active listing that eBay will let
 * us send a "Send offer to interested buyers" offer on, i.e. the listings that
 * have at least one interested buyer (watcher, or abandoned-cart buyer).
 *
 * This is the Negotiation API's findEligibleItems call:
 *   GET https://api.ebay.com/sell/negotiation/v1/find_eligible_items
 * It returns listing IDs only, so each one is optionally enriched with title /
 * price / watch count via the Trading API's GetItem (skip with --no-details).
 *
 * TOKENS -- two different ones, because these are two different APIs:
 *   EBAY_OAUTH_TOKEN     OAuth *user* access token with scope
 *                        https://api.ebay.com/oauth/api_scope/sell.negotiation
 *                        (REST call. An Auth'n'Auth token gets 403
 *                        "Insufficient permissions" here.)
 *   EBAY_ACCESS_TOKEN    Token for the Trading API GetItem enrichment -- the
 *                        Auth'n'Auth token in credentials.json works:
 *                          export EBAY_ACCESS_TOKEN=$(npx tsx src/get_token.ts jdm-direct-motors)
 *                        Falls back to EBAY_OAUTH_TOKEN if unset.
 *
 * Usage:
 *   npx tsx src/find_eligible_offer_items.ts [options]
 *
 * Options:
 *   --source WHICH     'negotiation' (default, authoritative) or 'watchers'
 *                      -- see below
 *   --marketplace ID   eBay marketplace (default EBAY_US)
 *   --site N           Trading API site id for enrichment (default 0 = US)
 *   --no-details       listing IDs only, no GetItem enrichment (fast)
 *   --csv PATH         also write a CSV (default reports/eligible-offer-items.csv)
 *   --json PATH        also write the raw joined data as JSON
 *   --max N            stop after N eligible listings (for a quick look)
 *
 * --source watchers is a stand-in that needs only the Trading API token we
 * already have: it walks GetMyeBaySelling sorted by watch count and keeps
 * active fixed-price listings that have >= 1 watcher and stock available. That
 * is the same "interested buyer" signal eBay uses, so the list is close, but it
 * is an approximation: it cannot see abandoned-cart buyers, and it does not
 * know about eBay's other exclusions (multi-variation listings, listings that
 * already have an offer out, Inventory-API-managed listings). Use
 * --source negotiation once a sell.negotiation token exists.
 *
 * Read-only: it sends no offers. Sending is a separate call
 * (sendOfferToInterestedBuyers) and is deliberately not implemented here.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { findText, findErrors, findBlocks } from "./xml_util.ts";

const NEGOTIATION_BASE = "https://api.ebay.com/sell/negotiation/v1";
const TRADING_API = "https://api.ebay.com/ws/api.dll";
const PAGE_LIMIT = 200; // findEligibleItems max page size
const DETAIL_DELAY_MS = 120; // be gentle: one GetItem per eligible listing

interface Options {
  source: "negotiation" | "watchers";
  marketplace: string;
  siteId: number;
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
  watchCount: number;
  listingType: string;
  bestOfferEnabled: boolean;
  sku: string;
  viewUrl: string;
}

function parseArgs(argv: string[]): Options {
  const opts: Options = {
    source: "negotiation",
    marketplace: "EBAY_US",
    siteId: 0,
    details: true,
    csvPath: "reports/eligible-offer-items.csv",
    jsonPath: undefined,
    max: undefined,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) {
        console.error(`ERROR: ${arg} needs a value`);
        process.exit(1);
      }
      return v;
    };
    switch (arg) {
      case "--source": {
        const v = next();
        if (v !== "negotiation" && v !== "watchers") {
          console.error("ERROR: --source must be 'negotiation' or 'watchers'");
          process.exit(1);
        }
        opts.source = v;
        break;
      }
      case "--marketplace":
        opts.marketplace = next();
        break;
      case "--site":
        opts.siteId = parseInt(next(), 10);
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
        console.log("See the header comment in src/find_eligible_offer_items.ts for usage.");
        process.exit(0);
      default:
        console.error(`ERROR: unknown argument '${arg}'`);
        process.exit(1);
    }
  }
  return opts;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Undo the XML entity escaping eBay applies to titles. */
function unescapeXml(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#0?39;/g, "'")
    .replace(/&amp;/g, "&");
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
        "\nThis call needs an OAuth *user* access token granted the scope\n" +
          "  https://api.ebay.com/oauth/api_scope/sell.negotiation\n" +
          "The Auth'n'Auth tokens in credentials.json cannot call the REST Sell APIs.\n" +
          "Mint one with src/refresh_token.ts (EBAY_SCOPES must include sell.negotiation)\n" +
          "and put it in EBAY_OAUTH_TOKEN."
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

/** Title / price / watchers for one listing, via Trading GetItem. */
async function fetchItemDetail(
  token: string,
  siteId: number,
  listingId: string
): Promise<ItemDetail> {
  const xmlBody = `<?xml version="1.0" encoding="utf-8"?>
<GetItemRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <ItemID>${listingId}</ItemID>
  <IncludeWatchCount>true</IncludeWatchCount>
  <DetailLevel>ReturnAll</DetailLevel>
</GetItemRequest>`;

  const resp = await fetch(TRADING_API, {
    method: "POST",
    headers: {
      "Content-Type": "text/xml",
      "X-EBAY-API-SITEID": String(siteId),
      "X-EBAY-API-COMPATIBILITY-LEVEL": "1193",
      "X-EBAY-API-CALL-NAME": "GetItem",
      "X-EBAY-API-IAF-TOKEN": token,
    },
    body: xmlBody,
  });

  const blank: ItemDetail = {
    listingId,
    title: "",
    price: NaN,
    currency: "",
    quantityAvailable: NaN,
    watchCount: NaN,
    listingType: "",
    bestOfferEnabled: false,
    sku: "",
    viewUrl: `https://www.ebay.com/itm/${listingId}`,
  };

  const xml = await resp.text();
  const ack = findText(xml, "Ack") ?? "Unknown";
  if (ack !== "Success" && ack !== "Warning") {
    for (const err of findErrors(xml)) {
      console.error(`  GetItem ${listingId}: ${err.severity}: ${err.short}`);
    }
    return blank;
  }

  const priceMatch = xml.match(
    /<(?:\w+:)?CurrentPrice[^>]*currencyID="([^"]*)"[^>]*>([\s\S]*?)<\/(?:\w+:)?CurrentPrice>/
  );

  return {
    listingId,
    title: unescapeXml((findText(xml, "Title") ?? "").trim()),
    price: parseFloat(priceMatch?.[2] ?? findText(xml, "CurrentPrice") ?? "NaN"),
    currency: priceMatch?.[1] ?? "",
    quantityAvailable: parseInt(findText(xml, "Quantity") ?? "NaN", 10),
    watchCount: parseInt(findText(xml, "WatchCount") ?? "NaN", 10),
    listingType: findText(xml, "ListingType") ?? "",
    bestOfferEnabled: (findText(xml, "BestOfferEnabled") ?? "").toLowerCase() === "true",
    sku: findText(xml, "SKU") ?? "",
    viewUrl: findText(xml, "ViewItemURL") ?? blank.viewUrl,
  };
}

const WATCHER_SCAN_SELECTOR = [
  "ActiveList.PaginationResult.TotalNumberOfPages",
  "ActiveList.PaginationResult.TotalNumberOfEntries",
  "ActiveList.ItemArray.Item.ItemID",
  "ActiveList.ItemArray.Item.Title",
  "ActiveList.ItemArray.Item.ListingType",
  "ActiveList.ItemArray.Item.WatchCount",
  "ActiveList.ItemArray.Item.Quantity",
  "ActiveList.ItemArray.Item.QuantityAvailable",
  "ActiveList.ItemArray.Item.SKU",
  "ActiveList.ItemArray.Item.SellingStatus.CurrentPrice",
  "ActiveList.ItemArray.Item.ListingDetails.ViewItemURL",
].join(",");

const WATCHER_PAGE_SIZE = 200; // GetMyeBaySelling max entries per page

/**
 * Trading-API stand-in for findEligibleItems: active listings sorted by watch
 * count descending, stopping at the first listing with no watchers. Only pages
 * far enough to cover the watched listings, not the whole store.
 */
async function scanWatchedListings(token: string, opts: Options): Promise<ItemDetail[]> {
  const rows: ItemDetail[] = [];
  let pageNumber = 1;

  for (;;) {
    const xmlBody = `<?xml version="1.0" encoding="utf-8"?>
<GetMyeBaySellingRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <ActiveList>
    <Include>true</Include>
    <Sort>WatchCountDescending</Sort>
    <Pagination>
      <EntriesPerPage>${WATCHER_PAGE_SIZE}</EntriesPerPage>
      <PageNumber>${pageNumber}</PageNumber>
    </Pagination>
  </ActiveList>
</GetMyeBaySellingRequest>`;

    const resp = await fetch(TRADING_API, {
      method: "POST",
      headers: {
        "Content-Type": "text/xml",
        "X-EBAY-API-SITEID": String(opts.siteId),
        "X-EBAY-API-COMPATIBILITY-LEVEL": "1193",
        "X-EBAY-API-CALL-NAME": "GetMyeBaySelling",
        "X-EBAY-API-IAF-TOKEN": token,
        "X-EBAY-API-OUTPUT-SELECTOR": WATCHER_SCAN_SELECTOR,
      },
      body: xmlBody,
    });

    const xml = await resp.text();
    const ack = findText(xml, "Ack") ?? "Unknown";
    if (ack !== "Success" && ack !== "Warning") {
      console.error(`GetMyeBaySelling page ${pageNumber}: Ack=${ack}`);
      for (const err of findErrors(xml)) console.error(`  ${err.severity}: ${err.short} -- ${err.long}`);
      process.exit(1);
    }

    if (pageNumber === 1) {
      const totalEntries = findText(xml, "TotalNumberOfEntries") ?? "?";
      console.error(`active listings reported: ${totalEntries} (paging by watch count, high to low)`);
    }

    const blocks = findBlocks(xml, "Item");
    if (blocks.length === 0) return rows;

    let sawZeroWatchers = false;
    for (const block of blocks) {
      const watchCount = parseInt(findText(block, "WatchCount") ?? "0", 10) || 0;
      if (watchCount === 0) {
        sawZeroWatchers = true;
        break; // sorted descending: everything after this has no watchers
      }
      const listingType = findText(block, "ListingType") ?? "";
      const quantity = parseInt(findText(block, "Quantity") ?? "NaN", 10);
      const availableRaw = findText(block, "QuantityAvailable");
      const available = availableRaw === undefined ? quantity : parseInt(availableRaw, 10);
      const priceMatch = block.match(
        /<(?:\w+:)?CurrentPrice[^>]*currencyID="([^"]*)"[^>]*>([\s\S]*?)<\/(?:\w+:)?CurrentPrice>/
      );
      const listingId = findText(block, "ItemID") ?? "";

      // Offers only make sense on a fixed-price listing that can still be bought.
      if (listingType !== "FixedPriceItem") continue;
      if (Number.isFinite(available) && available <= 0) continue;

      rows.push({
        listingId,
        title: unescapeXml((findText(block, "Title") ?? "").trim()),
        price: parseFloat(priceMatch?.[2] ?? "NaN"),
        currency: priceMatch?.[1] ?? "",
        quantityAvailable: available,
        watchCount,
        listingType,
        bestOfferEnabled: false, // not returned by this call
        sku: findText(block, "SKU") ?? "",
        viewUrl: findText(block, "ViewItemURL") ?? `https://www.ebay.com/itm/${listingId}`,
      });

      if (opts.max !== undefined && rows.length >= opts.max) return rows;
    }

    if (sawZeroWatchers) return rows;
    console.error(`  page ${pageNumber}: ${rows.length} watched listing(s) so far`);
    pageNumber++;
    await sleep(250);
  }
}

function csvCell(value: string | number | boolean): string {
  const s = typeof value === "number" && Number.isNaN(value) ? "" : String(value);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function writeCsv(path: string, rows: ItemDetail[], details: boolean, bestOffer: boolean): void {
  mkdirSync(dirname(path), { recursive: true });
  const header = details
    ? ["ListingID", "Title", "Price", "Currency", "WatchCount", "QuantityAvailable", "ListingType", ...(bestOffer ? ["BestOfferEnabled"] : []), "SKU", "URL"]
    : ["ListingID", "URL"];
  const lines = [header.join(",")];
  for (const r of rows) {
    const cells: Array<string | number | boolean> = details
      ? [r.listingId, r.title, r.price, r.currency, r.watchCount, r.quantityAvailable, r.listingType, ...(bestOffer ? [r.bestOfferEnabled] : []), r.sku, r.viewUrl]
      : [r.listingId, r.viewUrl];
    lines.push(cells.map(csvCell).join(","));
  }
  writeFileSync(path, lines.join("\n") + "\n");
  console.error(`wrote ${rows.length} row(s) to ${path}`);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const tradingToken = process.env.EBAY_ACCESS_TOKEN ?? process.env.EBAY_OAUTH_TOKEN;

  let rows: ItemDetail[];

  if (opts.source === "watchers") {
    if (!tradingToken) {
      console.error(
        "ERROR: set EBAY_ACCESS_TOKEN first, e.g.\n" +
          "  export EBAY_ACCESS_TOKEN=$(npx tsx src/get_token.ts jdm-direct-motors)"
      );
      process.exit(1);
    }
    rows = await scanWatchedListings(tradingToken, opts);
    if (rows.length === 0) {
      console.log("No active fixed-price listing currently has a watcher.");
      return;
    }
  } else {
    const oauthToken = process.env.EBAY_OAUTH_TOKEN ?? process.env.EBAY_ACCESS_TOKEN;
    if (!oauthToken) {
      console.error(
        "ERROR: set EBAY_OAUTH_TOKEN to an OAuth user token with the sell.negotiation scope.\n" +
          "  export EBAY_OAUTH_TOKEN=$(EBAY_SCOPES='https://api.ebay.com/oauth/api_scope/sell.negotiation' npx tsx src/refresh_token.ts)\n" +
          "Or run with --source watchers to approximate the list from watch counts."
      );
      process.exit(1);
    }

    const listingIds = await fetchAllEligible(oauthToken, opts);
    if (listingIds.length === 0) {
      console.log("No listings currently have an interested buyer to send an offer to.");
      return;
    }

    rows = listingIds.map((listingId) => ({
      listingId,
      title: "",
      price: NaN,
      currency: "",
      quantityAvailable: NaN,
      watchCount: NaN,
      listingType: "",
      bestOfferEnabled: false,
      sku: "",
      viewUrl: `https://www.ebay.com/itm/${listingId}`,
    }));

    if (opts.details) {
      console.error(`fetching details for ${listingIds.length} listing(s)...`);
      if (!tradingToken) {
        console.error("ERROR: --details needs EBAY_ACCESS_TOKEN (Trading API token) as well.");
        process.exit(1);
      }
      const detailed: ItemDetail[] = [];
      for (const [i, listingId] of listingIds.entries()) {
        detailed.push(await fetchItemDetail(tradingToken, opts.siteId, listingId));
        if ((i + 1) % 25 === 0) console.error(`  ${i + 1}/${listingIds.length}`);
        await sleep(DETAIL_DELAY_MS);
      }
      rows = detailed;
      rows.sort((a, b) => (b.watchCount || 0) - (a.watchCount || 0));
    }
  }

  const detailed = opts.details || opts.source === "watchers";
  for (const r of rows) {
    if (detailed) {
      const price = Number.isNaN(r.price) ? "?" : `${r.currency} ${r.price.toFixed(2)}`;
      const watchers = Number.isNaN(r.watchCount) ? "?" : String(r.watchCount);
      console.log(`${r.listingId}  ${watchers.padStart(4)} watchers  ${price.padStart(12)}  ${r.title}`);
    } else {
      console.log(r.listingId);
    }
  }
  console.log(
    opts.source === "watchers"
      ? `\n${rows.length} active fixed-price listing(s) with at least one watcher (approximation -- see --source negotiation).`
      : `\n${rows.length} listing(s) eligible for offers to interested buyers.`
  );

  if (opts.csvPath) writeCsv(opts.csvPath, rows, detailed, opts.source !== "watchers");
  if (opts.jsonPath) {
    mkdirSync(dirname(opts.jsonPath), { recursive: true });
    writeFileSync(opts.jsonPath, JSON.stringify(rows, null, 2) + "\n");
    console.error(`wrote JSON to ${opts.jsonPath}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
