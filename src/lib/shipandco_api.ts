/**
 * shipandco_api.ts -- requests to the Ship&Co API (https://developer.shipandco.com),
 * authenticated with the `x-access-token` header. The token is read from
 * SHIPANDCO_API_TOKEN in the project's gitignored `.env` (chmod 600).
 */

import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

export const SHIPANDCO_API = "https://api.shipandco.com/v1";

const ENV_PATH = resolve(dirname(fileURLToPath(import.meta.url)), "../../.env");

/** The Ship&Co API token from `.env` (or the environment); throws if it is missing. */
export function shipandcoToken(): string {
  if (!process.env.SHIPANDCO_API_TOKEN && existsSync(ENV_PATH)) process.loadEnvFile(ENV_PATH);
  const token = process.env.SHIPANDCO_API_TOKEN;
  if (!token) throw new Error(`SHIPANDCO_API_TOKEN is not set; add it to ${ENV_PATH}`);
  return token;
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
