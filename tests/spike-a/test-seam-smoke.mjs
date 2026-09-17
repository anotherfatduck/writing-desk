// tests/spike-a/test-seam-smoke.mjs
// Contract: fork spike-a report §Validated integration contract, lifted unchanged.
import { spawnServer, drive } from './stub-backend.mjs';

const inst = await spawnServer({ port: 5071, bearer: 'smoke-token' });
drive.bind(inst);
try {
  // 1. bearer gate: 401 without token, /api/status exempt
  const unauth = await fetch(`http://127.0.0.1:5071/api/documents`);
  if (unauth.status !== 401) throw new Error(`bearer gate: expected 401, got ${unauth.status}`);
  const status = await fetch(`http://127.0.0.1:5071/api/status`);
  if (!status.ok) throw new Error('/api/status must be bearer-exempt');

  // 2. draft → pending (write_to_pad path)
  const doc = await drive.createDocument('smoke.md', '# Smoke\n\nBody para.');
  const entries0 = await drive.pendingEntries(doc.docId);
  if (!Array.isArray(entries0.entries)) throw new Error('pending-entries shape');

  // 3. propose edit via the agent path → per-node resolve → commit
  await drive.writeToPad(doc.docId, [{ op: 'insert', text: 'Pending line.' }]);
  const entries = await drive.pendingEntries(doc.docId);
  if (entries.entries.length < 1) throw new Error('expected >=1 pending entry');
  const { resolved } = await drive.resolveEntry(doc.docId, entries.entries[0].nodeId, 'accept');
  if (resolved < 1) throw new Error('resolve-entry returned resolved=0');

  // 3b. The per-node accept auto-commits for the active doc; assert the history
  // boundary landed. This is also a sync barrier before the empty-refusal check.
  const commits = await drive.listCommits(doc.docId);
  if (!Array.isArray(commits.commits)) throw new Error('commits shape');
  if (commits.commits.length < 1) throw new Error('expected >=1 commit after accept auto-commit');

  // 4. quiesce freezes, unquiesce resumes
  await drive.quiesce(1000);
  await drive.unquiesce();

  // 5. manual commit — fork commitVersion refuses empty commits, so after the
  // accept auto-commit consumed the attributed events this returns
  // {committed:false, commit:null}. The contract pin is the response shape, not
  // a guaranteed truthy committed value. (Spike-a report line 30.)
  const commitRes = await drive.commit(doc.docId, 'smoke commit');
  if (typeof commitRes.committed !== 'boolean') throw new Error('commit response missing committed boolean');
  if (!('commit' in commitRes)) throw new Error('commit response missing commit field');
  if (commitRes.committed !== false) throw new Error(`fork-faithful empty-refusal: expected committed=false, got ${commitRes.committed}`);

  console.log('test-seam-smoke: PASS');
} finally {
  await inst.shutdown();
}
