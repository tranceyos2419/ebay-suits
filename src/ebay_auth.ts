#!/usr/bin/env -S npx tsx
/**
 * ebay_auth.ts -- the one place that reads credentials.json and hands out
 * eBay tokens for a named seller account (e.g. jdm-direct-motors,
 * love-of-japan). Every script that talks to eBay takes `--account <name>`
 * and gets its token from here, so the account is always explicit on the
 * command line -- never inherited from an exported shell variable.
 *
 * eBay has two auth systems, and each API only takes one of them:
 *   - Auth'n'Auth token (legacy, ~18 months): Trading API (XML) and
 *     Post-Order API. -> authnAuthToken(account)
 *   - OAuth user access token (2 hours): REST Sell APIs (Account,
 *     Negotiation, Fulfillment, ...). -> oauthToken(account, scopes)
 *     Returns the saved access token while it has >5 minutes left and covers
 *     the scopes asked for; otherwise mints a new one from the account's
 *     refresh token and saves it back. The refresh token itself comes from
 *     src/ebay_login.ts.
 *
 * credentials.json (project root, chmod 600, gitignored):
 *   {
 *     "app": { "clientId", "clientSecret", "ruName" },
 *     "accounts": {
 *       "<name>": {
 *         "ebayUserId": "...",                     // recorded by `whoami`
 *         "authnauth": { "token", "expiresAt" },
 *         "oauth": { "refreshToken", "refreshTokenExpiresAt", "scopes",
 *                    "accessToken", "accessTokenExpiresAt", "accessTokenScopes" }
 *       }
 *     }
 *   }
 *
 * CLI:
 *   npx tsx src/ebay_auth.ts status
 *       every account's tokens: expiry dates and scopes (never the values)
 *   npx tsx src/ebay_auth.ts whoami --account <name>
 *       ask eBay which user the account's token belongs to, and record it
 *   npx tsx src/ebay_auth.ts token --account <name> [--oauth [scope ...]]
 *       print a token to stdout for ad-hoc use (e.g. curl); scopes can be
 *       short names like sell.account
 */

import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { findErrors, findText } from "./xml_util.ts";

export const CREDS_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "credentials.json");

const TOKEN_URL = "https://api.ebay.com/identity/v1/oauth2/token";
const TRADING_API = "https://api.ebay.com/ws/api.dll";
const SCOPE_BASE = "https://api.ebay.com/oauth/api_scope";
const ACCESS_TOKEN_MARGIN_MS = 5 * 60 * 1000;
const EXPIRY_WARNING_DAYS = 60;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface AppCreds {
  clientId: string;
  clientSecret: string;
  ruName: string;
  note?: string;
}

export interface AuthnAuthCreds {
  token: string;
  expiresAt?: string;
  note?: string;
}

export interface OAuthCreds {
  refreshToken?: string;
  refreshTokenExpiresAt?: string;
  /** Scopes the refresh token was granted at sign-in. Unknown (unset) for
   * refresh tokens made before ebay_login.ts existed. */
  scopes?: string[];
  signedInAt?: string;
  accessToken?: string;
  accessTokenExpiresAt?: string;
  accessTokenScopes?: string[];
  note?: string;
}

export interface AccountCreds {
  ebayUserId?: string;
  authnauth?: AuthnAuthCreds;
  oauth?: OAuthCreds;
}

export interface CredentialsFile {
  app?: AppCreds;
  accounts: Record<string, AccountCreds>;
}

export function die(msg: string): never {
  console.error(msg);
  process.exit(1);
}

// ---- credentials.json -------------------------------------------------------

let cache: CredentialsFile | undefined;

function readFromDisk(): CredentialsFile {
  if (!existsSync(CREDS_PATH)) die(`ERROR: no credentials.json found at ${CREDS_PATH}`);
  const parsed = JSON.parse(readFileSync(CREDS_PATH, "utf8"));
  if (!parsed || typeof parsed.accounts !== "object") {
    die(`ERROR: ${CREDS_PATH} has no "accounts" object -- see the layout in src/ebay_auth.ts`);
  }
  return parsed as CredentialsFile;
}

export function loadCredentials(): CredentialsFile {
  cache ??= readFromDisk();
  return cache;
}

