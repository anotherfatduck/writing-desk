/**
 * Per-article orchestrator state: one JSON file per article under stateDir.
 * adr: adr/0007. The filename is derived safely (docId is app-controlled and
 * we do not trust it for pathing).
 */
import { existsSync, mkdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { atomicWriteFileSync } from './util.js';

export type ArticleState = 'idle' | 'shipping' | 'pr-open' | 'merged' | 'closed' | 'conflict';

export interface ArticleRecord {
  state: ArticleState;
  watermarkMs: number;
  lastMessageTs: number;
  lastPushedHash: string | null;
  lastPushedSha: string | null;
  // The desk file whose body was pushed this cycle (spec §2). Two desks can
  // map to one library key (an adopted doc carries the key), so the terminal
  // handlers must act on the desk that actually pushed — not whichever desk
  // doc a scan happened to pair with the key. null on legacy records.
  lastPushedDocPath: string | null;
  prNumber: number | null;
  prUrl: string | null;
  cycles: number;          // M4c: 1-based shipped-cycle count (drives review.pr.cycle)
}

const DEFAULT: ArticleRecord = {
  state: 'idle', watermarkMs: 0, lastMessageTs: 0,
  lastPushedHash: null, lastPushedSha: null, lastPushedDocPath: null,
  prNumber: null, prUrl: null, cycles: 0,
};

const ALLOWED: Record<ArticleState, ArticleState[]> = {
  // 'conflict' from idle = the ship-time base check refusing a stale adopted
  // copy (spec §2: the library moved since this desk last converged) — the
  // refusal happens before any ship, so the record is still idle.
  idle: ['shipping', 'conflict'],
  // 'shipping' self-entry = crash recovery (spec §Acceptance 2: restart
  // replay — a record caught mid-ship re-runs the idempotent ship). No
  // shipping→idle edge: the ship-failure path restores the pre-cycle record
  // directly via saveArticle (bypassing the machine).
  shipping: ['pr-open', 'shipping'],
  // 'shipping' from pr-open = the amend defense (spec §The loop step 2: a
  // re-submit while the PR is open amends the open PR, never a second one).
  // 'conflict' from pr-open = the diverged merge-back (spec §Terminal states:
  // "enter conflict state").
  'pr-open': ['merged', 'closed', 'shipping', 'conflict'],
  merged: ['idle'],
  closed: ['idle'],
  conflict: ['idle'],
};

export function articleKey(writerId: string, docId: string): string {
  return `${writerId}/${docId}`;
}

function statePath(stateDir: string, key: string): string {
  const safe = key.replace(/[^A-Za-z0-9._-]/g, '_');
  return join(stateDir, `${safe}.json`);
}

export function loadArticle(stateDir: string, key: string): ArticleRecord {
  const p = statePath(stateDir, key);
  if (!existsSync(p)) return { ...DEFAULT };
  try {
    return { ...DEFAULT, ...JSON.parse(readFileSync(p, 'utf-8')) } as ArticleRecord;
  } catch {
    return { ...DEFAULT };
  }
}

export function saveArticle(stateDir: string, key: string, rec: ArticleRecord): void {
  mkdirSync(stateDir, { recursive: true });
  atomicWriteFileSync(statePath(stateDir, key), JSON.stringify(rec, null, 2) + '\n');
}

export function transition(rec: ArticleRecord, next: ArticleState): ArticleRecord {
  if (!ALLOWED[rec.state].includes(next)) {
    throw new Error(`illegal state transition ${rec.state} -> ${next}`);
  }
  return { ...rec, state: next };
}
