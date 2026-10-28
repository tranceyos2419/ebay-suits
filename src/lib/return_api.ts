/**
 * return_api.ts -- seller returns through eBay's GraphQL Return API
 * (`sellerOrderReturns`), which replaces the Post-Order API's /return/search
 * and /return/{id}. Needs the sell.return OAuth scope; the buyer's username
 * also needs commerce.identity.readonly.
 *
 * Quirks worth knowing:
 *   - A search takes exactly one filter preset (CLOSED, IN_PROGRESS,
 *     AWAITING_ACTION_FROM_BUYER/EBAY/SELLER). The presets don't overlap, so
 *     "every return" means one search per preset.
 *   - The date range (on the request date) may span at most ~575 days, so
 *     longer ranges are walked in WINDOW_DAYS windows.
 *   - Later pages are fetched with the cursor alone; sending the initial
 *     filter again with a cursor is rejected.
 *   - There is no "get one return by id" query; look returns up by searching.
 *   - For some old returns (seen on love-of-japan, older than ~1 year) eBay
 *     fails to resolve the order / listing behind a return line, which nulls
 *     the whole page. Such pages are re-read without those fields and the
 *     order filled in from the Fulfillment API (fillMissingOrders).
 *   - Refund amounts (`refunds`, `refundEstimate` breakdowns) need the
 *     sell.refund.read scope, which our sign-in doesn't ask for, so they are
 *     not queried here. Order line items carry no title -- use the
 *     Fulfillment API (src/lib/fulfillment_api.ts) for titles and refunds.
 */

import { IDENTITY_SCOPE, oauthToken } from "../auth/ebay_auth.ts";
import { fetchOrders } from "./fulfillment_api.ts";
import { DAY_MS, sleep } from "./util.ts";
import { formatError, graphqlCall, type GraphqlError, RETURN_SCOPE } from "./graphql_api.ts";

export const RETURN_PRESETS = [
  "AWAITING_ACTION_FROM_SELLER",
  "AWAITING_ACTION_FROM_BUYER",
  "AWAITING_ACTION_FROM_EBAY",
  "IN_PROGRESS",
  "CLOSED",
] as const;
export type ReturnPreset = (typeof RETURN_PRESETS)[number];
export const OPEN_PRESETS: ReturnPreset[] = RETURN_PRESETS.filter((p) => p !== "CLOSED");

const WINDOW_DAYS = 180;
const PAGE_SIZE = 50;
const MAX_RETRIES = 2;

export interface Money {
  value: number;
  currency: string;
}

export interface ReturnTracking {
  trackingNumber: string;
  carrier?: string;
  /** Where on the return it was found (package event or seller-provided label). */
  source: string;
  occurredAt?: string;
}

export interface ReturnLine {
  orderId: string;
  orderLineItemId: string; // the legacy transaction id
  itemId: string;
  quantity?: number;
  reasonCode: string;
  reasonText: string;
  note: string; // the buyer's comment
}

export interface ReturnRecord {
  returnId: string;
  /** The search preset the return was found under (which side it waits on). */
  preset: ReturnPreset;
  statusCode: string; // REQUESTED / OPEN / CLOSED / CANCELLED / ...
  statusText: string;
  requestedAt: string;
  closedAt?: string;
  requester: string;
  buyer: string;
  // Convenience copies of the first return line (returns are almost always one line).
  orderId: string;
  orderLineItemId: string;
  itemId: string;
  reasonCode: string;
  reasonText: string;
  note: string;
  lines: ReturnLine[];
  fulfillmentStatus?: string; // e.g. AWAITING_FULFILLMENT_INITIATION, RETURN_FULFILLMENT_COMPLETE
  offer?: { status: string; amount?: Money };
  respondBy?: { dueAt: string; action: string };
  tracking: ReturnTracking[];
}

export function returnToken(account: string): Promise<string> {
  return oauthToken(account, [RETURN_SCOPE, IDENTITY_SCOPE]);
}

const AMOUNT = `original { value currency }`;
/**
 * The return fields we read; `withOrder` adds the order (id, buyer) and the
 * listing (item id), which eBay can't resolve for some old returns.
 */
