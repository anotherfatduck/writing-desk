/**
 * Multi-document operations for OpenWriter workspace.
 * Manages listing, switching, creating, deleting documents.
 * Each document is a .md file in ~/.openwriter/.
 */

import { existsSync, readFileSync, writeFileSync, readdirSync, statSync, mkdirSync, renameSync } from 'fs';
import { join } from 'path';
import matter from 'gray-matter';
import trash from 'trash';
import { tiptapToMarkdownChecked, markdownToTiptap } from './markdown.js';
import { resolveTypeMeta } from './content-type-meta.js';
import { parseMarkdownContent } from './compact.js';
import {
  getDocument, getTitle, getFilePath, getIsTemp, getMetadata, save, setMetadata, cancelDebouncedSave, setActiveDocument,
  registerExternalDoc, unregisterExternalDoc, getExternalDocs,
  cacheActiveDocument, getCachedDocument, invalidateDocCache, removePendingCacheEntry, setPendingCacheEntry,
  resetDocVersion, markAsAgentStub, unmarkAgentStub, isAgentStub, removeOverlayEntries, getOverlayEntries,
  startActiveDocWatcher,
  type PadDocument, type DocumentInfo,
} from './state.js';
import { commitFromFile } from './commits.js';
import { getDataDir, TEMP_PREFIX, ensureDataDir, filePathForTitle, tempFilePath, generateNodeId, resolveDocPath, isExternalDoc, atomicWriteFileSync, canonicalizePath, assertWritableDocPath, ROOT_DIR } from './helpers.js';
import type { Actor } from './attribution.js';
import { resolveListingTitle, getWorkspaceTitleMap } from './title-resolve.js';
import { deriveReviewGate } from './review-gate.js';
import { ensureDocId } from './versions.js';
import { renameDocInAllWorkspaces, removeDocFromAllWorkspaces } from './workspaces.js';
import { diagLog, loadDocFromDisk, deleteOverlay, loadOverlay, saveOverlay, liveOverlayEntries, type ProposedProvenance } from './pending-overlay.js';
import { loadPendingMetadata, savePendingMetadata, type PendingMetadata } from './pending-metadata.js';
import { getPendingMetadata as getActivePendingMetadata, setPendingMetadata as setActivePendingMetadata, getDocVersion, bumpDocVersion } from './state.js';

import { getDocId as getActiveDocId } from './state.js';

function getDocOrderFile(): string { return join(getDataDir(), '_doc-order.json'); }

/** Scan files for matching docId. Checks active doc first (free), then getDataDir(), then external docs. */
export function filenameByDocId(docId: string): string | null {
  // Undefined/empty/non-string docIds resolve to nothing. Without this guard,
  // undefined === undefined matched docless-frontmatter files (fresh-home
  // _untitled seeds) — arbitrary, wrong files.
  if (typeof docId !== 'string' || !docId) return null;

  // Fast path: check active document (no disk read)
  if (getActiveDocId() === docId) {
    return getActiveFilename();
  }

  // Scan getDataDir() files
  ensureDataDir();
  for (const f of readdirSync(getDataDir()).filter(f => f.endsWith('.md'))) {
    try {
      const raw = readFileSync(join(getDataDir(), f), 'utf-8');
      const { data } = matter(raw);
      if (data.docId === docId) return f;
    } catch { /* skip */ }
  }

  // Scan external docs
  for (const extPath of getExternalDocs()) {
    try {
      if (!existsSync(extPath)) continue;
      const raw = readFileSync(extPath, 'utf-8');
      const { data } = matter(raw);
      if (data.docId === docId) return extPath;
    } catch { /* skip */ }
  }

  return null;
}

/** Resolve docId to filename. Throws if not found. */
export function resolveDocId(docId: string): string {
  const filename = filenameByDocId(docId);
  if (!filename) throw new Error(`Document not found for docId: ${docId}`);
  return filename;
}

function readDocOrder(): string[] {
  try {
    if (!existsSync(getDocOrderFile())) return [];
    return JSON.parse(readFileSync(getDocOrderFile(), 'utf-8'));
  } catch { return []; }
}

function writeDocOrder(order: string[]): void {
  ensureDataDir();
  writeFileSync(getDocOrderFile(), JSON.stringify(order, null, 2), 'utf-8');
}

export function reorderDocs(orderedFilenames: string[]): void {
  writeDocOrder(orderedFilenames);
}

/** Derive content_type from frontmatter — explicit field first, then fallback from context keys. */
function deriveContentType(data: Record<string, any>): string | undefined {
  if (data.content_type) return data.content_type as string;
  if (data.tweetContext) return data.tweetContext.mode || 'tweet';
  if (data.articleContext) return 'article';
  if (data.linkedinContext) return 'linkedin';
  if (data.newsletterContext) return 'newsletter';
  if (data.blogContext) return 'blog';
  return undefined;
}

export function listDocuments(): DocumentInfo[] {
  ensureDataDir();
  const currentPath = getFilePath();
  const wsTitles = getWorkspaceTitleMap();
  const files = readdirSync(getDataDir())
    .filter((f) => f.endsWith('.md'))
    .map((f) => {
      const fullPath = join(getDataDir(), f);
      try {
        const stat = statSync(fullPath);
        const raw = readFileSync(fullPath, 'utf-8');

        // Use gray-matter directly — skip full TipTap parse for listing
        const { data, content } = matter(raw);
        const title = resolveListingTitle({ fmTitle: data.title, workspaceTitle: wsTitles.get(f), content, filename: f });

        // Skip archived docs
        if (data.archivedAt) return null;

        // Skip empty temp files (not the active doc)
        const trimmed = content.trim();
        if (f.startsWith(TEMP_PREFIX) && !trimmed && fullPath !== currentPath) return null;

        const wordCount = trimmed ? trimmed.split(/\s+/).length : 0;
        const gate = data.review ? deriveReviewGate(data.review) : null;

        return {
          filename: f,
          title,
          path: fullPath,
          lastModified: stat.mtime.toISOString(),
          wordCount,
          isActive: fullPath === currentPath,
          ...(data.docId ? { docId: data.docId as string } : {}),
          ...(data.newsletterContext?.lastSend?.sentAt ? { lastSent: data.newsletterContext.lastSend.sentAt } : data.tweetContext?.lastPost?.postedAt ? { lastSent: data.tweetContext.lastPost.postedAt } : data.blogContext?.lastPublish?.publishedAt ? { lastSent: data.blogContext.lastPublish.publishedAt } : data.articleContext?.lastPost?.postedAt ? { lastSent: data.articleContext.lastPost.postedAt } : data.manualPost?.postedAt ? { lastSent: data.manualPost.postedAt } : {}),
          ...(data.tweetContext?.lastPost?.tweetUrl ? { postedUrl: data.tweetContext.lastPost.tweetUrl } : data.articleContext?.lastPost?.tweetUrl ? { postedUrl: data.articleContext.lastPost.tweetUrl } : data.blogContext?.lastPublish?.publishedUrl ? { postedUrl: data.blogContext.lastPublish.publishedUrl } : {}),
          ...(data.newsletterContext ? { isNewsletter: true } : {}),
          ...(deriveContentType(data) ? { contentType: deriveContentType(data) } : {}),
          ...(data.masterDocId ? { masterDocId: data.masterDocId as string } : {}),
          ...(data.variantType ? { variantType: data.variantType as string } : {}),
          ...(typeof data.autoAccept === 'boolean' ? { autoAccept: data.autoAccept } : {}),
          // Tags ride along with the doc listing so the sidebar can populate its
          // tag overlay from one HTTP round-trip instead of N. The server already
          // has the parsed frontmatter in hand here; emitting tags is free.
          ...(Array.isArray(data.tags) && data.tags.length > 0 ? { tags: data.tags as string[] } : {}),
          // Enrichment fields — free at this point since data is in hand.
          // v0.19.0 schema: only logline (LLM) + status (agent) + enrichmentStale
          // (system) are surfaced. domain / concepts / docRole stayed on disk for
          // legacy docs but are no longer read (lazy migration via mark_enriched).
          // See brief 2026-05-21-simplify-enrichment-schema-three-fields.
          ...(typeof data.logline === 'string' && data.logline ? { logline: data.logline as string } : {}),
          ...(typeof data.status === 'string' && data.status ? { status: data.status as string } : {}),
          ...(data.enrichmentStale === true ? { enrichmentStale: true as const } : {}),
          ...(gate ? { reviewGate: gate } : {}),
          // The adoption stamp — how the client knows a desk doc is a checked-out
          // library article (spec §2). Derived from the frontmatter already parsed
          // above (same predicate as readLibraryKey) — no second matter parse.
          libraryKey: libraryKeyFromData(data),
          libraryAdoptedAt: libraryAdoptedAtFromData(data),
        } as DocumentInfo;
      } catch {
        return null;
      }
    })
    .filter((f): f is DocumentInfo => f !== null);

  // Append registered external docs
  for (const extPath of getExternalDocs()) {
    try {
      if (!existsSync(extPath)) {
        unregisterExternalDoc(extPath); // Clean up stale registry entries
        continue;
      }
      const stat = statSync(extPath);
      const raw = readFileSync(extPath, 'utf-8');
      const { data, content } = matter(raw);
      const title = resolveListingTitle({ fmTitle: data.title, workspaceTitle: wsTitles.get(extPath), content, filename: extPath });
      const trimmed = content.trim();
      const wordCount = trimmed ? trimmed.split(/\s+/).length : 0;
      const gate = data.review ? deriveReviewGate(data.review) : null;

      files.push({
        filename: extPath, // Full path as identifier
        title,
        path: extPath,
        lastModified: stat.mtime.toISOString(),
        wordCount,
        isActive: extPath === currentPath,
        ...(data.docId ? { docId: data.docId as string } : {}),
        ...(data.newsletterContext?.lastSend?.sentAt ? { lastSent: data.newsletterContext.lastSend.sentAt } : data.tweetContext?.lastPost?.postedAt ? { lastSent: data.tweetContext.lastPost.postedAt } : data.blogContext?.lastPublish?.publishedAt ? { lastSent: data.blogContext.lastPublish.publishedAt } : data.articleContext?.lastPost?.postedAt ? { lastSent: data.articleContext.lastPost.postedAt } : {}),
        ...(data.tweetContext?.lastPost?.tweetUrl ? { postedUrl: data.tweetContext.lastPost.tweetUrl } : data.articleContext?.lastPost?.tweetUrl ? { postedUrl: data.articleContext.lastPost.tweetUrl } : data.blogContext?.lastPublish?.publishedUrl ? { postedUrl: data.blogContext.lastPublish.publishedUrl } : {}),
        ...(data.newsletterContext ? { isNewsletter: true } : {}),
        ...(deriveContentType(data) ? { contentType: deriveContentType(data) } : {}),
        ...(data.masterDocId ? { masterDocId: data.masterDocId as string } : {}),
        ...(data.variantType ? { variantType: data.variantType as string } : {}),
        ...(typeof data.autoAccept === 'boolean' ? { autoAccept: data.autoAccept } : {}),
        ...(gate ? { reviewGate: gate } : {}),
        libraryKey: libraryKeyFromData(data),
        libraryAdoptedAt: libraryAdoptedAtFromData(data),
      });
    } catch { /* skip unreadable external files */ }
  }

  // Sort by persisted order; docs not in manifest prepend (newest first by mtime)
  const order = readDocOrder();
  if (order.length > 0) {
    const orderIndex = new Map(order.map((f, i) => [f, i]));
    const hasUnknown = files.some(f => !orderIndex.has(f.filename));
    files.sort((a, b) => {
      const ai = orderIndex.get(a.filename) ?? -1;
      const bi = orderIndex.get(b.filename) ?? -1;
      // Both unknown → newest first by mtime
      if (ai === -1 && bi === -1) return new Date(b.lastModified).getTime() - new Date(a.lastModified).getTime();
      // Unknown docs sort before known (prepend)
      if (ai === -1) return -1;
      if (bi === -1) return 1;
      return ai - bi;
    });
    // Absorb unknown docs into manifest so they stay put after edits
    if (hasUnknown) {
      writeDocOrder(files.map(f => f.filename));
    }
  } else {
    // No manifest yet — create one from current mtime order so all docs are tracked
    writeDocOrder(files.map(f => f.filename));
  }

  return files;
}

