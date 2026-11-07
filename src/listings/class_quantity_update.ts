#!/usr/bin/env -S npx tsx
/**
 * class_quantity_update.ts -- set the available quantity of our listings from
 * the class filter views in the Value Checker sheet (Motors tab), e.g.
 * "Achmad - Class A" -> 4 and "Achmad - Class B" -> 2.
 *
 * The sheet is read by the caller (Google Sheets connector) and handed over
 * as JSON files, so this script needs no Google credentials:
 *   --spreadsheet <file>  spreadsheets.get output with sheets.filterViews
 *                         (fields: sheets.properties.title, sheets.properties.sheetId, sheets.filterViews)
 *   --values <file>       spreadsheets.values.get output ({range, values}); repeat
 *                         once per column range. Must cover the item-id column and
 *                         every column the chosen filter views filter on.
 *
 * A row counts as "in" a filter view the same way Sheets shows it: inside the
 * view's range, below the header row, and no filtered column's displayed value
 * is one of that column's hidden values. Any other kind of filter criteria
 * (conditions, colours) makes the script stop rather than guess.
 *
 * Listings already at the target quantity are left alone. Listings that are
 * not among our active listings are skipped. Without --apply nothing is changed on eBay.
 *
 * Usage:
 *   npx tsx src/listings/class_quantity_update.ts --account <name> \
 *     --spreadsheet fv.json --values H.json --values O.json ... \
 *     --sheet Motors --id-column O \
 *     --view "Achmad - Class A=4" --view "Achmad - Class B=2" [--apply] [--report out.csv]
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { accountFromArgs, die } from "../auth/ebay_auth.ts";
import {
  listingToken,
  MAX_SEARCH_LISTING_IDS,
  searchActiveListings,
  updateInventory,
  type ListingInfo,
  type UpdateResult,
} from "../lib/listing_api.ts";
import { mapLimit, runMain, sleep } from "../lib/util.ts";

/** eBay's GraphQL backends sometimes time out; those are safe to retry. */
const isTransient = (msg: string) => /timeout|retryIsAllowed=true|HTTP 5\d\d|ECONNRESET|fetch failed/i.test(msg);

async function withRetry<T>(label: string, fn: () => Promise<T>, attempts = 4): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (e) {
      const msg = String(e instanceof Error ? e.message : e);
      if (i >= attempts || !isTransient(msg)) throw e;
      console.log(`  [retry ${i}] ${label}: ${msg.split("\n")[0].slice(0, 160)}`);
      await sleep(2000 * 2 ** (i - 1));
    }
  }
}

const USAGE =
  'Usage: npx tsx src/listings/class_quantity_update.ts --account <name> --spreadsheet <file> --values <file> [--values <file> ...] ' +
  '--sheet <tab> --id-column <letter> --view "<filter view title>=<qty>" [--view ...] [--apply] [--report <csv>]';

interface FilterView {
  title: string;
  range: { sheetId: number; startRowIndex?: number; endRowIndex?: number; startColumnIndex?: number; endColumnIndex?: number };
  filterSpecs?: { columnIndex: number; filterCriteria?: Record<string, unknown> }[];
  criteria?: Record<string, Record<string, unknown>>;
}