function returnFields(withOrder: boolean): string {
  return `
  returnId requestedAt closedAt requester
  status { code displayText }
  returnLineItems {
    requestedQuantity returnNote
    returnReason { code displayText }
    orderLineItem {
      orderLineItemId
      ${withOrder ? "orderReference { orderId buyer { username } }" : ""}
      ${withOrder ? "lineItem { ... on ContractListingItem { item { itemId } } }" : ""}
    }
  }
  returnNegotiation { latestReturnOffer {
    status { code }
    proposedTerm { ... on KeepItemPartialRefundTerm { refundAmount { ${AMOUNT} } } }
  } }
  sellerAvailableActions { respondByAction { responseDueAt respondAction { code } } }
  returnFulfillment {
    fulfillmentStatus { code }
    returnFulfillmentSummary { latestPackageEvents {
      __typename occurredAt
      ... on ReturnShipmentTrackingEvent { tracking { trackingNumber shippingCarrier { carrierCode unsupportedCarrierName } } }
    } }
    sellerFulfillmentInitiation { provisionedLabels { returnLabels { trackingNumber shippingCarrier { carrierCode unsupportedCarrierName } } } }
  }`;
}

function searchQuery(withOrder: boolean): string {
  return `query SellerReturns($input: SellerOrderReturnsInput!) {
  sellerOrderReturns(input: $input) {
    __typename
    ... on BusinessError { errorCode errorMessage }
    ... on SellerOrderReturns { pagination { nextCursor } orderReturns { ${returnFields(withOrder)} } }
  }
}`;
}
const FULL_QUERY = searchQuery(true);
const NO_ORDER_QUERY = searchQuery(false);

function money(a: any): Money | undefined {
  const o = a?.original;
  if (o?.value == null) return undefined;
  return { value: Number(o.value), currency: o.currency ?? "" };
}

function carrierName(c: any): string | undefined {
  return c?.unsupportedCarrierName || c?.carrierCode || undefined;
}

function toRecord(r: any, preset: ReturnPreset): ReturnRecord {
  const lines: ReturnLine[] = (r.returnLineItems ?? []).map((l: any) => ({
    orderId: l.orderLineItem?.orderReference?.orderId ?? "",
    orderLineItemId: l.orderLineItem?.orderLineItemId ?? "",
    itemId: l.orderLineItem?.lineItem?.item?.itemId ?? "",
    quantity: l.requestedQuantity ?? undefined,
    reasonCode: l.returnReason?.code ?? "",
    reasonText: l.returnReason?.displayText ?? "",
    note: l.returnNote ?? "",
  }));
  const first = lines[0];

  const tracking: ReturnTracking[] = [];
  const rf = r.returnFulfillment;
  for (const e of rf?.returnFulfillmentSummary?.latestPackageEvents ?? []) {
    const num = e.tracking?.trackingNumber?.trim();
    if (num) {
      tracking.push({
        trackingNumber: num,
        carrier: carrierName(e.tracking.shippingCarrier),
        source: "packageEvent",
        occurredAt: e.occurredAt,
      });
    }
  }
  for (const p of rf?.sellerFulfillmentInitiation?.provisionedLabels ?? []) {
    for (const l of p.returnLabels ?? []) {
      const num = l.trackingNumber?.trim();
      if (num) tracking.push({ trackingNumber: num, carrier: carrierName(l.shippingCarrier), source: "returnLabel" });
    }
  }

  const offer = r.returnNegotiation?.latestReturnOffer;
  const term = (offer?.proposedTerm ?? []).find((t: any) => t?.refundAmount);
  const respond = r.sellerAvailableActions?.respondByAction;

  return {
    returnId: String(r.returnId),
    preset,
    statusCode: r.status?.code ?? "",
    statusText: r.status?.displayText ?? "",
    requestedAt: r.requestedAt ?? "",
    closedAt: r.closedAt ?? undefined,
    requester: r.requester ?? "",
    buyer: r.returnLineItems?.[0]?.orderLineItem?.orderReference?.buyer?.username ?? "",
    orderId: first?.orderId ?? "",
    orderLineItemId: first?.orderLineItemId ?? "",
    itemId: first?.itemId ?? "",
    reasonCode: first?.reasonCode ?? "",
    reasonText: first?.reasonText ?? "",
    note: first?.note ?? "",
    lines,
    fulfillmentStatus: rf?.fulfillmentStatus?.code ?? undefined,
    offer: offer ? { status: offer.status?.code ?? "", amount: money(term?.refundAmount) } : undefined,
    respondBy: respond ? { dueAt: respond.responseDueAt, action: respond.respondAction?.code ?? "" } : undefined,
    tracking,
  };
}

