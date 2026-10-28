/**
 * listing_api.ts -- our own listings through eBay's GraphQL Listing API
 * (replaces Trading GetItem / GetSellerList / GetMyeBaySelling / ReviseItem /
 * ReviseInventoryStatus). Needs the sell.listing OAuth scope.
 *
 * Only the seller's own listings can be read here; for another seller's
 * listing use the Browse API (src/lib/browse_api.ts).
 */

import { oauthToken } from "../auth/ebay_auth.ts";
import { formatError, graphqlCall, graphqlCallOrThrow, LISTING_SCOPE } from "./graphql_api.ts";

export function listingToken(account: string): Promise<string> {
  return oauthToken(account, [LISTING_SCOPE]);
}

export interface ListingInfo {
  listingId: string;
  /** "SingleSkuListing" or "VariationListing". */
  kind: string;
  title: string;
  /** Listing-level SKU (variation listings), else the single item's SKU. */
  sku: string;
  /** The lowest item price (the only price for a single-SKU listing). */
  price: number;
  currency: string;
  /** Total available across all items. */
  quantityAvailable: number;
  quantitySold: number;
  imageUrls: string[];
  shippingPolicyId: string;
  acceptBestOffer: boolean;
  /** e.g. FIXED_PRICE, AUCTION */
  listingFormat: string;
  /** e.g. ACTIVE, ENDED, SCHEDULED */
  listingStatus: string;
  /** e.g. GTC, DAYS_7 */
  listingDuration: string;
  startAt: string;
  marketplace: string;
  items: { itemId: string; sku: string; price: number; quantityAvailable: number; quantitySold: number }[];
}

const LISTING_FIELDS = `
  listingId marketplace
  sellerProduct { title images { ebayImageUrl order } }
  items { itemId sku itemTerms {
    availability { quantityAvailable quantitySold }
    pricingTerms { fixedPrice { original { value currency } } } } }
  listingTerms {
    listingFormat totalQuantityAvailable
    bestOfferTerms { acceptBestOffer }
    lifecycleTerms { listingStatus listingDurationInDays startAt }
    listingFulfillmentTerms { shippingTerms { shippingBusinessPolicy { businessPolicy { businessPolicyId } } } }
  }`;

const LISTING_FRAGMENT = `
  __typename
  ... on SingleSkuListing { ${LISTING_FIELDS} }
  ... on VariationListing { sku ${LISTING_FIELDS} }`;

function toListingInfo(l: any): ListingInfo {
  const items = (l.items ?? []).map((i: any) => ({
    itemId: String(i.itemId ?? ""),
    sku: i.sku ?? "",
    price: Number(i.itemTerms?.pricingTerms?.fixedPrice?.original?.value ?? NaN),
    currency: i.itemTerms?.pricingTerms?.fixedPrice?.original?.currency ?? "",
    quantityAvailable: Number(i.itemTerms?.availability?.quantityAvailable ?? 0),
    quantitySold: Number(i.itemTerms?.availability?.quantitySold ?? 0),
  }));
  const prices = items.map((i: any) => i.price).filter((p: number) => Number.isFinite(p));
  const t = l.listingTerms ?? {};
  return {
    listingId: String(l.listingId),
    kind: l.__typename,
    title: l.sellerProduct?.title ?? "",
    sku: l.sku ?? items[0]?.sku ?? "",
    price: prices.length ? Math.min(...prices) : NaN,
    currency: items.find((i: any) => i.currency)?.currency ?? "",
    quantityAvailable: t.totalQuantityAvailable ?? items.reduce((n: number, i: any) => n + i.quantityAvailable, 0),
    quantitySold: items.reduce((n: number, i: any) => n + i.quantitySold, 0),
    imageUrls: [...(l.sellerProduct?.images ?? [])]
      .sort((a: any, b: any) => (a.order ?? 0) - (b.order ?? 0))
      .map((i: any) => i.ebayImageUrl)
      .filter(Boolean),
    shippingPolicyId: String(t.listingFulfillmentTerms?.shippingTerms?.shippingBusinessPolicy?.businessPolicy?.businessPolicyId ?? ""),
    acceptBestOffer: t.bestOfferTerms?.acceptBestOffer === true,
    listingFormat: t.listingFormat ?? "",
    listingStatus: t.lifecycleTerms?.listingStatus ?? "",
    listingDuration: t.lifecycleTerms?.listingDurationInDays ?? "",
    startAt: t.lifecycleTerms?.startAt ?? "",
    marketplace: l.marketplace ?? "",
    items: items.map(({ currency, ...rest }: any) => rest),
  };
}

const GET_LISTING = `query($id: ID!) { sellerListings(input:{listings:[{listingId:$id}]}) {
  __typename
  ... on ListingsSuccess { listings { __typename ... on ListingSuccess { listingId listing { ${LISTING_FRAGMENT} } } } }
} }`;

/** One of our listings, or undefined when eBay doesn't return it (wrong ID,
 * not ours, or no longer available). Throws on a request error. */