/** Apply `mutate` to one account and save. Re-reads the file first so a
 * concurrent run's changes to other fields aren't clobbered, then writes via
 * a temp file + rename so a crash can't leave a half-written file. */
export function updateAccount(name: string, mutate: (account: AccountCreds) => void): void {
  const fresh = readFromDisk();
  fresh.accounts[name] ??= {};
  mutate(fresh.accounts[name]);
  const tmp = `${CREDS_PATH}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(fresh, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmp, CREDS_PATH);
  chmodSync(CREDS_PATH, 0o600);
  cache = fresh;
}

export function accountNames(): string[] {
  return Object.keys(loadCredentials().accounts);
}

export function getAccount(name: string): AccountCreds {
  const account = loadCredentials().accounts[name];
  if (!account) die(`ERROR: no account '${name}' in credentials.json. Known accounts: ${accountNames().join(", ")}`);
  return account;
}

/** Validate an account name and say on stderr which account (and eBay user,
 * once `whoami` has recorded it) this run is acting as. */
export function useAccount(name: string): string {
  const account = getAccount(name);
  console.error(`[account] ${name}${account.ebayUserId ? ` (eBay user ${account.ebayUserId})` : ""}`);
  return name;
}

/**
 * Pull `--account <name>` out of a script's argv (required) and return the
 * remaining args for the script's own parsing.
 */
export function accountFromArgs(argv: string[]): { account: string; rest: string[] } {
  const rest: string[] = [];
  let account: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--account") account = argv[++i];
    else if (a.startsWith("--account=")) account = a.slice("--account=".length);
    else rest.push(a);
  }
  if (!account) die(`ERROR: --account <name> is required (${accountNames().join(", ")})`);
  return { account: useAccount(account), rest };
}

// ---- tokens -----------------------------------------------------------------

function daysUntil(iso: string): number {
  return Math.floor((Date.parse(iso) - Date.now()) / DAY_MS);
}

const warned = new Set<string>();

/** The account's Auth'n'Auth token -- for the Trading API (sent as
 * X-EBAY-API-IAF-TOKEN) and the Post-Order API (sent as `TOKEN <token>`). */
export function authnAuthToken(name: string): string {
  const creds = getAccount(name).authnauth;
  if (!creds?.token) {
    die(
      `ERROR: ${name} has no Auth'n'Auth token in credentials.json. Make one at developer.ebay.com ->\n` +
        "User Tokens -> Get a Token from eBay via Your Application -> Auth'n'Auth, then add it."
    );
  }
  if (creds.expiresAt) {
    const days = daysUntil(creds.expiresAt);
    if (days < 0) {
      die(`ERROR: ${name}'s Auth'n'Auth token expired ${creds.expiresAt}. Make a new one at developer.ebay.com -> User Tokens.`);
    }
    if (days < EXPIRY_WARNING_DAYS && !warned.has(name)) {
      warned.add(name);
      console.error(`WARNING: ${name}'s Auth'n'Auth token expires in ${days} day(s) (${creds.expiresAt}).`);
    }
  }
  return creds.token;
}

/** `sell.account` -> `https://api.ebay.com/oauth/api_scope/sell.account`;
 * full URLs pass through; `api_scope` is the base scope. */
export function expandScope(scope: string): string {
  if (scope.startsWith("https://")) return scope;
  if (scope === "api_scope") return SCOPE_BASE;
  return `${SCOPE_BASE}/${scope}`;
}

export function shortScope(scope: string): string {
  if (scope === SCOPE_BASE) return "api_scope";
  return scope.startsWith(`${SCOPE_BASE}/`) ? scope.slice(SCOPE_BASE.length + 1) : scope;
}

export interface TokenResponse {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
  refresh_token_expires_in?: number;
}

/** POST to eBay's OAuth token endpoint with the app's client credentials.
 * Throws with eBay's error / error_description on failure. */
export async function requestToken(params: Record<string, string>): Promise<TokenResponse> {
  const app = loadCredentials().app;
  if (!app?.clientId || !app.clientSecret) die('ERROR: credentials.json has no "app" { clientId, clientSecret }.');
  const basic = Buffer.from(`${app.clientId}:${app.clientSecret}`).toString("base64");
  const resp = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: `Basic ${basic}` },
    body: new URLSearchParams(params),
  });
  const text = await resp.text();
  let body: any;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`HTTP ${resp.status} from the token endpoint: ${text.slice(0, 500)}`);
  }
  if (!resp.ok || !body.access_token) {
    throw new Error(`${body.error ?? `HTTP ${resp.status}`}: ${body.error_description ?? text.slice(0, 500)}`);
  }
  return body as TokenResponse;
}

