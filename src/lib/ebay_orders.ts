/**
 * ebay_orders.ts -- look up one eBay order by its order number (Trading API
 * GetOrders with OrderIDArray) and parse the parts needed to ship it:
 * address, line items, shipping service/cost and any tracking already on it.
 * Works for orders in any state, including ones already shipped.
 */

import { money, num, tradingCallOrThrow, unescapeXml } from "./trading_api.ts";
import { findBlocks, findText } from "./xml_util.ts";

export interface EbayAddress {
  name: string;
  company: string;
  street1: string;
  street2: string;
  city: string;
  state: string;
  zip: string;
  country: string;
  phone: string;
  /** Empty when eBay no longer exposes it (e.g. after shipping). */
  email: string;
}

export interface EbayOrderItem {
  title: string;
  itemId: string;
  sku: string;
  quantity: number;
  price: number;
}

export interface EbayOrder {
  orderId: string;
  status: string;
  shippedTime: string;
  shippingService: string;
  shippingCost: number;
  currency: string;
  /** "<carrier> <number>" for each tracking number already on the order. */
  tracking: string[];
  address: EbayAddress;
  items: EbayOrderItem[];
}

const text = (block: string, tag: string) => unescapeXml(findText(block, tag) ?? "").trim();

/** Parse one <Order> block from a GetOrders response. */
export function parseEbayOrder(o: string): EbayOrder {
  const addr = findBlocks(o, "ShippingAddress")[0] ?? "";
  const shipping = findBlocks(o, "ShippingServiceSelected")[0] ?? "";
  const transactions = findBlocks(o, "Transaction");
  return {
    orderId: text(o, "OrderID"),
    status: text(o, "OrderStatus"),
    shippedTime: text(o, "ShippedTime"),
    shippingService: text(shipping, "ShippingService"),
    shippingCost: money(shipping, "ShippingServiceCost").amount,
    currency: money(o, "Total").currency,
    tracking: findBlocks(o, "ShipmentTrackingDetails").map((d) =>
      `${text(d, "ShippingCarrierUsed")} ${text(d, "ShipmentTrackingNumber")}`.trim()
    ),
    address: {
      name: text(addr, "Name"),
      company: text(addr, "CompanyName"),
      street1: text(addr, "Street1"),
      street2: text(addr, "Street2"),
      city: text(addr, "CityName"),
      state: text(addr, "StateOrProvince"),
      zip: text(addr, "PostalCode"),
      country: text(addr, "Country"),
      phone: text(addr, "Phone"),
      email: transactions.map((t) => text(t, "Email")).find((e) => e.includes("@")) ?? "",
    },
    items: transactions.map((t) => ({
      title: text(t, "Title"),
      itemId: text(t, "ItemID"),
      sku: text(t, "SKU"),
      quantity: num(findText(t, "QuantityPurchased")) || 1,
      price: money(t, "TransactionPrice").amount,
    })),
  };
}

/** The eBay order `orderId` on the token's account, or undefined if that account doesn't have it. */
export async function fetchEbayOrder(token: string, orderId: string): Promise<EbayOrder | undefined> {
  const { xml } = await tradingCallOrThrow(
    token,
    "GetOrders",
    `  <OrderIDArray><OrderID>${orderId}</OrderID></OrderIDArray>
  <OrderRole>Seller</OrderRole>
  <DetailLevel>ReturnAll</DetailLevel>`
  );
  const block = findBlocks(xml, "Order")[0];
  return block ? parseEbayOrder(block) : undefined;
}
