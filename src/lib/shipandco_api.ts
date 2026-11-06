/**
 * shipandco_api.ts -- requests to the Ship&Co API (https://developer.shipandco.com),
 * authenticated with the `x-access-token` header. The token is read from
 * `shipandco.apiToken` in the project's gitignored credentials.json (chmod 600), or
 * in EBAY_CREDENTIALS_JSON where that file is absent; failing that, from
 * SHIPANDCO_API_TOKEN in the environment or a gitignored `.env`.
 */

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

export const SHIPANDCO_API = "https://api.shipandco.com/v1";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const CREDS_PATH = resolve(ROOT, "credentials.json");
const ENV_PATH = resolve(ROOT, ".env");

let cachedToken: string | undefined;

/**
 * The Ship&Co API token: `shipandco.apiToken` in credentials.json (or EBAY_CREDENTIALS_JSON),
 * else SHIPANDCO_API_TOKEN from the environment or `.env`. Throws if none is set.
 */
export function shipandcoToken(): string {
  if (cachedToken) return cachedToken;
  // credentials.json, or its contents in EBAY_CREDENTIALS_JSON on web sessions.
  const credsText = existsSync(CREDS_PATH)
    ? readFileSync(CREDS_PATH, "utf8")
    : process.env.EBAY_CREDENTIALS_JSON;
  if (credsText) {
    const fromCreds = JSON.parse(credsText)?.shipandco?.apiToken;
    if (typeof fromCreds === "string" && fromCreds) return (cachedToken = fromCreds);
  }
  if (!process.env.SHIPANDCO_API_TOKEN && existsSync(ENV_PATH)) process.loadEnvFile(ENV_PATH);
  const token = process.env.SHIPANDCO_API_TOKEN;
  if (!token) {
    throw new Error(`No Ship&Co API token: add "shipandco": { "apiToken": "..." } to ${CREDS_PATH}`);
  }
  return (cachedToken = token);
}

/** Call `${SHIPANDCO_API}${path}` and parse the JSON; throws on a non-2xx response. */
export async function shipandcoRequest(method: string, path: string, body?: unknown): Promise<any> {
  const url = `${SHIPANDCO_API}${path}`;
  let resp: Response;
  for (let attempt = 1; ; attempt++) {
    resp = await fetch(url, {
      method,
      headers: {
        "x-access-token": shipandcoToken(),
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (resp.status !== 429 || attempt >= 5) break;
    // Over the call limit: wait until x-api-call-reset (at most a minute), then try again.
    const reset = Date.parse(resp.headers.get("x-api-call-reset") ?? "");
    const waitMs = Math.min(60_000, Math.max(1_000, Number.isNaN(reset) ? 10_000 : reset - Date.now() + 500));
    await resp.text();
    await new Promise((r) => setTimeout(r, waitMs));
  }
  const text = await resp.text();
  if (!resp.ok) throw new Error(`HTTP ${resp.status} from ${method} ${url}\n${text.slice(0, 1000)}`);
  // Some calls (e.g. DELETE) answer with plain text like "Order X deleted."
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return text;
  }
}