const warned = new Set<string>();
function warnPartial(errors: { message: string; path?: (string | number)[]; extensions?: any }[]): void {
  for (const e of errors) {
    const key = `${e.message} ${(e.path ?? []).filter((p) => typeof p === "string").join(".")}`;
    if (warned.has(key)) continue;
    warned.add(key);
    console.error(`[return_api] warning:${formatError(e)}`);
  }
}

function initialInput(preset: ReturnPreset, from: Date, to: Date, pageSize = PAGE_SIZE) {
  return {
    initialPage: {
      filter: { presets: preset, dateRange: { startDateTime: from.toISOString(), endDateTime: to.toISOString() } },
      sort: { sortField: "REQUESTED_AT", sortOrder: "DESC" },
    },
    pagination: { maxPageSize: pageSize },
  };
}

/**
 * One search page, retried while eBay fails it. A nested field failing with
 * "internal server error" nulls the whole result; that is usually transient,
 * but for some old returns it fails every time. `page` is undefined when the
 * page never loads.
 */
async function fetchPage(
  token: string,
  query: string,
  input: unknown,
  marketplace: string,
  retries: number
): Promise<{ page?: any; errors: GraphqlError[] }> {
  for (let attempt = 0; ; attempt++) {
    const r = await graphqlCall(token, query, { input }, marketplace);
    const o = r.data?.sellerOrderReturns;
    if (o) {
      if (o.__typename !== "SellerOrderReturns") {
        throw new Error(`sellerOrderReturns: ${o.__typename} ${o.errorCode ?? ""} ${o.errorMessage ?? ""}`);
      }
      return { page: o, errors: r.errors };
    }
    if (attempt >= retries) return { errors: r.errors };
    await sleep(3000 * (attempt + 1));
  }
}

/** Every return under one preset requested in [from, to), newest first. */
async function searchPreset(
  token: string,
  preset: ReturnPreset,
  from: Date,
  to: Date,
  marketplace: string
): Promise<ReturnRecord[]> {
  const out: ReturnRecord[] = [];
  let cursor: string | undefined;
  // Once a page fails for good, the older pages after it (newest-first) almost
  // always do too, so read the rest of this search without the order.
  let orderless = false;
  for (;;) {
    const input = cursor ? { pagination: { maxPageSize: PAGE_SIZE, pageCursor: cursor } } : initialInput(preset, from, to);
    let page: any;
    let errors: GraphqlError[] = [];
    if (!orderless) ({ page, errors } = await fetchPage(token, FULL_QUERY, input, marketplace, MAX_RETRIES));
    let records: ReturnRecord[];
    if (page) {
      records = page.orderReturns.map((x: any) => toRecord(x, preset));
    } else {
      orderless = true;
      // Load the page without the order and listing; fillMissingOrders() can
      // recover those from the Fulfillment API.
      ({ page } = await fetchPage(token, NO_ORDER_QUERY, input, marketplace, MAX_RETRIES));
      if (!page) throw new Error(`sellerOrderReturns failed:\n${errors.map(formatError).join("\n")}`);
      records = page.orderReturns.map((x: any) => toRecord(x, preset));
      errors = [];
    }
    // Field-level errors (e.g. a FORBIDDEN optional field) still come with data.
    if (errors.length) warnPartial(errors);
    out.push(...records);
    cursor = page.pagination?.nextCursor ?? undefined;
    if (!cursor || page.orderReturns.length === 0) break;
  }
  return out;
}

