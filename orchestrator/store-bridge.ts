/**
 * Store bridge (M4d): the orchestrator re-reads the encrypted store EVERY
 * poll — roster, repo, creds — so init/add-writer/cred-replacement need no
 * restart and no config edit. Stays dumb: read file, decrypt, assemble.
 */
import { join } from 'path';
import { readStore, resolveStoreFile, resolveRuntimeDir, loadMasterKey } from '../shared/store.js';
import { GitStore } from './git-store.js';
import { httpGitea } from './gitea.js';
import type { GiteaPort } from './gitea.js';
import type { OrchestratorConfig, StaticConfig } from './config.js';

export interface Cycle { cfg: OrchestratorConfig; git: GitStore; gitea: GiteaPort; }

export function makeStoreBridge(staticCfg: StaticConfig): () => Cycle | null {
  return function readCycle(): Cycle | null {
    let store;
    try { store = readStore(resolveStoreFile(), loadMasterKey(resolveRuntimeDir())); }
    catch (e) { console.error('[orchestrator] store unreadable:', e instanceof Error ? e.message : e); return null; }
    if (!store || store.users.length === 0) return null;
    const slug = store.gitea.repoUrl.replace(/\/+$/, '').replace(/\.git$/, '').split('/').slice(-2).join('/');
    const cfg: OrchestratorConfig = {
      ...staticCfg,
      writerRoots: store.users.map((u) => ({ id: u.id, root: join(staticCfg.workspacesBase, u.id) })),
      repo: {
        url: store.gitea.repoUrl, slug,
        cloneDir: staticCfg.cloneDir, mainBranch: staticCfg.mainBranch,
        mergeDir: staticCfg.mergeDir, branchPrefix: staticCfg.branchPrefix,
      },
    };
    return {
      cfg,
      git: new GitStore({ repoUrl: store.gitea.repoUrl, cloneDir: staticCfg.cloneDir,
        mainBranch: staticCfg.mainBranch, authorName: staticCfg.git.authorName, authorEmail: staticCfg.git.authorEmail,
        credentials: { user: store.gitea.username, pass: store.gitea.password } }),
      gitea: httpGitea({ repoSlug: slug,
        apiBaseUrl: staticCfg.gitea.apiBaseUrl, creds: () => ({ user: store.gitea.username, pass: store.gitea.password }) }),
    };
  };
}
