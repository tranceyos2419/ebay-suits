#!/usr/bin/env -S npx tsx
/**
 * cleanup_reports.ts -- delete files in reports/ that were created more than
 * N months ago (default 6). Uses each file's creation time (birthtime).
 * Subfolders are scanned too; folders left empty are removed. The reports/
 * folder itself is never removed.
 *
 * Runs monthly (1st, 09:00) via the launchd agent installed with --install
 * (~/Library/LaunchAgents/com.ebay-suits.cleanup-reports.plist, log at
 * ~/Library/Logs/ebay-suits-cleanup-reports.log).
 *
 * Usage:
 *   npx tsx src/cleanup_reports.ts [--months N] [--dry-run]
 *   npx tsx src/cleanup_reports.ts --install     # schedule the 1st of each month at 09:00
 *   npx tsx src/cleanup_reports.ts --uninstall
 */

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, rmdirSync, statSync, unlinkSync, writeFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPORTS_DIR = join(PROJECT_DIR, "reports");
const LABEL = "com.ebay-suits.cleanup-reports";
const PLIST_PATH = join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);
const LOG_PATH = join(homedir(), "Library", "Logs", "ebay-suits-cleanup-reports.log");

function argValue(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function cutoffDate(months: number): Date {
  const d = new Date();
  d.setMonth(d.getMonth() - months);
  return d;
}

/** Deletes old files under dir; returns true if dir ended up empty. */
function sweep(dir: string, cutoff: Date, dryRun: boolean, deleted: string[]): boolean {
  let remaining = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (sweep(path, cutoff, dryRun, deleted)) {
        if (!dryRun) rmdirSync(path);
      } else {
        remaining++;
      }
      continue;
    }
    const created = statSync(path).birthtime;
    if (created < cutoff) {
      deleted.push(`${relative(REPORTS_DIR, path)} (created ${created.toISOString().slice(0, 10)})`);
      if (!dryRun) unlinkSync(path);
    } else {
      remaining++;
    }
  }
  return remaining === 0;
}

function install(): void {
  const node = process.execPath;
  const tsxCli = join(PROJECT_DIR, "node_modules", "tsx", "dist", "cli.mjs");
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${node}</string>
    <string>${tsxCli}</string>
    <string>${join(PROJECT_DIR, "src", "cleanup_reports.ts")}</string>
  </array>
  <key>WorkingDirectory</key><string>${PROJECT_DIR}</string>
  <key>StartCalendarInterval</key>
  <dict><key>Day</key><integer>1</integer><key>Hour</key><integer>9</integer><key>Minute</key><integer>0</integer></dict>
  <key>StandardOutPath</key><string>${LOG_PATH}</string>
  <key>StandardErrorPath</key><string>${LOG_PATH}</string>
</dict>
</plist>
`;
  try { execFileSync("launchctl", ["bootout", `gui/${process.getuid!()}/${LABEL}`], { stdio: "ignore" }); } catch {}
  writeFileSync(PLIST_PATH, plist);
  execFileSync("launchctl", ["bootstrap", `gui/${process.getuid!()}`, PLIST_PATH]);
  console.log(`Installed ${PLIST_PATH} (1st of each month at 09:00, log: ${LOG_PATH})`);
}

function uninstall(): void {
  try { execFileSync("launchctl", ["bootout", `gui/${process.getuid!()}/${LABEL}`], { stdio: "ignore" }); } catch {}
  rmSync(PLIST_PATH, { force: true });
  console.log(`Removed ${PLIST_PATH}`);
}

function main(): void {
  if (process.argv.includes("--install")) return install();
  if (process.argv.includes("--uninstall")) return uninstall();

  const months = Number(argValue("--months") ?? 6);
  if (!Number.isInteger(months) || months < 1) throw new Error("--months must be a positive integer");
  const dryRun = process.argv.includes("--dry-run");
  if (!existsSync(REPORTS_DIR)) {
    console.log(`${new Date().toISOString()} no reports folder at ${REPORTS_DIR}`);
    return;
  }

  const cutoff = cutoffDate(months);
  const deleted: string[] = [];
  sweep(REPORTS_DIR, cutoff, dryRun, deleted);
  const verb = dryRun ? "would delete" : "deleted";
  console.log(`${new Date().toISOString()} ${verb} ${deleted.length} file(s) created before ${cutoff.toISOString().slice(0, 10)}`);
  for (const d of deleted) console.log(`  ${d}`);
}

main();
