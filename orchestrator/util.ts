/**
 * Shared orchestrator primitives. atomicWriteFileSync mirrors server/helpers.ts
 * (keep in lockstep). The orchestrator deliberately does not import server/
 * modules — these are documented mirrors of app behavior over ADR-0006 formats.
 */
import { writeFileSync, renameSync, statSync, readFileSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { createHash, randomUUID } from 'crypto';
import matter from 'gray-matter';

export function atomicWriteFileSync(filePath: string, content: string): void {
  const dir = dirname(filePath);
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.tmp-${randomUUID()}`);
  writeFileSync(tmp, content);
  renameSync(tmp, filePath);
}

export function sha256Hex(s: string): string {
  return createHash('sha256').update(s, 'utf-8').digest('hex');
}

/**
 * Hash of the article BODY only (frontmatter stripped) — the PROSE hash.
 * The merge-back byte-guard compares this, not the whole file: frontmatter
 * is orchestrator/app bookkeeping that legitimately churns (the app's
 * external-write reload resyncs and re-serializes it within moments of any
 * stamp — UAT 2026-09-11 merge-back read our own YAML stamp as
 * writer divergence because the app had already normalized it to its JSON
 * dialect). The writer's work is the prose; a body mismatch is the only
 * divergence the guard must refuse to clobber.
 *
 * Per-line trailing whitespace is stripped before hashing — the serializer
 * trims it on every round-trip (server/markdown-serialize.ts `trimEnd()`),
 * so a body pushed with a trailing space reads as prose-identical to its
 * trimmed next save. Byte-exact hashing turned one space into a phantom
 * "changed after submit" conflict twice: UAT (2026-09-11) and live
 * on writer-host-02, "Working up one level" (2026-09-16). Whitespace
 * beyond line ends (mid-line runs, added/removed lines) still differs —
 * the guard stays strict for prose.
 */
export function bodyHashHex(raw: string): string {
  return sha256Hex(matter(raw, {}).content.replace(/[ \t\r]+$/gm, ''));
}

export class MtimeRaceError extends Error {
  constructor(public filePath: string) {
    super(`mtime changed under CAS: ${filePath}`);
  }
}

/**
 * Read-modify-write guarded by mtime CAS: stat → read → fn → re-stat → atomic
 * write. The remaining window between the final stat and the rename is the
 * accepted DAF race (spec §Terminal states; the app's corruption guards remain
 * the app's).
 */
export function withMtimeCas(filePath: string, fn: (raw: string) => string): void {
  const before = statSync(filePath).mtimeMs;
  const raw = readFileSync(filePath, 'utf-8');
  const after = statSync(filePath).mtimeMs;
  if (before !== after) throw new MtimeRaceError(filePath);
  const next = fn(raw);
  const current = statSync(filePath).mtimeMs;
  if (current !== after) throw new MtimeRaceError(filePath);
  atomicWriteFileSync(filePath, next);
}
