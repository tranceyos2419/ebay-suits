#!/usr/bin/env -S npx tsx
/**
 * web_env.ts -- builds the "Environment variables" block for the `ebay-suits`
 * Claude Code web environment from the local credentials.json, so web
 * sessions have exactly the same credentials as this computer.
 *
 * Run it on your own computer, whenever credentials.json changes (a new eBay
 * sign-in, new scopes, a new Ship&Co token):
 *   npm run web-env
 * It copies the block to the clipboard (macOS pbcopy) without showing it. Then
 * in claude.ai/code: environment menu -> hover ebay-suits -> edit ->
 * Environment variables -> select everything in the box, paste, Save changes,
 * and start a new session (variables load when a session starts).
 *
 *   --print   write the block to stdout instead (it contains secrets)
 *
 * The block holds:
 *   EBAY_CREDENTIALS_JSON  the whole credentials.json (eBay keys and tokens,
 *                          and the Ship&Co token under shipandco.apiToken),
 *                          read by src/auth/ebay_auth.ts and src/lib/shipandco_api.ts
 *   NODE_USE_ENV_PROXY=1   makes Node's fetch use the web sandbox's proxy;
 *                          without it every API call fails with "fetch failed"
 */

import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { CREDS_PATH, CREDS_ENV, die } from "./ebay_auth.ts";

if (!existsSync(CREDS_PATH)) die(`ERROR: no credentials.json at ${CREDS_PATH} -- run this on the computer that has it.`);

let creds: any;
try {
  creds = JSON.parse(readFileSync(CREDS_PATH, "utf8"));
} catch (err) {
  die(`ERROR: ${CREDS_PATH} is not valid JSON (${(err as Error).message})`);
}

const json = JSON.stringify(creds);
// The value goes in single quotes (.env format: taken literally), so it can't contain one.
if (json.includes("'")) die("ERROR: credentials.json contains a single quote ('); remove it (e.g. from a note) and retry.");

const block = [`${CREDS_ENV}='${json}'`, "NODE_USE_ENV_PROXY=1", ""].join("\n");

const accounts = Object.keys(creds.accounts ?? {});
const summary =
  `accounts: ${accounts.join(", ") || "NONE"}; ` +
  `eBay app keys: ${creds.app?.clientId && creds.app?.clientSecret ? "yes" : "MISSING"}; ` +
  `Ship&Co token: ${creds.shipandco?.apiToken ? "yes" : "MISSING"}`;

if (process.argv.includes("--print")) {
  process.stdout.write(block);
  console.error(`\n(${summary})`);
} else {
  const r = spawnSync("pbcopy", { input: block });
  if (r.error || r.status !== 0) die("ERROR: couldn't copy to the clipboard (pbcopy is macOS-only). Re-run with --print.");
  console.log(`Copied the web environment variables to the clipboard (${summary}).`);
  console.log("Now: claude.ai/code -> environment menu -> ebay-suits -> edit -> Environment variables");
  console.log("     -> select all in the box, paste, Save changes -> start a new session.");
}
