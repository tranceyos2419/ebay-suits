#!/usr/bin/env -S npx tsx
/**
 * inr_report.ts -- list a seller account's Item Not Received (INR) inquiries
 * with the buyer's country, carrier, tracking number and tracking status, and
 * sort each into a likely cause (delivered per tracking, late in transit,
 * opened before the estimated delivery date, no tracking, ...).
 *
 * Inquiries come from eBay's GraphQL Order Inquiry API (src/lib/inquiry_api.ts,
 * needs the sell.inquiry scope); title, ship-to country, shipping service,
 * estimated delivery and uploaded tracking from the Fulfillment API.
 *
 * Usage:
 *   npx tsx src/cases/inr_report.ts --account <name> [--state OPEN|CLOSED|ALL] [--days N] [--out reports/prefix] [--json]
 *
 * --state OPEN (default) = awaiting the seller + awaiting eBay (escalated).
 * --days N limits to inquiries opened in the last N days (default: no limit).
 * Writes <out>-<account>-<YYYY-MM-DD>.csv (default out: reports/inr) and
 * prints a summary by cause and by country.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { accountFromArgs, die } from "../auth/ebay_auth.ts";
import { toCsv } from "../lib/csv.ts";
import { fulfillmentToken, getOrder, getTracking, type ShipmentTracking } from "../lib/fulfillment_api.ts";
import {
  INQUIRY_PRESETS,
  type InquiryPreset,
  type InquiryRecord,
  inquiryToken,
  OPEN_INQUIRY_PRESETS,
  searchInquiries,
} from "../lib/inquiry_api.ts";
import { DAY_MS, mapLimit, normalizeTracking, runMain } from "../lib/util.ts";

interface Args {
  state: string;
  days?: number;
  out: string;
  json: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { state: "OPEN", out: "reports/inr", json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--state") args.state = argv[++i].toUpperCase();
    else if (a === "--days") args.days = parseInt(argv[++i], 10);
    else if (a === "--out") args.out = argv[++i];
    else if (a === "--json") args.json = true;
    else die(`Unknown argument: ${a}`);
  }
  return args;
}

function presetsFor(state: string): readonly InquiryPreset[] {
  if (state === "OPEN") return OPEN_INQUIRY_PRESETS;
  if (state === "ALL") return INQUIRY_PRESETS;
  if ((INQUIRY_PRESETS as readonly string[]).includes(state)) return [state as InquiryPreset];
  die(`--state must be OPEN, ALL or one of ${INQUIRY_PRESETS.join(", ")}`);
}

export type Cause =
  | "DELIVERED_PER_TRACKING"
  | "DELIVERED_AFTER_OPENED"
  | "LATE_IN_TRANSIT"
  | "OPENED_BEFORE_EDD"
  | "NO_TRACKING_UPLOADED"
  | "NOT_SHIPPED"
  | "UNKNOWN";

const CAUSE_TEXT: Record<Cause, string> = {
  DELIVERED_PER_TRACKING: "Delivered per tracking, buyer says not received",
  DELIVERED_AFTER_OPENED: "Delivered late, after the inquiry was opened",
  LATE_IN_TRANSIT: "Not delivered, past estimated delivery date",
  OPENED_BEFORE_EDD: "Not delivered, opened before estimated delivery date",
  NO_TRACKING_UPLOADED: "Shipped but no tracking on the order",
  NOT_SHIPPED: "Not marked shipped",
  UNKNOWN: "Unknown",
};

interface Row {
  account: string;
  inquiry: InquiryRecord;
  title: string;
  country: string;
  shippingService: string;
  orderDate: string;
  total: string;
  carrier: string;
  trackingNumber: string;
  trackingStatus: string;
  shippedAt?: string;
  deliveredAt?: string;
  eddLatest?: string;
  handlingDays?: number;
  daysPastEddAtOpen?: number;
  daysInTransit?: number;
  cause: Cause;
}

const day = (iso?: string) => (iso ? iso.slice(0, 10) : "");
const daysBetween = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / DAY_MS);

function buildRow(account: string, inq: InquiryRecord, order: any, uploaded: ShipmentTracking[]): Row {
  const li = (order?.lineItems ?? []).find((l: any) => String(l.lineItemId) === inq.orderLineItemId) ?? order?.lineItems?.[0];
  const step = order?.fulfillmentStartInstructions?.[0]?.shippingStep;
  inq.itemId ||= String(li?.legacyItemId ?? "");

  // Prefer the shipment eBay tracks for this line; fall back to the tracking uploaded on the order.
  const ship = inq.shipments.find((s) => s.trackingNumber) ?? inq.shipments[0];
  const up = uploaded.find((u) => u.lineItemIds.includes(inq.orderLineItemId)) ?? uploaded[0];
  const trackingNumber = ship?.trackingNumber || up?.trackingNumber || inq.providedTracking[0]?.trackingNumber || "";
  const carrier = ship?.carrier || up?.carrier || inq.providedTracking[0]?.carrier || "";
  const shippedAt = ship?.shippedAt || up?.shippedDate || undefined;
  const deliveredAt = inq.shipments.find((s) => s.deliveredAt)?.deliveredAt;
  const eddLatest =
    inq.estimatedDelivery?.latest || li?.lineItemFulfillmentInstructions?.maxEstimatedDeliveryDate || undefined;

  let cause: Cause;
  if (deliveredAt && Date.parse(deliveredAt) <= Date.parse(inq.createdAt)) cause = "DELIVERED_PER_TRACKING";
  else if (deliveredAt) cause = "DELIVERED_AFTER_OPENED";
  else if (!trackingNumber && !shippedAt && order?.orderFulfillmentStatus !== "FULFILLED") cause = "NOT_SHIPPED";
  else if (!trackingNumber) cause = "NO_TRACKING_UPLOADED";
  else if (eddLatest && Date.parse(inq.createdAt) < Date.parse(eddLatest)) cause = "OPENED_BEFORE_EDD";
  else if (eddLatest) cause = "LATE_IN_TRANSIT";
  else cause = "UNKNOWN";

  const trackingStatus = deliveredAt
    ? "Delivered"
    : trackingNumber
      ? shippedAt
        ? "In transit / no delivery scan"
        : "Label created, no ship scan"
      : "No tracking";

  return {
    account,
    inquiry: inq,
    title: li?.title ?? "",
    country: step?.shipTo?.contactAddress?.countryCode ?? "",
    shippingService: step?.shippingServiceCode ?? "",
    orderDate: order?.creationDate ?? "",
    total: order?.pricingSummary?.total ? `${order.pricingSummary.total.value} ${order.pricingSummary.total.currency}` : "",
    carrier,
    trackingNumber,
    trackingStatus,
    shippedAt,
    deliveredAt,
    eddLatest,
    handlingDays: shippedAt && order?.creationDate ? daysBetween(order.creationDate, shippedAt) : undefined,
    daysPastEddAtOpen: eddLatest ? daysBetween(eddLatest, inq.createdAt) : undefined,
    daysInTransit: shippedAt ? daysBetween(shippedAt, deliveredAt ?? new Date().toISOString()) : undefined,
    cause,
  };
}

const HEADER = [
  "Account", "Inquiry ID", "Status", "Waiting on", "Opened", "Respond by", "Order ID", "Order date", "Item ID",
  "Title", "Buyer", "Country", "Shipping service", "Carrier", "Tracking number", "Tracking status", "Shipped",
  "Delivered", "Days order to ship", "Est. delivery (latest)", "Days past EDD when opened", "Days in transit", "Order total",
  "Seller tracking in inquiry", "Cause",
];

function csvRow(r: Row): (string | number)[] {
  const i = r.inquiry;
  return [
    r.account, i.inquiryId, i.statusText || i.statusCode, i.preset.replace("AWAITING_ACTION_FROM_", ""), day(i.createdAt),
    day(i.respondBy?.dueAt), i.orderId, day(r.orderDate), i.itemId, r.title, i.buyer, r.country, r.shippingService,
    r.carrier, r.trackingNumber, r.trackingStatus, day(r.shippedAt), day(r.deliveredAt), r.handlingDays ?? "", day(r.eddLatest),
    r.daysPastEddAtOpen ?? "", r.daysInTransit ?? "", r.total,
    i.providedTracking.map((p) => `${p.carrier} ${p.trackingNumber}`).join("; "), CAUSE_TEXT[r.cause],
  ];
}

function tally<T>(rows: T[], key: (r: T) => string): [string, number][] {
  const m = new Map<string, number>();
  for (const r of rows) m.set(key(r), (m.get(key(r)) ?? 0) + 1);
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
}

async function main() {
  const { account, rest } = accountFromArgs(process.argv.slice(2));
  const args = parseArgs(rest);

  const token = await inquiryToken(account);
  const from = args.days ? new Date(Date.now() - args.days * DAY_MS) : undefined;
  const inquiries = await searchInquiries(token, { presets: presetsFor(args.state), from });

  const fToken = await fulfillmentToken(account);
  const rows = await mapLimit(inquiries, 5, async (inq) => {
    const [order, uploaded] = inq.orderId
      ? await Promise.all([getOrder(fToken, inq.orderId), getTracking(fToken, inq.orderId)])
      : [undefined, []];
    return buildRow(account, inq, order, uploaded);
  });

  if (args.json) {
    console.log(JSON.stringify({ account, total: rows.length, rows }, null, 2));
  }

  const out = `${args.out}-${account}-${new Date().toISOString().slice(0, 10)}.csv`;
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, toCsv([HEADER, ...rows.map(csvRow)]));

  if (args.json) return;
  console.log(`INR inquiries for ${account} (state=${args.state}): ${rows.length}  ->  ${out}`);
  if (!rows.length) return;
  console.log("\nBy cause:");
  for (const [k, n] of tally(rows, (r) => CAUSE_TEXT[r.cause])) console.log(`  ${String(n).padStart(3)}  ${k}`);
  console.log("\nBy country:");
  for (const [k, n] of tally(rows, (r) => r.country || "?")) console.log(`  ${String(n).padStart(3)}  ${k}`);
  console.log("\nBy carrier:");
  for (const [k, n] of tally(rows, (r) => r.carrier || "(none)")) console.log(`  ${String(n).padStart(3)}  ${k}`);
  const dupes = tally(rows.filter((r) => r.trackingNumber), (r) => normalizeTracking(r.trackingNumber)).filter(([, n]) => n > 1);
  if (dupes.length) console.log(`\nTracking numbers on more than one inquiry: ${dupes.map(([t, n]) => `${t} x${n}`).join(", ")}`);
}

runMain(main);
