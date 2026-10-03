#!/usr/bin/env -S npx tsx
/**
 * fill_tracking_page_price.ts -- fill the "Tracking Page Price" sheet of a
 * "key pages ... eBay Price Tracker.xlsx" export.
 *
 * Reads every key page (col A, price col C) and its TrackingPage 01-20 item IDs
 * (cols Q..AJ) from the "Downloaded Data" sheet, looks up each tracking page's
 * current price with Trading API GetItem, and appends one row per tracking page
 * to "Tracking Page Price" (existing rows, e.g. the example row, are kept).
 * Deactivate = "Yes" when tracking price - key price < THRESHOLD.
 * The workbook is edited in place (XML level); a backup is written next to it.
 *
 * Usage:
 *   npx tsx src/fill_tracking_page_price.ts --account jdm-direct-motors <file.xlsx> [--threshold 9] [--drop-example]
 */

import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { findErrors, findText } from "./xml_util.ts";
import { accountFromArgs, authnAuthToken } from "./ebay_auth.ts";

const TRACK_COLS = ["Q","R","S","T","U","V","W","X","Y","Z","AA","AB","AC","AD","AE","AF","AG","AH","AI","AJ"];

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const idStr = (v: string) => String(Math.round(Number(v)));

function parseRows(xml: string, shared: string[]) {
  const rows: Record<string, string>[] = [];
  for (const m of xml.matchAll(/<row r="(\d+)"[^>]*>(.*?)<\/row>/gs)) {
    const row: Record<string, string> = { _r: m[1] };
    for (const c of m[2].matchAll(/<c r="([A-Z]+)\d+"([^>]*?)>(?:<f>.*?<\/f>)?<v>(.*?)<\/v>/gs)) {
      row[c[1]] = /t="s"/.test(c[2]) ? shared[Number(c[3])] : c[3];
    }
    rows.push(row);
  }
  return rows;
}

async function getPrice(itemId: string, token: string): Promise<{ price?: number; note?: string }> {
  const body = `<?xml version="1.0" encoding="utf-8"?>
<GetItemRequest xmlns="urn:ebay:apis:eBLBaseComponents"><ItemID>${itemId}</ItemID><DetailLevel>ReturnAll</DetailLevel></GetItemRequest>`;
  for (let attempt = 0; attempt < 3; attempt++) {
    const resp = await fetch("https://api.ebay.com/ws/api.dll", {
      method: "POST",
      headers: {
        "Content-Type": "text/xml",
        "X-EBAY-API-SITEID": "0",
        "X-EBAY-API-COMPATIBILITY-LEVEL": "1193",
        "X-EBAY-API-CALL-NAME": "GetItem",
        "X-EBAY-API-IAF-TOKEN": token,
      },
      body,
    });
    const xml = await resp.text();
    const ack = findText(xml, "Ack");
    if (ack === "Success" || ack === "Warning") {
      const status = findText(xml, "ListingStatus");
      const prices = [...xml.matchAll(/<(?:CurrentPrice|StartPrice)[^>]*>([\d.]+)</g)].map((m) => Number(m[1]));
      const price = prices.length ? Math.min(...prices) : undefined;
      if (price === undefined) return { note: "no price in response" };
      return { price, note: status && status !== "Active" ? `Listing ${status}` : undefined };
    }
    const errs = findErrors(xml);
    if (errs.some((e) => /rate|limit|exceeded|temporar/i.test(e.long + e.short))) {
      await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
      continue;
    }
    return { note: errs[0]?.short ?? `HTTP ${resp.status}` };
  }
  return { note: "API retries exhausted" };
}

