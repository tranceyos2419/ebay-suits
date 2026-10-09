#!/usr/bin/env -S npx tsx
/**
 * return_refund_report.ts -- for each return in a date window, pull the
 * Post-Order API return detail and report the figures the Return Log sheet
 * tracks:
 *
 *   Original  = summary.sellerTotalRefund.estimatedRefundAmount (the item price)
 *   Amount    = what the seller actually pays out -- the actual refund once
 *               issued, else the partial refund offered/agreed
 *   Deduction = refundDeductionType.refundDeductionAmount from the response
 *               history (eBay's deduction on a returned-item refund)
 *
 * Usage:
 *   npx tsx src/returns/return_refund_report.ts --account <name> [--days N] [--json]
 */

import { accountFromArgs, authnAuthToken, die } from "../auth/ebay_auth.ts";
import { postOrderGet } from "../lib/post_order_api.ts";
import { DAY_MS, runMain } from "../lib/util.ts";

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

function figuresFor(detail: any): Figures {
  const s = detail.summary ?? {};
  const d = detail.detail ?? {};
  const est = s.sellerTotalRefund?.estimatedRefundAmount;
  const actual = s.sellerTotalRefund?.actualRefundAmount;

  // The most recent partial-refund offer in the response history is the amount
  // the parties settled on when no actual refund has been recorded yet.
  let partial: any;
  let deduction: any;
  for (const h of d.responseHistory ?? []) {
    const attrs = h.attributes ?? {};
    if (attrs.partialRefundAmount) partial = attrs.partialRefundAmount;
    if (attrs.refundDeductionType?.refundDeductionAmount) {
      deduction = attrs.refundDeductionType.refundDeductionAmount;
    }
  }

  const amount = actual ?? partial;
  return {
    returnId: s.returnId ?? "",
    orderId: s.orderId ?? "",
    itemId: s.creationInfo?.item?.itemId ?? "",
    title: d.itemDetail?.itemTitle ?? "",
    buyer: s.buyerLoginName ?? "",
    status: s.status ?? "",
    reason: s.creationInfo?.reason ?? "",
    created: s.creationInfo?.creationDate?.value ?? "",
    currency: est?.currency ?? actual?.currency ?? "",
    original: est?.value,
    amount: amount?.value,
    amountIsActual: actual != null,
    deduction: deduction?.value,
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

  const token = authnAuthToken(account);

  const from = new Date(Date.now() - days * DAY_MS).toISOString();
  const ids: string[] = [];
  let page = 1;
  for (;;) {
    const params = new URLSearchParams({
      role: "SELLER",
      limit: "100",
      offset: String(page),
      creation_date_range_from: from,
    });
    const data = await postOrderGet(`/return/search?${params}`, token);
    const fresh = (data.members ?? []).map((m: any) => m.returnId).filter((id: string) => !ids.includes(id));
    ids.push(...fresh);
    if (fresh.length === 0 || page >= (data.paginationOutput?.totalPages ?? 1)) break;
    page++;
  }

  const rows: Figures[] = [];
  for (const id of ids) {
    rows.push(figuresFor(await postOrderGet(`/return/${id}`, token)));
  }
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
