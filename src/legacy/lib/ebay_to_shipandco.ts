/**
 * ebay_to_shipandco.ts -- the one step both upload scripts share: read an
 * eBay order, show what its Ship&Co order would be, and (when asked) create
 * it, skipping orders that already have a Ship&Co order with that ref_number.
 * The store's 貨物内容 rules are always applied; an order whose items still
 * need a reviewed title (or an unknown HS code) is not created.
 */

import { readFileSync } from "node:fs";
import { fetchEbayOrder } from "./ebay_orders.ts";
import { applyCargoRules, type Store } from "../../lib/shipandco_cargo_rules.ts";
import {
  createShipandcoOrder,
  findOrdersByRef,
  applyAdjustments,
  formatOrderPreview,
  itemsTotal,
  orderBodyFromEbay,
  type OrderAdjustments,
  type ShipandcoOrder,
} from "../../lib/shipandco_orders.ts";

export type UploadStatus = "not_found" | "exists" | "needs_review" | "preview" | "created";

export interface UploadResult {
  orderId: string;
  status: UploadStatus;
  /** The Ship&Co order id (existing or newly created). */
  shipandcoId?: string;
  /** Items total (合計金額) in the Ship&Co order: the existing order's, or the one sent. */
  itemTotal?: number;
  preview?: string;
  /** Why the order can't be created yet (status needs_review). */
  errors?: string[];
}

export interface UploadOptions {
  /** Actually create the order; otherwise only preview it. */
  create: boolean;
  /** Already-fetched API orders to check for duplicates (see listApiOrders). */
  existing?: ShipandcoOrder[];
  /** Per-batch rules such as DDP or pricing items at the shipping fee. */
  adjust?: OrderAdjustments;
  /** eBay item id -> title reviewed by Claude (jdm-direct-motors 貨物内容 rule). */
  reviewedNames?: Record<string, string>;
}

/** --ddp, --price-from-shipping, --gift and --price-cap from a script's arguments, and the arguments left over. */
export function adjustmentsFromArgs(argv: string[]): { adjust: OrderAdjustments; rest: string[] } {
  const flags = new Set(["--ddp", "--price-from-shipping", "--gift", "--price-cap"]);
  return {
    adjust: { ddp: argv.includes("--ddp"), priceFromShipping: argv.includes("--price-from-shipping"), gift: argv.includes("--gift"), priceCap: argv.includes("--price-cap") },
    rest: argv.filter((a) => !flags.has(a)),
  };
}

export async function uploadEbayOrder(
  token: string,
  account: string,
  orderId: string,
  opts: UploadOptions
): Promise<UploadResult> {
  const ebay = await fetchEbayOrder(token, orderId);
  if (!ebay) return { orderId, status: "not_found" };

  const base = applyAdjustments(orderBodyFromEbay(ebay), opts.adjust);
  const cargo = applyCargoRules(base.products, account as Store, ebay.address.country, opts.reviewedNames);
  const body = { ...base, products: cargo.products };
  const preview = formatOrderPreview(ebay, body, account);
  const dup = (await findOrdersByRef(orderId, opts.existing))[0];
  if (dup) return { orderId, status: "exists", shipandcoId: dup.id, itemTotal: itemsTotal(dup), preview };
  if (cargo.errors.length) return { orderId, status: "needs_review", itemTotal: itemsTotal(body), preview, errors: cargo.errors };
  if (!opts.create) return { orderId, status: "preview", itemTotal: itemsTotal(body), preview };

  const created = await createShipandcoOrder(body);
  opts.existing?.push(created);
  return { orderId, status: "created", shipandcoId: created.id, itemTotal: itemsTotal(created), preview };
}

/** A JSON file of eBay item id -> reviewed title, as passed with --names. */
export function loadReviewedNames(path?: string): Record<string, string> {
  return path ? JSON.parse(readFileSync(path, "utf8")) : {};
}

/** One-line summary of a result, for script output. */
export function describeResult(r: UploadResult, account: string): string {
  switch (r.status) {
    case "not_found":
      return `  -> ${r.orderId}: not found on ${account}`;
    case "exists":
      return `  -> already in Ship&Co as ${r.shipandcoId}; not created again`;
    case "needs_review":
      return `  -> NOT ready: ${r.errors?.join("; ")}`;
    case "preview":
      return `  -> preview only`;
    case "created":
      return `  -> created Ship&Co order ${r.shipandcoId}`;
  }
}
