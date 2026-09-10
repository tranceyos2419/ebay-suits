#!/usr/bin/env -S npx tsx
/**
 * get_returns.ts -- list return requests for a seller account via eBay's
 * Post-Order API (Return Management).
 *
 * Usage:
 *   export EBAY_ACCESS_TOKEN=$(npx tsx src/get_token.ts jdm-direct-motors)
 *   npx tsx src/get_returns.ts [--days N] [--state OPEN|CLOSED|ALL] [--json]
 *
 * The Auth'n'Auth tokens in credentials.json work here -- the Post-Order API
 * accepts them via the `Authorization: TOKEN <token>` header.
 */

const ENDPOINT = "https://api.ebay.com/post-order/v2/return/search";

interface Args {
  days: number;
  state: string;
  json: boolean;
  limit: number;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { days: 90, state: "ALL", json: false, limit: 100 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--days") args.days = parseInt(argv[++i], 10);
    else if (a === "--state") args.state = argv[++i].toUpperCase();
    else if (a === "--limit") args.limit = parseInt(argv[++i], 10);
    else if (a === "--json") args.json = true;
    else {
      console.error(`Unknown argument: ${a}`);
      process.exit(1);
    }
  }
  return args;
}

function pick(obj: any, ...paths: string[]): any {
  for (const path of paths) {
    let cur = obj;
    for (const key of path.split(".")) {
      if (cur == null) break;
      cur = cur[key];
    }
    if (cur != null && cur !== "") return cur;
  }
  return undefined;
}

function money(m: any): string {
  if (!m) return "";
  const value = pick(m, "value", "amount.value");
  const cur = pick(m, "currency", "amount.currency") ?? "";
  return value != null ? `${value} ${cur}`.trim() : "";
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const token = process.env.EBAY_ACCESS_TOKEN;
  if (!token) {
    console.error(
      "ERROR: set EBAY_ACCESS_TOKEN first, e.g.\n" +
        "  export EBAY_ACCESS_TOKEN=$(npx tsx src/get_token.ts jdm-direct-motors)"
    );
    process.exit(1);
  }

  const from = new Date(Date.now() - args.days * 24 * 60 * 60 * 1000);

  async function fetchPage(page: number): Promise<any> {
    const params = new URLSearchParams({
      role: "SELLER",
      limit: String(args.limit),
      offset: String(page),
      creation_date_range_from: from.toISOString(),
    });
    if (args.state && args.state !== "ALL") params.set("return_state", args.state);

    const resp = await fetch(`${ENDPOINT}?${params}`, {
      headers: {
        Authorization: `TOKEN ${token}`,
        "Content-Type": "application/json",
        Accept: "application/json",
        "X-EBAY-C-MARKETPLACE-ID": "EBAY_US",
      },
    });
    const text = await resp.text();
    if (!resp.ok) {
      console.error(`HTTP ${resp.status} ${resp.statusText}`);
      console.error(text.slice(0, 2000));
      process.exit(1);
    }
    return JSON.parse(text);
  }

  // The Post-Order API paginates by page number (1-based), not record offset.
  const first = await fetchPage(1);
  const seen = new Map<string, any>();
  for (const m of first.members ?? []) seen.set(m.returnId, m);
  const totalPages = first.paginationOutput?.totalPages ?? 1;
  for (let page = 2; page <= totalPages; page++) {
    const next = await fetchPage(page);
    const before = seen.size;
    for (const m of next.members ?? []) seen.set(m.returnId, m);
    if (seen.size === before) break; // no new records -- stop rather than loop
  }

  const data = {
    ...first,
    members: [...seen.values()].sort((a, b) =>
      (b.creationInfo?.creationDate?.value ?? "").localeCompare(a.creationInfo?.creationDate?.value ?? "")
    ),
  };
  if (args.json) {
    console.log(JSON.stringify(data, null, 2));
    return;
  }

  const members: any[] = data.members ?? [];
  console.log(
    `Return requests for jdm-direct-motors (last ${args.days} days, state=${args.state}): ` +
      `${members.length} of ${data.total ?? members.length}`
  );

  if (members.length === 0) {
    console.log("(none)");
    return;
  }

  for (const r of members) {
    const detail = r.detail ?? r;
    console.log("----");
    console.log(`Return ID:   ${r.returnId ?? ""}`);
    console.log(`State:       ${r.status ?? r.state ?? ""}`);
    console.log(`Order:       ${pick(detail, "orderId", "creationInfo.orderId", "legacyOrderId") ?? ""}`);
    console.log(`Item:        ${pick(detail, "itemId", "creationInfo.item.itemId") ?? ""}`);
    console.log(`Title:       ${pick(detail, "creationInfo.item.itemTitle", "itemTitle") ?? ""}`);
    console.log(`Buyer:       ${pick(detail, "buyerLoginName", "creationInfo.buyerLoginName", "buyer.loginName") ?? ""}`);
    console.log(`Reason:      ${pick(detail, "creationInfo.reason", "reason") ?? ""}`);
    console.log(`Comments:    ${pick(detail, "creationInfo.comments.content", "creationInfo.comments") ?? ""}`);
    console.log(`Opened:      ${pick(detail, "creationInfo.creationDate.value", "creationDate.value") ?? ""}`);
    const refund = pick(detail, "creationInfo.requestRefundAmount", "requestRefundAmount", "totalRefundAmount");
    if (refund) console.log(`Refund req:  ${money(refund)}`);
    const due = pick(detail, "sellerResponseDue.respondByDate.value", "respondByDate.value");
    if (due) console.log(`Respond by:  ${due}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
