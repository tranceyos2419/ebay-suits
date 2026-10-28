#!/usr/bin/env -S npx tsx
/**
 * return_refund_report.ts -- for each return in a date window, report the
 * figures the Return Log sheet tracks, from eBay's GraphQL Return API plus
 * the Fulfillment API's order record:
 *
 *   Original  = what eBay would refund in full: the order line's total (item
 *               price after discounts, plus its shipping when the reason is the
 *               seller's fault -- not as described, damaged, defective, ...;
 *               item price only for buyer's-remorse reasons), pro rata to the
 *               quantity returned
 *   Amount    = what the seller actually pays out -- the refunds recorded on
 *               the order line since the return was opened, else the latest
 *               partial refund offered (the return's negotiation)
 *   Deduction = Original - Amount when a refund was issued for less than the
 *               original and it isn't a partial refund offered in the return's
 *               negotiation (eBay's deduction on a returned-item refund) --
 *               derived, see below
 *
 * The Return API's own refund figures (`refunds`, `refundEstimate`) need the
 * sell.refund.read OAuth scope, which our sign-in doesn't request, so
 * Original and Deduction are computed rather than read from eBay. Amounts
 * are in the buyer's currency, as on the order.
 *
 * Usage:
 *   npx tsx src/returns/return_refund_report.ts --account <name> [--days N] [--json]
 */

import { accountFromArgs, die } from "../auth/ebay_auth.ts";
import { fulfillmentToken, getOrder } from "../lib/fulfillment_api.ts";
import {
  fillMissingOrders,
  type ReturnRecord,
  returnToken,
  searchReturns,
  SELLER_FAULT_REASONS,
} from "../lib/return_api.ts";
import { DAY_MS, mapLimit, runMain } from "../lib/util.ts";

interface Figures {
  returnId: string;
  orderId: string;
  itemId: string;
  title: string;
  buyer: string;
  status: string;
  reason: string;
  created: string;
  currency: string;
  original?: number;
  amount?: number;
  amountIsActual: boolean;
  deduction?: number;
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const num = (a: { value?: string } | undefined) => (a?.value != null ? parseFloat(a.value) : NaN);

function figuresFor(r: ReturnRecord, order: any): Figures {
  const lineItems: any[] = order?.lineItems ?? [];
  const li =
    lineItems.find((l) => String(l.lineItemId) === r.orderLineItemId) ??
    lineItems.find((l) => String(l.legacyItemId) === r.itemId);

  let original: number | undefined;
  let currency = li?.total?.currency ?? "";
  if (li) {
    const total = num(li.total);
    const shipping = num(li.deliveryCost?.shippingCost) || 0;
    const qty = Number(li.quantity) || 1;
    const returned = Math.min(r.lines[0]?.quantity ?? qty, qty);
    const itemPart = ((total - shipping) * returned) / qty;
    if (Number.isFinite(total)) {
      original = round2(itemPart + (SELLER_FAULT_REASONS.has(r.reasonCode) ? shipping : 0));
    }
  }

  // Refunds issued on this order line once the return was opened.
  const refunds = (li?.refunds ?? []).filter(
    (x: any) => !x.refundDate || !r.requestedAt || x.refundDate >= r.requestedAt
  );
  let amount: number | undefined;
  let amountIsActual = false;
  if (refunds.length) {
    amount = round2(refunds.reduce((s: number, x: any) => s + (num(x.amount) || 0), 0));
    amountIsActual = true;
    currency ||= refunds[0].amount?.currency ?? "";
  } else if (r.offer?.amount) {
    amount = r.offer.amount.value;
    currency ||= r.offer.amount.currency;
  }

  // A refund short of the original that isn't a partial refund offered in the
  // return's negotiation is eBay's returned-item deduction. (The offer's status
  // is often left PENDING even after the seller refunds that amount, so match
  // on the amount, not the status.)
  let deduction: number | undefined;
  const isOfferedPartial = r.offer?.amount != null && Math.abs(r.offer.amount.value - (amount ?? NaN)) < 0.005;
  if (amountIsActual && original != null && amount! < original - 0.005 && !isOfferedPartial) {
    deduction = round2(original - amount!);
  }

  return {
    returnId: r.returnId,
    orderId: r.orderId,
    itemId: r.itemId,
    title: li?.title ?? "",
    buyer: r.buyer,
    status: r.statusCode,
    reason: r.reasonCode,
    created: r.requestedAt,
    currency,
    original,
    amount,
    amountIsActual,
    deduction,
  };
}

async function main() {
  const { account, rest: argv } = accountFromArgs(process.argv.slice(2));
  let days = 45;
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--days") days = parseInt(argv[++i], 10);
    else if (argv[i] === "--json") json = true;
    else die(`Unknown argument: ${argv[i]}`);
  }

  const token = await returnToken(account);
  const fToken = await fulfillmentToken(account);

  const from = new Date(Date.now() - days * DAY_MS);
  const returns = await searchReturns(token, { from });
  await fillMissingOrders(fToken, returns);
  const rows: Figures[] = await mapLimit(returns, 5, async (r) => figuresFor(r, await getOrder(fToken, r.orderId)));
  rows.sort((a, b) => b.created.localeCompare(a.created));

  if (json) {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }

  console.log(`${rows.length} returns created in the last ${days} days\n`);
  console.log(
    ["created", "returnId", "order", "status", "original", "amount", "actual?", "deduction"].join("\t")
  );
  for (const r of rows) {
    console.log(
      [
        r.created.slice(0, 10),
        r.returnId,
        r.orderId,
        r.status,
        r.original != null ? `${r.original} ${r.currency}` : "",
        r.amount ?? "",
        r.amountIsActual ? "actual" : r.amount != null ? "offered" : "",
        r.deduction ?? "",
      ].join("\t")
    );
  }
}

runMain(main);
