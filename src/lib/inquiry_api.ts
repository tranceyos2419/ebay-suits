/**
 * inquiry_api.ts -- Item Not Received (INR) inquiries through eBay's GraphQL
 * Order Inquiry API (`sellerOrderInquiries`), which replaces the Post-Order
 * API's /inquiry/search. Needs the sell.inquiry (or sell.inquiry.read) OAuth
 * scope; the buyer's username also needs commerce.identity.readonly.
 *
 * Quirks worth knowing:
 *   - A search takes exactly one filter preset: AWAITING_ACTION_FROM_SELLER,
 *     AWAITING_ACTION_FROM_EBAY (escalated / under review) or CLOSED. "Every
 *     open inquiry" means one search per open preset.
 *   - The only sort field is CREATED_AT.
 *   - Later pages are fetched with the cursor alone (pageInfo), like returns.
 *   - The carrier's view of the shipment (shippedAt, deliveredAt, tracking
 *     number) comes from the order line's fulfillmentExecution. The GraphQL
 *     `sellerOrders` query isn't live in Production, so this is the only
 *     Modernized place that says whether a package was delivered.
 *   - The order line carries no item title or ship-to country; use the
 *     Fulfillment API (src/lib/fulfillment_api.ts) for those.
 *   - eBay sometimes fails to resolve a line's listing (item id) or shipment,
 *     which nulls the whole page (seen on jdm-direct-motors' closed
 *     inquiries). Such pages are re-read without those fields; itemId is then
 *     blank and the caller can fill it in from the order.
 */

import { IDENTITY_SCOPE, oauthToken } from "../auth/ebay_auth.ts";
import { sleep } from "./util.ts";
import { formatError, graphqlCall, type GraphqlError } from "./graphql_api.ts";

export const INQUIRY_SCOPE = "https://api.ebay.com/oauth/api_scope/sell.inquiry";

export const INQUIRY_PRESETS = ["AWAITING_ACTION_FROM_SELLER", "AWAITING_ACTION_FROM_EBAY", "CLOSED"] as const;
export type InquiryPreset = (typeof INQUIRY_PRESETS)[number];
export const OPEN_INQUIRY_PRESETS: InquiryPreset[] = INQUIRY_PRESETS.filter((p) => p !== "CLOSED");

const PAGE_SIZE = 50;
const MAX_RETRIES = 2;

/** One shipment of the order line as eBay's tracking sees it. */
export interface InquiryShipment {
  carrier: string;
  trackingNumber: string;
  shippedAt?: string;
  deliveredAt?: string;
  trackingProvidedAt?: string;
  state: string; // FulfillmentCompleted / FulfillmentInProgress / ...
}

export interface InquiryRecord {
  inquiryId: string;
  preset: InquiryPreset;
  statusCode: string;
  statusText: string;
  createdAt: string;
  closedAt?: string;
  resolutionEstimate?: string;
  initiator: string;
  responder: string;
  buyer: string;
  orderId: string;
  orderLineItemId: string;
  itemId: string;
  quantity?: number;
  /** Tracking the seller gave inside the inquiry. */
  providedTracking: { carrier: string; trackingNumber: string; submittedAt: string }[];
  /** What eBay has asked for and not yet received (e.g. ShipmentTrackingInformationRequested). */
  requestedInformation: string[];
  respondBy?: { dueAt: string; action: string };
  secondaryActions: string[];
  /** Estimated delivery window from the order's shipping step. */
  estimatedDelivery?: { earliest?: string; latest?: string };
  shipments: InquiryShipment[];
}

export function inquiryToken(account: string): Promise<string> {
  return oauthToken(account, [INQUIRY_SCOPE, IDENTITY_SCOPE]);
}

