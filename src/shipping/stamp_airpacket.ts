#!/usr/bin/env -S npx tsx
/**
 * stamp_airpacket.ts -- put the OSAKA KITA post-office stamp on Japan Post
 * 国際エアパケット (International Air Small Packet) dispatch notes.
 *
 * Each PDF is read and its text analysed. Only a 国際エアパケット送り状
 * (one A4 page, 595.2 x 841.68pt, the Mypage "AIR Small Packet" form) is
 * stamped; anything else (EMS, invoices, other carriers) is left alone. The
 * original file is never changed: the stamped copy is written next to it as
 * "<name>-OSAKA-KITA.pdf" (or into --out). The stamp, position and size are
 * the same as the "Ship&Co 国際エアパケット 捺印 (OSAKA KITA)" userscript v1.6.0.
 *
 * Usage:
 *   # stamp the given files / every PDF in the given folders
 *   npx tsx src/shipping/stamp_airpacket.ts label.pdf ~/Downloads/labels
 *
 *   # keep running and stamp every new PDF that lands in ~/Downloads
 *   npm run stamp-airpacket -- --watch
 *   npm run stamp-airpacket -- --watch ~/Desktop/labels --out ~/Desktop/stamped
 *
 * Options:
 *   --watch [dir]   watch a folder (default ~/Downloads) and stamp new PDFs
 *                   automatically as soon as they finish downloading
 *   --existing      with --watch, also process PDFs already in the folder
 *   --out <dir>     write stamped PDFs here instead of next to the original
 *   --force         overwrite an existing "-OSAKA-KITA.pdf"
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, watch, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BlendMode, PDFDict, PDFDocument, PDFName, PDFNumber, PDFRawStream } from "pdf-lib";
import { runMain } from "../lib/util.ts";

// Coordinates: PDF origin bottom-left, in pt (same as the userscript CONFIG).
const STAMP = { x: 96.4, y: 570, width: 98, aspect: 105 / 103 };
const PAGE = { width: 595.2, height: 841.68 };
const SUFFIX = "-OSAKA-KITA";
const MARKER = "OSAKA-KITA-STAMPED";
const STAMP_JPG = join(dirname(fileURLToPath(import.meta.url)), "assets", "osaka_kita_stamp.jpg");

type Outcome =
  | { status: "stamped"; output: string }
  | { status: "skipped"; reason: string }
  | { status: "error"; reason: string };

interface Options {
  inputs: string[];
  watchDir?: string;
  existing: boolean;
  outDir?: string;
  force: boolean;
}

function parseArgs(argv: string[]): Options {
  const opts: Options = { inputs: [], existing: false, force: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--watch") {
      const next = argv[i + 1];
      opts.watchDir = next && !next.startsWith("--") ? argv[++i] : join(homedir(), "Downloads");
    } else if (a === "--existing") opts.existing = true;
    else if (a === "--force") opts.force = true;
    else if (a === "--out") opts.outDir = argv[++i];
    else if (a === "-h" || a === "--help") {
      console.log("Usage: stamp_airpacket.ts [files/folders...] [--watch [dir]] [--existing] [--out dir] [--force]");
      process.exit(0);
    } else if (a.startsWith("--")) throw new Error(`Unknown option: ${a}`);
    else opts.inputs.push(a);
  }
  if (!opts.watchDir && !opts.inputs.length) {
    throw new Error("Give PDF files/folders to stamp, or --watch [dir]. See --help.");
  }
  return opts;
}

// ---------------------------------------------------------------- analysis

async function extractText(bytes: Uint8Array): Promise<string> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  // pdf.js takes ownership of the buffer it is given, so hand it a copy.
  const doc = await pdfjs.getDocument({
    data: bytes.slice(),
    isEvalSupported: false,
    disableFontFace: true,
    useSystemFonts: false,
    verbosity: 0,
  }).promise;
  try {
    let text = "";
    for (let p = 1; p <= doc.numPages; p++) {
      const content = await (await doc.getPage(p)).getTextContent();
      for (const item of content.items) if ("str" in item) text += item.str + "\n";
    }
    return text;
  } finally {
    await doc.destroy();
  }
}

/**
 * A 国際エアパケット送り状 says "国際エアパケット" in its service boxes and
 * "AIR Small Packet". Every Mypage form also carries the notice
 * "…国際エアパケットはご利用できません", so that sentence is removed first and
 * does not count.
 */
export function isAirPacketText(raw: string): boolean {
  const text = raw.normalize("NFKC").replace(/\s+/g, "");
  const withoutNotice = text.replace(/国際エアパケットはご利用(でき|出来)ません/g, "");
  return withoutNotice.includes("国際エアパケット") && /SmallPacket/i.test(text);
}

function checkLayout(doc: PDFDocument): void {
  const pages = doc.getPages();
  if (pages.length !== 1) throw new Error(`${pages.length}ページあります（1ページの送り状のみ対応）`);
  const page = pages[0];
  const crop = page.getCropBox();
  if (
    Math.abs(page.getWidth() - PAGE.width) > 1 || Math.abs(page.getHeight() - PAGE.height) > 1 ||
    page.getRotation().angle !== 0 || crop.x !== 0 || crop.y !== 0 ||
    Math.abs(crop.width - page.getWidth()) > 1 || Math.abs(crop.height - page.getHeight()) > 1
  ) {
    throw new Error("確認済みのA4送り状とレイアウトが異なるため押印しません");
  }
}

/**
 * True when the page already holds the 105x103 stamp JPEG -- also catches
 * PDFs stamped by the browser userscript (which sets no marker) and renamed.
 */