const inflight = new Map<string, Promise<string>>();

/**
 * An OAuth user access token for `name` that covers `scopes` (full URLs or
 * short names). Reuses the saved token while it's valid for 5+ more minutes;
 * otherwise refreshes it and saves the new one to credentials.json.
 */
export async function oauthToken(name: string, scopes: string[]): Promise<string> {
  const needed = [...new Set(scopes.map(expandScope))];
  const key = `${name} ${needed.join(" ")}`;
  let pending = inflight.get(key);
  if (!pending) {
    pending = mintOrReuse(name, needed).finally(() => inflight.delete(key));
    inflight.set(key, pending);
  }
  return pending;
}

async function mintOrReuse(name: string, needed: string[]): Promise<string> {
  const o = getAccount(name).oauth ?? {};
  const login = `npx tsx src/ebay_login.ts --account ${name}`;

  if (
    o.accessToken &&
    o.accessTokenExpiresAt &&
    Date.parse(o.accessTokenExpiresAt) - Date.now() > ACCESS_TOKEN_MARGIN_MS &&
    needed.every((s) => o.accessTokenScopes?.includes(s))
  ) {
    return o.accessToken;
  }

  if (!o.refreshToken) die(`ERROR: ${name} has no OAuth refresh token. Sign in once with:\n  ${login}`);
  if (o.refreshTokenExpiresAt && Date.parse(o.refreshTokenExpiresAt) < Date.now()) {
    die(`ERROR: ${name}'s OAuth refresh token expired ${o.refreshTokenExpiresAt}. Sign in again with:\n  ${login}`);
  }
  const missing = o.scopes ? needed.filter((s) => !o.scopes!.includes(s)) : [];
  if (missing.length) {
    die(
      `ERROR: ${name}'s sign-in wasn't granted ${missing.map(shortScope).join(", ")}.\n` +
        `Sign in again including it:\n  ${login} --scopes ${[...o.scopes!, ...missing].map(shortScope).join(" ")}`
    );
  }

  // Ask for everything the refresh token was granted, so the one access token
  // serves every API; for an older refresh token of unknown grant, only what's needed.
  const request = o.scopes ?? needed;
  let body: TokenResponse;
  try {
    body = await requestToken({ grant_type: "refresh_token", refresh_token: o.refreshToken, scope: request.join(" ") });
  } catch (err) {
    die(
      `ERROR refreshing ${name}'s OAuth token (${request.map(shortScope).join(", ")}):\n  ${(err as Error).message}\n` +
        `If the refresh token was revoked, expired, or never granted these scopes, sign in again:\n  ${login}`
    );
  }

  updateAccount(name, (a) => {
    a.oauth = {
      ...a.oauth,
      accessToken: body.access_token,
      accessTokenExpiresAt: new Date(Date.now() + body.expires_in * 1000).toISOString(),
      accessTokenScopes: request,
    };
  });
  console.error(`[auth] refreshed ${name}'s OAuth access token (valid ${Math.round(body.expires_in / 60)} min)`);
  return body.access_token;
}

/** The eBay user ID a token belongs to (Trading API GetUser). Works with an
 * Auth'n'Auth token or an OAuth user token. */
export async function getUserId(token: string): Promise<string> {
  const resp = await fetch(TRADING_API, {
    method: "POST",
    headers: {
      "Content-Type": "text/xml",
      "X-EBAY-API-SITEID": "0",
      "X-EBAY-API-COMPATIBILITY-LEVEL": "1193",
      "X-EBAY-API-CALL-NAME": "GetUser",
      "X-EBAY-API-IAF-TOKEN": token,
    },
    body: `<?xml version="1.0" encoding="utf-8"?>
<GetUserRequest xmlns="urn:ebay:apis:eBLBaseComponents"></GetUserRequest>`,
  });
  const xml = await resp.text();
  const ack = findText(xml, "Ack") ?? `HTTP ${resp.status}`;
  if (ack !== "Success" && ack !== "Warning") {
    const why = findErrors(xml).map((e) => e.long || e.short).join("; ");
    throw new Error(`GetUser failed (${ack})${why ? `: ${why}` : ""}`);
  }
  // Exact tag match -- findText would also accept <UserIDChanged> etc.
  const id = /<UserID>([^<]+)<\/UserID>/.exec(xml)?.[1];
  if (!id) throw new Error("GetUser returned no UserID");
  return id;
}

