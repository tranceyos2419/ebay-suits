/**
 * shipandco_orders.ts -- Ship&Co orders built from eBay orders: the request
 * body for POST /v1/orders, a human-readable preview of it (laid out like the
 * Ship&Co order page), creating it, and finding orders we already created.
 *
 * Creating an order is free; it does not create a shipment or buy a label.
 * Ship&Co assigns API-created orders an id like "API-XXXXXXXXXX" (a custom
 * id is ignored), so the eBay order number is kept in setup.ref_number.
 */

import type { EbayOrder } from "./ebay_orders.ts";
import { shipandcoRequest } from "./shipandco_api.ts";

export interface ShipandcoProduct {
  name: string;
  item_id: string;
  sku: string;
  quantity: number;
  price: number;
  hs_code?: string;
  hs_description?: string;
  origin_country?: string;
}

export interface ShipandcoOrderBody {
  to_address: Record<string, string>;
  products: ShipandcoProduct[];
  setup: { currency: string; shipping_fee: number; ref_number: string };
  customs?: { duty_paid?: boolean; content_type?: string };
}

export interface ShipandcoOrder extends ShipandcoOrderBody {
  id: string;
  state: string;
}

/**
 * The POST /v1/orders body for an eBay order (carrier and parcels are left for Ship&Co;
 * 貨物内容 rules are applied separately, see shipandco_cargo_rules.ts).
 * 法人名 (company) is never set: a company name goes into 個人名 only when there is no person's name.
 */
export function orderBodyFromEbay(o: EbayOrder): ShipandcoOrderBody {
  const a = o.address;
  const toAddress: Record<string, string> = {
    // 宛先 rule: 法人名 is always left empty; it only fills 個人名 when that is empty.
    full_name: a.name || a.company,
    address1: a.street1,
    address2: a.street2,
    city: a.city,
    province: a.state,
    zip: a.zip,
    country: a.country,
    phone: a.phone,
  };
  if (a.email) toAddress.email = a.email;
  return {
    to_address: toAddress,
    products: o.items.map((i) => ({ name: i.title, item_id: i.itemId, sku: i.sku, quantity: i.quantity, price: i.price })),
    setup: { currency: o.currency, shipping_fee: o.shippingCost, ref_number: o.orderId },
  };
}

/** Optional per-batch rules applied to the body before it is sent. */
export interface OrderAdjustments {
  /** Tick DDP (送料・関税 荷送人負担): customs.duty_paid = true. */
  ddp?: boolean;
  /** Item prices (合計金額) become the shipping fee (送料), and 送料 becomes 0. */
  priceFromShipping?: boolean;
  /** Set 内容品種別 to 贈答品: customs.content_type = "GIFT". */
  gift?: boolean;
}

/**
 * Make the items' total (合計金額) equal the shipping fee (送料) and set 送料 to 0.
 * With several items the fee is split in proportion to their original line totals.
 */
export function priceItemsAtShipping(body: ShipandcoOrderBody): ShipandcoOrderBody {
  const fee = body.setup.shipping_fee;
  if (!body.products.length) return body;
  const lineTotal = body.products.reduce((sum, p) => sum + p.price * p.quantity, 0);
  const round = (n: number) => Math.round(n * 100) / 100;
  const products = body.products.map((p) => {
    const share = lineTotal > 0 ? (fee * p.price * p.quantity) / lineTotal : fee / body.products.length;
    return { ...p, price: round(share / p.quantity) };
  });
  // Put any rounding remainder on the first item so the total matches the fee exactly.
  const diff = round(fee - products.reduce((sum, p) => sum + p.price * p.quantity, 0));
  if (diff) products[0].price = round(products[0].price + diff / products[0].quantity);
  return { ...body, products, setup: { ...body.setup, shipping_fee: 0 } };
}

