#!/usr/bin/env -S npx tsx
/**
 * get_token.ts -- look up a saved account's eBay token by name and print it
 * to stdout (nothing else), so it can be used like:
 *
 *   export EBAY_ACCESS_TOKEN=$(npx tsx get_token.ts jdm-direct-motors)
 *   npx tsx check_item.ts 397429202355
 *
 * Reads from credentials.json in the project root. That file should be
 * chmod 600 (owner-read-only) and never committed to version control or
 * shared -- the tokens in it are long-lived (Auth'n'Auth tokens can be valid
 * for ~2+ years).
 */

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const CREDS_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "credentials.json");

interface CredentialEntry {
  token?: string;
  expires?: string;
}

function main() {
  const account = process.argv[2];
  if (!account || process.argv.length !== 3) {
    console.error("Usage: npx tsx get_token.ts <account-name>\n(e.g. jdm-direct-motors or love-of-japan)");
    process.exit(1);
  }

  if (!existsSync(CREDS_PATH)) {
    console.error(`ERROR: no credentials.json found at ${CREDS_PATH}`);
    process.exit(1);
  }

  const creds: Record<string, CredentialEntry> = JSON.parse(readFileSync(CREDS_PATH, "utf8"));

  if (!(account in creds)) {
    const known = Object.keys(creds).join(", ") || "(none saved yet)";
    console.error(`ERROR: no saved credentials for '${account}'. Known accounts: ${known}`);
    process.exit(1);
  }

  const token = creds[account].token;
  if (!token) {
    console.error(`ERROR: entry for '${account}' has no 'token' field.`);
    process.exit(1);
  }

  const expires = creds[account].expires;
  if (expires) {
    console.error(`(token for ${account} expires ${expires})`);
  }

  console.log(token);
}

main();