export async function getListing(token: string, listingId: string): Promise<ListingInfo | undefined> {
  const d = await graphqlCallOrThrow(token, GET_LISTING, { id: listingId });
  const listing = d.sellerListings?.listings?.[0]?.listing;
  return listing?.listingId ? toListingInfo(listing) : undefined;
}

export interface ListingSearchFilters {
  listingIds?: string[];
  skus?: string[];
  /** ISO times: listings ending in [from, to). */
  endAtRange?: { from: string; to: string };
  startAtRange?: { from: string; to: string };
  formatType?: "FIXED_PRICE" | "AUCTION";
}

const SEARCH_ACTIVE = `query($input: SellerActiveListingSearchInput) { sellerListingSearch {
  activeListings(searchInput: $input) {
    __typename
    ... on SellerListings { pagination { nextCursor totalElements } listings { listingId listing { ${LISTING_FRAGMENT} } } }
    ... on SellerListingSearchInvalidInput { errorCode errorMessage }
  } } }`;

function dateRange(r?: { from: string; to: string }) {
  return r ? { startAt: r.from, endAt: r.to } : undefined;
}

/** One active-listing search returns at most this many listings (paging
 * stops there: nextCursor comes back empty), so a bigger store has to be
 * searched in slices, e.g. by startAtRange -- see countActiveListings. */
export const MAX_SEARCH_RESULTS = 50_000;

const COUNT_ACTIVE = `query($input: SellerActiveListingSearchInput) { sellerListingSearch {
  activeListings(searchInput: $input) {
    __typename
    ... on SellerListings { pagination { totalElements } }
    ... on SellerListingSearchInvalidInput { errorCode errorMessage }
  } } }`;

/** How many active listings match `filters` (eBay's totalElements). */
export async function countActiveListings(token: string, filters: ListingSearchFilters = {}): Promise<number> {
  const filterInput = {
    listingIds: filters.listingIds,
    skus: filters.skus,
    endAtRange: dateRange(filters.endAtRange),
    startAtRange: dateRange(filters.startAtRange),
    formatType: filters.formatType,
  };
  const hasFilter = Object.values(filterInput).some((v) => v !== undefined);
  const input = { pagination: { maxPageSize: 1 }, ...(hasFilter ? { filters: filterInput } : {}) };
  const d = await graphqlCallOrThrow(token, COUNT_ACTIVE, { input });
  const r = d.sellerListingSearch.activeListings;
  if (r.__typename !== "SellerListings") throw new Error(`sellerListingSearch: ${r.errorCode ?? r.__typename} ${r.errorMessage ?? ""}`);
  return r.pagination?.totalElements ?? 0;
}

/** Max listing IDs eBay accepts in one search's listingIds filter. */
export const MAX_SEARCH_LISTING_IDS = 100;

/** A SellerListingSortFieldEnum value, e.g. WATCH_COUNT, LISTING_ID, END_TIME.
 * (WATCH_COUNT sorts by watchers, but the count itself isn't returned.) */
export interface ListingSearchSort {
  field: string;
  order?: "ASC" | "DESC";
}

/**
 * Every active listing matching `filters`, page by page (200 per page).
 * `onPage` gets the running count and eBay's total, for progress output.
 * `listingIds` takes at most MAX_SEARCH_LISTING_IDS ids per search.
 */
export async function* searchActiveListings(
  token: string,
  filters: ListingSearchFilters = {},
  onPage?: (fetched: number, total: number | undefined) => void,
  opts: { sort?: ListingSearchSort } = {}
): AsyncGenerator<ListingInfo> {
  const filterInput = {
    listingIds: filters.listingIds,
    skus: filters.skus,
    endAtRange: dateRange(filters.endAtRange),
    startAtRange: dateRange(filters.startAtRange),
    formatType: filters.formatType,
  };
  const hasFilter = Object.values(filterInput).some((v) => v !== undefined);
  let cursor: string | undefined;
  let fetched = 0;
  for (;;) {
    const input = cursor
      ? { pagination: { pageCursor: cursor } }
      : {
          pagination: { maxPageSize: 200 },
          ...(hasFilter ? { filters: filterInput } : {}),
          ...(opts.sort ? { sort: { field: opts.sort.field, sortOrder: opts.sort.order ?? "ASC" } } : {}),
        };
    const d = await graphqlCallOrThrow(token, SEARCH_ACTIVE, { input });
    const r = d.sellerListingSearch.activeListings;
    if (r.__typename !== "SellerListings") throw new Error(`sellerListingSearch: ${r.errorCode ?? r.__typename} ${r.errorMessage ?? ""}`);
    for (const ref of r.listings ?? []) {
      fetched++;
      if (ref.listing?.listingId) yield toListingInfo(ref.listing);
    }
    onPage?.(fetched, r.pagination?.totalElements ?? undefined);
    cursor = r.pagination?.nextCursor ?? undefined;
    if (!cursor || !r.listings?.length) return;
  }
}

