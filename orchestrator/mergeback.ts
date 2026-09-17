/**
 * Terminal PR states. adr: adr/0007; spec §Terminal states and the writer's
 * loop. All workspace writes are guarded external edits the app already
 * tolerates (fs.watch reload); transcripts never merge back (the workspace
 * owns them).
 */
import { readFileSync, statSync } from 'fs';
import { OrchestratorConfig } from './config.js';
import { GitStore } from './git-store.js';
import { ScannedDoc } from './scan.js';
import { ArticleRecord, loadArticle, saveArticle, transition } from './state.js';
import { publishedTransition, returnedTransition, conflictTransition, readLibraryBlock, reapplyLibraryTransition } from './frontmatter.js';
import { GiteaPort } from './gitea.js';
import { atomicWriteFileSync, bodyHashHex, sha256Hex, withMtimeCas } from './util.js';

export interface TerminalArgs {
  cfg: OrchestratorConfig;
  writerId: string;
  doc: ScannedDoc;
  rec: ArticleRecord;
  key: string;
  gitea: GiteaPort;   // M4c: findings read on the closed path (unused by handleMerged)
}

export async function handleMerged(args: TerminalArgs & { git: GitStore }): Promise<void> {
  const { cfg, git, key, rec } = args;
  const doc = args.doc;
  const repoPath = `${cfg.repo.mergeDir}/${key}/article.md`;
  const merged = await git.showRemoteFile(repoPath);
  if (merged === null) {
    console.error(`[orchestrator] PR ${rec.prNumber} merged but ${repoPath} not on origin/${cfg.repo.mainBranch} yet; will retry`);
    return;   // stay pr-open, retry next poll
  }

  // The desk file whose body was pushed this cycle (spec §2): two desks can
  // share one library key (an adopted doc), so `doc` from the scan is not
  // necessarily the desk holding the open cycle. Legacy records (null) fall
  // back to the scanned doc, as before.
  const articlePath = rec.lastPushedDocPath ?? doc.filePath;
  const stat1 = statSync(articlePath).mtimeMs;
  const currentRaw = readFileSync(articlePath, 'utf-8');
  if (statSync(articlePath).mtimeMs !== stat1) return;   // raced with the app; retry next poll

  // Branch lifecycle (spec §Commit shape): the merge is confirmed on main —
  // retire the article branch so the next cycle re-creates it from the fresh
  // main tip and the next PR's diff is that cycle only, whatever merge style
  // the gate used. Before any workspace write: a failure here retries the
  // whole merged handling next poll; the deletes are idempotent. Rejection
  // never retires (handleClosed) — the branch must persist so the next PR
  // re-shows everything unmerged.
  await git.retireBranch(`${cfg.repo.branchPrefix}/${key}`);

  // Body-level byte-guard: the writer's prose is what must not be clobbered.
  // Frontmatter churns by design (our own stamps, the app's reload resync
  // re-serializing them — UAT 2026-09-11), so whole-file bytes can
  // never be the baseline; the body is.
  if (bodyHashHex(currentRaw) !== rec.lastPushedHash) {
    // Diverged since submit: never clobber. Conflict note in desk/library prose;
    // technical pointers go to the journal via console.error.
    console.error(
      `[orchestrator] merge-conflict: key=${key}, branch=${cfg.repo.branchPrefix}/${key}, ` +
      `pr=${rec.prUrl ?? rec.prNumber}, articlePath=${articlePath}, ` +
      `pushedSha=${rec.lastPushedSha ?? 'unknown'}, pushedBodyHash=${rec.lastPushedHash}, ` +
      `currentBodyHash=${bodyHashHex(currentRaw)}, originPath=${repoPath}`
    );
    const note = [
      'This article changed in the library after you submitted it, and then it was approved.',
      'Because your desk copy also changed after you submitted, the approved library version was not written back to your desk automatically.',
      '',
      'Your work is not lost. Open the History tab to see past snapshots, including the approved version.',
      'Restore the approved snapshot, or bring your desk copy in line with it — then submit the article for approval again. A fresh submission starts a new review.',
    ].join('\n') + '\n';
    atomicWriteFileSync(`${articlePath}.merge-conflict.txt`, note);
    // Conflict is a gate state the desk must see: clear submitted (the poll
    // loop's exit signal — run.ts "stamp cleared after conflict") and pr, stamp
    // conflict. withMtimeCas like every other transition; the guard compares
    // BODY hashes, so our own frontmatter stamp can't read as divergence.
    withMtimeCas(articlePath, conflictTransition({ at: new Date().toISOString(), pr: rec.prNumber as number }));
    saveArticle(cfg.stateDir, key, transition(rec, 'conflict'));
    return;
  }

  // Clean merge-back: merged content + published stamp, guarded atomic write.
  // The merged bytes are ship-cleaned (no library block), so the desk copy's
  // own check-out stamp is re-applied — else the librarian resurrects the
  // shelf mirror while the desk still holds the doc, and the next submit
  // ships under the adopter's own key (the duplicate-article failure mode).
  const stamped = reapplyLibraryTransition(readLibraryBlock(currentRaw))(
    publishedTransition({
      at: new Date().toISOString(),
      pr: rec.prNumber as number,
      sha: sha256Hex(merged),
    })(merged),
  );
  withMtimeCas(articlePath, () => stamped);
  const done = transition(loadArticle(cfg.stateDir, key), 'merged');
  // prNumber/prUrl clear on the return to idle: the next cycle opens its own
  // fresh PR (spec §Commit shape — one PR per cycle). Past PRs stay auditable
  // in review.published and in Gitea itself.
  saveArticle(cfg.stateDir, key, { ...transition(done, 'idle'), prNumber: null, prUrl: null });
}

export async function handleClosed(args: TerminalArgs): Promise<void> {
  const { cfg, doc, rec, key, gitea } = args;
  // Same pinned-desk resolution as the merged path (spec §2).
  const articlePath = rec.lastPushedDocPath ?? doc.filePath;
  // Findings: the gate's parting comments on the PR. A failed read must not
  // block the return — the note says findings are unavailable instead.
  let findings = '';
  try {
    const comments = await gitea.getPrComments(rec.prNumber as number);
    if (comments.length > 0) {
      findings = '\nNotes from the reviewer:\n\n'
        + comments.map((c) => `${c.user} at ${c.at}:\n${c.body}`).join('\n\n') + '\n';
    }
  } catch (e) {
    findings = `\nreviewer notes unavailable: ${e instanceof Error ? e.message : String(e)}\n`;
  }
  console.error(
    `[orchestrator] returned-with-notes: key=${key}, branch=${cfg.repo.branchPrefix}/${key}, ` +
    `pr=${rec.prUrl ?? rec.prNumber}, articlePath=${articlePath}`
  );
  const note = [
    'Your article was returned with notes from the reviewer and was not added to the library.',
    '',
    ...(findings ? [findings] : []),
    '',
    'No changes were made to your desk copy. Read the notes, make any needed fixes, and ask your writing companion to submit the article for approval again.',
    'A fresh submission starts a new review.',
  ].join('\n') + '\n';
  atomicWriteFileSync(`${articlePath}.submit-rejected.txt`, note);
  withMtimeCas(articlePath, returnedTransition({ at: new Date().toISOString(), pr: rec.prNumber as number }));
  const done = transition(loadArticle(cfg.stateDir, key), 'closed');
  // clear prNumber/prUrl like the merged path — the revision cycle opens a
  // fresh PR (which is what the rejection note promises)
  saveArticle(cfg.stateDir, key, { ...transition(done, 'idle'), prNumber: null, prUrl: null });
}
