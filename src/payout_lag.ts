#!/usr/bin/env -S npx tsx
/**
 * payout_lag.ts -- how many days, on average, pass between a sale and the
 * payout that sends its funds to the seller's bank / Payoneer account.
 *
 * Uses the Sell Finances API: every SUCCEEDED payout in the window, then the
 * SALE transactions bundled into each payout. Lag = payoutDate - sale
 * transactionDate (when eBay recorded the buyer's payment).
 *
 * Needs the sell.finances OAuth scope. Sign in including it with:
 *   npx tsx src/ebay_login.ts --account <name> --scopes api_scope sell.account sell.inventory sell.negotiation sell.fulfillment sell.finances
 *
 * Usage:
 *   npx tsx src/payout_lag.ts --account <name> [DAYS] [--json out.json]
 *
 * DAYS defaults to 180 (payouts dated within the last DAYS days).
 */

import { writeFileSync } from "node:fs";
import { accountFromArgs, die, oauthToken } from "./ebay_auth.ts";

const FINANCES_API = "https://apiz.ebay.com/sell/finances/v1";
const FINANCES_SCOPE = "sell.finances";
const DAY_MS = 86_400_000;

interface Payout {
  payoutId: string;
  payoutDate: string;
  payoutStatus: string;
  amount: { value: string; currency: string };
  payoutInstrument?: { instrumentType?: string; nickname?: string; accountLastFourDigits?: string };
}

interface Transaction {
  transactionId: string;
  orderId?: string;
  transactionDate: string;
  transactionType: string;
  amount: { value: string; currency: string };
}

async function getJson<T>(token: string, path: string): Promise<T> {
  const resp = await fetch(`${FINANCES_API}${path}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
  });
  if (!resp.ok) die(`ERROR ${resp.status} GET ${path}\n${(await resp.text()).slice(0, 800)}`);
  return (await resp.json()) as T;
}

async function getPayouts(token: string, from: Date, to: Date): Promise<Payout[]> {
  const out: Payout[] = [];
  const filter = encodeURIComponent(`payoutDate:[${from.toISOString()}..${to.toISOString()}],payoutStatus:{SUCCEEDED}`);
  for (let offset = 0; ; offset += 200) {
    const page = await getJson<{ payouts?: Payout[]; total?: number }>(
      token,
      `/payout?filter=${filter}&limit=200&offset=${offset}&sort=payoutDate`
    );
    out.push(...(page.payouts ?? []));
    if (!page.payouts?.length || out.length >= (page.total ?? 0)) break;
  }
  return out;
}

async function getSales(token: string, payoutId: string): Promise<Transaction[]> {
  const out: Transaction[] = [];
  const filter = encodeURIComponent(`payoutId:{${payoutId}},transactionType:{SALE}`);
  for (let offset = 0; ; offset += 1000) {
    const page = await getJson<{ transactions?: Transaction[]; total?: number }>(
      token,
      `/transaction?filter=${filter}&limit=1000&offset=${offset}`
    );
    out.push(...(page.transactions ?? []));
    if (!page.transactions?.length || out.length >= (page.total ?? 0)) break;
  }
  return out;
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function instrumentLabel(p: Payout): string {
  const i = p.payoutInstrument;
  if (!i) return "(unknown)";
  return [i.nickname, i.instrumentType, i.accountLastFourDigits && `x${i.accountLastFourDigits}`].filter(Boolean).join(" ");
}

async function main(): Promise<void> {
  const { account, rest } = accountFromArgs(process.argv.slice(2));
  let days = 180;
  let jsonOut: string | undefined;
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "--json") jsonOut = rest[++i];
    else if (/^\d+$/.test(rest[i])) days = parseInt(rest[i], 10);
    else die(`Unknown argument: ${rest[i]}`);
  }

  const token = await oauthToken(account, [FINANCES_SCOPE]);
  const to = new Date();
  const from = new Date(to.getTime() - days * DAY_MS);
  const payouts = await getPayouts(token, from, to);
  console.error(`[payouts] ${payouts.length} succeeded payouts in the last ${days} days`);

  const rows: { payoutId: string; payoutDate: string; instrument: string; orderId?: string; saleDate: string; lagDays: number }[] = [];
  for (const p of payouts) {
    for (const t of await getSales(token, p.payoutId)) {
      const lagDays = (Date.parse(p.payoutDate) - Date.parse(t.transactionDate)) / DAY_MS;
      rows.push({ payoutId: p.payoutId, payoutDate: p.payoutDate, instrument: instrumentLabel(p), orderId: t.orderId, saleDate: t.transactionDate, lagDays });
    }
  }
  if (!rows.length) die("No SALE transactions found in payouts for this window.");

  const lags = rows.map((r) => r.lagDays);
  const avg = lags.reduce((a, b) => a + b, 0) / lags.length;
  const intervals = payouts
    .slice(1)
    .map((p, i) => (Date.parse(p.payoutDate) - Date.parse(payouts[i].payoutDate)) / DAY_MS);

  console.log(`account:            ${account}`);
  console.log(`window:             ${from.toISOString().slice(0, 10)} .. ${to.toISOString().slice(0, 10)}`);
  console.log(`payouts:            ${payouts.length}`);
  console.log(`payout destination: ${[...new Set(payouts.map(instrumentLabel))].join(", ")}`);
  if (intervals.length) console.log(`avg payout interval: ${(intervals.reduce((a, b) => a + b, 0) / intervals.length).toFixed(1)} days`);
  console.log(`sales:              ${rows.length}`);
  console.log(`sale -> payout:     avg ${avg.toFixed(1)} days, median ${median(lags).toFixed(1)}, min ${Math.min(...lags).toFixed(1)}, max ${Math.max(...lags).toFixed(1)}`);

  if (jsonOut) {
    writeFileSync(jsonOut, JSON.stringify({ account, from, to, payouts, rows }, null, 2));
    console.error(`[json] wrote ${jsonOut}`);
  }
}

main();
