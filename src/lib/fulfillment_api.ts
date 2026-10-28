/**
 * fulfillment_api.ts -- seller orders through eBay's Fulfillment REST API
 * (replaces Trading GetOrders). Needs the sell.fulfillment OAuth scope.
 *
 * The GraphQL Order API isn't used for orders because its line items carry no
 * item title, which the order scripts and Ship&Co customs data need.
 */

import { oauthToken } from "../auth/ebay_auth.ts";
import { sleep } from "./util.ts";

export const FULFILLMENT_API = "https://api.ebay.com/sell/fulfillment/v1";
export const FULFILLMENT_SCOPE = "https://api.ebay.com/oauth/api_scope/sell.fulfillment";
const MAX_RETRIES = 4;
const PAGE_SIZE = 200;

export function fulfillmentToken(account: string): Promise<string> {
  return oauthToken(account, [FULFILLMENT_SCOPE]);
}

/** GET `${FULFILLMENT_API}/${path}`, retrying network errors, 429s and 5xx with backoff.
 * Returns undefined on 404; throws on any other non-2xx response. */
export async function fulfillmentGet(token: string, path: string): Promise<any | undefined> {
  const url = `${FULFILLMENT_API}/${path}`;
  for (let attempt = 0; ; attempt++) {
    let resp: Response;
    try {
      resp = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } });
    } catch (err) {
      if (attempt >= MAX_RETRIES) throw err;
      await sleep(2000 * (attempt + 1));
      continue;
    }
    if ((resp.status === 429 || resp.status >= 500) && attempt < MAX_RETRIES) {
      await sleep(2000 * (attempt + 1));
      continue;
    }
    if (resp.status === 404) return undefined;
    const text = await resp.text();
    if (!resp.ok) throw new Error(`HTTP ${resp.status} from ${url}\n${text.slice(0, 1000)}`);
    return JSON.parse(text);
  }
}

/** One order (the Fulfillment API `Order` object), or undefined if this
 * account doesn't have it. */
export function getOrder(token: string, orderId: string): Promise<any | undefined> {
  return fulfillmentGet(token, `order/${encodeURIComponent(orderId)}`);
}

/**
 * Every order created in [from, to), oldest first, as Fulfillment API
 * `Order` objects. Orders can be looked up up to two years back.
 */
export async function fetchOrders(token: string, from: Date, to: Date): Promise<any[]> {
  const filter = `creationdate:[${from.toISOString()}..${to.toISOString()}]`;
  const orders: any[] = [];
  const seen = new Set<string>();
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const page = await fulfillmentGet(token, `order?filter=${encodeURIComponent(filter)}&limit=${PAGE_SIZE}&offset=${offset}`);
    for (const o of page?.orders ?? []) {
      // creationdate's upper bound is inclusive; keep the window half-open.
      if (seen.has(o.orderId) || Date.parse(o.creationDate) >= to.getTime()) continue;
      seen.add(o.orderId);
      orders.push(o);
    }
    if (!page?.next || !page.orders?.length) break;
  }
  return orders.sort((a, b) => Date.parse(a.creationDate) - Date.parse(b.creationDate));
}

export interface ShipmentTracking {
  carrier: string;
  trackingNumber: string;
  shippedDate: string;
  lineItemIds: string[];
}

/** The tracking numbers uploaded for an order (one per shipping fulfillment). */
export async function getTracking(token: string, orderId: string): Promise<ShipmentTracking[]> {
  const r = await fulfillmentGet(token, `order/${encodeURIComponent(orderId)}/shipping_fulfillment`);
  return (r?.fulfillments ?? []).map((f: any) => ({
    carrier: f.shippingCarrierCode ?? "",
    trackingNumber: f.shipmentTrackingNumber ?? "",
    shippedDate: f.shippedDate ?? "",
    lineItemIds: (f.lineItems ?? []).map((l: any) => String(l.lineItemId)),
  }));
}

/** `{ value: "12.34", currency: "USD" }` -> 12.34 (0 when missing). */
export function amount(a: { value?: string } | undefined): number {
  const n = parseFloat(a?.value ?? "");
  return Number.isFinite(n) ? n : 0;
}
