/**
 * env_file.ts -- read and update the project's `.env` (project root,
 * chmod 600, gitignored), the one place this project keeps secrets: the
 * eBay app keys and tokens (src/auth/ebay_auth.ts) and the Ship&Co token.
 *
 * Values are written double-quoted (`KEY="value"`) so characters eBay tokens
 * contain, such as `#` and `^`, survive Node's own .env parser
 * (process.loadEnvFile) as well as this one.
 */

import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

export const ENV_PATH = resolve(dirname(fileURLToPath(import.meta.url)), "../../.env");

const LINE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/;

function parseValue(raw: string): string {
  const v = raw.trim();
  const q = v[0];
  if ((q === '"' || q === "'") && v.endsWith(q) && v.length >= 2) return v.slice(1, -1);
  // Unquoted: an inline comment starts at " #".
  const hash = v.search(/\s#/);
  return (hash >= 0 ? v.slice(0, hash) : v).trim();
}

/** Every KEY=value in `path`; {} when the file doesn't exist. */
export function readEnvFile(path = ENV_PATH): Record<string, string> {
  if (!existsSync(path)) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = LINE.exec(line);
    if (m) out[m[1]] = parseValue(m[2]);
  }
  return out;
}

/**
 * Set each key in `updates` (undefined removes it), keeping every other line
 * -- comments, blank lines, other keys -- as it was. Existing keys are
 * replaced in place and new ones appended. Writes via a temp file + rename so
 * a crash can't leave a half-written file, and keeps the file at chmod 600.
 */
export function updateEnvFile(updates: Record<string, string | undefined>, path = ENV_PATH): void {
  if (/["\n]/.test(Object.values(updates).join(""))) throw new Error("updateEnvFile: values may not contain quotes or newlines");
  const lines = existsSync(path) ? readFileSync(path, "utf8").replace(/\n$/, "").split("\n") : [];
  const pending = new Map(Object.entries(updates));
  const kept: string[] = [];
  for (const line of lines) {
    const key = LINE.exec(line)?.[1];
    if (key === undefined || !pending.has(key)) {
      kept.push(line);
      continue;
    }
    const value = pending.get(key);
    pending.delete(key);
    if (value !== undefined) kept.push(`${key}="${value}"`);
  }
  for (const [key, value] of pending) if (value !== undefined) kept.push(`${key}="${value}"`);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, kept.join("\n") + "\n", { mode: 0o600 });
  renameSync(tmp, path);
  chmodSync(path, 0o600);
}
