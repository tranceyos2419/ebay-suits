#!/usr/bin/env -S npx tsx
/**
 * ebay_login.ts -- sign a seller account in to our eBay app (OAuth
 * authorization-code grant) and save its refresh token, so the REST Sell
 * APIs work for that account without the developer portal. After this,
 * src/ebay_auth.ts mints 2-hour access tokens from the refresh token on
 * demand (~18 months, until the refresh token expires).
 *
 * Usage (run it in your own terminal -- it waits for you to paste):
 *   npx tsx src/ebay_login.ts --account love-of-japan
 *   npx tsx src/ebay_login.ts --account love-of-japan --scopes sell.account sell.negotiation
 *
 *   1. It prints an eBay sign-in link. Open it and sign in AS THAT SELLER
 *      (prompt=login forces a fresh sign-in, so whoever is already signed in
 *      to eBay in the browser doesn't get used by accident), then agree.
 *   2. eBay sends the browser to the app's "auth accepted" page. Copy that
 *      page's full address from the address bar and paste it back here
 *      (just the code= value works too). The code is only valid ~5 minutes.
 *   3. It swaps the code for access + refresh tokens, checks with GetUser that
 *      they belong to the right eBay user, and only then saves them.
 *
 * Non-interactive: pass the pasted address/code with --code '<...>'.
 *
 * Needs "app" { clientId, clientSecret, ruName } in credentials.json, and the
 * RuName must have OAuth enabled (developer.ebay.com -> User Tokens ->
 * "Your eBay Sign-in Settings").
 */

import { randomBytes } from "node:crypto";
import { createInterface } from "node:readline/promises";
import {
  accountFromArgs,
  authnAuthToken,
  die,
  expandScope,
  getAccount,
  getUserId,
  loadCredentials,
  requestToken,
  shortScope,
  updateAccount,
  type TokenResponse,
} from "./ebay_auth.ts";

const AUTHORIZE_URL = "https://auth.ebay.com/oauth2/authorize";

// Asked for once at sign-in, so a script using another of these APIs later
// doesn't need a new sign-in. api_scope is the base scope; the Trading API
// (GetUser, for the identity check below) accepts a token carrying it.
const DEFAULT_SCOPES = ["api_scope", "sell.account", "sell.inventory", "sell.negotiation", "sell.fulfillment"];

function parseArgs(argv: string[]): { account: string; scopes: string[]; code?: string } {
  const { account, rest } = accountFromArgs(argv);
  let scopes: string[] | undefined;
  let code: string | undefined;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--scopes") {
      scopes = [];
      while (rest[i + 1] && !rest[i + 1].startsWith("--")) scopes.push(rest[++i]);
    } else if (a === "--code") code = rest[++i];
    else die(`ERROR: unknown argument ${a}`);
  }
  const chosen = scopes?.length ? scopes : DEFAULT_SCOPES;
  // GetUser (the identity check) needs the base scope.
  if (!chosen.map(expandScope).includes(expandScope("api_scope"))) chosen.unshift("api_scope");
  return { account, scopes: [...new Set(chosen.map(expandScope))], code };
}

/** Accept the full redirect address, or just the code (URL-encoded or not). */
function extractCode(input: string): { code: string; state?: string } {
  const s = input.trim();
  if (/^https?:\/\//i.test(s)) {
    const url = new URL(s);
    const code = url.searchParams.get("code");
    if (!code) {
      die(
        "ERROR: that address has no code= in it." +
          (url.searchParams.get("isAuthSuccessful") === "false" ? " eBay says the sign-in was declined." : "")
      );
    }
    return { code, state: url.searchParams.get("state") ?? undefined };
  }
  return { code: s.includes("%") ? decodeURIComponent(s) : s };
}

async function main() {
  const { account, scopes, code: codeArg } = parseArgs(process.argv.slice(2));
  const app = loadCredentials().app;
  if (!app?.ruName) die('ERROR: credentials.json has no "app".ruName (the app\'s RuName / redirect_uri).');

  let pasted = codeArg;
  const state = randomBytes(12).toString("hex");
  if (!pasted) {
    // URLSearchParams writes spaces as "+"; eBay's examples use %20 between
    // scopes. (A literal "+" would have been encoded as %2B, so this is safe.)
    const query = new URLSearchParams({
      client_id: app.clientId,
      redirect_uri: app.ruName,
      response_type: "code",
      scope: scopes.join(" "),
      state,
      prompt: "login",
    })
      .toString()
      .replace(/\+/g, "%20");
    const url = `${AUTHORIZE_URL}?${query}`;
    console.error(`\nSigning in ${account} with scopes: ${scopes.map(shortScope).join(", ")}\n`);
    console.error(`1. Open this link and sign in as the eBay seller '${getAccount(account).ebayUserId ?? account}':\n\n${url}\n`);
    console.error("2. After agreeing, copy the full address of the page eBay sends you to.\n");
    if (!process.stdin.isTTY) {
      die(`No terminal to paste into -- re-run with:\n  npx tsx src/ebay_login.ts --account ${account} --code '<address or code>'`);
    }
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    pasted = await rl.question("3. Paste it here: ");
    rl.close();
  }

  const { code, state: returnedState } = extractCode(pasted);
  if (!codeArg && returnedState && returnedState !== state) {
    die("ERROR: the pasted address is from a different sign-in attempt (state mismatch). Nothing was saved.");
  }

  let tokens: TokenResponse;
  try {
    tokens = await requestToken({ grant_type: "authorization_code", code, redirect_uri: app.ruName });
  } catch (err) {
    die(`ERROR exchanging the code (codes expire after ~5 minutes and work once):\n  ${(err as Error).message}`);
  }
  if (!tokens.refresh_token) die("ERROR: eBay returned no refresh token. Nothing was saved.");

  // Make sure the browser was signed in as the right seller before saving.
  let signedInAs: string;
  try {
    signedInAs = await getUserId(tokens.access_token);
  } catch (err) {
    die(`ERROR: couldn't confirm which eBay user signed in (${(err as Error).message}). Nothing was saved.`);
  }
  const current = getAccount(account);
  const expected = current.ebayUserId ?? (current.authnauth?.token ? await getUserId(authnAuthToken(account)) : undefined);
  if (expected && expected.toLowerCase() !== signedInAs.toLowerCase()) {
    die(
      `ERROR: the browser signed in as eBay user '${signedInAs}', but ${account} is '${expected}'.\n` +
        "Nothing was saved. Sign out of eBay in the browser and run this again as the right seller."
    );
  }

  const now = Date.now();
  updateAccount(account, (a) => {
    a.ebayUserId ??= signedInAs;
    a.oauth = {
      refreshToken: tokens.refresh_token,
      refreshTokenExpiresAt: tokens.refresh_token_expires_in
        ? new Date(now + tokens.refresh_token_expires_in * 1000).toISOString()
        : undefined,
      scopes,
      signedInAt: new Date(now).toISOString(),
      accessToken: tokens.access_token,
      accessTokenExpiresAt: new Date(now + tokens.expires_in * 1000).toISOString(),
      accessTokenScopes: scopes,
    };
  });

  console.error(`\nSaved. ${account} (eBay user ${signedInAs}) is signed in.`);
  console.error(`Check it with: npx tsx src/ebay_auth.ts status`);
}

main().catch((err) => die(String(err?.stack ?? err)));