// ============================================================================
// LIBRARY (read-only shelf — the librarian's mirrors of the merged articles)
// ============================================================================
//
// The library is canonical; every desk mirrors it. Mirrors land flat at
// `<ROOT_DIR>/library/<docId>.md` holding the library article's pristine bytes
// (the orchestrator never stamps one), plus the librarian's derived
// `index.json` (`{ [docId]: <writerId>/<docId> }` — the only place the key's
// original-writerId component exists that the app can read) and the
// `taxonomy.json` manifest. The app derives everything else from mirror
// frontmatter. The app never writes the shelf except through adopt, which
// moves a mirror OUT (spec §2/§3). adr: adr/0007-git-orchestrator-dumb-host-side.md

export interface LibraryArticleInfo {
  docId: string;
  /** The library key (`<writerId>/<docId>`) — null when the mirror is absent
   *  from index.json (it would not be adoptable). */
  key: string | null;
  title: string;
  /** Series name — the Library view's folder (null = unfiled). */
  series: string | null;
  /** Topics render as tags on the row, not as folders (spec §3). */
  topics: string[];
  publishedAt: string | null;
  /** A desk doc on this writer's desk holds this docId (the adopt guard's
   *  409 test) — the shelf row shows the "checked out" chip and Adopt
   *  disables. */
  checkedOut: boolean;
}

export interface LibraryListing {
  articles: LibraryArticleInfo[];
  categories: { series: string[]; topics: string[] };
}

function libraryDir(): string { return join(ROOT_DIR, 'library'); }

/** A library docId is the librarian's article directory name — exactly one
 *  path segment. The routes pass user input straight in and it becomes a file
 *  path, so anything else (a separator, `..`, an empty string) is refused
 *  before it can escape the shelf. */
function assertLibraryDocId(docId: string): void {
  if (typeof docId !== 'string' || !docId || docId === '.' || docId === '..' || !/^[A-Za-z0-9._-]+$/.test(docId)) {
    throw libraryHttpError(400, `invalid library docId: ${String(docId)}`);
  }
}

function libraryMirrorPath(docId: string): string { return join(libraryDir(), `${docId}.md`); }

