/**
 * The poll loop. Zero LLM: everything here is deterministic fs/git/Gitea-REST work.
 * adr: adr/0007; spec 2026-09-08-m4a-git-orchestrator-design.md §The loop.
 */
import { existsSync, readFileSync, readdirSync } from 'fs';
import { dirname, join } from 'path';
import type { StaticConfig, OrchestratorConfig } from './config.js';
import type { GitStore } from './git-store.js';
import type { GiteaPort } from './gitea.js';
import { scanWriterRoot, type ScannedDoc } from './scan.js';
import { articleKey, loadArticle, saveArticle, transition, type ArticleRecord } from './state.js';
import { cycleMessage } from './cycle-message.js';
import { prOpenedTransition, conflictTransition, readPublishedSha, cleanForShipTransition } from './frontmatter.js';
import { atomicWriteFileSync, bodyHashHex, sha256Hex, withMtimeCas, MtimeRaceError } from './util.js';
import { readLibraryFromClone, syncDeskMirror } from './desk-mirror.js';
import { handleMerged, handleClosed } from './mergeback.js';
import type { Cycle } from './store-bridge.js';

export interface OrchestratorPorts { git: GitStore; gitea: GiteaPort }

interface DocEntry extends ScannedDoc { writerId: string; key: string; }

/**
 * The library key a desk doc ships under (spec §2): an adopted doc carries the
 * original writer's key in frontmatter (`library.key`) and so edits the
 * EXISTING article file — the duplicate-article failure mode dies structurally.
 * A plain doc keys to its own desk, as before.
 */
export function docKey(writerId: string, doc: ScannedDoc): string {
  return doc.libraryKey ?? articleKey(writerId, doc.docId);
}

/** Ship-refusal note (spec §2, second sequential adopter). Distinct from the
 *  merge-back divergence copy: this refusal happens before any PR. */
const SHIP_REFUSAL_NOTE = [
  'The library version of this article moved forward since you checked it out,',
  'and your desk copy is based on the older version.',
  '',
  'Your work is not lost. Open the History tab to see past snapshots. You can',
  'return the article to the library (Return to library — your text stays in',
  'History), or bring your desk copy in line with the',
  'library — then submit the article for approval again. A fresh submission',
  'starts a new review.',
].join('\n') + '\n';

