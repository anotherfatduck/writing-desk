/**
 * Physician-gate visibility for the Review tab (M4c spec §App rendering).
 * Pure derivation from review.* frontmatter + the findings-note reader —
 * node-testable from fixtures (spec §Testing: "banner renders each state
 * from fixture frontmatter"). The orchestrator is the only writer of gate
 * state (adr: adr/0007); this module only reads. No network, no Gitea.
 *
 * Derivation order is current-state-first: conflict (a cycle ended in conflict — merge-back diverged) → returned → pr → submitted → published.
 */
import { existsSync, readFileSync } from 'fs';

export type ReviewGatePhase = 'submitted' | 'in-review' | 'published' | 'returned' | 'conflict';
export interface ReviewGate { phase: ReviewGatePhase; since: string }

export function deriveReviewGate(review: unknown): ReviewGate | null {
  const r = (review ?? {}) as Record<string, any>;
  if (r.conflict && typeof r.conflict.at === 'string') return { phase: 'conflict', since: r.conflict.at };
  if (r.returned && typeof r.returned.at === 'string') return { phase: 'returned', since: r.returned.at };
  if (r.pr && typeof r.pr.at === 'string') return { phase: 'in-review', since: r.pr.at };
  if (r.submitted && typeof r.submitted.at === 'string') return { phase: 'submitted', since: r.submitted.at };
  if (r.published && typeof r.published.at === 'string') return { phase: 'published', since: r.published.at };
  return null;
}

export function reviewNotePath(filePath: string, phase: ReviewGatePhase | null): string {
  return `${filePath}${phase === 'conflict' ? '.merge-conflict.txt' : '.submit-rejected.txt'}`;
}

export function readReviewNote(filePath: string, phase: ReviewGatePhase | null): string | null {
  if (phase !== 'returned' && phase !== 'conflict') return null;
  const p = reviewNotePath(filePath, phase);
  if (!existsSync(p)) return null;
  try {
    return readFileSync(p, 'utf-8');
  } catch {
    return null;
  }
}

/**
 * The review object a fresh submit writes: returned/published/conflict are
 * cleared (forward stamps clear each other), every other key rides along,
 * submitted stamped. The human submit route (POST /api/review-gate/submit) calls
 * this — the clear-set lives in exactly one place.
 */
export function reviewAfterFreshSubmit(existing: unknown, submitted: { at: string; sessionId: string; model: string }): Record<string, any> {
  const r = (existing ?? {}) as Record<string, any>;
  const { returned: _returned, published: _published, conflict: _conflict, ...rest } = r;
  return { ...rest, submitted };
}
