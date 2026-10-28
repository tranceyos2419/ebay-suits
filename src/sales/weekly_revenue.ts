#!/usr/bin/env -S npx tsx
/**
 * weekly_revenue.ts -- pull orders via the Fulfillment REST API (getOrders)
 * and summarise revenue per ISO week (Mon-Sun), so week-over-week swings can
 * be compared and drilled into.
 *
 * An order's revenue is what the old Trading GetOrders "Total" reported:
 * items (after promotions) + shipping, less any refunds issued against its
 * line items, plus retail delivery fees (e.g. Colorado's) that eBay collects
 * on the seller's behalf. Sales tax / VAT that eBay collects and remits is not
 * revenue and is left out. The Fulfillment API folds retail delivery fees into
 * its sales-tax amount, so they are read from the GraphQL Order API's tax
 * breakdown (TAX_FEE).
 *
 * Orders cancelled because the buyer never paid are not returned by either
 * API, so they are missing from the "cancelled" column (Trading counted them).
 *
 * Usage:
 *   npx tsx src/sales/weekly_revenue.ts --account <name> [WEEKS] [--json out.json]
 *
 * WEEKS defaults to 8 (complete weeks back from the most recent Monday).
 */

import { writeFileSync } from "node:fs";
import { accountFromArgs } from "../auth/ebay_auth.ts";
import { amount, fetchOrders, fulfillmentToken } from "../lib/fulfillment_api.ts";
import { graphqlCallOrThrow, graphqlToken, ORDER_SCOPE } from "../lib/graphql_api.ts";
import { runMain } from "../lib/util.ts";

/** Kept below 200: at 200 the GraphQL Order API drops the next-page cursor. */
const GRAPHQL_PAGE_SIZE = 100;

interface Txn {
  itemId: string;
  title: string;
  qty: number;
  /** Unit price after any promotion discount. */
  price: number;
  sku: string;
}

interface Order {
  orderId: string;
  created: string; // ISO
  paid: string;
  /** "<orderPaymentStatus> / <orderFulfillmentStatus>", e.g. "PAID / FULFILLED". */
  status: string;
  /** Fulfillment cancelState: NONE_REQUESTED, IN_PROGRESS or CANCELED. */
  cancelStatus: string;
  total: number;
  currency: string;
  subtotal: number;
  shipping: number;
  /** Two-letter country code of the ship-to address. */
  buyerCountry: string;
  txns: Txn[];
}

const FEES_QUERY = `query ($input: OrdersInput!) {
  orders {
    sellerOrders(input: $input) {
      pagination { nextCursor }
      orders { orderId taxes { taxBreakdown { name taxAmount { original { value } } } } }
    }
  }
}`;

