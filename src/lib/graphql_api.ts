/**
 * graphql_api.ts -- the one place that POSTs to eBay's Modernized GraphQL
 * APIs (Listing, Order, Return, ...), which replace the Trading API (XML) and
 * the Post-Order API. All of them share one endpoint; the OAuth scopes on
 * the user access token decide which operations a call may use.
 *
 * Tokens come from src/auth/ebay_auth.ts (oauthToken). The scopes are asked
 * for at sign-in by src/auth/ebay_login.ts (DEFAULT_SCOPES).
 */

import { oauthToken } from "../auth/ebay_auth.ts";
import { sleep } from "./util.ts";

export const GRAPHQL_API = "https://graphqlapi.ebay.com/graphql";
export const GRAPHQL_API_SANDBOX = "https://graphqlapi.sandbox.ebay.com/graphql";
const MAX_RETRIES = 4;

/** Where every call in this process goes (Production unless switched). */
let endpoint = GRAPHQL_API;

/** Send every following call to eBay's Sandbox (true) or Production (false).
 * For tools with a --sandbox mode; the token must then be a Sandbox token. */
export function useGraphqlSandbox(sandbox: boolean): void {
  endpoint = sandbox ? GRAPHQL_API_SANDBOX : GRAPHQL_API;
}

export const LISTING_SCOPE = "https://api.ebay.com/oauth/api_scope/sell.listing";
export const ORDER_SCOPE = "https://api.ebay.com/oauth/api_scope/sell.order";
export const RETURN_SCOPE = "https://api.ebay.com/oauth/api_scope/sell.return";

export interface GraphqlError {
  message: string;
  path?: (string | number)[];
  extensions?: Record<string, unknown>;
}

export interface GraphqlResponse<T = any> {
  status: number;
  data?: T;
  errors: GraphqlError[];
}

/** User access token for `account` carrying `scopes`. */
export function graphqlToken(account: string, scopes: string[]): Promise<string> {
  return oauthToken(account, scopes);
}

/** Run `query` with `variables`, retrying network errors, 429s and 5xx with backoff. */
export async function graphqlCall<T = any>(
  token: string,
  query: string,
  variables: Record<string, unknown> = {},
  marketplace = "EBAY_US"
): Promise<GraphqlResponse<T>> {
  for (let attempt = 0; ; attempt++) {
    let resp: Response;
    try {
      resp = await fetch(endpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "X-EBAY-C-MARKETPLACE-ID": marketplace,
        },
        body: JSON.stringify({ query, variables }),
      });
    } catch (err) {
      if (attempt >= MAX_RETRIES) throw err;
      await sleep(2000 * (attempt + 1));
      continue;
    }
    if ((resp.status === 429 || resp.status >= 500) && attempt < MAX_RETRIES) {
      await sleep(2000 * (attempt + 1));
      continue;
    }
    const text = await resp.text();
    let body: any = {};
    try {
      body = JSON.parse(text);
    } catch {
      return { status: resp.status, errors: [{ message: `HTTP ${resp.status}: ${text.slice(0, 300)}` }] };
    }
    return { status: resp.status, data: body.data ?? undefined, errors: body.errors ?? [] };
  }
}

/** Like graphqlCall, but throws unless there is data and no errors. */
export async function graphqlCallOrThrow<T = any>(
  token: string,
  query: string,
  variables: Record<string, unknown> = {},
  marketplace = "EBAY_US"
): Promise<T> {
  const r = await graphqlCall<T>(token, query, variables, marketplace);
  if (r.errors.length || !r.data) {
    throw new Error(`GraphQL call failed (HTTP ${r.status}):\n${r.errors.map(formatError).join("\n")}`);
  }
  return r.data;
}

export function formatError(e: GraphqlError): string {
  const code = e.extensions?.code ?? e.extensions?.errorId;
  return `  ${code ? `[${code}] ` : ""}${e.message}${e.path ? ` (at ${e.path.join(".")})` : ""}`;
}
