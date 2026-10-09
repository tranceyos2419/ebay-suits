/**
 * post_order_api.ts -- GET requests to eBay's Post-Order API (returns), which
 * takes the account's Auth'n'Auth token as `Authorization: TOKEN <token>`.
 */

export const POST_ORDER_API = "https://api.ebay.com/post-order/v2";

/** GET `${POST_ORDER_API}${path}` and parse the JSON; throws on a non-2xx response. */
export async function postOrderGet(path: string, token: string, marketplace = "EBAY_US"): Promise<any> {
  const url = `${POST_ORDER_API}${path}`;
  const resp = await fetch(url, {
    headers: {
      Authorization: `TOKEN ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json",
      "X-EBAY-C-MARKETPLACE-ID": marketplace,
    },
  });
  const text = await resp.text();
  if (!resp.ok) throw new Error(`HTTP ${resp.status} from ${url}\n${text.slice(0, 1000)}`);
  return JSON.parse(text);
}
