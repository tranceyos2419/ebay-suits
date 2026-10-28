#!/usr/bin/env -S npx tsx
/**
 * find_order_by_tracking.ts -- given an outbound shipment tracking number,
 * find the eBay order(s) it belongs to and report every line item on the
 * order (title, quantity, price), so a single tracking number covering a
 * multi-item / combined-payment order can be checked against how many units
 * it actually represents.
 *
 * Unlike find_return_by_tracking.ts (which walks *return* records), this
 * walks regular orders. The GraphQL Order API (sellerOrders) lists every
 * order created in the date range together with its shipments' tracking
 * numbers, 100 orders per call; each matching order is then read from the
 * Fulfillment REST API (getOrder + shipping fulfillments), which has the item
 * titles and which line items each tracking number covers.
 *
 * Usage:
 *   npx tsx src/sales/find_order_by_tracking.ts <tracking-number> --month 2026-07
 *   npx tsx src/sales/find_order_by_tracking.ts <tracking-number> --from 2026-06-20 --to 2026-08-10
 *   npx tsx src/sales/find_order_by_tracking.ts <tracking-number> --account jdm-direct-motors --month 2026-07
 *
 * With no --account, every account in credentials.json is searched (each
 * with its own OAuth token, via src/auth/ebay_auth.ts).
 */

import { accountNames, die, useAccount } from "../auth/ebay_auth.ts";
import { amount, fulfillmentToken, getOrder, getTracking, type ShipmentTracking } from "../lib/fulfillment_api.ts";
import { graphqlCallOrThrow, graphqlToken, ORDER_SCOPE } from "../lib/graphql_api.ts";
import { normalizeTracking as normalize, runMain } from "../lib/util.ts";

/** Kept below 200: at 200 the GraphQL Order API drops the next-page cursor. */
const PAGE_SIZE = 100;

interface Options {
  tracking: string;
  account?: string;
  from: Date;
  to: Date;
}

interface LineItem {
  itemId: string;
  lineItemId: string;
  title: string;
  sku: string;
  qty: number;
  /** Unit price after any promotion discount. */
  price: number;
  currency: string;
  trackingNumbers: string[];
}

interface OrderRecord {
  orderId: string;
  created: string;
  /** "<orderPaymentStatus> / <orderFulfillmentStatus>", e.g. "PAID / FULFILLED". */
  status: string;
  /** Fulfillment cancelState: NONE_REQUESTED, IN_PROGRESS or CANCELED. */
  cancelStatus: string;
  buyer: string;
  /** Items + shipping, less refunds (excludes sales tax collected by eBay). */
  total: number;
  currency: string;
  items: LineItem[];
}

function parseArgs(argv: string[]): Options {
  let tracking: string | undefined;
  let account: string | undefined;
  let from: Date | undefined;
  let to: Date | undefined;
  let month: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--account") account = argv[++i];
    else if (a === "--from") from = new Date(argv[++i]);
    else if (a === "--to") to = new Date(argv[++i]);
    else if (a === "--month") month = argv[++i];
    else if (a.startsWith("--")) die(`ERROR: unknown flag ${a}`);
    else if (tracking === undefined) tracking = a;
    else die(`ERROR: unexpected extra argument ${a}`);
  }

  if (!tracking) {
    die(
      "Usage: npx tsx src/sales/find_order_by_tracking.ts <tracking-number> [--account <name>] (--month YYYY-MM | --from <date> --to <date>)"
    );
  }

  if (month) {
    const m = /^(\d{4})-(\d{2})$/.exec(month);
    if (!m) die("ERROR: --month expects YYYY-MM");
    const year = Number(m[1]);
    const mon = Number(m[2]);
    from = new Date(Date.UTC(year, mon - 1, 1));
    to = new Date(Date.UTC(year, mon, 1));
  }

  if (!from || !to || Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
    die("ERROR: pass --month YYYY-MM, or both --from and --to");
  }

  return { tracking, account, from, to };
}

const TRACKING_QUERY = `query ($input: OrdersInput!) {
  orders {
    sellerOrders(input: $input) {
      pagination { nextCursor }
      orders {
        orderId
        logistics {
          fulfillmentExecution {
            logisticsExecutionSteps {
              ... on ShippingStep {
                planOrExecution { ... on ShippingExecutionList { executions { trackingNumber } } }
              }
            }
          }
        }
      }
    }
  }
}`;

