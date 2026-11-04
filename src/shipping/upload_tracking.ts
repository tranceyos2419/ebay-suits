#!/usr/bin/env -S npx tsx
/**
 * upload_tracking.ts -- make sure each order has a given tracking number
 * uploaded on eBay, and upload it when it's missing.
 *
 * Input is a CSV with "Order Number" and "New Tracking" columns (other
 * columns are ignored; rows with an empty tracking are skipped). Each order
 * is looked up with the Fulfillment REST API; its shipping fulfillments are
 * compared against the tracking number. Without --apply nothing is written:
 * the script only reports which orders already have the tracking and which
 * don't. With --apply, missing tracking numbers are uploaded as a new
 * shipping fulfillment covering every line item of the order
 * (POST order/{orderId}/shipping_fulfillment).
 *
 * Usage:
 *   npx tsx src/shipping/upload_tracking.ts orders.csv --account love-of-japan
 *   npx tsx src/shipping/upload_tracking.ts orders.csv --account love-of-japan --apply
 *   npx tsx src/shipping/upload_tracking.ts orders.csv --carrier JAPAN_POST --apply
 *
 * With no --account, every account in credentials.json is tried for each
 * order. Without --carrier, the carrier of the order's existing tracking is
 * reused (JAPAN_POST if it has none).
 */

import { readFileSync } from "node:fs";
import { accountNames, die } from "../auth/ebay_auth.ts";
import { parseCsv } from "../lib/csv.ts";
import { FULFILLMENT_API, fulfillmentToken, getOrder, getTracking } from "../lib/fulfillment_api.ts";
import { normalizeTracking, runMain } from "../lib/util.ts";

interface Options {
  file: string;
  accounts: string[];
  carrier?: string;
  apply: boolean;
}

function parseArgs(argv: string[]): Options {
  let file = "";
  let account = "";
  let carrier: string | undefined;
  let apply = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--account") account = argv[++i] ?? "";
    else if (a === "--carrier") carrier = argv[++i] ?? "";
    else if (a === "--apply") apply = true;
    else if (a.startsWith("--")) die(`Unknown option ${a}`);
    else file = a;
  }
  if (!file) die("Usage: upload_tracking.ts <csv> [--account <name>] [--carrier <code>] [--apply]");
  return { file, accounts: account ? [account] : accountNames(), carrier, apply };
}

async function postFulfillment(token: string, orderId: string, body: unknown): Promise<string> {
  const url = `${FULFILLMENT_API}/order/${encodeURIComponent(orderId)}/shipping_fulfillment`;
  const resp = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body),
  });
  const text = await resp.text();
  if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${text.slice(0, 800)}`);
  return resp.headers.get("location") ?? "";
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const rows = parseCsv(readFileSync(opts.file, "utf8"));
  const header = rows[0].map((h) => h.trim().toLowerCase());
  const orderCol = header.indexOf("order number");
  const trackCol = header.indexOf("new tracking");
  if (orderCol < 0 || trackCol < 0) die('CSV needs "Order Number" and "New Tracking" columns');

  const tokens = new Map<string, string>();
  for (const acct of opts.accounts) tokens.set(acct, await fulfillmentToken(acct));

  const counts = { present: 0, missing: 0, uploaded: 0, failed: 0, notFound: 0 };
  for (const row of rows.slice(1)) {
    const orderId = (row[orderCol] ?? "").trim();
    const tracking = normalizeTracking(row[trackCol] ?? "");
    if (!orderId || !tracking) continue;

    let found: { account: string; token: string; order: any } | undefined;
    for (const [account, token] of tokens) {
      // Another account's order id comes back as 400 "Invalid Order Id", not 404.
      const order = await getOrder(token, orderId).catch(() => undefined);
      if (order) { found = { account, token, order }; break; }
    }
    if (!found) {
      counts.notFound++;
      console.log(`${orderId}\t${tracking}\tORDER NOT FOUND`);
      continue;
    }

    const existing = await getTracking(found.token, orderId);
    const existingList = existing.map((t) => `${t.carrier}:${t.trackingNumber}`).join(", ") || "none";
    if (existing.some((t) => normalizeTracking(t.trackingNumber) === tracking)) {
      counts.present++;
      console.log(`${orderId}\t${tracking}\tALREADY UPLOADED\t${found.account}\t[${existingList}]`);
      continue;
    }

    counts.missing++;
    if (!opts.apply) {
      console.log(`${orderId}\t${tracking}\tMISSING\t${found.account}\t[${existingList}]\t${found.order.orderFulfillmentStatus}`);
      continue;
    }

    const body = {
      lineItems: (found.order.lineItems ?? []).map((l: any) => ({ lineItemId: l.lineItemId, quantity: l.quantity })),
      shippedDate: new Date().toISOString(),
      // Match the carrier the order's earlier tracking was uploaded with.
      shippingCarrierCode: opts.carrier ?? existing.find((t) => t.carrier)?.carrier ?? "JAPAN_POST",
      trackingNumber: tracking,
    };
    try {
      await postFulfillment(found.token, orderId, body);
      const after = await getTracking(found.token, orderId);
      const ok = after.some((t) => normalizeTracking(t.trackingNumber) === tracking);
      if (ok) counts.uploaded++; else counts.failed++;
      console.log(`${orderId}\t${tracking}\t${ok ? "UPLOADED" : "POSTED BUT NOT VISIBLE"}\t${found.account}\t[was: ${existingList}]`);
    } catch (err) {
      counts.failed++;
      console.log(`${orderId}\t${tracking}\tUPLOAD FAILED\t${found.account}\t${(err as Error).message}`);
    }
  }
  console.error(JSON.stringify(counts));
}

runMain(main);
