// Shared hermetic fixtures: bare remote seeder, a one-writer workspace, and a
// config builder. Each test file runs in its own node process, so process.env
// mutations here don't leak across files.
import { mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { mintMasterKey, writeStore } from '../../../dist/shared/store.js';

export const STAMP_AT = '2026-09-08T10:00:00.000Z';

/** The fixture article; pass null `at` for the not-submitted variant. */
export function articleDoc(at = STAMP_AT) {
  const review = at ? `review:\n  submitted:\n    at: "${at}"\n    sessionId: s1\n    model: glm-5.3-flash\n` : '';
  const library = `library:\n  key: w1/doc-1\n  adoptedAt: "2026-09-08T09:00:00.000Z"\n`;
  return `---\ndocId: doc-1\ntitle: Hypertension Follow-up\n${library}${review}---\n\nBody v1.\n`;
}

/** One-writer fixture workspace: profiles/p1 with doc-1 + chats + commits manifest. */
export function fixtureRoot(dir, { submit = true } = {}) {
  const root = join(dir, 'w1root');
  const profile = join(root, 'profiles', 'p1');
  mkdirSync(join(profile, '_chats', 'doc-1'), { recursive: true });
  mkdirSync(join(profile, '_commits'), { recursive: true });
  writeFileSync(join(profile, 'Article.md'), articleDoc(submit ? STAMP_AT : null));
  writeFileSync(join(profile, '_chats', 'doc-1', 's1.jsonl'), '{"role":"user","text":"draft"}\n');
  writeFileSync(join(profile, '_commits', 'doc-1.jsonl'),
    JSON.stringify({
      ts: 1000, parent: null, fromTs: 0, trigger: 'agent-finished', actors: ['agent'], snapshotTs: 1,
      summary: { added: 5, edited: 0, removed: 0, byActor: { agent: { added: 5, edited: 0, removed: 0 } } },
    }) + '\n');
  return { root, profile, articlePath: join(profile, 'Article.md') };
}

/** Local bare repo seeded with a README on main (the remote stand-in). */
export function seedBareRemote(dir) {
  const remote = join(dir, 'remote.git');
  execFileSync('git', ['init', '--bare', '-b', 'main', remote]);
  const seed = join(dir, 'seed');
  execFileSync('git', ['clone', remote, seed], { stdio: ['ignore', 'ignore', 'inherit'] });
  writeFileSync(join(seed, 'README.md'), 'seed\n');
  execFileSync('git', ['-C', seed, '-c', 'user.email=t@e', '-c', 'user.name=t', 'add', '.']);
  execFileSync('git', ['-C', seed, '-c', 'user.email=t@e', '-c', 'user.name=t', 'commit', '-m', 'seed']);
  execFileSync('git', ['-C', seed, 'push', 'origin', 'main']);
  return remote;
}

export function makeCfg(dir, { root, remote, fake }) {
  return {
    writerRoots: [{ id: 'w1', root }],
    repo: {
      url: remote,
      slug: 'owner/content-repo',
      cloneDir: join(dir, 'clone'),
      mainBranch: 'main',
      mergeDir: 'articles',
      branchPrefix: 'article',
    },
    pollIntervalMs: 1000,
    stateDir: join(dir, 'state'),
    git: { authorName: 'orch', authorEmail: 'orch@e' },
    gitea: { apiBaseUrl: fake.baseUrl },
  };
}

/** Plain constructor-arg helper: spread p.git into `new GitStore(...)`,
 *  p.gitea into `httpGitea(...)`. */
export function makePorts(cfg, fake) {
  return {
    git: {
      repoUrl: cfg.repo.url, cloneDir: cfg.repo.cloneDir, mainBranch: cfg.repo.mainBranch,
      authorName: cfg.git.authorName, authorEmail: cfg.git.authorEmail,
    },
    gitea: {
      repoSlug: cfg.repo.slug, apiBaseUrl: fake.baseUrl,
    },
  };
}

/** Minimal store user for the bridge fixture. */
export function storeUser(id) {
  return {
    id,
    name: id,
    isAdmin: false,
    vk: null,
    loginTokenHash: 'deadbeef',
    createdAt: new Date().toISOString(),
  };
}

/** Write a real encrypted store into `dir` and return runtimeDir/storeFile/key. */
export function writeFixtureStore(dir, { users, gitea }) {
  const runtimeDir = join(dir, 'runtime');
  const storeFile = join(dir, 'store.enc');
  const key = mintMasterKey(runtimeDir);
  writeStore(storeFile, key, {
    v: 1,
    createdAt: new Date().toISOString(),
    users,
    gitea,
    sessions: [],
  });
  return { runtimeDir, storeFile, key };
}