/** Ids of the orders created in [from, to] that carry `target` (normalized) on any shipment. */
async function orderIdsWithTracking(token: string, from: Date, to: Date, target: string): Promise<{ ids: string[]; scanned: number }> {
  const ids: string[] = [];
  let scanned = 0;
  let cursor: string | undefined;
  do {
    const input = cursor
      ? { ordersPage: { maxPageSize: PAGE_SIZE, pageCursor: cursor } }
      : {
          ordersFirstPage: {
            maxPageSize: PAGE_SIZE,
            filter: {
              dateRange: { dateType: "CONFIRMED", dateTimeRange: { startDateTime: from.toISOString(), endDateTime: to.toISOString() } },
              filter: { includeAbandoned: false, includeCancelled: true, includeConfirmed: true, includePlaced: false },
              sort: { sortField: "CONFIRMED_AT", sortOrder: "DESC" },
            },
          },
        };
    const data = await graphqlCallOrThrow(token, TRACKING_QUERY, { input });
    const page = data.orders.sellerOrders;
    for (const o of page.orders ?? []) {
      scanned++;
      const steps: any[] = (o.logistics?.fulfillmentExecution ?? []).flatMap((f: any) => f.logisticsExecutionSteps ?? []);
      const numbers = steps.flatMap((s) => s.planOrExecution?.executions ?? []).map((e: any) => e.trackingNumber ?? "");
      if (numbers.some((t: string) => normalize(t) === target) && !ids.includes(o.orderId)) ids.push(o.orderId);
    }
    cursor = page.pagination?.nextCursor ?? undefined;
  } while (cursor);
  return { ids, scanned };
}

function parseOrder(o: any, tracking: ShipmentTracking[]): OrderRecord {
  const lines: any[] = o.lineItems ?? [];
  const refunded = lines.reduce((s, l) => s + (l.refunds ?? []).reduce((t: number, r: any) => t + amount(r.amount), 0), 0);
  const items: LineItem[] = lines.map((l) => {
    const qty = Number(l.quantity) || 1;
    const lineItemId = String(l.lineItemId ?? "");
    return {
      itemId: String(l.legacyItemId ?? ""),
      lineItemId,
      title: l.title ?? "",
      sku: l.sku ?? "",
      qty,
      price: amount(l.discountedLineItemCost ?? l.lineItemCost) / qty,
      currency: (l.discountedLineItemCost ?? l.lineItemCost)?.currency ?? "",
      trackingNumbers: tracking.filter((t) => t.lineItemIds.includes(lineItemId) && t.trackingNumber).map((t) => t.trackingNumber),
    };
  });
  return {
    orderId: o.orderId,
    created: o.creationDate ?? "",
    status: `${o.orderPaymentStatus ?? ""} / ${o.orderFulfillmentStatus ?? ""}`,
    cancelStatus: o.cancelStatus?.cancelState ?? "",
    buyer: o.buyer?.username ?? "",
    // Line items don't always list refunds issued through a return, so trust
    // the order's payment status for full refunds.
    total: o.orderPaymentStatus === "FULLY_REFUNDED" ? 0 : Math.max(0, amount(o.pricingSummary?.total) - refunded),
    currency: o.pricingSummary?.total?.currency ?? "",
    items,
  };
}

function describe(account: string, o: OrderRecord, target: string): string {
  const totalQty = o.items.reduce((s, i) => s + i.qty, 0);
  const lines = [
    `[${account}] Order ${o.orderId}`,
    `  Created:      ${o.created}`,
    `  Status:       ${o.status}${o.cancelStatus && o.cancelStatus !== "NONE_REQUESTED" ? ` (cancel: ${o.cancelStatus})` : ""}`,
    `  Buyer:        ${o.buyer}`,
    `  Order total:  ${o.total.toFixed(2)} ${o.currency}`,
    `  Line items (${o.items.length}), total units purchased: ${totalQty}`,
  ];
  for (const it of o.items) {
    const mark = it.trackingNumbers.some((t) => normalize(t) === target) ? " <-- this tracking number" : "";
    lines.push(
      `    - qty ${it.qty}  ${it.price.toFixed(2)} ${it.currency}  itemId ${it.itemId}  "${it.title}"${it.sku ? `  sku=${it.sku}` : ""}${mark}`
    );
    if (it.trackingNumbers.length) lines.push(`        tracking: ${it.trackingNumbers.join(", ")}`);
  }
  lines.push(`  Order page: https://www.ebay.com/mesh/ord/details?orderid=${encodeURIComponent(o.orderId)}`);
  return lines.join("\n");
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const target = normalize(opts.tracking);
  const names = opts.account ? [useAccount(opts.account)] : accountNames();

  let anyMatch = false;
  for (const name of names) {
    console.error(
      `Scanning ${name}: orders created ${opts.from.toISOString().slice(0, 10)} .. ${opts.to.toISOString().slice(0, 10)}...`
    );
    const { ids, scanned } = await orderIdsWithTracking(await graphqlToken(name, [ORDER_SCOPE]), opts.from, opts.to, target);
    console.error(`  ${scanned} orders scanned.`);
    if (!ids.length) continue;

    const token = await fulfillmentToken(name);
    for (const id of ids) {
      const o = await getOrder(token, id);
      // The date filter's upper bound is inclusive; keep the window half-open.
      if (!o || Date.parse(o.creationDate) >= opts.to.getTime()) continue;
      anyMatch = true;
      console.log("\n" + describe(name, parseOrder(o, await getTracking(token, id)), target));
    }
  }

  if (!anyMatch) {
    console.log(`\nNo order (in the given date range, on the searched account(s)) carries tracking number ${opts.tracking}.`);
    process.exit(2);
  }
}

runMain(main);