const CARRIER = `shippingCarrier { carrierCode unsupportedCarrierName }`;
/** `full` adds the listing and the order line's shipping execution, which are dropped if eBay fails to resolve them. */
function inquiryFields(full: boolean): string {
  return `
  __typename inquiryId createdAt closedAt initiator responder
  status { code displayText }
  ... on ItemNotReceivedInquiry { resolutionEstimate }
  lineItems {
    quantity
    orderLineItem {
      orderLineItemId
      orderReference { orderId buyer { username } }
      ${full ? "lineItem { ... on ContractListingItem { item { itemId } } }" : ""}
      ${full ? FULFILLMENT : ""}
    }
  }
  providedInformation {
    submittedAt submitter
    submittedInformation { __typename ... on OrderInquiryShipmentTracking { trackingNumber ${CARRIER} } }
  }
  requestedInformation { __typename requestedAt requester }
  sellerAvailableActions {
    respondByAction { responseDueAt respondAction { code } }
    secondaryActions { code }
  }`;
}

const FULFILLMENT = `fulfillmentExecution { logisticsExecutionSteps { __typename ... on ShippingStep {
  estimate { earliestFulfillmentAt latestFulfillmentAt }
  planOrExecution { __typename ... on ShippingExecutionList { executions {
    shippedAt deliveredAt shippingCarrier trackingNumber trackingProvidedAt shippingState { __typename }
  } } }
} } }`;

function searchQuery(full: boolean): string {
  return `query SellerInquiries($input: SellerOrderInquiriesInput!) {
  sellerOrderInquiries(input: $input) {
    __typename
    ... on BusinessError { errorCode errorMessage }
    ... on SellerOrderInquiries { pagination { nextCursor } orderInquiries { ${inquiryFields(full)} } }
  }
}`;
}
const FULL_QUERY = searchQuery(true);
const MINIMAL_QUERY = searchQuery(false);

function carrierName(c: any): string {
  return c?.unsupportedCarrierName || c?.carrierCode || "";
}

function toRecord(r: any, preset: InquiryPreset): InquiryRecord {
  const line = r.lineItems?.[0];
  const oli = line?.orderLineItem;

  const shipments: InquiryShipment[] = [];
  let estimatedDelivery: InquiryRecord["estimatedDelivery"];
  for (const ex of oli?.fulfillmentExecution ?? []) {
    for (const step of ex.logisticsExecutionSteps ?? []) {
      if (step.__typename !== "ShippingStep") continue;
      if (step.estimate && !estimatedDelivery) {
        estimatedDelivery = {
          earliest: step.estimate.earliestFulfillmentAt ?? undefined,
          latest: step.estimate.latestFulfillmentAt ?? undefined,
        };
      }
      for (const e of step.planOrExecution?.executions ?? []) {
        shipments.push({
          carrier: e.shippingCarrier ?? "",
          trackingNumber: e.trackingNumber ?? "",
          shippedAt: e.shippedAt ?? undefined,
          deliveredAt: e.deliveredAt ?? undefined,
          trackingProvidedAt: e.trackingProvidedAt ?? undefined,
          state: e.shippingState?.__typename ?? "",
        });
      }
    }
  }

  const providedTracking: InquiryRecord["providedTracking"] = [];
  for (const p of r.providedInformation ?? []) {
    for (const info of p.submittedInformation ?? []) {
      if (info.trackingNumber) {
        providedTracking.push({ carrier: carrierName(info.shippingCarrier), trackingNumber: info.trackingNumber, submittedAt: p.submittedAt });
      }
    }
  }

  const actions = r.sellerAvailableActions;
  return {
    inquiryId: String(r.inquiryId),
    preset,
    statusCode: r.status?.code ?? "",
    statusText: r.status?.displayText ?? "",
    createdAt: r.createdAt ?? "",
    closedAt: r.closedAt ?? undefined,
    resolutionEstimate: r.resolutionEstimate ?? undefined,
    initiator: r.initiator ?? "",
    responder: r.responder ?? "",
    buyer: oli?.orderReference?.buyer?.username ?? "",
    orderId: oli?.orderReference?.orderId ?? "",
    orderLineItemId: oli?.orderLineItemId ?? "",
    itemId: oli?.lineItem?.item?.itemId ?? "",
    quantity: line?.quantity ?? undefined,
    providedTracking,
    requestedInformation: (r.requestedInformation ?? []).map((x: any) => x.__typename),
    respondBy: actions?.respondByAction
      ? { dueAt: actions.respondByAction.responseDueAt, action: actions.respondByAction.respondAction?.code ?? "" }
      : undefined,
    secondaryActions: (actions?.secondaryActions ?? []).map((a: any) => a.code),
    estimatedDelivery,
    shipments,
  };
}