// ---- updates ----------------------------------------------------------------

export interface UpdateResult {
  ok: boolean;
  /** Validation errors or request errors, one per line. */
  errors: string[];
  warnings: string[];
}

const UPDATE_LISTING = `mutation($input: UpdateListingInput!) { updateListing(input: $input) {
  __typename
  ... on UpdateListingSuccess { warnings { warningCode warningMessage } }
  ... on UpdateListingValidationSuccess { warnings { warningCode warningMessage } }
  ... on UpdateListingValidationError { errorCode errorMessage violations { violationCode violationDescription } warnings { warningCode warningMessage } }
} }`;

/**
 * Apply `changes` (an UpdateListingInput minus the identifier) to a listing.
 * `validateOnly` asks eBay to check the change without applying it.
 */
export async function updateListing(
  token: string,
  listingId: string,
  changes: { listingItems?: unknown; listingTerms?: unknown; product?: unknown },
  opts: { validateOnly?: boolean; marketplace?: string } = {}
): Promise<UpdateResult> {
  const input = {
    listingIdentifier: { listingId },
    marketplace: opts.marketplace ?? "EBAY_US",
    ...(opts.validateOnly ? { options: { operationMode: "VALIDATE" } } : {}),
    ...changes,
  };
  const r = await graphqlCall(token, UPDATE_LISTING, { input });
  if (r.errors.length || !r.data?.updateListing) {
    return { ok: false, errors: r.errors.length ? r.errors.map(formatError) : ["no response"], warnings: [] };
  }
  const u = r.data.updateListing;
  const warnings = (u.warnings ?? []).map((w: any) => `[${w.warningCode}] ${w.warningMessage}`);
  if (u.__typename === "UpdateListingValidationError") {
    const errors = (u.violations ?? []).map((v: any) => `[${v.violationCode}] ${v.violationDescription}`);
    return { ok: false, errors: errors.length ? errors : [`[${u.errorCode}] ${u.errorMessage}`], warnings };
  }
  return { ok: true, errors: [], warnings };
}

/** Set a single-SKU listing's fixed price. */
export function updatePrice(token: string, listingId: string, price: number | string, opts?: { validateOnly?: boolean }) {
  return updateListing(token, listingId, { listingItems: { items: [{ itemTerms: { pricingTerms: { fixedPrice: String(price) } } }] } }, opts);
}

/** Point a listing at another shipping (fulfillment) business policy.
 * `marketplace` must be the listing's own (ListingInfo.marketplace) for
 * listings not on EBAY_US, e.g. EBAY_AU -- else LSTNG_MARKETPLACE_MISMATCH. */
export function updateShippingPolicy(
  token: string,
  listingId: string,
  policyId: string,
  opts?: { validateOnly?: boolean; marketplace?: string }
) {
  return updateListing(token, listingId, { listingTerms: { fulfillmentTerms: { shippingTerms: { businessPolicy: { businessPolicyId: policyId } } } } }, opts);
}

const BULK_UPDATE = `mutation($input: BulkUpdateInventoryInput!) { bulkUpdateInventory(input: $input) {
  __typename
  ... on BulkUpdateInventorySuccess { successes { warnings { warningCode warningMessage } } }
  ... on BulkUpdateInventoryPartialFailure { errorCode errorMessage failures { violations { violationCode violationDescription } } }
  ... on BulkUpdateInventoryFailure { errorCode errorMessage failures { violations { violationCode violationDescription } } }
} }`;

/**
 * Set price and/or available quantity on one listing (or one SKU of a
 * variation listing). The Trading ReviseInventoryStatus replacement.
 */
export async function updateInventory(
  token: string,
  target: { listingId: string; sku?: string },
  change: { price?: number | string; quantity?: number }
): Promise<UpdateResult> {
  const input = {
    inventory: [
      {
        listingItemIdentifier: target.sku ? { listingId: target.listingId, sku: target.sku } : { listingId: target.listingId },
        ...(change.price !== undefined ? { fixedPrice: String(change.price) } : {}),
        ...(change.quantity !== undefined ? { availableQuantity: change.quantity } : {}),
      },
    ],
  };
  const r = await graphqlCall(token, BULK_UPDATE, { input });
  if (r.errors.length || !r.data?.bulkUpdateInventory) {
    return { ok: false, errors: r.errors.length ? r.errors.map(formatError) : ["no response"], warnings: [] };
  }
  const b = r.data.bulkUpdateInventory;
  const warnings = (b.successes ?? []).flatMap((s: any) => (s.warnings ?? []).map((w: any) => `[${w.warningCode}] ${w.warningMessage}`));
  if (b.__typename !== "BulkUpdateInventorySuccess") {
    const errors = (b.failures ?? []).flatMap((f: any) => f.violations.map((v: any) => `[${v.violationCode}] ${v.violationDescription}`));
    return { ok: false, errors: errors.length ? errors : [`[${b.errorCode}] ${b.errorMessage}`], warnings };
  }
  return { ok: true, errors: [], warnings };
}