/** orderId -> retail delivery fees (tax breakdown TAX_FEE) for orders created in [from, to]. */
async function retailDeliveryFees(account: string, from: Date, to: Date): Promise<Map<string, number>> {
  const token = await graphqlToken(account, [ORDER_SCOPE]);
  const fees = new Map<string, number>();
  let cursor: string | undefined;
  do {
    const input = cursor
      ? { ordersPage: { maxPageSize: GRAPHQL_PAGE_SIZE, pageCursor: cursor } }
      : {
          ordersFirstPage: {
            maxPageSize: GRAPHQL_PAGE_SIZE,
            filter: {
              dateRange: { dateType: "CONFIRMED", dateTimeRange: { startDateTime: from.toISOString(), endDateTime: to.toISOString() } },
              filter: { includeAbandoned: false, includeCancelled: true, includeConfirmed: true, includePlaced: false },
              sort: { sortField: "CONFIRMED_AT", sortOrder: "DESC" },
            },
          },
        };
    const data = await graphqlCallOrThrow(token, FEES_QUERY, { input });
    const page = data.orders.sellerOrders;
    for (const o of page.orders ?? []) {
      const fee = (o.taxes?.taxBreakdown ?? [])
        .filter((t: any) => t.name === "TAX_FEE")
        .reduce((s: number, t: any) => s + Number(t.taxAmount?.original?.value ?? 0), 0);
      if (fee) fees.set(o.orderId, fee);
    }
    cursor = page.pagination?.nextCursor ?? undefined;
  } while (cursor);
  return fees;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

function parseOrder(o: any, fee: number): Order {
  const ps = o.pricingSummary ?? {};
  const lines: any[] = o.lineItems ?? [];
  const refunded = lines.reduce((s, l) => s + (l.refunds ?? []).reduce((t: number, r: any) => t + amount(r.amount), 0), 0);
  // A fully refunded (or cancelled) order totals 0, retail delivery fee
  // included. Line items don't always list refunds issued through a return,
  // so trust the order's payment status for full refunds.
  const net = o.orderPaymentStatus === "FULLY_REFUNDED" ? 0 : round2(amount(ps.total) - refunded);
  const txns: Txn[] = lines.map((l) => {
    const qty = Number(l.quantity) || 1;
    return {
      itemId: String(l.legacyItemId ?? ""),
      title: l.title ?? "",
      qty,
      price: round2(amount(l.discountedLineItemCost ?? l.lineItemCost) / qty),
      sku: l.sku ?? "",
    };
  });
  return {
    orderId: o.orderId,
    created: o.creationDate ?? "",
    paid: o.paymentSummary?.payments?.[0]?.paymentDate ?? "",
    status: `${o.orderPaymentStatus ?? ""} / ${o.orderFulfillmentStatus ?? ""}`,
    cancelStatus: o.cancelStatus?.cancelState ?? "",
    total: net > 0 ? round2(net + fee) : 0,
    currency: ps.total?.currency ?? "",
    subtotal: round2(amount(ps.priceSubtotal) + amount(ps.priceDiscount)),
    shipping: amount(ps.deliveryCost),
    buyerCountry: o.fulfillmentStartInstructions?.[0]?.shippingStep?.shipTo?.contactAddress?.countryCode ?? "",
    txns,
  };
}

async function main() {
  const { account, rest } = accountFromArgs(process.argv.slice(2));
  const weeks = parseInt(rest[0] ?? "8", 10);
  const jsonIdx = rest.indexOf("--json");
  const jsonOut = jsonIdx > -1 ? rest[jsonIdx + 1] : undefined;

  const token = await fulfillmentToken(account);

  const now = new Date();
  // Most recent Monday 00:00 UTC (start of the in-progress week).
  const thisMonday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const dow = (thisMonday.getUTCDay() + 6) % 7; // 0 = Monday
  thisMonday.setUTCDate(thisMonday.getUTCDate() - dow);
  const start = new Date(thisMonday);
  start.setUTCDate(start.getUTCDate() - weeks * 7);

  const [raw, fees] = await Promise.all([fetchOrders(token, start, now), retailDeliveryFees(account, start, now)]);
  const all = raw.map((o) => parseOrder(o, fees.get(o.orderId) ?? 0));
  console.error(`fetched ${all.length} orders from ${start.toISOString().slice(0, 10)} to today`);

  if (jsonOut) {
    writeFileSync(jsonOut, JSON.stringify({ start: start.toISOString(), fetched: now.toISOString(), orders: all }, null, 2));
    console.error(`wrote ${jsonOut}`);
  }

  // Weekly buckets
  const buckets = new Map<string, Order[]>();
  for (const o of all) {
    const d = new Date(o.created);
    const wk = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
    wk.setUTCDate(wk.getUTCDate() - ((wk.getUTCDay() + 6) % 7));
    const key = wk.toISOString().slice(0, 10);
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key)!.push(o);
  }

  const keys = [...buckets.keys()].sort();
  console.log("week (Mon, UTC)  orders   items   revenue   cancelled  avg order");
  for (const k of keys) {
    const os = buckets.get(k)!;
    const live = os.filter((o) => o.cancelStatus !== "CANCELED");
    const rev = live.reduce((s, o) => s + o.total, 0);
    const items = live.reduce((s, o) => s + o.txns.reduce((t, x) => t + x.qty, 0), 0);
    const cancelled = os.length - live.length;
    const avg = live.length ? rev / live.length : 0;
    console.log(
      `${k}    ${String(live.length).padStart(5)}  ${String(items).padStart(5)}  ${rev.toFixed(2).padStart(9)}  ${String(cancelled).padStart(8)}  ${avg.toFixed(2).padStart(8)}`,
    );
  }
}

runMain(main);
