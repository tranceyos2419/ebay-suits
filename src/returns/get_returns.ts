#!/usr/bin/env -S npx tsx
/**
 * get_returns.ts -- list return requests for a seller account via eBay's
 * GraphQL Return API (src/lib/return_api.ts). Item titles come from the
 * Fulfillment API's order record.
 *
 * Usage:
 *   npx tsx src/returns/get_returns.ts --account <name> [--days N] [--state OPEN|CLOSED|ALL|<preset>] [--json]
 *
 * --state OPEN = every preset but CLOSED; a preset name (e.g.
 * AWAITING_ACTION_FROM_SELLER) narrows to just that one.
 */

import { accountFromArgs, die } from "../auth/ebay_auth.ts";
import { fulfillmentToken, getOrder } from "../lib/fulfillment_api.ts";
import {
  fillMissingOrders,
  OPEN_PRESETS,
  RETURN_PRESETS,
  type ReturnPreset,
  returnToken,
  searchReturns,
} from "../lib/return_api.ts";
import { DAY_MS, mapLimit, runMain } from "../lib/util.ts";

interface Args {
  days: number;
  state: string;
  json: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { days: 90, state: "ALL", json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--days") args.days = parseInt(argv[++i], 10);
    else if (a === "--state") args.state = argv[++i].toUpperCase();
    else if (a === "--limit") i++; // accepted for compatibility; paging is automatic
    else if (a === "--json") args.json = true;
    else die(`Unknown argument: ${a}`);
  }
  return args;
}

function presetsFor(state: string): readonly ReturnPreset[] {
  if (state === "ALL") return RETURN_PRESETS;
  if (state === "OPEN") return OPEN_PRESETS;
  if ((RETURN_PRESETS as readonly string[]).includes(state)) return [state as ReturnPreset];
  die(`--state must be OPEN, CLOSED, ALL or one of ${RETURN_PRESETS.join(", ")}`);
}

async function main() {
  const { account, rest } = accountFromArgs(process.argv.slice(2));
  const args = parseArgs(rest);
  const token = await returnToken(account);

  const from = new Date(Date.now() - args.days * DAY_MS);
  const returns = await searchReturns(token, { from, presets: presetsFor(args.state) });

  // Titles live on the order (the Return API's line items have none).
  const fToken = await fulfillmentToken(account);
  await fillMissingOrders(fToken, returns);
  const titles = new Map<string, string>();
  await mapLimit([...new Set(returns.map((r) => r.orderId).filter(Boolean))], 5, async (orderId) => {
    const order = await getOrder(fToken, orderId);
    for (const li of order?.lineItems ?? []) {
      titles.set(`${orderId}/${li.lineItemId}`, li.title ?? "");
      titles.set(`${orderId}/item:${li.legacyItemId}`, li.title ?? "");
    }
  });
  const titleOf = (orderId: string, lineId: string, itemId: string) =>
    titles.get(`${orderId}/${lineId}`) ?? titles.get(`${orderId}/item:${itemId}`) ?? "";

  const members = returns.map((r) => ({ ...r, title: titleOf(r.orderId, r.orderLineItemId, r.itemId) }));
  if (args.json) {
    console.log(JSON.stringify({ total: members.length, members }, null, 2));
    return;
  }

  console.log(
    `Return requests for ${account} (last ${args.days} days, state=${args.state}): ` +
      `${members.length} of ${members.length}`
  );

  if (members.length === 0) {
    console.log("(none)");
    return;
  }

  for (const r of members) {
    console.log("----");
    console.log(`Return ID:   ${r.returnId}`);
    console.log(`State:       ${r.statusCode} (${r.preset}${r.fulfillmentStatus ? `, ${r.fulfillmentStatus}` : ""})`);
    console.log(`Order:       ${r.orderId}`);
    console.log(`Item:        ${r.itemId}`);
    console.log(`Title:       ${r.title}`);
    console.log(`Buyer:       ${r.buyer}`);
    console.log(`Reason:      ${r.reasonCode}`);
    console.log(`Comments:    ${r.note}`);
    console.log(`Opened:      ${r.requestedAt}`);
    if (r.closedAt) console.log(`Closed:      ${r.closedAt}`);
    if (r.offer?.amount) {
      console.log(`Offer:       ${r.offer.amount.value} ${r.offer.amount.currency} (partial refund, ${r.offer.status})`);
    }
    if (r.respondBy) console.log(`Respond by:  ${r.respondBy.dueAt} (${r.respondBy.action})`);
  }
}

runMain(main);
