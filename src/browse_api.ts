/**
 * browse_api.ts -- Buy Browse API (REST) access with an application token
 * (client credentials), so it works for any seller's listing.
 */

import { requestToken } from "./ebay_auth.ts";
import { sleep } from "./util.ts";

const BROWSE = "https://api.ebay.com/buy/browse/v1";
const MAX_RETRIES = 4;

/** Browse error id for "this listing has variations; use get_items_by_item_group". */
const HAS_VARIATIONS = 11006;

export async function appToken(): Promise<string> {
  const t = await requestToken({ grant_type: "client_credentials", scope: "https://api.ebay.com/oauth/api_scope" });
  return t.access_token;
}

/** GET `${BROWSE}/${path}` on EBAY_US, retrying 429s and 5xx with backoff. */
export async function browse(path: string, token: string): Promise<{ status: number; body: any }> {
  for (let attempt = 0; ; attempt++) {
    const resp = await fetch(`${BROWSE}/${path}`, {
      headers: { Authorization: `Bearer ${token}`, "X-EBAY-C-MARKETPLACE-ID": "EBAY_US" },
    });
    if ((resp.status === 429 || resp.status >= 500) && attempt < MAX_RETRIES) {
      await sleep(2000 * (attempt + 1));
      continue;
    }
    return { status: resp.status, body: await resp.json().catch(() => ({})) };
  }
}

export interface LegacyItem {
  status: number;
  /** The listing, or for a multi-variation listing its lowest-priced variation. */
  item?: any;
  variations: boolean;
  /** First Browse error message, when no item was found. */
  error?: string;
}

/** Look a listing up by its legacy (Trading) item id. */
export async function getLegacyItem(itemId: string, token: string): Promise<LegacyItem> {
  const single = await browse(`item/get_item_by_legacy_id?legacy_item_id=${itemId}`, token);
  if (single.status === 200) return { status: 200, item: single.body, variations: false };
  if (single.body.errors?.some((e: any) => e.errorId === HAS_VARIATIONS)) {
    const group = await browse(`item/get_items_by_item_group?item_group_id=${itemId}`, token);
    const items: any[] = (group.body.items ?? []).filter((i: any) => !Number.isNaN(Number(i.price?.value)));
    if (items.length) {
      const low = items.reduce((a, b) => (Number(b.price.value) < Number(a.price.value) ? b : a));
      return { status: 200, item: low, variations: true };
    }
  }
  return { status: single.status, variations: false, error: single.body.errors?.[0]?.message };
}

/** Cheapest shipping option's cost, or undefined when the listing reports none. */
export function shippingFee(item: any): number | undefined {
  const costs = (item?.shippingOptions ?? [])
    .map((o: any) => Number(o.shippingCost?.value))
    .filter((n: number) => !Number.isNaN(n));
  return costs.length ? Math.min(...costs) : undefined;
}