export async function pollOnce(cfg: OrchestratorConfig, ports: OrchestratorPorts): Promise<void> {
  // Pass 0: one scan per writer root. The scan is a flat list, NOT a per-key
  // map: two desks can map to one library key (an adopted doc carries the
  // key), and both must stay visible — the ship and terminal passes each pick
  // the doc they need (the submitted one; the one whose body was pushed).
  const docs: DocEntry[] = [];
  for (const w of cfg.writerRoots) {
    for (const doc of scanWriterRoot(w.root)) {
      docs.push({ ...doc, writerId: w.id, key: docKey(w.id, doc) });
    }
  }

  // Pass 1: shipping — submit boundaries, interrupted ships, and PR-open amends.
  const shipped = new Set<string>();   // one ship per key per tick
  for (const doc of docs) {
    const key = doc.key;
    let rec = loadArticle(cfg.stateDir, key);
    const stampMs = doc.submittedAt ? Date.parse(doc.submittedAt) : NaN;
    // Conflict exit (spec §Terminal states): conflict-write cleared
    // review.submitted (mergeback.ts) — the cleared stamp is the signal; conflict → idle.
    if (rec.state === 'conflict') {
      if (!doc.submittedAt) {
        // prNumber/prUrl clear here too — a post-conflict cycle opens a fresh PR
        saveArticle(cfg.stateDir, key, { ...transition(rec, 'idle'), prNumber: null, prUrl: null });
        console.error(`[orchestrator] ${key}: stamp cleared after conflict; conflict -> idle`);
        continue;
      }
      if (Number.isNaN(stampMs) || stampMs <= rec.watermarkMs) continue;
      // Fresh resubmit landed before this tick: resolve conflict → idle and let
      // the normal ship path open the new cycle (the stamp is strictly newer).
      saveArticle(cfg.stateDir, key, { ...transition(rec, 'idle'), prNumber: null, prUrl: null });
      console.error(`[orchestrator] ${key}: fresh resubmit after conflict; conflict -> idle, will ship`);
      rec = loadArticle(cfg.stateDir, key);
    }
    if (!doc.submittedAt) continue;
    if (Number.isNaN(stampMs)) continue;
    if (rec.state === 'merged' || rec.state === 'closed' || rec.state === 'conflict') continue;
    if (stampMs <= rec.watermarkMs && rec.state !== 'shipping') continue;
    if (shipped.has(key)) continue;
    try {
      if (await refuseStaleBase(cfg, ports, key, doc, rec)) { shipped.add(key); continue; }
      await shipCycle(cfg, ports, key, doc, rec, stampMs);
      shipped.add(key);
    } catch (e) {
      if (e instanceof MtimeRaceError) {
        // The app wrote the desk file inside a withMtimeCas window (the
        // conflict stamp or the pr stamp): the CAS rejected the write, so
        // nothing of ours landed and the next tick re-reads and retries
        // cleanly. Not a ship failure — say so; record handling is unchanged.
        console.error(`[orchestrator] ${key}: desk write raced the app (mtime CAS at ${e.filePath}); retrying next tick`);
      } else {
        console.error(`[orchestrator] ship failed for ${key}:`, e instanceof Error ? e.message : e);
      }
      const cur = loadArticle(cfg.stateDir, key);
      if (cur.state === 'shipping') saveArticle(cfg.stateDir, key, rec);   // restore pre-cycle record
    }
  }

  // Pass 2: terminal-state polling for articles with a gate PR.
  const seen = new Set<string>();   // one terminal handling per key per tick
  for (const doc of docs) {
    const key = doc.key;
    if (seen.has(key)) continue;
    seen.add(key);
    const rec = loadArticle(cfg.stateDir, key);
    if (rec.state !== 'pr-open' || rec.prNumber === null) continue;
    // Pinned desk path (spec §2): the desk that pushed drives the merge-back.
    // Another desk doc sharing the key is not the one holding the open cycle —
    // its own submit hits the ship-time base check. Legacy records (null pin)
    // take the first doc holding the key, as before the pin existed.
    const keyDocs = docs.filter((d) => d.key === key);
    const pin = rec.lastPushedDocPath;
    const pinned = pin == null ? undefined : keyDocs.find((d) => d.filePath === pin);
    let driver = pinned ?? keyDocs[0];
    if (pin != null && pinned === undefined) {
      // Orphaned pin: no scanned doc sits at the pinned path any more. A doc
      // can ship while untitled (nothing blocks stamping `submitted` on a
      // `_untitled-*.md` — scan.ts deliberately includes those) and the
      // writer's title promotion renames the file mid-review (promoteTempFile).
      // Skipping every doc under the key would wedge the rec pr-open forever:
      // the PR orphaned open, the desk never stamped review.published. Follow
      // the doc to its promoted path instead — a rename never leaves the
      // profile dir, so the key-mate sharing the pin's directory is the renamed
      // desk (otherwise the first key-mate) — and converge the record so later
      // ticks are stable. The body-hash guard still decides clean vs conflict.
      driver = keyDocs.find((d) => dirname(d.filePath) === dirname(pin)) ?? keyDocs[0];
      console.error(`[orchestrator] ${key}: pinned desk path gone (${pin}); terminal desk converged to ${driver.filePath}`);
      rec.lastPushedDocPath = driver.filePath;
      saveArticle(cfg.stateDir, key, rec);
    }
    try {
      const st = await ports.gitea.getPrState(rec.prNumber);
      if (st === 'merged') await handleMerged({ cfg, git: ports.git, writerId: driver.writerId, doc: driver, rec, key, gitea: ports.gitea });
      else if (st === 'closed') await handleClosed({ cfg, writerId: driver.writerId, doc: driver, rec, key, gitea: ports.gitea });
    } catch (e) {
      console.error(`[orchestrator] terminal poll failed for ${key}:`, e instanceof Error ? e.message : e);
    }
  }

  // Pass 3: the librarian — mirror the library (origin/main) onto each desk's
  // read-only shelf (spec §1). Non-fatal: a sync failure must never break the
  // ship/terminal cycle. Reuses Pass 0's scan (no re-scan): per-writer checked-
  // out keys are the docs' non-null library.key stamps.
  try {
    const cloneDir = await ports.git.syncMain();
    const { articles, taxonomy } = await readLibraryFromClone(cloneDir, cfg.repo.mergeDir);
    for (const w of cfg.writerRoots) {
      const checkedOut = new Set(
        docs.filter((d) => d.writerId === w.id && d.libraryKey).map((d) => d.libraryKey as string),
      );
      const r = syncDeskMirror(w.root, articles, taxonomy, checkedOut);
      if (r.seeded.length || r.updated.length || r.deleted.length)
        console.log(`[orchestrator] desk-sync ${w.id}: +${r.seeded.length} ~${r.updated.length} -${r.deleted.length}`);
    }
  } catch (e) { console.error(`[orchestrator] desk-sync failed (non-fatal): ${e instanceof Error ? e.message : String(e)}`); }
}

