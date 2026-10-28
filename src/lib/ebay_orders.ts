/**
 * ebay_orders.ts -- look up one eBay order by its order number (Fulfillment
 * API getOrder + its shipping fulfillments) and parse the parts needed to ship
 * it: address, line items, shipping service/cost and any tracking already on
 * it. Works for orders in any state, including ones already shipped.
 */

import { amount, getOrder, getTracking, type ShipmentTracking } from "./fulfillment_api.ts";

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
  /** Unit price after any promotion discount. */
  price: number;
}

export interface EbayOrder {
  orderId: string;
  /** e.g. "PAID / FULFILLED", or "CANCELED" for a cancelled order. */
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

/** One ebayCollectAndRemitTaxes entry as Trading wrote it into Street2:
 *   EU IOSS            "IOSS IM0123456789"
 *   AU GST (ABN)       "ABN#12345678901 Code:PAID"
 *   MY SST             "1234567890 Trans Type:LV & Exempt Type:LG"
 *   import VAT (FR)    "FR12345678901 Import VAT Paid"
 *   others (UK VAT, NO VOEC, NZ IRD, ...)  "<reference> Code:Paid"
 * The Fulfillment API has no field for Malaysia's transaction/exemption
 * type; eBay only collects SST under the low-value-goods scheme, which is
 * what Trading reported (LV / LG). */
function taxReferenceText(t: any): string {
  const ref = t.ebayReference?.value;
  if (!ref) return "";
  if (t.ebayReference.name === "IOSS" && /^IM/.test(ref)) return `IOSS ${ref}`;
  if (/^ABN#/.test(ref)) return `${ref} Code:PAID`;
  if (t.taxType === "SST") return `${ref} Trans Type:LV & Exempt Type:LG`;
  if (t.taxType === "IMPORT_VAT") return `${ref} Import VAT Paid`;
  return `${ref} Code:Paid`;
}

/** Map a Fulfillment API `Order` (plus its tracking) to EbayOrder. */
export function parseEbayOrder(o: any, tracking: ShipmentTracking[] = []): EbayOrder {
  const step = o.fulfillmentStartInstructions?.[0]?.shippingStep ?? {};
  const to = step.shipTo ?? {};
  const addr = to.contactAddress ?? {};
  const cancelled = o.cancelStatus?.cancelState === "CANCELED";
  // eBay's import-tax registration for taxes it collected and remitted (AU
  // ABN, EU IOSS, UK VAT, ...). Customs needs it on the label, so -- as the
  // Trading API did -- it is appended to address line 2, in Trading's format.
  const taxRefs = [
    ...new Set<string>((o.lineItems ?? []).flatMap((l: any) => (l.ebayCollectAndRemitTaxes ?? []).map(taxReferenceText).filter(Boolean))),
  ];
  return {
    orderId: o.orderId,
    status: cancelled ? "CANCELED" : `${o.orderPaymentStatus ?? ""} / ${o.orderFulfillmentStatus ?? ""}`,
    shippedTime: tracking.map((t) => t.shippedDate).filter(Boolean).sort()[0] ?? "",
    shippingService: step.shippingServiceCode ?? "",
    shippingCost: amount(o.pricingSummary?.deliveryCost),
    currency: o.pricingSummary?.total?.currency ?? "",
    tracking: tracking.map((t) => `${t.carrier} ${t.trackingNumber}`.trim()),
    address: {
      name: (to.fullName ?? "").trim(),
      company: (to.companyName ?? "").trim(),
      street1: (addr.addressLine1 ?? "").trim(),
      street2: [(addr.addressLine2 ?? "").trim(), ...taxRefs].filter(Boolean).join(" "),
      city: (addr.city ?? "").trim(),
      state: (addr.stateOrProvince ?? "").trim(),
      zip: (addr.postalCode ?? "").trim(),
      country: (addr.countryCode ?? "").trim(),
      phone: (to.primaryPhone?.phoneNumber ?? "").trim(),
      email: (to.email ?? "").includes("@") ? to.email.trim() : "",
    },
    items: (o.lineItems ?? []).map((l: any) => {
      const quantity = Number(l.quantity) || 1;
      return {
        title: (l.title ?? "").trim(),
        itemId: String(l.legacyItemId ?? ""),
        sku: l.sku ?? "",
        quantity,
        // After promotions, like Trading's TransactionPrice.
        price: Math.round((amount(l.discountedLineItemCost ?? l.lineItemCost) / quantity) * 100) / 100,
      };
    }),
  };
}

/** The eBay order `orderId` on the token's account, or undefined if that account doesn't have it. */
export async function fetchEbayOrder(token: string, orderId: string): Promise<EbayOrder | undefined> {
  const o = await getOrder(token, orderId);
  if (!o) return undefined;
  return parseEbayOrder(o, await getTracking(token, orderId));
}