// ---- CLI --------------------------------------------------------------------

function describeExpiry(iso: string | undefined): string {
  if (!iso) return "expiry unknown";
  const days = daysUntil(iso);
  const date = iso.slice(0, 10);
  if (days < 0) return `EXPIRED ${date}`;
  const flag = days < EXPIRY_WARNING_DAYS ? "  <-- WARNING: renew soon" : "";
  return `expires ${date} (in ${days} days)${flag}`;
}

function status(): void {
  const creds = loadCredentials();
  const app = creds.app;
  console.log(`app keys: ${app?.clientId && app.clientSecret ? "present" : "MISSING"}${app?.ruName ? ", RuName set" : ", no RuName"}`);
  for (const [name, a] of Object.entries(creds.accounts)) {
    const o = a.oauth ?? {};
    const login = `run: npx tsx src/ebay_login.ts --account ${name}`;
    let access = "none";
    if (o.accessToken) {
      const exp = o.accessTokenExpiresAt ? Date.parse(o.accessTokenExpiresAt) : NaN;
      access = exp > Date.now()
        ? `valid for ${Math.round((exp - Date.now()) / 60000)} more min (${(o.accessTokenScopes ?? []).map(shortScope).join(", ")})`
        : o.refreshToken ? "expired (refreshed automatically when needed)" : "expired";
    }
    console.log(`\n${name}  (eBay user: ${a.ebayUserId ?? `unknown -- run: npx tsx src/ebay_auth.ts whoami --account ${name}`})`);
    console.log(`  Auth'n'Auth token    ${a.authnauth?.token ? describeExpiry(a.authnauth.expiresAt) : "MISSING"}   [Trading, Post-Order]`);
    console.log(`  OAuth refresh token  ${o.refreshToken ? describeExpiry(o.refreshTokenExpiresAt) : `MISSING -- ${login}`}   [REST Sell APIs]`);
    if (o.refreshToken) {
      console.log(`  OAuth scopes         ${o.scopes ? o.scopes.map(shortScope).join(", ") : "unknown (signed in before ebay_login.ts)"}`);
    }
    console.log(`  OAuth access token   ${access}`);
  }
}

async function whoami(name: string): Promise<void> {
  const id = await getUserId(authnAuthToken(name));
  const stored = getAccount(name).ebayUserId;
  if (stored && stored.toLowerCase() !== id.toLowerCase()) {
    die(`MISMATCH: ${name}'s token belongs to eBay user '${id}', but credentials.json records '${stored}'. Nothing changed.`);
  }
  if (!stored) updateAccount(name, (a) => (a.ebayUserId = id));
  console.log(`${name} -> eBay user ${id}${stored ? "" : " (recorded)"}`);
}

async function cli(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  if (command === "status") return status();
  if (command === "whoami") return whoami(accountFromArgs(args).account);
  if (command === "token") {
    const { account, rest } = accountFromArgs(args);
    if (rest[0] !== "--oauth") {
      if (rest.length) die(`ERROR: unexpected arguments: ${rest.join(" ")}`);
      console.log(authnAuthToken(account));
      return;
    }
    const scopes = rest.slice(1);
    const granted = getAccount(account).oauth?.scopes;
    if (!scopes.length && !granted) die("ERROR: name the scopes you need, e.g. --oauth sell.account");
    console.log(await oauthToken(account, scopes.length ? scopes : granted!));
    return;
  }
  die(
    "Usage:\n" +
      "  npx tsx src/ebay_auth.ts status\n" +
      "  npx tsx src/ebay_auth.ts whoami --account <name>\n" +
      "  npx tsx src/ebay_auth.ts token --account <name> [--oauth [scope ...]]"
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  cli().catch((err) => die(String(err?.stack ?? err)));
}