async function main() {
  const { account, rest } = accountFromArgs(process.argv.slice(2));
  const ti = rest.indexOf("--threshold");
  const threshold = ti >= 0 ? Number(rest[ti + 1]) : 9;
  const file = resolve(rest.filter((a, i) => !a.startsWith("--") && (ti < 0 || i !== ti + 1))[0] ?? "");
  if (!existsSync(file)) {
    console.error("Usage: npx tsx src/fill_tracking_page_price.ts --account <name> <file.xlsx> [--threshold 9] [--drop-example]");
    process.exit(1);
  }
  const token = authnAuthToken(account);

  const dir = mkdtempSync(join(tmpdir(), "xlsx-"));
  execFileSync("unzip", ["-q", "-o", file, "-d", dir]);
  const shared = [...readFileSync(join(dir, "xl/sharedStrings.xml"), "utf8").matchAll(/<si>(.*?)<\/si>/gs)].map(
    (m) => m[1].replace(/<[^>]+>/g, "").replace(/&amp;/g, "&"),
  );
  const data = parseRows(readFileSync(join(dir, "xl/worksheets/sheet1.xml"), "utf8"), shared).slice(1);
  const sheet2Path = join(dir, "xl/worksheets/sheet2.xml");
  let sheet2 = readFileSync(sheet2Path, "utf8");

  const pairs: { track: string; key: string; keyPrice: number }[] = [];
  const seen = new Set<string>();
  for (const r of data) {
    if (!r.A) continue;
    for (const c of TRACK_COLS) {
      if (!r[c]) continue;
      const track = idStr(r[c]);
      if (seen.has(track)) continue;
      seen.add(track);
      pairs.push({ track, key: idStr(r.A), keyPrice: Number(r.C) });
    }
  }
  if (rest.includes("--drop-example")) sheet2 = sheet2.replace(/<row r="2"[^>]*?(?:\/>|>.*?<\/row>)/s, "");
  // skip tracking pages already on the sheet
  const existing = new Set([...sheet2.matchAll(/<c r="A\d+"[^>]*><v>(.*?)<\/v>/g)].map((m) => idStr(m[1])));
  const todo = pairs.filter((p) => !existing.has(p.track));
  console.log(`${pairs.length} tracking pages, ${todo.length} to fill`);

  const results = new Map<string, { price?: number; note?: string }>();
  let next = 0;
  await Promise.all(
    Array.from({ length: 5 }, async () => {
      while (next < todo.length) {
        const p = todo[next++];
        results.set(p.track, await getPrice(p.track, token));
      }
    }),
  );

  // Sheets can ship with blank pre-formatted rows; drop those and append right after the last row with data.
  const rowRe = /<row r="(\d+)"[^>]*?(?:\/>|>(.*?)<\/row>)/gs;
  const lastRow = Math.max(1, ...[...sheet2.matchAll(rowRe)].filter((m) => /<v>/.test(m[2] ?? "")).map((m) => Number(m[1])));
  sheet2 = sheet2.replace(rowRe, (all, r) => (Number(r) > lastRow ? "" : all));
  let rowsXml = "";
  let n = lastRow;
  let yes = 0, missing = 0;
  for (const p of todo) {
    const res = results.get(p.track)!;
    n++;
    const r = n;
    const num = (col: string, v: number | string, s = 1) => `<c r="${col}${r}" s="${s}"><v>${v}</v></c>`;
    const str = (col: string, v: string) => `<c r="${col}${r}" s="1" t="inlineStr"><is><t>${esc(v)}</t></is></c>`;
    let cells = num("A", p.track);
    if (res.price !== undefined) {
      const diff = Math.round((res.price - p.keyPrice) * 100) / 100;
      const deact = diff < threshold;
      if (deact) yes++;
      cells += num("B", res.price) + num("C", p.key) + num("D", p.keyPrice);
      cells += `<c r="E${r}" s="3"><f>B${r}-D${r}</f><v>${diff}</v></c>`;
      if (deact) cells += str("F", "Yes");
      if (res.note) cells += str("G", res.note);
    } else {
      missing++;
      cells += `<c r="B${r}" s="1"/>` + num("C", p.key) + num("D", p.keyPrice) + `<c r="E${r}" s="3"/>` + `<c r="F${r}" s="1"/>`;
      cells += str("G", `Price lookup failed: ${res.note}`);
    }
    rowsXml += `<row r="${r}">${cells}</row>`;
  }
  sheet2 = sheet2.replace("</sheetData>", rowsXml + "</sheetData>");
  writeFileSync(sheet2Path, sheet2);

  copyFileSync(file, file.replace(/\.xlsx$/, ".backup.xlsx"));
  const out = join(dir, "out.xlsx");
  execFileSync("zip", ["-q", "-r", "-X", out, "[Content_Types].xml", "_rels", "xl"], { cwd: dir });
  copyFileSync(out, file);
  console.log(`Filled ${todo.length} rows: ${yes} Deactivate=Yes, ${missing} lookup failures. Saved ${file}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