function hasStampImage(doc: PDFDocument): boolean {
  for (const page of doc.getPages()) {
    const xobjects = page.node.Resources()?.lookupMaybe(PDFName.of("XObject"), PDFDict);
    for (const [, ref] of xobjects?.entries() ?? []) {
      const obj = doc.context.lookup(ref);
      if (!(obj instanceof PDFRawStream)) continue;
      const d = obj.dict;
      const num = (k: string) => d.lookupMaybe(PDFName.of(k), PDFNumber)?.asNumber();
      if (d.get(PDFName.of("Subtype")) === PDFName.of("Image") && num("Width") === 105 &&
          num("Height") === 103 && String(d.get(PDFName.of("Filter"))) === "/DCTDecode") return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------- stamping

export async function stampPdf(bytes: Uint8Array): Promise<Uint8Array> {
  const doc = await PDFDocument.load(bytes);
  checkLayout(doc);
  const page = doc.getPages()[0];
  const image = await doc.embedJpg(readFileSync(STAMP_JPG));
  const height = STAMP.width / STAMP.aspect;
  if (STAMP.x + STAMP.width > page.getWidth() || STAMP.y + height > page.getHeight()) {
    throw new Error("印影がページの外に出ます");
  }
  // Multiply keeps the form's ruled lines visible under the stamp.
  page.drawImage(image, { x: STAMP.x, y: STAMP.y, width: STAMP.width, height, blendMode: BlendMode.Multiply });
  doc.setKeywords([...(doc.getKeywords()?.split(/[;,\s]+/).filter(Boolean) ?? []), MARKER]);
  return doc.save();
}

function outputPath(input: string, outDir?: string): string {
  const name = basename(input, extname(input)) + SUFFIX + ".pdf";
  return join(outDir ?? dirname(input), name);
}

export async function processFile(input: string, opts: Pick<Options, "outDir" | "force">): Promise<Outcome> {
  try {
    if (basename(input, extname(input)).endsWith(SUFFIX)) return { status: "skipped", reason: "押印済みファイル" };
    const output = outputPath(input, opts.outDir);
    if (!opts.force && existsSync(output)) return { status: "skipped", reason: `既にあります: ${basename(output)}` };

    const bytes = new Uint8Array(readFileSync(input));
    if (String.fromCharCode(...bytes.slice(0, 5)) !== "%PDF-") return { status: "skipped", reason: "PDFではありません" };

    const meta = await PDFDocument.load(bytes, { updateMetadata: false });
    if (meta.getKeywords()?.includes(MARKER) || hasStampImage(meta)) {
      return { status: "skipped", reason: "押印済みPDF" };
    }

    if (!isAirPacketText(await extractText(bytes))) {
      return { status: "skipped", reason: "国際エアパケットの送り状ではありません" };
    }
    const stamped = await stampPdf(bytes);
    mkdirSync(dirname(output), { recursive: true });
    writeFileSync(output, stamped);
    return { status: "stamped", output };
  } catch (err) {
    return { status: "error", reason: err instanceof Error ? err.message : String(err) };
  }
}

function report(input: string, outcome: Outcome): void {
  const name = basename(input);
  if (outcome.status === "stamped") console.log(`✅ 押印しました  ${name} → ${outcome.output}`);
  else if (outcome.status === "skipped") console.log(`⏭  スキップ      ${name}（${outcome.reason}）`);
  else console.error(`❌ 失敗          ${name}（${outcome.reason}）`);
}

function listPdfs(path: string): string[] {
  const full = resolve(path);
  if (!statSync(full).isDirectory()) return [full];
  return readdirSync(full)
    .filter((f) => extname(f).toLowerCase() === ".pdf")
    .sort()
    .map((f) => join(full, f));
}

// ---------------------------------------------------------------- watching

/** Wait until a file stops growing (browsers write downloads in chunks). */
async function waitUntilStable(file: string): Promise<boolean> {
  let last = -1;
  for (let i = 0; i < 60; i++) {
    if (!existsSync(file)) return false;
    const size = statSync(file).size;
    if (size > 0 && size === last) return true;
    last = size;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

async function watchFolder(dir: string, opts: Options): Promise<void> {
  const folder = resolve(dir);
  if (!existsSync(folder) || !statSync(folder).isDirectory()) throw new Error(`フォルダがありません: ${folder}`);
  const seen = new Set<string>();
  const pending = new Set<string>();

  const handle = async (file: string) => {
    if (seen.has(file) || pending.has(file)) return;
    pending.add(file);
    try {
      if (!(await waitUntilStable(file))) return;
      seen.add(file);
      const outcome = await processFile(file, opts);
      // Quietly ignore our own output files appearing in the folder.
      if (!(outcome.status === "skipped" && outcome.reason === "押印済みファイル")) report(file, outcome);
      if (outcome.status === "stamped") seen.add(outcome.output);
    } finally {
      pending.delete(file);
    }
  };

  for (const f of listPdfs(folder)) {
    if (opts.existing) await handle(f);
    else seen.add(f);
  }
  console.log(`👀 監視中: ${folder}`);
  console.log("   国際エアパケットの送り状PDFが保存されると自動で押印します。終了は Ctrl+C。");
  watch(folder, (_event, name) => {
    if (!name || extname(name.toString()).toLowerCase() !== ".pdf") return;
    void handle(join(folder, name.toString()));
  });
  await new Promise(() => {}); // run until Ctrl+C
}

// ---------------------------------------------------------------- main

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  let failed = 0;
  for (const input of opts.inputs) {
    for (const file of listPdfs(input)) {
      const outcome = await processFile(file, opts);
      report(file, outcome);
      if (outcome.status === "error") failed++;
    }
  }
  if (opts.watchDir) await watchFolder(opts.watchDir, opts);
  if (failed) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) runMain(main);