/** The librarian's identity map; `{}` when absent/unreadable — never throws. */
function readLibraryIndex(): Record<string, string> {
  try {
    const p = join(libraryDir(), 'index.json');
    if (!existsSync(p)) return {};
    const parsed = JSON.parse(readFileSync(p, 'utf-8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed)) if (typeof v === 'string' && v) out[k] = v;
    return out;
  } catch { return {}; }
}

/** The taxonomy manifest (`{ series, topics }`); empty when absent/unreadable. */
function readLibraryTaxonomy(): { series: string[]; topics: string[] } {
  try {
    const p = join(libraryDir(), 'taxonomy.json');
    if (!existsSync(p)) return { series: [], topics: [] };
    const parsed = JSON.parse(readFileSync(p, 'utf-8'));
    return {
      series: Array.isArray(parsed?.series) ? parsed.series.filter((s: unknown) => typeof s === 'string') : [],
      topics: Array.isArray(parsed?.topics) ? parsed.topics.filter((t: unknown) => typeof t === 'string') : [],
    };
  } catch { return { series: [], topics: [] }; }
}

/** The adoption-stamp predicate, applied to already-parsed frontmatter
 *  (listDocuments has `data` in hand — no second matter parse). null unless
 *  `library.key` is a non-empty `owner/docId` string. */
function libraryKeyFromData(data: Record<string, any> | undefined): string | null {
  const lib = data && (data.library as { key?: unknown } | undefined);
  return lib && typeof lib.key === 'string' && lib.key.includes('/') ? lib.key : null;
}

/** Adoption timestamp off the desk doc's frontmatter — when the writer checked
 *  the article out (null for pre-stamp adoptions; the chip tooltip falls back). */
function libraryAdoptedAtFromData(data: Record<string, any> | undefined): string | null {
  const at = data && (data.library as { adoptedAt?: unknown } | undefined)?.adoptedAt;
  return typeof at === 'string' ? at : null;
}

/** Reads the app-minted adoption stamp off a desk doc's frontmatter. Same
 *  semantics as the orchestrator's readLibraryKey — re-defined here so the
 *  app-server never imports the orchestrator module. adr: adr/0007. */
export function readLibraryKey(raw: string): string | null {
  return libraryKeyFromData(matter(raw, {}).data as Record<string, any> | undefined);
}

/** Transition: stamp the check-out identity onto a mirror's frontmatter as
 *  `library: { key }` — every other field spread-preserved, body byte-exact
 *  (the same matter pattern the orchestrator's transitions use). */
export function stampLibraryKey(key: string): (raw: string) => string {
  return (raw) => {
    const result = matter(raw, {}) as any;
    const { data, content } = result;
    if (result.isEmpty || !result.matter || result.matter.trim() === '') return raw;
    const d = (data ?? {}) as Record<string, any>;
    return matter.stringify(content, { ...d, library: { key, adoptedAt: new Date().toISOString() } });
  };
}

/** Cycle stamps never ride into a fresh desk lifecycle: a re-adopted copy
 *  inherited the corpus-carried review.submitted and showed a phantom "Sent
 *  for review" (live leak, 2026-09-15). review.published rides through (the
 *  ship-time base check's convergence sha); library is re-stamped by
 *  stampLibraryKey below. Duplicated from the orchestrator's
 *  cleanForShipTransition minus the library strip — separate builds, and the
 *  gate logic already lives twice by design. */
function stripCycleStamps(raw: string): string {
  const result = matter(raw, {}) as any;
  const { data, content } = result;
  if (result.isEmpty || !result.matter || result.matter.trim() === '') return raw;
  const d = (data ?? {}) as Record<string, any>;
  const review = { ...((d.review ?? {}) as Record<string, any>) };
  delete review.submitted;
  delete review.pr;
  delete review.returned;
  delete review.conflict;
  const next: Record<string, any> = { ...d, review };
  if (Object.keys(review).length === 0) delete next.review;
  return matter.stringify(content, next);
}

/** The desk-docId universe the adopt guard (filenameByDocId) tests against:
 *  the active doc's docId plus every .md file's frontmatter docId on this
 *  writer's desk (dataDir + registered external docs). Mirrors
 *  filenameByDocId's own enumeration (documents.ts:39) in ONE pass, so the
 *  shelf listing tests membership instead of scanning the whole desk per
 *  article (final review: GET /api/library was O(shelf × desk) I/O). */
function collectDeskDocIds(): Set<string> {
  const ids = new Set<string>();
  const activeId = getActiveDocId();
  if (typeof activeId === 'string' && activeId) ids.add(activeId);
  ensureDataDir();
  for (const f of readdirSync(getDataDir()).filter(f => f.endsWith('.md'))) {
    try {
      const { data } = matter(readFileSync(join(getDataDir(), f), 'utf-8'));
      if (typeof data.docId === 'string' && data.docId) ids.add(data.docId);
    } catch { /* skip */ }
  }
  for (const extPath of getExternalDocs()) {
    try {
      if (!existsSync(extPath)) continue;
      const { data } = matter(readFileSync(extPath, 'utf-8'));
      if (typeof data.docId === 'string' && data.docId) ids.add(data.docId);
    } catch { /* skip */ }
  }
  return ids;
}

/** The Library view's server-side derivation (spec §3): every mirror's
 *  frontmatter values, keys from the identity index, and the folder/tag
 *  categories = the taxonomy manifest ∪ the values observed on the shelf.
 *  No shelf yet (librarian has not run) → the empty shape, never a throw. */
export function listLibraryDocs(): LibraryListing {
  if (!existsSync(libraryDir())) return { articles: [], categories: { series: [], topics: [] } };
  const index = readLibraryIndex();
  const deskDocIds = collectDeskDocIds();
  const articles: LibraryArticleInfo[] = [];
  const observedSeries = new Set<string>();
  const observedTopics = new Set<string>();

  for (const f of readdirSync(libraryDir()).filter((f) => f.endsWith('.md'))) {
    try {
      const { data } = matter(readFileSync(join(libraryDir(), f), 'utf-8'));
      const docId = f.slice(0, -'.md'.length);
      const series = mirrorSeries(data);
      const topics = mirrorTopics(data);
      if (series) observedSeries.add(series);
      for (const t of topics) observedTopics.add(t);
      const publishedAt = data.review?.published?.at ?? data.publishedOn ?? data.updatedOn ?? null;
      articles.push({
        docId,
        key: index[docId] ?? null,
        title: typeof data.title === 'string' && data.title ? data.title : docId,
        series,
        topics,
        publishedAt: typeof publishedAt === 'string' ? publishedAt : null,
        // The adopt guard's own test (filenameByDocId) — always THIS writer's
        // desk (per-writer slot), so "checked out" means "already on yours".
        // One desk scan, not one per article (final review: O(shelf × desk)).
        checkedOut: deskDocIds.has(docId),
      });
    } catch { /* skip unreadable mirrors */ }
  }
  articles.sort((a, b) => a.docId.localeCompare(b.docId));

  const tax = readLibraryTaxonomy();
  return {
    articles,
    categories: {
      series: Array.from(new Set([...tax.series, ...observedSeries])).sort(),
      topics: Array.from(new Set([...tax.topics, ...observedTopics])).sort(),
    },
  };
}

/** Mirror frontmatter `series` → the one folder it files under (null =
 *  unfiled). Arrays are tolerated (first entry wins); the migration emits a
 *  scalar. */
function mirrorSeries(data: Record<string, any>): string | null {
  if (typeof data.series === 'string' && data.series) return data.series;
  if (Array.isArray(data.series)) {
    const first = data.series.find((s: unknown) => typeof s === 'string' && s);
    if (typeof first === 'string') return first;
  }
  return null;
}

/** Mirror frontmatter `topics` → the row's tags. Scalar tolerated as one tag. */
function mirrorTopics(data: Record<string, any>): string[] {
  if (Array.isArray(data.topics)) return data.topics.filter((t: unknown) => typeof t === 'string');
  if (typeof data.topics === 'string' && data.topics) return [data.topics];
  return [];
}

/** Preview a shelf mirror: its head title + the matter-stripped markdown body.
 *  Throws (ENOENT) when the mirror is absent — the route maps that to 404. */
export function readLibraryDoc(docId: string): { title: string; body: string } {
  assertLibraryDocId(docId);
  const raw = readFileSync(libraryMirrorPath(docId), 'utf-8');
  const { data, content } = matter(raw);
  return {
    title: typeof data.title === 'string' && data.title ? data.title : docId,
    body: content,
  };
}

/** 404/409-carrying error so the thin routes can map library refusals without
 *  re-deriving the reason. */
function libraryHttpError(status: number, message: string): Error {
  return Object.assign(new Error(message), { status });
}

/**
 * Adopt (check out) a shelf mirror: the app-server promotes the mirror copy
 * into the writer's working area as a normal editable doc, stamped with the
 * library key. The shelf mirror STAYS — the Library row is the catalog entry
 * (the card stays in the drawer while the book is out; spec 2026-09-16), and
 * the librarian keeps it current from the corpus. Identity reuse: the desk
 * doc keeps the library docId, so submits map straight back to the article.
 */
export function adoptLibraryDoc(docId: string, _actor: Actor = 'human'): DocumentInfo {
  assertLibraryDocId(docId);
  // A desk doc already holding this docId means it is currently checked out —
  // refused BEFORE the mirror-existence branch. The author's own merged
  // article is the case that makes this ordering load-bearing: its original
  // desk doc carries no `library.key` stamp, so the mirror for the merged
  // article is ALWAYS on the author's own shelf (the librarian seeds every
  // corpus article). Without the 409 first, that mirror's presence would let
  // a second desk doc with the same docId be created — filenameByDocId is
  // first-match-wins, so return-to-library could then delete the writer's
  // original working doc, and both docs resolve to one key so the next
  // submission hits the ship-time base check.
  if (filenameByDocId(docId)) throw Object.assign(libraryHttpError(409, `library article ${docId} is already adopted`), { code: 'already-adopted' });
  const mirrorPath = libraryMirrorPath(docId);
  if (!existsSync(mirrorPath)) {
    throw libraryHttpError(404, `library article not found: ${docId}`);
  }
  const key = readLibraryIndex()[docId];
  if (!key) throw libraryHttpError(409, `library index has no key for ${docId}`);

  const raw = readFileSync(mirrorPath, 'utf-8');
  const stamped = stampLibraryKey(key)(stripCycleStamps(raw));
  const { data } = matter(raw);
  const title = typeof data.title === 'string' && data.title ? data.title : docId;

  ensureDataDir();
  let filePath = filePathForTitle(title);
  if (existsSync(filePath)) {
    let counter = 2;
    while (existsSync(filePathForTitle(`${title} ${counter}`))) counter++;
    filePath = filePathForTitle(`${title} ${counter}`);
  }
  atomicWriteFileSync(filePath, stamped);
  // The shelf mirror stays: the catalog row survives the check-out (spec
  // 2026-09-16) and the librarian keeps it current. The route broadcasts
  // library-changed for the row's chip flip.
  bumpDocVersion();

  const stat = statSync(filePath);
  const trimmed = matter(stamped).content.trim();
  return {
    filename: filePath.split(/[/\\]/).pop()!,
    title,
    path: filePath,
    lastModified: stat.mtime.toISOString(),
    wordCount: trimmed ? trimmed.split(/\s+/).length : 0,
    isActive: false,
    docId,
    libraryKey: key,
  } as DocumentInfo;
}

/**
 * Return-to-library: discard the adopted desk copy, releasing the key so the
 * row un-chips on the next snapshot. The shelf mirror never left (the catalog
 * row survives the check-out, spec 2026-09-16) — the librarian keeps it
 * current, so there is nothing to re-seed. Goes through the guarded delete
 * path, so a review in flight refuses (the same guard the delete route uses)
 * and is surfaced as 409.
 */
export async function restoreLibraryDoc(
  docId: string, _actor: Actor = 'human',
): Promise<{ switched: boolean; newDoc?: { document: PadDocument; title: string; filename: string }; filename: string }> {
  assertLibraryDocId(docId);
  const filename = filenameByDocId(docId);
  if (!filename) throw libraryHttpError(404, `no desk doc adopted from library article ${docId}`);
  // Membership follows success (F1 rider, spec 2026-09-13): the guarded delete
  // owns the review-in-flight refusal — mutating workspace membership first
  // left a 409 with the doc unlisted but still on disk. deleteDocument also
  // reads the sidebar order from the manifest, so membership must still be
  // present while it runs (sibling-adjacent switching depends on it).
  try {
    const result = await deleteDocument(filename);
    removeDocFromAllWorkspaces(filename);
    return { ...result, filename };
  } catch (err: any) {
    if (/review in flight/.test(err?.message ?? '')) throw libraryHttpError(409, err.message);
    throw err;
  }
}

// ============================================================================
// ARCHIVE
// ============================================================================

export function listArchivedDocuments(): DocumentInfo[] {
  ensureDataDir();
  const files = readdirSync(getDataDir())
    .filter((f) => f.endsWith('.md'))
    .map((f) => {
      const fullPath = join(getDataDir(), f);
      try {
        const stat = statSync(fullPath);
        const raw = readFileSync(fullPath, 'utf-8');
        const { data, content } = matter(raw);
        if (!data.archivedAt) return null;
        const title = resolveListingTitle({ fmTitle: data.title, content, filename: f });
        const trimmed = content.trim();
        const wordCount = trimmed ? trimmed.split(/\s+/).length : 0;
        return {
          filename: f,
          title,
          path: fullPath,
          lastModified: stat.mtime.toISOString(),
          wordCount,
          isActive: false,
          ...(data.docId ? { docId: data.docId as string } : {}),
          ...(data.masterDocId ? { masterDocId: data.masterDocId as string } : {}),
          ...(data.variantType ? { variantType: data.variantType as string } : {}),
          libraryKey: libraryKeyFromData(data),
          libraryAdoptedAt: libraryAdoptedAtFromData(data),
          archivedAt: data.archivedAt as string,
        } as DocumentInfo & { archivedAt: string };
      } catch { return null; }
    })
    .filter((f): f is DocumentInfo & { archivedAt: string } => f !== null);

  // Sort by archivedAt desc (most recently archived first)
  files.sort((a, b) => new Date(b.archivedAt).getTime() - new Date(a.archivedAt).getTime());
  return files;
}

export function archiveDocument(filename: string): { switched: boolean; newDoc?: { document: PadDocument; title: string; filename: string } } {
  ensureDataDir();
  const targetPath = resolveDocPath(filename);
  assertWritableDocPath(targetPath); // library area is read-only (spec §3)
  if (!existsSync(targetPath)) {
    throw new Error(`Document not found: ${filename}`);
  }

  const raw = readFileSync(targetPath, 'utf-8');
  const { data, content } = matter(raw);
  data.archivedAt = new Date().toISOString();
  atomicWriteFileSync(targetPath, matter.stringify(content, data));

  // Remove from workspaces
  removeDocFromAllWorkspaces(filename);

  // Invalidate cache
  invalidateDocCache(targetPath);

  const isArchivingActive = targetPath === getFilePath();
  if (isArchivingActive) {
    // Switch to most recent remaining doc
    const remaining = readdirSync(getDataDir())
      .filter((f) => f.endsWith('.md') && f !== filename)
      .map((f) => {
        const fullPath = join(getDataDir(), f);
        try {
          const stat = statSync(fullPath);
          const raw = readFileSync(fullPath, 'utf-8');
          const { data } = matter(raw);
          if (data.archivedAt) return null;
          return { name: f, path: fullPath, mtime: stat.mtimeMs };
        } catch { return null; }
      })
      .filter((f): f is { name: string; path: string; mtime: number } => f !== null)
      .sort((a, b) => b.mtime - a.mtime);

    if (remaining.length > 0) {
      const next = remaining[0];
      const raw = readFileSync(next.path, 'utf-8');
      const parsed = markdownToTiptap(raw);
      setActiveDocument(parsed.document, parsed.title, next.path, next.name.startsWith(TEMP_PREFIX), new Date(next.mtime), parsed.metadata, undefined);
      return { switched: true, newDoc: { document: getDocument(), title: getTitle(), filename: next.name } };
    }
  }

  return { switched: false };
}

export function unarchiveDocument(filename: string): { filename: string; title: string } {
  ensureDataDir();
  const targetPath = resolveDocPath(filename);
  assertWritableDocPath(targetPath); // library area is read-only (spec §3)
  if (!existsSync(targetPath)) {
    throw new Error(`Document not found: ${filename}`);
  }

  const raw = readFileSync(targetPath, 'utf-8');
  const { data, content } = matter(raw);
  delete data.archivedAt;
  atomicWriteFileSync(targetPath, matter.stringify(content, data));

  return { filename, title: (data.title as string) || 'Untitled' };
}

// ============================================================================
// SEARCH
// ============================================================================

export interface SearchResult {
  filename: string;
  title: string;
  lastModified: string;
  wordCount: number;
  isActive: boolean;
  matchType: 'title' | 'tag' | 'content';
  snippet: string | null;
  matchedTag: string | null;
  isArchived?: boolean;
}

export function searchDocuments(query: string, includeArchived = false): SearchResult[] {
  if (!query || !query.trim()) return [];
  const q = query.trim().toLowerCase();
  const currentPath = getFilePath();

  // Collect all files (same pattern as listDocuments)
  ensureDataDir();
  const allFiles: { filename: string; path: string; raw: string; mtime: Date }[] = [];

  for (const f of readdirSync(getDataDir()).filter(f => f.endsWith('.md'))) {
    try {
      const fullPath = join(getDataDir(), f);
      const mtime = statSync(fullPath).mtime;
      const raw = readFileSync(fullPath, 'utf-8');
      allFiles.push({ filename: f, path: fullPath, raw, mtime });
    } catch { /* skip */ }
  }

  for (const extPath of getExternalDocs()) {
    try {
      if (!existsSync(extPath)) { unregisterExternalDoc(extPath); continue; }
      const mtime = statSync(extPath).mtime;
      const raw = readFileSync(extPath, 'utf-8');
      allFiles.push({ filename: extPath, path: extPath, raw, mtime });
    } catch { /* skip */ }
  }

  const results: SearchResult[] = [];
  const wsTitles = getWorkspaceTitleMap();

  for (const file of allFiles) {
    const { data, content } = matter(file.raw);
    const title = resolveListingTitle({ fmTitle: data.title, workspaceTitle: wsTitles.get(file.filename), content, filename: file.filename });
    const trimmed = content.trim();
    const isArchived = !!data.archivedAt;

    // Skip archived unless requested
    if (isArchived && !includeArchived) continue;

    // Skip empty temp files (not active)
    if (file.filename.startsWith(TEMP_PREFIX) && !trimmed && file.path !== currentPath) continue;

    const wordCount = trimmed ? trimmed.split(/\s+/).length : 0;
    const isActive = file.path === currentPath;
    const tags: string[] = Array.isArray(data.tags) ? data.tags : [];

    const base = { filename: file.filename, title, lastModified: file.mtime.toISOString(), wordCount, isActive, isArchived };

    // Title match
    if (title.toLowerCase().includes(q)) {
      results.push({ ...base, matchType: 'title', snippet: null, matchedTag: null });
      continue; // Only best match type per doc
    }

    // Tag match
    const matchedTag = tags.find(t => t.toLowerCase().includes(q));
    if (matchedTag) {
      results.push({ ...base, matchType: 'tag', snippet: null, matchedTag });
      continue;
    }

    // Content match
    const lowerContent = content.toLowerCase();
    const idx = lowerContent.indexOf(q);
    if (idx !== -1) {
      // ~80 char snippet around match
      const start = Math.max(0, idx - 30);
      const end = Math.min(content.length, idx + q.length + 50);
      let snippet = content.slice(start, end).replace(/\n/g, ' ').trim();
      if (start > 0) snippet = '...' + snippet;
      if (end < content.length) snippet = snippet + '...';
      results.push({ ...base, matchType: 'content', snippet, matchedTag: null });
    }
  }

  // Sort: active first, then title > tag > content, within each group by mtime desc
  // Archived results sort after active results
  const typeOrder = { title: 0, tag: 1, content: 2 };
  results.sort((a, b) => {
    // Archived always after active
    if (a.isArchived !== b.isArchived) return a.isArchived ? 1 : -1;
    const typeDiff = typeOrder[a.matchType] - typeOrder[b.matchType];
    if (typeDiff !== 0) return typeDiff;
    return new Date(b.lastModified).getTime() - new Date(a.lastModified).getTime();
  });

  return results;
}

export function switchDocument(filename: string): { document: PadDocument; title: string; filename: string } {
  const tStart = performance.now();
  const prevFilename = getActiveFilename();

  // No-op if already on this document — avoids save/reload cycle that can clear editor content
  if (filename === prevFilename) {
    diagLog(`[Switch] NOOP ${filename} (${(performance.now() - tStart).toFixed(1)}ms)`);
    return { document: getDocument(), title: getTitle(), filename };
  }

  // Cancel any pending debounced save, then save current doc immediately.
  cancelDebouncedSave();
  const tSaveStart = performance.now();
  save();
  const tSaveEnd = performance.now();

  // Cache current doc before switching (preserves node IDs)
  cacheActiveDocument();
  const tCacheEnd = performance.now();

  // Reset version counter — new document starts a fresh version lineage
  resetDocVersion();

  // Read target from disk — markdownToTiptap rehydrates pending state
  const targetPath = resolveDocPath(filename);
  if (!existsSync(targetPath)) {
    throw new Error(`Document not found: ${filename}`);
  }

  // Register external docs so they appear in listings
  if (isExternalDoc(filename)) {
    registerExternalDoc(targetPath);
  }

  // Check cache first — preserves stable node IDs across switches
  const cached = getCachedDocument(targetPath);
  if (cached) {
    setActiveDocument(cached.document, cached.title, targetPath, cached.isTemp, cached.lastModified, cached.metadata, cached.originalFrontmatter);
    const tEnd = performance.now();
    diagLog(`[Switch] ${prevFilename} → ${filename} CACHE-HIT total=${(tEnd - tStart).toFixed(1)}ms save=${(tSaveEnd - tSaveStart).toFixed(1)}ms cache=${(tCacheEnd - tSaveEnd).toFixed(1)}ms setActive=${(tEnd - tCacheEnd).toFixed(1)}ms`);
    return { document: getDocument(), title: getTitle(), filename };
  }

  const tReadStart = performance.now();
  const raw = readFileSync(targetPath, 'utf-8');
  const tReadEnd = performance.now();
  const parsed = markdownToTiptap(raw);
  const tParseEnd = performance.now();
  const mtime = new Date(statSync(targetPath).mtimeMs);

  // Ensure docId exists on loaded doc metadata (lazy migration)
  ensureDocId(parsed.metadata);

  const baseName = targetPath.split(/[/\\]/).pop() || '';
  setActiveDocument(parsed.document, parsed.title, targetPath, baseName.startsWith(TEMP_PREFIX), mtime, parsed.metadata, parsed.rawFrontmatter);
  const tEnd = performance.now();
  diagLog(`[Switch] ${prevFilename} → ${filename} CACHE-MISS total=${(tEnd - tStart).toFixed(1)}ms save=${(tSaveEnd - tSaveStart).toFixed(1)}ms cache=${(tCacheEnd - tSaveEnd).toFixed(1)}ms read=${(tReadEnd - tReadStart).toFixed(1)}ms parse=${(tParseEnd - tReadEnd).toFixed(1)}ms setActive=${(tEnd - tParseEnd).toFixed(1)}ms`);
  return { document: getDocument(), title: getTitle(), filename };
}

export function createDocument(title?: string, content?: string | PadDocument, path?: string): { document: PadDocument; title: string; filename: string } {
  // Cancel any pending debounced save, then save current doc immediately
  cancelDebouncedSave();
  save();

  // Cache current doc before switching to new one
  cacheActiveDocument();

  const docTitle = title || 'Untitled';
  let filePath: string;
  let isTemp: boolean;
  let filename: string;

  if (path) {
    // External path — create file at the specified location. A caller-supplied
    // path is the one create-time route into the shelf, so the read-only
    // chokepoint runs here too (spec §3).
    assertWritableDocPath(path);
    filePath = path;
    isTemp = false;
    filename = path; // Full path as identifier for external docs
    registerExternalDoc(path);
    // Ensure parent directory exists
    const dir = filePath.substring(0, Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\')));
    if (dir && !existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  } else {
    isTemp = !title;
    if (isTemp) {
      filePath = tempFilePath();
    } else {
      filePath = filePathForTitle(docTitle);
      // Deduplicate: append counter if file already exists
      if (existsSync(filePath)) {
        let counter = 2;
        while (existsSync(filePathForTitle(`${docTitle} ${counter}`))) counter++;
        filePath = filePathForTitle(`${docTitle} ${counter}`);
      }
    }
    filename = filePath.split(/[/\\]/).pop()!;
  }

  let newDoc: PadDocument;
  if (content) {
    if (typeof content === 'string') {
      // Markdown string → TipTap JSON
      newDoc = { type: 'doc', content: parseMarkdownContent(content) };
    } else {
      // Already TipTap JSON
      newDoc = content;
    }
  } else {
    newDoc = { type: 'doc', content: [{ type: 'paragraph', attrs: { id: generateNodeId() }, content: [] }] };
  }

  const metadata: Record<string, any> = { title: docTitle, docId: generateNodeId() };
  setActiveDocument(newDoc, docTitle, filePath, isTemp, undefined, metadata);

  // Write doc to disk
  const { markdown } = tiptapToMarkdownChecked(newDoc, docTitle, metadata);
  ensureDataDir();
  atomicWriteFileSync(filePath, markdown);
  // Re-anchor the fs watcher now that the file exists. setActiveDocument was
  // called before the file was created, so its startActiveDocWatcher call was a
  // no-op; without this the active doc is not watched for external writes.
  // adr: adr/0004-active-doc-watcher.md
  startActiveDocWatcher();

  // Prepend to doc order so new docs appear at top and stay put after edits
  const order = readDocOrder();
  const fn = filePath.split(/[/\\]/).pop()!;
  if (!order.includes(fn)) {
    order.unshift(fn);
    writeDocOrder(order);
  }

  return { document: getDocument(), title: getTitle(), filename };
}

/**
 * Create a new document file on disk WITHOUT switching the active document.
 * Used by the two-step creation flow (create_document → populate_document)
 * so the user's editor isn't hijacked during agent content generation.
 * The file is written with agentCreated: true in frontmatter.
 */
export function createDocumentFile(title?: string, path?: string, extraMeta?: Record<string, any>): { filename: string; docId: string; title: string } {
  const docTitle = title || 'Untitled';
  let filePath: string;
  let filename: string;

  if (path) {
    assertWritableDocPath(path); // library area is read-only (spec §3)
    filePath = path;
    filename = path;
    registerExternalDoc(path);
    const dir = filePath.substring(0, Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\')));
    if (dir && !existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  } else {
    if (!title) {
      filePath = tempFilePath();
    } else {
      filePath = filePathForTitle(docTitle);
      if (existsSync(filePath)) {
        let counter = 2;
        while (existsSync(filePathForTitle(`${docTitle} ${counter}`))) counter++;
        filePath = filePathForTitle(`${docTitle} ${counter}`);
      }
    }
    filename = filePath.split(/[/\\]/).pop()!;
  }

  const newDoc: PadDocument = { type: 'doc', content: [{ type: 'paragraph', attrs: { id: generateNodeId() }, content: [] }] };
  // No `agentCreated: true` in metadata — stub status is in-memory only.
  // adr: adr/agent-stub-model.md
  const metadata: Record<string, any> = { title: docTitle, docId: generateNodeId(), ...extraMeta };

  const { markdown } = tiptapToMarkdownChecked(newDoc, docTitle, metadata);
  ensureDataDir();
  atomicWriteFileSync(filePath, markdown);

  // Mark this filename as a fresh agent stub. Process-lifetime only — any
  // accepted content via subsequent save graduates it out of the set, and a
  // server restart naturally forgets stub status (a stub that survives a
  // restart is by definition no longer fresh).
  markAsAgentStub(filename);

  // Prepend to doc order so new docs appear at top and stay put after edits
  const order = readDocOrder();
  const fn = filePath.split(/[/\\]/).pop()!;
  if (!order.includes(fn)) {
    order.unshift(fn);
    writeDocOrder(order);
  }

  return { filename, docId: metadata.docId, title: docTitle };
}

export async function deleteDocument(filename: string): Promise<{ switched: boolean; newDoc?: { document: PadDocument; title: string; filename: string } }> {
  ensureDataDir();
  const targetPath = resolveDocPath(filename);
  assertWritableDocPath(targetPath); // library area is read-only (spec §3)
  // Kill any pending debounced save BEFORE the trash: a save firing in the
  // trash→switch await window writes getFilePath() — the just-trashed path —
  // and resurrects the deleted doc as a zombie. Same invariant every other
  // switch-path function follows (state.ts: "Cancel any pending debounced
  // save. Call before doc switch").
  cancelDebouncedSave();

  // Review-in-flight guard (spec §6): the orchestrator owns the review
  // lifecycle (adr: adr/0007); deleting a doc mid-flight would orphan its
  // article branch. Reads the same frontmatter review-gate.ts derives from.
  {
    const raw = readFileSync(targetPath, 'utf-8');
    const { data: fm } = matter(raw);
    const gate = deriveReviewGate(fm.review);
    if (gate && gate.phase !== 'published') {
      const label = gate.phase === 'in-review' ? 'in review' : gate.phase;
      throw new Error(`Cannot delete "${filename}" — review in flight (${gate.phase} since ${gate.since}). Resolve the review lifecycle first.`);
    }
  }

  // Invalidate cache for deleted doc
  invalidateDocCache(targetPath);

  // Remove stub status for the deleted filename so a future recreate with
  // the same name doesn't inherit the prior stub flag.
  unmarkAgentStub(filename);

  // Unregister if external
  if (isExternalDoc(filename)) {
    unregisterExternalDoc(targetPath);
  }

  const allDocs = readdirSync(getDataDir()).filter((f) => f.endsWith('.md'));
  // The desk is never empty (spec 2026-09-14-last-doc-starter): deleting the
  // last document seeds a fresh starter instead of refusing.
  const lastDoc = allDocs.length <= 1;

  const isDeletingActive = targetPath === getFilePath();

  // Capture the sidebar's flat order BEFORE the file is trashed, so a
  // delete-of-the-active-doc can land the switch on the doc ADJACENT to the one
  // removed (least-jarring — the view barely moves). The prior behavior switched
  // to the globally newest-by-mtime doc, which flung the editor + filetree across
  // the workspace to an unrelated doc. Only needed when deleting the active doc.
  const orderedBefore = isDeletingActive
    ? (() => { try { return listDocuments().map((d) => d.filename); } catch { return [] as string[]; } })()
    : [];

  // Read docId BEFORE deleting the file so we can retire its overlay sidecar
  // in lockstep. The sidecar's lifecycle is bound to the docId's existence in
  // the workspace; delete retires the docId, archive does not.
  // adr: adr/0005-pending-overlay-model.md
  let docIdToRetire = '';
  if (existsSync(targetPath)) {
    try {
      const raw = readFileSync(targetPath, 'utf-8');
      const { data } = matter(raw);
      if (typeof data?.docId === 'string') docIdToRetire = data.docId;
    } catch { /* best-effort */ }
  }

  if (!isExternalDoc(filename) && existsSync(targetPath)) {
    await trash(targetPath);
  }

  if (docIdToRetire) deleteOverlay(docIdToRetire);

  if (lastDoc) {
    // Seed the starter AFTER the trash so the dying doc can't force the
    // 'Untitled 2' dedupe suffix, and through the standard create path so
    // the starter is a pristine record — fresh docId, empty body, clean
    // {title, docId} frontmatter, nothing inherited from the deleted doc.
    const seeded = createDocumentFile('Untitled');
    // createDocumentFile marks in-memory agent-stub status at create time;
    // the starter is writer-owned, so reject semantics must not apply.
    unmarkAgentStub(seeded.filename);
    if (isDeletingActive) {
      // Land the writer on the starter — same re-anchor pattern as the
      // sibling-adjacent switch below (parse fresh, stat mtime, re-watch).
      const starterPath = resolveDocPath(seeded.filename);
      const raw = readFileSync(starterPath, 'utf-8');
      const parsed = markdownToTiptap(raw);
      const mtime = statSync(starterPath).mtimeMs;
      setActiveDocument(parsed.document, seeded.title, starterPath, false, new Date(mtime), parsed.metadata, undefined);
      return { switched: true, newDoc: { document: getDocument(), title: getTitle(), filename: seeded.filename } };
    }
    // Active doc is external/temp — file seeded, editor untouched.
  }

  if (isDeletingActive) {
    // Prefer the doc adjacent to the deleted one in sidebar order — previous
    // sibling first, then next. Falls back to newest-by-mtime only if the order
    // lookup comes up empty (e.g. manifest missing), preserving old behavior.
    let nextName: string | null = null;
    const idx = orderedBefore.indexOf(filename);
    if (idx >= 0) {
      for (let i = idx - 1; i >= 0; i--) { if (orderedBefore[i] !== filename) { nextName = orderedBefore[i]; break; } }
      if (!nextName) {
        for (let i = idx + 1; i < orderedBefore.length; i++) { if (orderedBefore[i] !== filename) { nextName = orderedBefore[i]; break; } }
      }
    }

    let nextPath: string | null = null;
    if (nextName) {
      const p = resolveDocPath(nextName);
      if (existsSync(p)) nextPath = p;
    }
    if (!nextPath) {
      const remaining = readdirSync(getDataDir())
        .filter((f) => f.endsWith('.md'))
        .map((f) => ({ name: f, path: join(getDataDir(), f), mtime: statSync(join(getDataDir(), f)).mtimeMs }))
        .sort((a, b) => b.mtime - a.mtime);
      if (remaining.length > 0) { nextName = remaining[0].name; nextPath = remaining[0].path; }
    }

    if (nextPath && nextName) {
      const nextBase = nextPath.split(/[/\\]/).pop() || nextName;
      const raw = readFileSync(nextPath, 'utf-8');
      const parsed = markdownToTiptap(raw);
      const mtime = statSync(nextPath).mtimeMs;
      setActiveDocument(parsed.document, parsed.title, nextPath, nextBase.startsWith(TEMP_PREFIX), new Date(mtime), parsed.metadata, undefined);
      return { switched: true, newDoc: { document: getDocument(), title: getTitle(), filename: nextName } };
    }
  }

  return { switched: false };
}

export function reloadDocument(): { document: PadDocument; title: string; filename: string } {
  const filePath = getFilePath();
  if (!existsSync(filePath)) {
    throw new Error('Active document file not found on disk');
  }

  // Force fresh parse — invalidate any cached version
  invalidateDocCache(filePath);
  const filename = filePath.split(/[/\\]/).pop()!;
  const raw = readFileSync(filePath, 'utf-8');
  const parsed = markdownToTiptap(raw);
  const mtime = new Date(statSync(filePath).mtimeMs);

  setActiveDocument(parsed.document, parsed.title, filePath, filename.startsWith(TEMP_PREFIX), mtime, parsed.metadata, undefined);
  return { document: getDocument(), title: getTitle(), filename };
}

export function updateDocumentTitle(filename: string, newTitle: string): void {
  ensureDataDir();
  const filePath = resolveDocPath(filename);
  assertWritableDocPath(filePath); // library area is read-only (spec §3)
  if (!existsSync(filePath)) {
    throw new Error(`Document not found: ${filename}`);
  }

  const raw = readFileSync(filePath, 'utf-8');
  const parsed = markdownToTiptap(raw);
  const metadata = { ...parsed.metadata, title: newTitle };
  const { markdown } = tiptapToMarkdownChecked(parsed.document, newTitle, metadata);
  atomicWriteFileSync(filePath, markdown);

  // Update state if this is the active document
  const baseName = filePath.split(/[/\\]/).pop() || '';
  if (getFilePath() === filePath) {
    setActiveDocument(getDocument(), newTitle, filePath, baseName.startsWith(TEMP_PREFIX), undefined, metadata);
  }
}

// ============================================================================
// PENDING TITLE STAGING (agent-initiated renames gated through pending review)
// ============================================================================
//
// Agent-side renames (MCP rename_item, set_metadata with a title field) route
// here instead of calling updateDocumentTitle directly. The proposal lands in
// the per-doc sidecar's `metadata:` slot; the .md file's frontmatter is
// unchanged on disk; the user accepts or rejects via the title-bar inline
// diff. User-typed renames (HTTP PUT /api/documents/:filename) and creation-
// time titling (populate_document) still write hot — they're the user
// disposing, not the agent proposing.
//
// adr: adr/0005-pending-overlay-model.md

/** Read the canonical current title for a doc without loading it into state.
 *  Active doc → in-memory; otherwise → parse the .md frontmatter from disk. */
function readCanonicalTitle(docId: string, filename: string): string {
  if (getActiveDocId() === docId) {
    return getTitle();
  }
  const filePath = resolveDocPath(filename);
  if (!existsSync(filePath)) {
    throw new Error(`Document not found: ${filename}`);
  }
  const raw = readFileSync(filePath, 'utf-8');
  const { data } = matter(raw);
  return (data.title as string) || filename.replace(/\.md$/i, '');
}

/** Stage a pending title rename for the doc identified by `docId`. Writes
 *  to the sidecar (and to state.pendingMetadata when the doc is active).
 *  Does NOT touch the .md file on disk. Returns the resolved {from, to}
 *  pair for the caller's response message. */
export function stagePendingTitle(docId: string, newTitle: string): { from: string; to: string; filename: string } {
  const filename = filenameByDocId(docId);
  if (!filename) {
    throw new Error(`Document not found: ${docId}`);
  }
  const from = readCanonicalTitle(docId, filename);

  // Idempotency: if the proposal equals canonical, clear any pending entry
  // and return — nothing to review.
  if (newTitle === from) {
    if (getActiveDocId() === docId) {
      setActivePendingMetadata(null);
    } else {
      savePendingMetadata(docId, null);
    }
    return { from, to: newTitle, filename };
  }

  const meta: PendingMetadata = {
    title: { from, to: newTitle, addedAtVersion: getDocVersion() },
  };
  if (getActiveDocId() === docId) {
    setActivePendingMetadata(meta);
  } else {
    savePendingMetadata(docId, meta);
  }
  diagLog(`[Overlay] PENDING-TITLE STAGE docId=${docId} from="${from}" to="${newTitle}"`);
  return { from, to: newTitle, filename };
}

/** Accept a staged title rename — promote it to canonical (writes through
 *  updateDocumentTitle) and clear the pending entry. Returns the {from, to}
 *  applied, or null if no pending title was staged for this doc. */
export function acceptPendingTitle(docId: string): { from: string; to: string; filename: string } | null {
  const filename = filenameByDocId(docId);
  if (!filename) return null;
  const meta = (getActiveDocId() === docId)
    ? getActivePendingMetadata()
    : loadPendingMetadata(docId);
  if (!meta?.title) return null;
  const { from, to } = meta.title;

  // Order matters: clear pending FIRST so updateDocumentTitle's downstream
  // setActiveDocument re-rehydration sees an empty sidecar metadata slot.
  if (getActiveDocId() === docId) {
    setActivePendingMetadata(null);
  } else {
    savePendingMetadata(docId, null);
  }
  updateDocumentTitle(filename, to);
  diagLog(`[Overlay] PENDING-TITLE ACCEPT docId=${docId} from="${from}" to="${to}"`);
  return { from, to, filename };
}

/** Reject a staged title rename — discard the proposal without modifying
 *  the .md file. Returns the {from, to} that was discarded, or null if no
 *  pending title was staged. */
export function rejectPendingTitle(docId: string): { from: string; to: string; filename: string } | null {
  const filename = filenameByDocId(docId);
  if (!filename) return null;
  const meta = (getActiveDocId() === docId)
    ? getActivePendingMetadata()
    : loadPendingMetadata(docId);
  if (!meta?.title) return null;
  const { from, to } = meta.title;

  if (getActiveDocId() === docId) {
    setActivePendingMetadata(null);
  } else {
    savePendingMetadata(docId, null);
  }
  diagLog(`[Overlay] PENDING-TITLE REJECT docId=${docId} from="${from}" to="${to}"`);
  return { from, to, filename };
}

/** Lookup helper: read the currently-staged pending title for a docId, or
 *  null if no proposal exists. Active doc → in-memory; otherwise → sidecar. */
export function getPendingTitle(docId: string): { from: string; to: string; addedAtVersion: number } | null {
  const meta = (getActiveDocId() === docId)
    ? getActivePendingMetadata()
    : loadPendingMetadata(docId);
  return meta?.title ?? null;
}

/** Open an existing file from any path. Saves current doc, registers as external, sets as active.
 *
 *  Canonicalizes the input path at the boundary so opening the same physical
 *  file via different spellings (forward/back slash, drive-letter case,
 *  symlink) hits the same doc identity — same cache slot, same watcher
 *  subscription, same pending overlay.
 *  adr: adr/path-canonicalization.md */
export function openFile(fullPath: string): { document: PadDocument; title: string; filename: string } {
  if (!existsSync(fullPath)) {
    throw new Error(`File not found: ${fullPath}`);
  }
  const canonPath = canonicalizePath(fullPath);

  // Cancel any pending debounced save, then save current doc immediately
  cancelDebouncedSave();
  save();

  // Cache current doc before switching
  cacheActiveDocument();

  // Register as external if not in getDataDir()
  if (isExternalDoc(canonPath)) {
    registerExternalDoc(canonPath);
  }

  // Check cache first — preserves stable node IDs
  const cached = getCachedDocument(canonPath);
  if (cached) {
    setActiveDocument(cached.document, cached.title, canonPath, cached.isTemp, cached.lastModified, cached.metadata, cached.originalFrontmatter);
    const filename = isExternalDoc(canonPath) ? canonPath : (canonPath.split(/[/\\]/).pop() || '');
    return { document: getDocument(), title: getTitle(), filename };
  }

  const raw = readFileSync(canonPath, 'utf-8');
  const parsed = markdownToTiptap(raw);
  const mtime = new Date(statSync(canonPath).mtimeMs);

  ensureDocId(parsed.metadata);

  // Title fallback: use filename stem instead of "Untitled" for files without a title
  let title = parsed.title;
  if (title === 'Untitled') {
    const stem = canonPath.split(/[/\\]/).pop()?.replace(/\.md$/i, '');
    if (stem) title = stem;
  }

  const baseName = canonPath.split(/[/\\]/).pop() || '';
  setActiveDocument(parsed.document, title, canonPath, baseName.startsWith(TEMP_PREFIX), mtime, parsed.metadata, parsed.rawFrontmatter);

  // Use full path as filename for external docs, basename for getDataDir() docs
  const filename = isExternalDoc(canonPath) ? canonPath : baseName;
  return { document: getDocument(), title: getTitle(), filename };
}

export function duplicateDocument(
  filename: string,
  variant?: { masterDocId?: string; variantType?: string },
): { document: PadDocument; title: string; filename: string } {
  // Cancel any pending debounced save, then save current doc immediately
  cancelDebouncedSave();
  save();

  const sourcePath = resolveDocPath(filename);
  if (!existsSync(sourcePath)) {
    throw new Error(`Document not found: ${filename}`);
  }

  const raw = readFileSync(sourcePath, 'utf-8');
  const parsed = markdownToTiptap(raw);

  // Title suffix: variants read as "(Tweet)" / "(Blog)", plain copies as "(Copy)".
  const suffix = variant?.variantType
    ? variant.variantType.charAt(0).toUpperCase() + variant.variantType.slice(1)
    : 'Copy';

  // Generate deduplicated title
  let newTitle = `${parsed.title} (${suffix})`;
  let filePath = filePathForTitle(newTitle);
  if (existsSync(filePath)) {
    let counter = 2;
    while (existsSync(filePathForTitle(`${parsed.title} (${suffix} ${counter})`))) counter++;
    newTitle = `${parsed.title} (${suffix} ${counter})`;
    filePath = filePathForTitle(newTitle);
  }

  const metadata: Record<string, any> = { ...parsed.metadata, title: newTitle, docId: generateNodeId() };
  // Variant relationship — set AFTER the spread so it overrides any inherited
  // masterDocId/variantType from the source doc. masterDocId points at the
  // source (the master); variantType labels this copy's intended format.
  // adr: docs/variants.md
  if (variant?.masterDocId) metadata.masterDocId = variant.masterDocId;
  if (variant?.variantType) metadata.variantType = variant.variantType;
  setActiveDocument(parsed.document, newTitle, filePath, false, undefined, metadata);

  const { markdown } = tiptapToMarkdownChecked(parsed.document, newTitle, metadata);
  ensureDataDir();
  atomicWriteFileSync(filePath, markdown);

  const newFilename = filePath.split(/[/\\]/).pop()!;
  return { document: getDocument(), title: getTitle(), filename: newFilename };
}

// Content types that surface an editable title/headline above the body. For
// these, the doc's frontmatter `title` IS content (blog headline, article title,
// newsletter subject). For every other type the title is just a sidebar label
// and the body carries everything. adr: docs/variants.md
const TITLE_BEARING_TYPES = new Set(['blog', 'article', 'newsletter']);

/**
 * Create a variant of `masterFilename` retyped as `variantType`, nested under
 * the master. Field-projection model (NOT a verbatim clone — that's
 * duplicateDocument): port the fields the two types share.
 *  - body: always ported.
 *  - downcast (title-bearing master → body-only variant): the master's title is
 *    folded into the body as its first paragraph so the headline isn't lost.
 *  - the variant is scaffolded with the TARGET type's content_type + context;
 *    the source's context objects (blogContext, tweetContext, …) are NOT
 *    inherited — a variant is a new typed doc, not a surface clone.
 * adr: docs/variants.md
 */
export function createVariant(
  masterFilename: string,
  opts: { masterDocId: string; variantType: string },
): { document: PadDocument; title: string; filename: string } {
  cancelDebouncedSave();
  save();

  const sourcePath = resolveDocPath(masterFilename);
  if (!existsSync(sourcePath)) throw new Error(`Document not found: ${masterFilename}`);

  const raw = readFileSync(sourcePath, 'utf-8');
  const parsed = markdownToTiptap(raw);
  const srcType = deriveContentType(parsed.metadata) || 'document';
  const tgtType = opts.variantType;
  const srcTitleBearing = TITLE_BEARING_TYPES.has(srcType);
  const tgtTitleBearing = TITLE_BEARING_TYPES.has(tgtType);

  // Body projection. Downcast (title-bearing → body-only): prepend the master's
  // title as the first paragraph so the headline survives in a surface with no
  // title field ("title becomes first line, body the next paragraph"). Otherwise
  // the body ports unchanged.
  let bodyContent = parsed.document.content || [];
  if (srcTitleBearing && !tgtTitleBearing && parsed.title) {
    bodyContent = [
      { type: 'paragraph', content: [{ type: 'text', text: parsed.title }] },
      ...bodyContent,
    ];
  }
  const bodyDoc = { ...parsed.document, content: bodyContent } as PadDocument;

  // Title is always label-suffixed: it doubles as the filename + sidebar name,
  // so it must stay unique vs the master (a raw duplicate title would collide).
  // The title CONTENT still rides along for title-bearing targets — they render
  // it as the headline and the user trims the suffix.
  const Label = tgtType.charAt(0).toUpperCase() + tgtType.slice(1);
  let newTitle = `${parsed.title} (${Label})`;
  let filePath = filePathForTitle(newTitle);
  if (existsSync(filePath)) {
    let counter = 2;
    while (existsSync(filePathForTitle(`${parsed.title} (${Label} ${counter})`))) counter++;
    newTitle = `${parsed.title} (${Label} ${counter})`;
    filePath = filePathForTitle(newTitle);
  }

  // Fresh metadata: target type scaffold + variant relationship only. Source
  // context objects are intentionally dropped (see header).
  const metadata: Record<string, any> = {
    title: newTitle,
    docId: generateNodeId(),
    ...(resolveTypeMeta(tgtType) || {}),
    masterDocId: opts.masterDocId,
    variantType: tgtType,
  };

  setActiveDocument(bodyDoc, newTitle, filePath, false, undefined, metadata);
  const { markdown } = tiptapToMarkdownChecked(bodyDoc, newTitle, metadata);
  ensureDataDir();
  atomicWriteFileSync(filePath, markdown);

  const newFilename = filePath.split(/[/\\]/).pop()!;
  return { document: getDocument(), title: getTitle(), filename: newFilename };
}

export function getActiveFilename(): string {
  const filePath = getFilePath();
  // For external docs, return the full path as the identifier
  if (isExternalDoc(filePath)) return filePath;
  return filePath.split(/[/\\]/).pop() || '';
}

/**
 * Promote a temp file (_untitled-xxx.md) to a named file when the title is set.
 * Renames the file on disk, updates state, workspace refs, marks sidecar, and caches.
 * Returns the new filename, or null if not applicable (not temp, or title is 'Untitled').
 */
export function promoteTempFile(newTitle: string): string | null {
  if (!getIsTemp() || !newTitle || newTitle === 'Untitled') return null;

  const oldPath = getFilePath();
  const oldFilename = oldPath.split(/[/\\]/).pop() || '';
  if (!oldFilename || !existsSync(oldPath)) return null;

  // Generate new path with dedup
  let newPath = filePathForTitle(newTitle);
  if (existsSync(newPath)) {
    let counter = 2;
    while (existsSync(filePathForTitle(`${newTitle} ${counter}`))) counter++;
    newPath = filePathForTitle(`${newTitle} ${counter}`);
  }
  const newFilename = newPath.split(/[/\\]/).pop()!;

  // Rename on disk
  renameSync(oldPath, newPath);

  // Update state
  setActiveDocument(getDocument(), newTitle, newPath, false, undefined, getMetadata());

  // Invalidate old caches
  removePendingCacheEntry(oldFilename);
  invalidateDocCache(oldPath);

  // Carry the agent-stub flag across the rename (if the doc was still a
  // fresh stub when renamed — uncommon but possible). The Set is keyed by
  // filename, so we must transfer the entry to the new key.
  // adr: adr/agent-stub-model.md
  if (isAgentStub(oldFilename)) {
    unmarkAgentStub(oldFilename);
    markAsAgentStub(newFilename);
  }

  // Update workspace references
  renameDocInAllWorkspaces(oldFilename, newFilename, newTitle);

  return newFilename;
}

// ============================================================================
// BATCH RESOLVE — accept/reject pending changes across multiple docs
// ============================================================================

const PENDING_ATTRS = ['pendingStatus', 'pendingOriginalContent', 'pendingProvenance', 'pendingGroupId', 'pendingSelectionFrom', 'pendingSelectionTo', 'pendingOriginalFrom', 'pendingOriginalTo'];

function clearPendingAttrs(attrs: Record<string, any>): Record<string, any> {
  const clean = { ...attrs };
  for (const key of PENDING_ATTRS) delete clean[key];
  return clean;
}

/** Walk TipTap JSON, accept all pending changes in-place. Returns count of resolved nodes. */
function acceptAllInDoc(doc: any): number {
  let count = 0;
  function walk(nodes: any[]): any[] {
    const result: any[] = [];
    for (const node of nodes) {
      const status = node.attrs?.pendingStatus;
      if (status === 'delete') {
        count++;
        continue; // Remove delete nodes
      }
      if (status === 'insert' || status === 'rewrite') {
        node.attrs = clearPendingAttrs(node.attrs);
        count++;
      }
      if (node.content) {
        node.content = walk(node.content);
      }
      result.push(node);
    }
    return result;
  }
  if (doc.content) doc.content = walk(doc.content);
  return count;
}

/** Walk TipTap JSON, reject all pending changes in-place. Returns count of resolved nodes. */
function rejectAllInDoc(doc: any): number {
  let count = 0;
  function walk(nodes: any[]): any[] {
    const result: any[] = [];
    for (const node of nodes) {
      const status = node.attrs?.pendingStatus;
      if (status === 'insert') {
        count++;
        continue; // Remove inserted nodes
      }
      if (status === 'rewrite') {
        const original = node.attrs?.pendingOriginalContent;
        if (original) {
          // Replace with original content
          result.push(original);
        }
        // If no original, just drop the node
        count++;
        continue;
      }
      if (status === 'delete') {
        // Keep the node, just clear pending status
        node.attrs = clearPendingAttrs(node.attrs);
        count++;
      }
      if (node.content) {
        node.content = walk(node.content);
      }
      result.push(node);
    }
    return result;
  }
  if (doc.content) doc.content = walk(doc.content);
  return count;
}

export interface ProvenanceRecord {
  agentSessionId: string;
  model: string;
  promptVersion: string;
  sourceSet: string[];
  reviewerStatus: string | null;
  proposedAt: string;
  acceptedAt: string;
  accepted: { nodeId: string; status: string }[];
}

/** Build frontmatter provenance records from accepted pending entries. The
 *  author tag rides the entry itself (atomic with the change), so attribution
 *  cannot drift from the text it describes. Entries WITHOUT a provenance tag
 *  (external MCP writes) record nothing. Entries sharing one origin batch
 *  (one propose_edits call) coalesce into ONE record. */
export function collectAcceptedProvenance(
  entries: { nodeId: string; status: string; provenance?: ProposedProvenance }[],
  acceptedAt: string,
): ProvenanceRecord[] {
  const byOrigin = new Map<string, ProvenanceRecord>();
  for (const entry of entries) {
    const p = entry.provenance;
    if (!p) continue;
    const key = JSON.stringify([p.agentSessionId, p.model, p.promptVersion, p.sourceSet, p.reviewerStatus, p.proposedAt]);
    const record: ProvenanceRecord = byOrigin.get(key) ?? {
      agentSessionId: p.agentSessionId,
      model: p.model,
      promptVersion: p.promptVersion,
      sourceSet: p.sourceSet ?? [],
      reviewerStatus: p.reviewerStatus ?? null,
      proposedAt: p.proposedAt,
      acceptedAt,
      accepted: [],
    };
    record.accepted.push({ nodeId: entry.nodeId, status: entry.status });
    byOrigin.set(key, record);
  }
  return Array.from(byOrigin.values());
}

/** Append records to a frontmatter `provenance` array (the key is an array
 *  of records; earlier accepted batches survive). Returns the new metadata. */
export function appendProvenanceRecords(metadata: Record<string, any> | undefined, records: ProvenanceRecord[]): Record<string, any> {
  const existing = Array.isArray(metadata?.provenance) ? metadata!.provenance : [];
  return { ...(metadata ?? {}), provenance: [...existing, ...records] };
}

/** Per-node resolve (spike patch #7): accept/reject ONE pending entry by nodeId.
 *  Signature per evaluation build list #7 — the CALLER supplies docId. The
 *  active doc resolves in-memory; any other pending doc resolves through the
 *  file path resolveDocFile (below) uses for whole-doc resolves. */
export function resolveOverlayEntry(docId: string, nodeId: string, action: 'accept' | 'reject'): { resolved: number } {
  if (docId === getActiveDocId()) {
    const doc = getDocument();
    const resolved = walkAndResolve(doc.content, nodeId, action);
    if (resolved > 0) {
      // Keep the in-memory overlay consistent with the mutated merged document
      // before save() derives the canonical body and persists the sidecar.
      // Capture the accepted entry's author tag FIRST — the entry is about to
      // be removed. setMetadata bumps docVersion, so we only fall back to
      // bumpDocVersion when there are no records to append.
      const acceptedEntry = getOverlayEntries().find((e) => e.nodeId === nodeId);
      const records = action === 'accept' && acceptedEntry
        ? collectAcceptedProvenance([acceptedEntry], new Date().toISOString())
        : [];
      removeOverlayEntries([nodeId]);
      if (records.length > 0) {
        setMetadata(appendProvenanceRecords(getMetadata(), records));
      } else {
        bumpDocVersion();
      }
      save();
    }
    return { resolved };
  }
  // Non-active: load the full merged document (canonical + sidecar overlay), walk
  // it, then persist the resolved canonical body plus the filtered sidecar.
  const filename = resolveDocId(docId);
  const filePath = isExternalDoc(filename) ? filename : join(getDataDir(), filename);
  assertWritableDocPath(filePath); // library area is read-only (spec §3)
  if (!existsSync(filePath)) return { resolved: 0 };
  const merged = loadDocFromDisk(filename);
  const acceptedEntry = action === 'accept' ? loadOverlay(docId).find((e) => e.nodeId === nodeId) : undefined;
  const resolved = walkAndResolve(merged.document.content, nodeId, action);
  if (resolved > 0) {
    if (acceptedEntry) {
      const records = collectAcceptedProvenance([acceptedEntry], new Date().toISOString());
      if (records.length > 0) {
        merged.metadata = appendProvenanceRecords(merged.metadata, records);
      }
    }
    const { markdown } = tiptapToMarkdownChecked(merged.document, merged.title, merged.metadata);
    atomicWriteFileSync(filePath, markdown);
    saveOverlay(docId, loadOverlay(docId).filter((e) => e.nodeId !== nodeId));
  }
  return { resolved };
}

/** Shared per-node walker — exactly ONE nodeId, node semantics identical to
 *  acceptAllInDoc/rejectAllInDoc (documents.ts:1484/1510) and the client's
 *  resolve.ts: accept → clear attrs (delete: drop node); reject → drop inserts,
 *  restore pendingOriginalContent on rewrites, clear deletes. */
function walkAndResolve(nodes: any[], nodeId: string, action: 'accept' | 'reject'): number {
  let resolved = 0;
  function walk(list: any[]): any[] {
    const result: any[] = [];
    for (const node of list) {
      if (node.attrs?.id === nodeId && node.attrs?.pendingStatus) {
        const status = node.attrs.pendingStatus as 'insert' | 'rewrite' | 'delete';
        if (action === 'accept') {
          if (status === 'delete') { resolved++; continue; }        // drop node (parity: acceptAllInDoc)
          node.attrs = clearPendingAttrs(node.attrs); resolved++;
        } else {
          if (status === 'insert') { resolved++; continue; }        // drop node
          if (status === 'rewrite') {
            const original = node.attrs?.pendingOriginalContent;
            if (original) result.push(...(Array.isArray(original) ? original : [original]));
            resolved++;                                             // no original → drop (parity: rejectAllInDoc)
            continue;
          }
          node.attrs = clearPendingAttrs(node.attrs); resolved++;   // delete: keep node
        }
      }
      if (node.content) node.content = walk(node.content);
      result.push(node);
    }
    return result;
  }
  if (nodes) {
    // Mutate the caller's array in place so the resolved document is reflected
    // in the active merged view (state.document.content) and in the parsed
    // non-active document before re-serialization.
    const result = walk(nodes);
    nodes.length = 0;
    nodes.push(...result);
  }
  return resolved;
}

/** Resolve a single doc file on disk. Returns number of changes resolved. */
function resolveDocFile(filePath: string, action: 'accept' | 'reject'): { count: number; docId: string | null } {
  const raw = readFileSync(filePath, 'utf-8');
  const { data } = matter(raw);
  const docId = (data && typeof data.docId === 'string') ? data.docId : null;
  const filename = filePath.split(/[/\\]/).pop() || '';
  const loaded = loadDocFromDisk(filename);
  const doc = loaded.document;
  const pendingEntries = docId ? loadOverlay(docId) : [];
  const hasPending = doc?.content?.some((n: any) => n?.attrs?.pendingStatus);
  if (!hasPending) return { count: 0, docId };
  // Orphan filter ( final-review item 1): liveness against the merged
  // doc BEFORE any resolve mutation — accepted deletes drop/transform their
  // nodes, and the record must list only entries whose targets existed at
  // accept time.
  const liveEntries = action === 'accept' ? liveOverlayEntries(doc.content ?? [], pendingEntries) : pendingEntries;
  const count = action === 'accept' ? acceptAllInDoc(doc) : rejectAllInDoc(doc);
  if (count === 0) return { count: 0, docId };
  if (action === 'accept' && liveEntries.length > 0) {
    const records = collectAcceptedProvenance(liveEntries, new Date().toISOString());
    if (records.length > 0) {
      loaded.metadata = appendProvenanceRecords(loaded.metadata, records);
    }
  }
  const { markdown: newRaw } = tiptapToMarkdownChecked(doc, loaded.title, loaded.metadata);
  atomicWriteFileSync(filePath, newRaw);
  if (docId) deleteOverlay(docId);
  return { count, docId };
}

export function batchResolve(filenames: string[], action: 'accept' | 'reject'): { docsResolved: number; changesResolved: number } {
  let docsResolved = 0;
  let changesResolved = 0;
  for (const filename of filenames) {
    const filePath = isExternalDoc(filename) ? filename : join(getDataDir(), filename);
    assertWritableDocPath(filePath); // library area is read-only (spec §3)
    if (!existsSync(filePath)) continue;
    try {
      const { count, docId } = resolveDocFile(filePath, action);
      if (count > 0) {
        docsResolved++;
        changesResolved += count;
        if (filePath === getFilePath()) {
          const currentDoc = getDocument();
          if (action === 'accept') acceptAllInDoc(currentDoc);
          else rejectAllInDoc(currentDoc);
          save();
        }
        if (action === 'accept' && docId) {
          try {
            commitFromFile(docId, filePath, { trigger: 'accept', actor: 'human', nowTs: Date.now() });
          } catch { /* best-effort */ }
        }
      }
    } catch { /* skip unreadable files */ }
  }
  return { docsResolved, changesResolved };
}
