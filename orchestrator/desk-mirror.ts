/**
 * The librarian: reconciles the clone's library tree onto each desk's
 * read-only shelf (`<root>/library/`). Pure fs — no git here (the poll hook
 * reads the clone and hands the articles in); writes are atomic. adr: adr/0007;
 * spec 2026-09-12 library mirror + adopt §1.
 *
 * Mirrors are pristine: the library article's raw bytes land verbatim — the
 * orchestrator never stamps a mirror, the app derives metadata itself. The one
 * derived artifact is `index.json`, the identity map `{ [docId]: key }`: a
 * flat mirror filename carries only the docId, and the key's original-writer
 * component exists nowhere else the app can read (the app never touches the
 * clone — ADR-0007/atlas invariant). The mirror compare is WHOLE-FILE byte
 * equality: spec §3 renders folders/tags/publishedAt FROM the mirror's
 * frontmatter, so a frontmatter-only library merge must converge the shelf too
 * (byte-for-byte the repo's article.md — Global Constraint). The brief's
 * body-hash rationale covers DESK-side frontmatter churn (orchestrator stamps +
 * the app's reload resync), which never touches a read-only shelf copy; atomic
 * writes + compare-before-write keep the shelf churn-free.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { atomicWriteFileSync } from './util.js';

export interface LibraryArticle { key: string; docId: string; content: string; }

export interface DeskSyncResult { seeded: string[]; updated: string[]; deleted: string[]; }

/**
 * Walks the fresh clone's library tree: `<cloneDir>/<mergeDir>/<writerId>/<docId>/article.md`
 * → one `LibraryArticle` per file (key = `<writerId>/<docId>` from the path,
 * content = the raw file bytes); `taxonomy` = the raw bytes of
 * `<cloneDir>/<mergeDir>/taxonomy.json` when present.
 */
export async function readLibraryFromClone(
  cloneDir: string, mergeDir: string,
): Promise<{ articles: LibraryArticle[]; taxonomy: string | null }> {
  const base = join(cloneDir, mergeDir);
  const articles: LibraryArticle[] = [];
  if (existsSync(base)) {
    for (const writer of readdirSync(base, { withFileTypes: true })) {
      if (!writer.isDirectory()) continue;
      const writerDir = join(base, writer.name);
      for (const doc of readdirSync(writerDir, { withFileTypes: true })) {
        if (!doc.isDirectory()) continue;
        const articlePath = join(writerDir, doc.name, 'article.md');
        if (!existsSync(articlePath)) continue;
        articles.push({
          key: `${writer.name}/${doc.name}`,
          docId: doc.name,
          content: readFileSync(articlePath, 'utf-8'),
        });
      }
    }
  }
  const taxonomyPath = join(base, 'taxonomy.json');
  const taxonomy = existsSync(taxonomyPath) ? readFileSync(taxonomyPath, 'utf-8') : null;
  return { articles, taxonomy };
}

/**
 * Pure fs reconciliation of the library articles onto one desk's shelf. Per
 * article: **seed** (mirror absent), **no-op** (byte-identical), or
 * **update/repair** (the library moved OR the desk dirtied the read-only copy —
 * both overwrite from the library; repair is automatic, not an admin ritual).
 * Checked-out articles are synced like every other — the shelf row is the
 * catalog entry: it exists while the book is out and always shows the
 * last-merged corpus version, never the desk draft (spec 2026-09-16, the
 * catalog model). Mirrors whose docId left the library are deleted, except a
 * checked-out docId's — its row stays until the doc returns. The index is
 * rebuilt from the article set each run and byte-compared; taxonomy is
 * mirrored verbatim when present.
 */
export function syncDeskMirror(
  root: string, articles: LibraryArticle[], taxonomy: string | null, checkedOutKeys: ReadonlySet<string>,
): DeskSyncResult {
  const libDir = join(root, 'library');
  mkdirSync(libDir, { recursive: true });

  // docIds the desk currently holds (a key is "<writerId>/<docId>") — used to
  // exempt a checked-out docId from the sweep below.
  const checkedOutDocIds = new Set<string>();
  for (const key of checkedOutKeys) {
    const docId = key.slice(key.lastIndexOf('/') + 1);
    if (docId) checkedOutDocIds.add(docId);
  }

  const seeded: string[] = [];
  const updated: string[] = [];
  const index: Record<string, string> = {};

  for (const article of articles) {
    index[article.docId] = article.key;
    const mirrorPath = join(libDir, `${article.docId}.md`);
    if (!existsSync(mirrorPath)) {
      atomicWriteFileSync(mirrorPath, article.content);
      seeded.push(article.docId);
      continue;
    }
    const mirrorRaw = readFileSync(mirrorPath, 'utf-8');
    if (mirrorRaw !== article.content) {
      atomicWriteFileSync(mirrorPath, article.content);
      updated.push(article.docId);
    }
  }

  // Retire shelf mirrors whose docId is no longer in the library.
  const articleDocIds = new Set(articles.map((a) => a.docId));
  const deleted: string[] = [];
  for (const entry of readdirSync(libDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
    const docId = entry.name.slice(0, -'.md'.length);
    if (articleDocIds.has(docId) || checkedOutDocIds.has(docId)) continue;
    rmSync(join(libDir, entry.name));
    deleted.push(docId);
  }
  deleted.sort();

  // Identity map: sorted keys so a converged shelf serializes byte-stably.
  const sorted: Record<string, string> = {};
  for (const docId of Object.keys(index).sort()) sorted[docId] = index[docId];
  writeIfChanged(join(libDir, 'index.json'), JSON.stringify(sorted) + '\n');
  if (taxonomy !== null) writeIfChanged(join(libDir, 'taxonomy.json'), taxonomy);

  return { seeded, updated, deleted };
}

/** Write only when the bytes differ — a converged shelf never churns. */
function writeIfChanged(filePath: string, content: string): void {
  if (existsSync(filePath) && readFileSync(filePath, 'utf-8') === content) return;
  atomicWriteFileSync(filePath, content);
}