/** "A" -> 0, "O" -> 14, "BI" -> 60. */
function colIndex(letters: string): number {
  let n = 0;
  for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function colLetters(index: number): string {
  let s = "";
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

/** Load a values.get dump into column -> (0-based row -> displayed value). */
function loadValues(file: string, sheet: string, cols: Map<number, Map<number, string>>): void {
  const dump = JSON.parse(readFileSync(file, "utf8")) as { range: string; values?: string[][] };
  const m = /^'?(.+?)'?!([A-Z]+)(\d+)(?::([A-Z]+)\d+)?$/i.exec(dump.range);
  if (!m) die(`${file}: can't parse range "${dump.range}"`);
  if (m[1] !== sheet) die(`${file}: range is on tab "${m[1]}", expected "${sheet}"`);
  const startCol = colIndex(m[2]);
  const endCol = colIndex(m[4] ?? m[2]);
  const startRow = Number(m[3]) - 1;
  for (let c = startCol; c <= endCol; c++) if (!cols.has(c)) cols.set(c, new Map());
  (dump.values ?? []).forEach((row, r) => {
    row.forEach((v, i) => cols.get(startCol + i)?.set(startRow + r, String(v ?? "")));
  });
}

/** Column index -> hidden values for one filter view; dies on criteria it can't evaluate. */
function hiddenValuesOf(view: FilterView): Map<number, Set<string>> {
  const out = new Map<number, Set<string>>();
  const specs =
    view.filterSpecs ??
    Object.entries(view.criteria ?? {}).map(([k, c]) => ({ columnIndex: Number(k), filterCriteria: c }));
  for (const s of specs) {
    const c = s.filterCriteria ?? {};
    for (const key of Object.keys(c)) {
      if (key !== "hiddenValues") die(`Filter view "${view.title}" column ${colLetters(s.columnIndex)} uses "${key}", which this script can't evaluate.`);
    }
    const hidden = (c.hiddenValues as string[] | undefined) ?? [];
    if (hidden.length) out.set(s.columnIndex, new Set(hidden));
  }
  return out;
}

interface Planned {
  itemId: string;
  view: string;
  target: number;
  rows: number[];
}

async function main() {
  const { account, rest } = accountFromArgs(process.argv.slice(2));
  const opt = (name: string) => {
    const i = rest.indexOf(name);
    return i === -1 ? undefined : rest[i + 1];
  };
  const many = (name: string) => rest.flatMap((a, i) => (a === name && rest[i + 1] ? [rest[i + 1]] : []));

  const spreadsheetFile = opt("--spreadsheet");
  const valueFiles = many("--values");
  const sheet = opt("--sheet") ?? "Motors";
  const idCol = colIndex(opt("--id-column") ?? "O");
  const apply = rest.includes("--apply");
  const views = many("--view").map((v) => {
    const eq = v.lastIndexOf("=");
    const qty = Number(v.slice(eq + 1));
    if (eq === -1 || !Number.isInteger(qty) || qty < 0) die(`Bad --view "${v}" (want "<title>=<qty>")\n${USAGE}`);
    return { title: v.slice(0, eq), qty };
  });
  if (!spreadsheetFile || valueFiles.length === 0 || views.length === 0) die(USAGE);

  // --- Filter view definitions -------------------------------------------
  const ss = JSON.parse(readFileSync(spreadsheetFile, "utf8")) as {
    sheets: { properties: { title: string; sheetId: number }; filterViews?: FilterView[] }[];
  };
  const tab = ss.sheets.find((s) => s.properties.title === sheet);
  if (!tab) die(`Tab "${sheet}" not found in ${spreadsheetFile}`);

  const cols = new Map<number, Map<number, string>>();
  for (const f of valueFiles) loadValues(f, sheet, cols);
  if (!cols.has(idCol)) die(`No --values file covers the item-id column ${colLetters(idCol)}`);
  let lastRow = 0;
  for (const m of cols.values()) for (const r of m.keys()) if (r > lastRow) lastRow = r;
  const cell = (c: number, r: number) => cols.get(c)?.get(r) ?? "";

  // --- Rows shown by each view --------------------------------------------
  const byItem = new Map<string, Planned>();
  const conflicts: string[] = [];
  const badIds: string[] = [];
  for (const v of views) {
    const fv = (tab.filterViews ?? []).find((f) => f.title === v.title);
    if (!fv) die(`Filter view "${v.title}" not found on tab "${sheet}"`);
    const hidden = hiddenValuesOf(fv);
    for (const c of hidden.keys()) {
      if (!cols.has(c)) die(`Filter view "${v.title}" filters column ${colLetters(c)}, but no --values file covers it`);
    }
    // Row startRowIndex is the header row; data begins on the next row.
    const first = (fv.range.startRowIndex ?? 0) + 1;
    const end = Math.min(fv.range.endRowIndex ?? Infinity, lastRow + 1);
    let shown = 0;
    for (let r = first; r < end; r++) {
      let visible = true;
      for (const [c, set] of hidden) if (set.has(cell(c, r))) { visible = false; break; }
      if (!visible) continue;
      shown++;
      const id = cell(idCol, r).trim();
      if (!/^\d{9,15}$/.test(id)) { badIds.push(`row ${r + 1} (${v.title}): "${id}"`); continue; }
      const prev = byItem.get(id);
      if (prev && prev.target !== v.qty) {
        conflicts.push(`${id}: row ${prev.rows.join("/")} in "${prev.view}" (=${prev.target}) and row ${r + 1} in "${v.title}" (=${v.qty})`);
        prev.target = -1;
      } else if (prev) prev.rows.push(r + 1);
      else byItem.set(id, { itemId: id, view: v.title, target: v.qty, rows: [r + 1] });
    }
    console.log(`"${v.title}": ${shown} rows shown -> quantity ${v.qty}`);
  }
  const plan = [...byItem.values()].filter((p) => p.target >= 0);
  console.log(`${plan.length} unique items to check${conflicts.length ? `, ${conflicts.length} skipped (in views with different quantities)` : ""}.`);
  for (const c of conflicts) console.log(`  [Conflict] ${c}`);
  for (const b of badIds) console.log(`  [No item id] ${b}`);

  // --- eBay: current state, 100 listings per search -----------------------
  const token = await listingToken(account);
  const current = new Map<string, ListingInfo>();
  const batches: string[][] = [];
  for (let i = 0; i < plan.length; i += MAX_SEARCH_LISTING_IDS) batches.push(plan.slice(i, i + MAX_SEARCH_LISTING_IDS).map((p) => p.itemId));
  let done = 0;
  await mapLimit(batches, 4, async (ids) => {
    await withRetry(`search ${ids[0]}..`, async () => {
      for await (const l of searchActiveListings(token, { listingIds: ids })) current.set(l.listingId, l);
    });
    if (++done % 50 === 0 || done === batches.length) console.log(`  looked up ${done}/${batches.length} batches`);
  });

  // --- eBay: changes ------------------------------------------------------
  type Row = Planned & { before: string; status: string; detail: string };
  const results: Row[] = await mapLimit(plan, 4, async (p): Promise<Row> => {
    const l = current.get(p.itemId);
    if (!l) return { ...p, before: "", status: "NOT ACTIVE", detail: "not among our active listings" };
    const before = String(l.quantityAvailable);
    if (l.kind !== "SingleSkuListing") return { ...p, before, status: "SKIPPED", detail: "variation listing" };
    if (l.quantityAvailable === p.target) return { ...p, before, status: "UNCHANGED", detail: "" };
    if (!apply) return { ...p, before, status: "WOULD CHANGE", detail: "" };
    let r: UpdateResult = { ok: false, errors: [], warnings: [] };
    try {
      r = await withRetry(p.itemId, async () => {
        const res = await updateInventory(token, { listingId: p.itemId }, { quantity: p.target });
        if (!res.ok && res.errors.some(isTransient)) throw new Error(res.errors.join(" | "));
        return res;
      });
    } catch (e) {
      r.errors = [String(e instanceof Error ? e.message : e)];
    }
    return { ...p, before, status: r.ok ? "CHANGED" : "FAILED", detail: [...r.errors, ...r.warnings].join(" | ") };
  });

  const count = (s: string) => results.filter((r) => r.status === s).length;
  for (const r of results) {
    if (r.status === "UNCHANGED") continue;
    console.log(`${r.itemId} [${r.view}] ${r.status}${r.before !== "" ? ` ${r.before} -> ${r.target}` : ""}${r.detail ? `  ${r.detail}` : ""}`);
  }
  console.log(
    `\n${apply ? "APPLIED" : "DRY RUN (add --apply to change eBay)"}: ` +
      `${count(apply ? "CHANGED" : "WOULD CHANGE")} ${apply ? "changed" : "would change"}, ${count("UNCHANGED")} already correct, ` +
      `${count("SKIPPED")} skipped, ${count("NOT ACTIVE")} not active, ${count("FAILED")} failed.`
  );

  const report =
    opt("--report") ??
    join(dirname(fileURLToPath(import.meta.url)), "..", "..", "reports", `class_quantity_${new Date().toISOString().slice(0, 10)}${apply ? "" : "_dryrun"}.csv`);
  mkdirSync(dirname(report), { recursive: true });
  const esc = (s: string) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  writeFileSync(
    report,
    ["item_id,filter_view,sheet_rows,quantity_before,quantity_target,status,detail"]
      .concat(results.map((r) => [r.itemId, r.view, r.rows.join(" "), r.before, String(r.target), r.status, r.detail].map(esc).join(",")))
      .join("\n") + "\n"
  );
  console.log(`Report: ${report}`);
  if (count("FAILED")) process.exitCode = 1;
}

runMain(main);
