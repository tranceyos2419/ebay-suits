/**
 * trading_api.ts -- the one place that POSTs to eBay's Trading API (XML).
 *
 * Every Trading call has the same envelope and headers; scripts pass only the
 * call name and the request's inner XML, and get back the raw response plus
 * its Ack and <Errors>. Tokens come from src/auth/ebay_auth.ts (authnAuthToken).
 */

import { findBlocks, findErrors, findText, type TradingError } from "./xml_util.ts";

export const TRADING_API = "https://api.ebay.com/ws/api.dll";
export const TRADING_API_SANDBOX = "https://api.sandbox.ebay.com/ws/api.dll";
const COMPATIBILITY_LEVEL = "1193";

export interface TradingOptions {
  /** eBay site id (X-EBAY-API-SITEID); 0 = US. */
  siteId?: number;
  /** Endpoint override, e.g. TRADING_API_SANDBOX. */
  url?: string;
  /** Extra headers, e.g. X-EBAY-API-OUTPUT-SELECTOR. */
  headers?: Record<string, string>;
}

export interface TradingResponse {
  xml: string;
  status: number;
  /** The response's Ack, or `HTTP <status>` when there is none. */
  ack: string;
  /** Ack is Success or Warning. */
  ok: boolean;
  errors: TradingError[];
}

/** The full request document for `callName` around `inner`. */
export function tradingRequestXml(callName: string, inner: string): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<${callName}Request xmlns="urn:ebay:apis:eBLBaseComponents">
${inner}
</${callName}Request>`;
}

export async function tradingCall(
  token: string,
  callName: string,
  inner: string,
  opts: TradingOptions = {}
): Promise<TradingResponse> {
  const resp = await fetch(opts.url ?? TRADING_API, {
    method: "POST",
    headers: {
      "Content-Type": "text/xml",
      "X-EBAY-API-SITEID": String(opts.siteId ?? 0),
      "X-EBAY-API-COMPATIBILITY-LEVEL": COMPATIBILITY_LEVEL,
      "X-EBAY-API-CALL-NAME": callName,
      "X-EBAY-API-IAF-TOKEN": token,
      ...opts.headers,
    },
    body: tradingRequestXml(callName, inner),
  });
  const xml = await resp.text();
  const ack = findText(xml, "Ack") ?? `HTTP ${resp.status}`;
  return { xml, status: resp.status, ack, ok: ack === "Success" || ack === "Warning", errors: findErrors(xml) };
}

/** Print each error as `  [Severity] short -- long`; true when none is a hard Error. */
export function printErrors(errors: TradingError[], log: (line: string) => void = console.log): boolean {
  for (const err of errors) log(`  [${err.severity}] ${err.short} -- ${err.long}`);
  return !errors.some((e) => e.severity === "Error");
}

/** Like tradingCall, but throws (after printing the errors to stderr) unless Ack is Success/Warning. */
export async function tradingCallOrThrow(
  token: string,
  callName: string,
  inner: string,
  opts: TradingOptions = {}
): Promise<TradingResponse> {
  const r = await tradingCall(token, callName, inner, opts);
  if (!r.ok) {
    printErrors(r.errors, console.error);
    throw new Error(`${callName} failed (HTTP ${r.status}, Ack ${r.ack})`);
  }
  return r;
}

// ---- response parsing helpers -----------------------------------------------

export function num(s: string | undefined): number {
  const n = parseFloat(s ?? "");
  return Number.isFinite(n) ? n : 0;
}

/** Amount and currency of a money element: `<Total currencyID="USD">12.34</Total>`. */
export function money(block: string, tag: string): { amount: number; currency: string } {
  const re = new RegExp(`<(?:\\w+:)?${tag}[^>]*currencyID="([^"]*)"[^>]*>([\\s\\S]*?)</(?:\\w+:)?${tag}>`);
  const m = block.match(re);
  if (!m) return { amount: num(findText(block, tag)), currency: "" };
  return { amount: num(m[2]), currency: m[1] };
}

/** Undo the XML entity escaping eBay applies to text such as titles. */
export function unescapeXml(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#0?39;/g, "'")
    .replace(/&amp;/g, "&");
}

// ---- GetOrders --------------------------------------------------------------

/** GetOrders' CreateTimeFrom/CreateTimeTo window is capped at 30 days. */
const ORDER_CHUNK_DAYS = 29;
const DAY_MS = 86_400_000;

/**
 * Every seller order created in [from, to), as raw <Order> blocks, walking the
 * range in 29-day chunks and each chunk's pages, deduplicated by OrderID.
 */
export async function fetchOrderBlocks(token: string, from: Date, to: Date): Promise<string[]> {
  const blocks: string[] = [];
  const seen = new Set<string>();
  for (let cursor = new Date(from); cursor < to; ) {
    const chunkEnd = new Date(Math.min(cursor.getTime() + ORDER_CHUNK_DAYS * DAY_MS, to.getTime()));
    for (let page = 1; ; page++) {
      const { xml } = await tradingCallOrThrow(
        token,
        "GetOrders",
        `  <CreateTimeFrom>${cursor.toISOString()}</CreateTimeFrom>
  <CreateTimeTo>${chunkEnd.toISOString()}</CreateTimeTo>
  <OrderRole>Seller</OrderRole>
  <OrderStatus>All</OrderStatus>
  <DetailLevel>ReturnAll</DetailLevel>
  <Pagination>
    <EntriesPerPage>100</EntriesPerPage>
    <PageNumber>${page}</PageNumber>
  </Pagination>`
      );
      for (const o of findBlocks(xml, "Order")) {
        const id = findText(o, "OrderID") ?? "";
        if (seen.has(id)) continue;
        seen.add(id);
        blocks.push(o);
      }
      if (findText(xml, "HasMoreOrders") !== "true") break;
    }
    cursor = chunkEnd;
  }
  return blocks;
}