/**
 * Ship-time base check (spec §2 — the second sequential adopter). A
 * library-key-stamped desk copy ships only while the library article still
 * matches the version it converged on (`review.published.sha`, stamped by
 * merge-back as sha256Hex of the merged article). A mismatch means the library
 * moved since this desk last converged → refuse the ship: conflict stamp, the
 * refusal note, no PR (the existing conflict→idle exit and fresh-submit
 * recovery carry on from there). Absent sha, or no article on main yet, cannot
 * be verified → ship normally (the merge-back body guard still protects the
 * desk). Unstamped docs (new articles, the original writer's own copy) skip
 * this entirely — spec §2: key/state logic unchanged.
 */
async function refuseStaleBase(
  cfg: OrchestratorConfig, ports: OrchestratorPorts, key: string, doc: DocEntry, rec: ArticleRecord,
): Promise<boolean> {
  if (!doc.libraryKey) return false;
  const base = readPublishedSha(readFileSync(doc.filePath, 'utf-8'));
  if (base === null) return false;
  const articlePath = `${cfg.repo.mergeDir}/${key}/article.md`;
  const current = await ports.git.showRemoteFile(articlePath);   // fetches origin first → current main
  if (current === null || sha256Hex(current) === base) return false;
  console.error(
    `[orchestrator] ship-refused (stale base): key=${key}, articlePath=${doc.filePath}, ` +
    `basedOn=${base}, currentMain=${sha256Hex(current)}, originPath=${articlePath}`
  );
  const at = new Date().toISOString();
  withMtimeCas(doc.filePath, conflictTransition({ at, pr: null }));
  atomicWriteFileSync(`${doc.filePath}.merge-conflict.txt`, SHIP_REFUSAL_NOTE);
  // Record the conflict only in a state the machine can leave for it. The desk
  // write above is the user-visible truth and lands unconditionally; the rec
  // write is bookkeeping. 'shipping' has no →conflict edge by design (state.ts:
  // only pr-open/idle reach conflict), and it is reachable here — a replay of an
  // interrupted ship whose base went stale while the process was down. The
  // refusal still holds: no PR opens, and the shipping rec stays inert until the
  // writer converges (this check re-runs first on any later ship attempt).
  if (rec.state !== 'shipping') saveArticle(cfg.stateDir, key, transition(rec, 'conflict'));
  return true;
}

