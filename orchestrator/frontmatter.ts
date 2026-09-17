/**
 * Frontmatter surgery for orchestrator transitions. adr: adr/0007; spec
 * 2026-09-08-m4a-git-orchestrator-design.md Decision 9. gray-matter is already
 * the app's frontmatter dep — same YAML engine, so the provenance array
 * round-trips. The body passes through byte-exactly; the YAML block
 * re-serializes, which the app tolerates as an external edit.
 */
import matter from 'gray-matter';

export interface DocHead {
  docId: string | null;
  title: string | null;
  submittedAt: string | null;
  sessionId: string | null;
  model: string | null;
}

export function readDocHead(raw: string): DocHead {
  const { data } = matter(raw, {});
  const d = (data ?? {}) as Record<string, any>;
  const review = (d.review ?? {}) as Record<string, any>;
  const sub = review.submitted ?? null;
  return {
    docId: typeof d.docId === 'string' ? d.docId : null,
    title: typeof d.title === 'string' ? d.title : null,
    submittedAt: sub && typeof sub.at === 'string' ? sub.at : null,
    sessionId: sub && typeof sub.sessionId === 'string' ? sub.sessionId : null,
    model: sub && typeof sub.model === 'string' ? sub.model : null,
  };
}

/**
 * Reads the app-minted adoption stamp (`library.key`) off a desk doc's
 * frontmatter. null when there is no frontmatter block, when `library` is
 * absent, or when `key` is not a non-empty `owner/docId` string.
 */
export function readLibraryKey(raw: string): string | null {
  const data = matter(raw, {}).data as Record<string, unknown> | undefined;
  const lib = data && (data as Record<string, unknown>).library as { key?: unknown } | undefined;
  return lib && typeof lib.key === 'string' && lib.key.includes('/') ? lib.key : null;
}

/**
 * Reads the desk copy's recorded converged base (`review.published.sha`): the
 * sha of the library article as it stood when this desk last converged with
 * main (merge-back stamps `sha256Hex(merged)`). null when absent — the
 * ship-time base check then skips (cannot verify the base).
 */
export function readPublishedSha(raw: string): string | null {
  const data = matter(raw, {}).data as Record<string, any> | undefined;
  const pub = data && (data.review ?? {}) as Record<string, any>;
  return pub && typeof pub.published?.sha === 'string' ? pub.published.sha : null;
}

type Transition = (raw: string) => string;

export function prOpenedTransition(pr: { at: string; url: string; cycle: number }): Transition {
  return (raw) => {
    const result = matter(raw, {}) as any;
    const { data, content } = result;
    if (result.isEmpty || !result.matter || result.matter.trim() === '') return raw;
    const d = (data ?? {}) as Record<string, any>;
    const review = { ...((d.review ?? {}) as Record<string, any>) };
    review.pr = { at: pr.at, url: pr.url, cycle: pr.cycle };
    return matter.stringify(content, { ...d, review });
  };
}

export function returnedTransition(ret: { at: string; pr: number }): Transition {
  return (raw) => {
    const result = matter(raw, {}) as any;
    const { data, content } = result;
    if (result.isEmpty || !result.matter || result.matter.trim() === '') return raw;
    const d = (data ?? {}) as Record<string, any>;
    const review = { ...((d.review ?? {}) as Record<string, any>) };
    delete review.submitted;
    delete review.pr;
    review.returned = { at: ret.at, pr: ret.pr };
    return matter.stringify(content, { ...d, review });
  };
}

export function publishedTransition(pub: { at: string; pr: number; sha: string }): Transition {
  return (raw) => {
    const result = matter(raw, {}) as any;
    const { data, content } = result;
    if (result.isEmpty || !result.matter || result.matter.trim() === '') return raw;
    const d = (data ?? {}) as Record<string, any>;
    const review = { ...((d.review ?? {}) as Record<string, any>) };
    delete review.submitted;
    delete review.pr;
    delete review.returned;
    review.published = pub;
    return matter.stringify(content, { ...d, review });
  };
}

/** `pr: null` = the conflict was a ship-time refusal (spec §2): no PR was ever
 *  opened for it, so there is no number to record. */
export function conflictTransition(c: { at: string; pr: number | null }): Transition {
  return (raw) => {
    const result = matter(raw, {}) as any;
    const { data, content } = result;
    if (result.isEmpty || !result.matter || result.matter.trim() === '') return raw;
    const d = (data ?? {}) as Record<string, any>;
    const review = { ...((d.review ?? {}) as Record<string, any>) };
    delete review.submitted;
    delete review.pr;
    review.conflict = { at: c.at, pr: c.pr };
    return matter.stringify(content, { ...d, review });
  };
}

export function submittedClearedTransition(): Transition {
  return (raw) => {
    const result = matter(raw, {}) as any;
    const { data, content } = result;
    if (result.isEmpty || !result.matter || result.matter.trim() === '') return raw;
    const d = (data ?? {}) as Record<string, any>;
    const review = { ...((d.review ?? {}) as Record<string, any>) };
    delete review.submitted;
    return matter.stringify(content, { ...d, review });
  };
}

/**
 * Reads the desk copy's full check-out block (`library`) — re-applied at
 * merge-back, since the merged corpus bytes are ship-cleaned. null when
 * absent or not an object.
 */
export function readLibraryBlock(raw: string): Record<string, unknown> | null {
  const data = matter(raw, {}).data as Record<string, unknown> | undefined;
  const lib = data && (data as Record<string, unknown>).library;
  return lib && typeof lib === 'object' ? (lib as Record<string, unknown>) : null;
}

/** Re-applies a check-out block to (ship-cleaned) bytes; no-op when null. */
export function reapplyLibraryTransition(library: Record<string, unknown> | null): Transition {
  return (raw) => {
    if (library === null) return raw;
    const result = matter(raw, {}) as any;
    const { data, content } = result;
    if (result.isEmpty || !result.matter || result.matter.trim() === '') return raw;
    return matter.stringify(content, { ...((data ?? {}) as Record<string, any>), library });
  };
}

/**
 * The corpus article never carries writer-session stamps: the ship path
 * commits the desk file's bytes, so the pushed copy drops the review cycle
 * stamps (submitted/pr/returned/conflict) and the check-out bookkeeping
 * (library) — a re-adopted copy inherited the corpus-carried
 * review.submitted and showed a phantom "Sent for review" (live leak,
 * 2026-09-15). review.published rides along (the convergence sha feeds the
 * ship-time base check); every other key rides; the body passes through
 * byte-exactly.
 */
export function cleanForShipTransition(): Transition {
  return (raw) => {
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
    delete next.library;
    return matter.stringify(content, next);
  };
}
