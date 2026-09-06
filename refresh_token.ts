#!/usr/bin/env -S npx tsx
/**
 * refresh_token.ts -- mint a fresh eBay OAuth access token from a saved
 * refresh token. No browser, no login -- this is what refresh tokens are for.
 *
 * Requires three environment variables:
 *   EBAY_CLIENT_ID       Your app's Client ID (App ID)
 *   EBAY_CLIENT_SECRET   Your app's Client Secret (Cert ID)
 *   EBAY_REFRESH_TOKEN   The refresh token eBay showed you when you first
 *                         generated a User Token (valid ~18 months)
 *
 * Optional:
 *   EBAY_SCOPES           Space-separated scopes to request (default below)
 *
 * Prints ONLY the new access token to stdout (nothing else), so you can do:
 *
 *   export EBAY_ACCESS_TOKEN=$(npx tsx refresh_token.ts)
 *
 * Errors go to stderr so they don't get captured into the export above.
 */

const DEFAULT_SCOPES = [
  "https://api.ebay.com/oauth/api_scope",
  "https://api.ebay.com/oauth/api_scope/sell.account",
  "https://api.ebay.com/oauth/api_scope/sell.inventory",
].join(" ");

function envOrDie(name: string): string {
  const val = process.env[name];
  if (!val) {
    console.error(`ERROR: environment variable ${name} is not set.`);
    process.exit(1);
  }
  return val;
}

async function main() {
  const clientId = envOrDie("EBAY_CLIENT_ID");
  const clientSecret = envOrDie("EBAY_CLIENT_SECRET");
  const refreshToken = envOrDie("EBAY_REFRESH_TOKEN");
  const scopes = process.env.EBAY_SCOPES ?? DEFAULT_SCOPES;

  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");

  const data = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    scope: scopes,
  });

  const resp = await fetch("https://api.ebay.com/identity/v1/oauth2/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${basic}`,
    },
    body: data,
  });

  if (!resp.ok) {
    const errBody = await resp.text();
    console.error(`ERROR ${resp.status} refreshing token:\n${errBody}`);
    process.exit(1);
  }

  const body = (await resp.json()) as { access_token?: string; expires_in?: number; scope?: string };
  const accessToken = body.access_token;
  if (!accessToken) {
    console.error(`ERROR: no access_token in response: ${JSON.stringify(body)}`);
    process.exit(1);
  }

  // Only the token goes to stdout -- everything else (if you want to see
  // expiry, granted scopes, etc.) goes to stderr.
  console.error(`expires_in=${body.expires_in} scope=${body.scope ?? ""}`);
  console.log(accessToken);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
