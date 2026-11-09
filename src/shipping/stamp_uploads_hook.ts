#!/usr/bin/env -S npx tsx
/**
 * stamp_uploads_hook.ts -- Claude Code UserPromptSubmit hook.
 *
 * Reads the hook input (JSON on stdin), finds every PDF attached to or named
 * in the user's message, and runs stamp_airpacket on it: a 国際エアパケット
 * 送り状 gets the OSAKA KITA stamp, written to stamped/<name>-OSAKA-KITA.pdf
 * (gitignored -- labels hold buyer addresses). Whatever is printed on stdout
 * is added to Claude's context, so Claude can send the stamped PDF back.
 *
 * Registered in .claude/settings.json via .claude/hooks/stamp-uploads.sh.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { processFile } from "./stamp_airpacket.ts";

interface HookInput {
  prompt?: string;
  cwd?: string;
}

/** PDF paths in the prompt: @"path with spaces.pdf", @path.pdf, or a bare absolute path. */
export function pdfPathsIn(prompt: string): string[] {
  const found = new Set<string>();
  for (const m of prompt.matchAll(/@"([^"]+\.pdf)"/gi)) found.add(m[1]);
  for (const m of prompt.matchAll(/(?:^|[\s@])((?:\/|~\/)[^\s"']+\.pdf)\b/gim)) found.add(m[1]);
  return [...found];
}

async function main(): Promise<void> {
  let input: HookInput = {};
  try {
    input = JSON.parse(readFileSync(0, "utf8"));
  } catch {
    return;
  }
  const root = process.env.CLAUDE_PROJECT_DIR ?? input.cwd ?? process.cwd();
  const outDir = join(root, "stamped");
  const lines: string[] = [];

  for (const raw of pdfPathsIn(input.prompt ?? "")) {
    const file = resolve(raw.replace(/^~(?=\/)/, process.env.HOME ?? "~"));
    if (!existsSync(file) || !statSync(file).isFile()) continue;
    const outcome = await processFile(file, { outDir, force: false });
    const name = basename(file);
    if (outcome.status === "stamped") {
      lines.push(`- ${name}: 国際エアパケット → OSAKA KITA 押印済み: ${outcome.output}`);
    } else if (outcome.status === "skipped" && outcome.reason.startsWith("既にあります")) {
      lines.push(`- ${name}: 押印済みPDFが既にあります: ${join(outDir, outcome.reason.replace(/^既にあります: /, ""))}`);
    } else if (outcome.status === "skipped") {
      lines.push(`- ${name}: 押印なし（${outcome.reason}）`);
    } else {
      lines.push(`- ${name}: 押印失敗（${outcome.reason}）`);
    }
  }

  if (lines.length) {
    console.log(
      "[自動チェック: 国際エアパケット押印 (src/shipping/stamp_airpacket.ts)]\n" +
        lines.join("\n") +
        "\n押印済みPDFがあれば SendUserFile でユーザーに送ってください。",
    );
  }
}

main().catch(() => {});