const warned = new Set<string>();
function warnPartial(errors: GraphqlError[]): void {
  for (const e of errors) {
    const key = `${e.message} ${(e.path ?? []).filter((p) => typeof p === "string").join(".")}`;
    if (warned.has(key)) continue;
    warned.add(key);
    console.error(`[inquiry_api] warning:${formatError(e)}`);
  }
}

/** One search page, retried while eBay fails it; `page` is undefined when it never loads. */
async function fetchPage(
  token: string,
  query: string,
  input: unknown,
  marketplace: string
): Promise<{ page?: any; errors: GraphqlError[] }> {
  for (let attempt = 0; ; attempt++) {
    const r = await graphqlCall(token, query, { input }, marketplace);
    const o = r.data?.sellerOrderInquiries;
    // A failed nested field can null the inquiry list while leaving the wrapper.
    if (o && !(o.__typename === "SellerOrderInquiries" && o.orderInquiries == null && r.errors.length)) {
      if (o.__typename !== "SellerOrderInquiries") {
        throw new Error(`sellerOrderInquiries: ${o.__typename} ${o.errorCode ?? ""} ${o.errorMessage ?? ""}`);
      }
      return { page: o, errors: r.errors };
    }
    if (r.errors.some((e) => e.extensions?.errorCode === "FORBIDDEN")) {
      throw new Error(
        "sellerOrderInquiries: FORBIDDEN -- the token lacks the sell.inquiry scope. " +
          "Sign in again with src/auth/ebay_login.ts to add it."
      );
    }
    if (attempt >= MAX_RETRIES) return { errors: r.errors };
    await sleep(3000 * (attempt + 1));
  }
}

/** Every inquiry under one preset (optionally created in [from, to)), newest first. */
async function searchPreset(
  token: string,
  preset: InquiryPreset,
  marketplace: string,
  from?: Date,
  to?: Date
): Promise<InquiryRecord[]> {
  const out: InquiryRecord[] = [];
  let cursor: string | undefined;
  for (;;) {
    const input = cursor
      ? { pageInfo: { maxPageSize: PAGE_SIZE, pageCursor: cursor } }
      : {
          initialPage: {
            filter: {
              presets: preset,
              ...(from ? { createdBetween: { startDateTime: from.toISOString(), endDateTime: (to ?? new Date()).toISOString() } } : {}),
            },
            sort: { sortField: "CREATED_AT", sortOrder: "DESC" },
          },
          pageInfo: { maxPageSize: PAGE_SIZE },
        };
    let { page, errors } = await fetchPage(token, FULL_QUERY, input, marketplace);
    if (!page) {
      // A listing or shipment eBay can't resolve nulls the page; read it without them.
      ({ page } = await fetchPage(token, MINIMAL_QUERY, input, marketplace));
      if (!page) throw new Error(`sellerOrderInquiries failed:\n${errors.map(formatError).join("\n")}`);
      console.error(`[inquiry_api] warning: a ${preset} page was read without item ids and shipment data`);
      errors = [];
    }
    if (errors.length) warnPartial(errors);
    const rows = page.orderInquiries ?? [];
    out.push(...rows.map((x: any) => toRecord(x, preset)));
    cursor = page.pagination?.nextCursor ?? undefined;
    if (!cursor || rows.length === 0) break;
  }
  return out;
}

export interface InquirySearchOptions {
  presets?: readonly InquiryPreset[]; // default: the open presets
  from?: Date;
  to?: Date;
  marketplace?: string; // default EBAY_US
}

/** Every inquiry under the given presets, deduped by inquiryId, newest first. */
export async function searchInquiries(token: string, opts: InquirySearchOptions = {}): Promise<InquiryRecord[]> {
  const byId = new Map<string, InquiryRecord>();
  for (const preset of opts.presets ?? OPEN_INQUIRY_PRESETS) {
    for (const r of await searchPreset(token, preset, opts.marketplace ?? "EBAY_US", opts.from, opts.to)) {
      if (!byId.has(r.inquiryId)) byId.set(r.inquiryId, r);
    }
  }
  return [...byId.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
