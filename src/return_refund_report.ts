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
 *   export EBAY_ACCESS_TOKEN=$(npx tsx src/get_token.ts jdm-direct-motors)
 *   npx tsx src/return_refund_report.ts [--days N] [--json]
 */

const SEARCH = "https://api.ebay.com/post-order/v2/return/search";
const DETAIL = "https://api.ebay.com/post-order/v2/return";

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

function headers(token: string) {
  return {
    Authorization: `TOKEN ${token}`,
    "Content-Type": "application/json",
    Accept: "application/json",
    "X-EBAY-C-MARKETPLACE-ID": "EBAY_US",
  };
}

async function getJson(url: string, token: string): Promise<any> {
  const resp = await fetch(url, { headers: headers(token) });
  const text = await resp.text();
  if (!resp.ok) throw new Error(`HTTP ${resp.status} for ${url}: ${text.slice(0, 500)}`);
  return JSON.parse(text);
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
  const argv = process.argv.slice(2);
  let days = 45;
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--days") days = parseInt(argv[++i], 10);
    else if (argv[i] === "--json") json = true;
    else {
      console.error(`Unknown argument: ${argv[i]}`);
      process.exit(1);
    }
  }

  const token = process.env.EBAY_ACCESS_TOKEN;
  if (!token) {
    console.error(
      "ERROR: set EBAY_ACCESS_TOKEN first, e.g.\n" +
        "  export EBAY_ACCESS_TOKEN=$(npx tsx src/get_token.ts jdm-direct-motors)"
    );
    process.exit(1);
  }

  const from = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const ids: string[] = [];
  let page = 1;
  for (;;) {
    const params = new URLSearchParams({
      role: "SELLER",
      limit: "100",
      offset: String(page),
      creation_date_range_from: from,
    });
    const data = await getJson(`${SEARCH}?${params}`, token);
    const fresh = (data.members ?? []).map((m: any) => m.returnId).filter((id: string) => !ids.includes(id));
    ids.push(...fresh);
    if (fresh.length === 0 || page >= (data.paginationOutput?.totalPages ?? 1)) break;
    page++;
  }

  const rows: Figures[] = [];
  for (const id of ids) {
    rows.push(figuresFor(await getJson(`${DETAIL}/${id}`, token)));
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

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