export interface SearchOptions {
  from: Date;
  to?: Date;
  presets?: readonly ReturnPreset[];
  marketplace?: string; // default EBAY_US
}

/**
 * Every return requested in [from, to) under the given presets (default:
 * all of them, i.e. open and closed), deduped by returnId, newest first.
 * Returns whose order eBay can't resolve come back with orderId, itemId and
 * buyer blank -- pass them through fillMissingOrders().
 */
export async function searchReturns(token: string, opts: SearchOptions): Promise<ReturnRecord[]> {
  const to = opts.to ?? new Date();
  const presets = opts.presets ?? RETURN_PRESETS;
  const byId = new Map<string, ReturnRecord>();
  for (let end = to.getTime(); end > opts.from.getTime(); end -= WINDOW_DAYS * DAY_MS) {
    const start = Math.max(opts.from.getTime(), end - WINDOW_DAYS * DAY_MS);
    for (const preset of presets) {
      for (const r of await searchPreset(token, preset, new Date(start), new Date(end), opts.marketplace ?? "EBAY_US")) {
        if (!byId.has(r.returnId)) byId.set(r.returnId, r);
      }
    }
  }
  return [...byId.values()].sort((a, b) => b.requestedAt.localeCompare(a.requestedAt));
}

/**
 * Fill in orderId / itemId / buyer for returns the Return API couldn't link
 * to their order, by finding the order line (lineItemId = the return's
 * orderLineItemId) among Fulfillment API orders created up to `lookbackDays`
 * before the return. Orders older than two years can't be looked up.
 * Returns how many records are still missing their order.
 */
export async function fillMissingOrders(
  fToken: string,
  records: ReturnRecord[],
  lookbackDays = 90
): Promise<number> {
  const missing = records.filter((r) => !r.orderId && r.orderLineItemId && r.requestedAt);
  if (!missing.length) return 0;

  // Merge the per-return search windows into as few order searches as possible.
  const oldest = Date.now() - 729 * DAY_MS;
  const ranges = missing
    .map((r) => {
      const at = Date.parse(r.requestedAt);
      return [Math.max(oldest, at - lookbackDays * DAY_MS), Math.min(Date.now(), at + DAY_MS)] as [number, number];
    })
    .filter(([s, e]) => s < e)
    .sort((x, y) => x[0] - y[0]);
  const merged: [number, number][] = [];
  for (const r of ranges) {
    const last = merged[merged.length - 1];
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else merged.push([...r]);
  }

  const byLine = new Map<string, { orderId: string; itemId: string; buyer: string }>();
  for (const [s, e] of merged) {
    for (const o of await fetchOrders(fToken, new Date(s), new Date(e))) {
      for (const li of o.lineItems ?? []) {
        byLine.set(String(li.lineItemId), {
          orderId: o.orderId,
          itemId: String(li.legacyItemId ?? ""),
          buyer: o.buyer?.username ?? "",
        });
      }
    }
  }

  let still = 0;
  for (const r of missing) {
    const hit = byLine.get(r.orderLineItemId);
    if (!hit) {
      still++;
      continue;
    }
    r.orderId = hit.orderId;
    r.itemId ||= hit.itemId;
    r.buyer ||= hit.buyer;
    for (const l of r.lines) {
      const h = byLine.get(l.orderLineItemId);
      if (h) {
        l.orderId ||= h.orderId;
        l.itemId ||= h.itemId;
      }
    }
  }
  return still;
}

/**
 * Reasons eBay treats as the seller's fault ("not as described"): the buyer
 * gets the original shipping back too. Every other reason (no longer needed,
 * ordered by accident, wrong size, ...) is buyer's remorse: item price only.
 */
export const SELLER_FAULT_REASONS = new Set([
  "NOT_AS_DESCRIBED",
  "DAMAGED_ITEM_RECEIVED",
  "DEFECTIVE",
  "MISSING_PARTS",
  "WRONG_ITEM_RECEIVED",
  "FIT_COMPATIBILITY_ISSUE",
]);
