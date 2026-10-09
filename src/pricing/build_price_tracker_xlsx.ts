#!/usr/bin/env -S npx tsx
/**
 * build_price_tracker_xlsx.ts -- turn the CSVs written by tracking_price_diff.ts
 * into an Excel workbook laid out like the "[Claude] key pages ... from eBay
 * Price Tracker" Google Sheet: "Tracking Page Price" and "Deactivate" sheets.
 *
 * Usage:
 *   npx tsx src/pricing/build_price_tracker_xlsx.ts <prefix> <output.xlsx>
 *   e.g. npx tsx src/pricing/build_price_tracker_xlsx.ts reports/key-pages-20-30 reports/key-pages-20-30.xlsx
 */

import { readFileSync } from "node:fs";
import ExcelJS from "exceljs";
import { die } from "../auth/ebay_auth.ts";
import { parseCsv } from "../lib/csv.ts";
import { runMain } from "../lib/util.ts";

const WIDTHS = [26, 22, 24, 18, 20, 12, 22];

function addSheet(wb: ExcelJS.Workbook, name: string, csvPath: string) {
  const [header, ...data] = parseCsv(readFileSync(csvPath, "utf8"));
  const ws = wb.addWorksheet(name, { views: [{ state: "frozen", ySplit: 1 }] });
  ws.addRow(header).font = { bold: true };
  for (const r of data) {
    const [track, price, key, keyPrice, , deact, comment] = r;
    const row = ws.addRow([
      Number(track), price === "" ? null : Number(price), Number(key), Number(keyPrice), null, deact || null, comment || null,
    ]);
    // difference stays a live formula, as in the Google Sheet
    row.getCell(5).value = price === "" ? null : { formula: `B${row.number}-D${row.number}`, result: Math.round((Number(price) - Number(keyPrice)) * 100) / 100 };
  }
  WIDTHS.forEach((w, i) => (ws.getColumn(i + 1).width = w));
  for (const c of [1, 3]) ws.getColumn(c).numFmt = "0";
  return data.length;
}

async function main() {
  const [prefix, out] = process.argv.slice(2);
  if (!prefix || !out) die("Usage: npx tsx src/pricing/build_price_tracker_xlsx.ts <prefix> <output.xlsx>");
  const wb = new ExcelJS.Workbook();
  const a = addSheet(wb, "Tracking Page Price", `${prefix}-tracking-page-price.csv`);
  const d = addSheet(wb, "Deactivate", `${prefix}-deactivate.csv`);
  await wb.xlsx.writeFile(out);
  console.log(`Wrote ${out}: Tracking Page Price ${a} rows, Deactivate ${d} rows`);
}

runMain(main);