async function shipCycle(
  cfg: OrchestratorConfig, ports: OrchestratorPorts, key: string,
  doc: DocEntry, rec: ArticleRecord, stampMs: number,
): Promise<void> {
  const untilTs = Date.now();
  const articleRaw = readFileSync(doc.filePath, 'utf-8');
  const repoBase = `${cfg.repo.mergeDir}/${key}`;          // key = "<writerId>/<docId>"
  const branch = `${cfg.repo.branchPrefix}/${key}`;
  // The corpus copy is cleaned of writer-session stamps (review cycle stamps +
  // library check-out) — the desk file keeps its own (bodyHash is body-only,
  // and the review.pr stamp below lands on the desk copy, not the pushed one).
  const files: { path: string; content: string }[] = [{ path: `${repoBase}/article.md`, content: cleanForShipTransition()(articleRaw) }];
  const chatsDir = join(doc.profileDir, '_chats', doc.docId);
  for (const name of listJsonl(chatsDir)) {
    files.push({ path: `${repoBase}/_chats/${name}`, content: readFileSync(join(chatsDir, name), 'utf-8') });
  }
  const message = cycleMessage(
    join(doc.profileDir, '_commits', `${doc.docId}.jsonl`),
    rec.lastMessageTs,
    untilTs,
    { at: doc.submittedAt as string, sessionId: doc.sessionId ?? 'unknown', model: doc.model ?? 'unset' },
  );

  saveArticle(cfg.stateDir, key, transition(rec, 'shipping'));
  const sha = await ports.git.upsertBranchFiles(branch, files, message);
  let next = loadArticle(cfg.stateDir, key);
  // lastPushedHash is the BODY hash (frontmatter stripped — util.bodyHashHex):
  // the app's external-write reload resyncs frontmatter right after any stamp,
  // so whole-file bytes never stay stable across a cycle (UAT 2026-09-11,
  // merge-back). The body is the writer's work and the only thing
  // the merge-back guard must protect.
  next = { ...next, watermarkMs: stampMs, lastMessageTs: untilTs, lastPushedHash: bodyHashHex(articleRaw), lastPushedSha: sha, lastPushedDocPath: doc.filePath };
  saveArticle(cfg.stateDir, key, next);
  // Every cycle opens its own PR: terminal handlers clear prNumber on the
  // return to idle (spec §Commit shape — a fresh PR per cycle; §Terminal
  // states — cycle-2 semantics). Recorded v1 edge: a crash between openPr and
  // the pr-open save can in principle duplicate a PR (millisecond window;
  // a network timeout-then-retry is the realistic path). Accepted for v1 — the
  // duplicate is visible in Gitea and closable by hand; a head-query dedupe
  // is the follow-up if it ever fires in practice.
  if (next.prNumber === null) {
    const pr = await ports.gitea.openPr({ head: branch, base: cfg.repo.mainBranch, title: doc.title, body: message });
    next = { ...next, prNumber: pr.number, prUrl: pr.url, cycles: next.cycles + 1 };
    // Gate-state visibility (M4c spec §Gate-state model): stamp review.pr into
    // the workspace article. Computed from articleRaw — the same content that
    // was pushed. No hash refresh needed here: the guard compares BODY hashes
    // (run.ts shipCycle above) and a frontmatter stamp doesn't touch the body,
    // so our own stamp — or the app's reload resync of it — can't read as
    // writer divergence. The mtime-CAS rejects an app write landing in the
    // push→stamp window (the cycle retries; the push is an idempotent upsert).
    const stampedRaw = prOpenedTransition({
      at: new Date().toISOString(), url: pr.url, cycle: next.cycles,
    })(articleRaw);
    withMtimeCas(doc.filePath, () => stampedRaw);
  }
  saveArticle(cfg.stateDir, key, transition(next, 'pr-open'));
}

function listJsonl(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.jsonl') && !e.name.startsWith('.'))
    .map((e) => e.name);
}

/** Never resolves-failure out of the tick; pollOnce errors are logged, not fatal. */
export function runLoop(staticCfg: StaticConfig, readCycle: () => Cycle | null): NodeJS.Timeout {
  let lastConfigured = false;
  let idleLogged = false; // journal stays quiet while idling: one 'not configured' line at boot/transition, not one per poll
  let polling = false;    // a poll slower than the interval must not overlap the next one (concurrent shipCycles race openPr)
  const tick = () => {
    if (polling) return;
    const cyc = readCycle();
    if (!cyc) {
      if (!idleLogged) { console.error('[orchestrator] not configured — store absent; idling'); idleLogged = true; } // spec §Orchestrator: logs 'not configured' and idles (journey A1)
      lastConfigured = false;
      return;
    }
    idleLogged = false;
    if (!lastConfigured) console.error('[orchestrator] configured — store loaded');
    lastConfigured = true;
    polling = true;
    pollOnce(cyc.cfg, { git: cyc.git, gitea: cyc.gitea })
      .catch((e) => console.error('[orchestrator] poll failed:', e instanceof Error ? e.message : e))
      .finally(() => { polling = false; });
  };
  tick();
  return setInterval(tick, staticCfg.pollIntervalMs);
}