export function applyAdjustments(body: ShipandcoOrderBody, adj: OrderAdjustments = {}): ShipandcoOrderBody {
  let out = body;
  if (adj.priceFromShipping) out = priceItemsAtShipping(out);
  if (adj.ddp) out = { ...out, customs: { ...out.customs, duty_paid: true } };
  if (adj.gift) out = { ...out, customs: { ...out.customs, content_type: "GIFT" } };
  return out;
}

/** Sum of price x quantity over the order's items (合計金額), rounded to cents. */
export function itemsTotal(body: Pick<ShipandcoOrderBody, "products">): number {
  return Math.round(body.products.reduce((sum, p) => sum + p.price * p.quantity, 0) * 100) / 100;
}

/** What would be sent, laid out like the Ship&Co order page. */
export function formatOrderPreview(o: EbayOrder, body: ShipandcoOrderBody, account: string): string {
  const a = body.to_address;
  const s = body.setup;
  const total = itemsTotal(body);
  const ddp = body.customs?.duty_paid ? "on" : "off";
  return [
    `=== ${o.orderId}  [${account}]  eBay status: ${o.status}${o.shippedTime ? `, shipped ${o.shippedTime.slice(0, 10)}` : ""}`,
    o.tracking.length ? `    eBay tracking: ${o.tracking.join(", ")}` : "",
    `  配送方法 (eBay): ${o.shippingService}    送料: ${s.shipping_fee} ${s.currency}    合計金額: ${total.toFixed(2)} ${s.currency}    DDP: ${ddp}    内容品種別: ${body.customs?.content_type ?? "(Ship&Co default)"}`,
    `  宛先:`,
    `    個人名:   ${a.full_name}`,
    `    法人名:   (empty)${o.address.company ? `  -- eBay had "${o.address.company}"` : ""}`,
    `    住所1:    ${a.address1}`,
    `    住所2:    ${a.address2}`,
    `    郵便番号: ${a.zip}   州: ${a.province}   都市: ${a.city}   国: ${a.country}`,
    `    電話番号: ${a.phone}`,
    `    メール:   ${a.email ?? "(not available from eBay)"}`,
    `  貨物内容:`,
    ...body.products.map(
      (p) => `    - ${p.name}\n      SKU ${p.sku}  ショップ商品ID ${p.item_id}  ${p.price.toFixed(2)} ${s.currency} x ${p.quantity}\n      HS ${p.hs_code ?? "-"} ${p.hs_description ?? ""}  原産国 ${p.origin_country ?? "-"}`
    ),
    `  参照番号 (ref_number): ${s.ref_number}`,
  ]
    .filter(Boolean)
    .join("\n");
}

/** Create the order in Ship&Co; returns it with its assigned id. */
export async function createShipandcoOrder(body: ShipandcoOrderBody): Promise<ShipandcoOrder> {
  return shipandcoRequest("POST", "/orders", body);
}

/** Every active order created through the API (Ship&Co keeps about 2 months). */
export async function listApiOrders(): Promise<ShipandcoOrder[]> {
  const orders: ShipandcoOrder[] = [];
  const since = new Date(Date.now() - 60 * 86_400_000).toISOString();
  for (let page = 1; ; page++) {
    let r: any;
    try {
      r = await shipandcoRequest("GET", `/orders?scope=api&limit=100&page=${page}&created_after=${since}`);
    } catch (e) {
      if (String(e).includes("NO_ORDERS")) break; // Ship&Co answers 400 NO_ORDERS for an empty result
      throw e;
    }
    orders.push(...r.orders);
    if (page >= r.pages) break;
  }
  return orders;
}

/** API-created Ship&Co orders whose ref_number is `ebayOrderId` (to avoid creating duplicates). */
export async function findOrdersByRef(ebayOrderId: string, orders?: ShipandcoOrder[]): Promise<ShipandcoOrder[]> {
  return (orders ?? (await listApiOrders())).filter((o) => o.setup?.ref_number === ebayOrderId);
}
