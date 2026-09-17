/**
 * Workspace scan: OW_HOME/profiles/<profile>/*.md, one level deep. Docs live
 * flat at the profile (data-dir) root; dot entries are app machinery
 * (.versions) and are never traversed, nor are _-prefixed entries — EXCEPT
 * _untitled-*.md, the temp name a fresh doc keeps until a title promotes it
 * (writer docs, not machinery). adr: adr/0006 formats; spec Decision 1.
 */
import { existsSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { readDocHead, readLibraryKey } from './frontmatter.js';

export interface ScannedDoc {
  profileDir: string;
  docId: string;
  filePath: string;
  title: string;
  submittedAt: string | null;
  sessionId: string | null;
  model: string | null;
  libraryKey: string | null;
}

export function scanWriterRoot(root: string): ScannedDoc[] {
  const out: ScannedDoc[] = [];
  const profilesDir = join(root, 'profiles');
  if (!existsSync(profilesDir)) return out;
  for (const profile of readdirSync(profilesDir, { withFileTypes: true })) {
    if (!profile.isDirectory()) continue;
    if (profile.name.startsWith('.') || profile.name.startsWith('_')) continue;
    const dir = join(profilesDir, profile.name);
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
      if (entry.name.startsWith('.')) continue;
      // _untitled-*.md is the temp name a fresh doc keeps until a title
      // promotes it to <title>.md — a real writer doc (titled in frontmatter,
      // submitted like any other). Skipping _ files wholesale made an untitled
      // doc's submit invisible to the ship cycle (the live "no PR" report).
      // The rest of the _ machinery is directories, excluded by isFile().
      if (entry.name.startsWith('_') && !entry.name.startsWith('_untitled-')) continue;
      const filePath = join(dir, entry.name);
      let raw: string;
      let head: ReturnType<typeof readDocHead>;
      try { raw = readFileSync(filePath, 'utf-8'); head = readDocHead(raw); } catch { continue; }
      if (!head.docId) continue;
      out.push({
        profileDir: dir,
        docId: head.docId,
        filePath,
        title: head.title ?? entry.name,
        submittedAt: head.submittedAt,
        sessionId: head.sessionId,
        model: head.model,
        libraryKey: readLibraryKey(raw),
      });
    }
  }
  return out;
}
