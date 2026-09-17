/**
 * Local clone management for the article repo. Plain git CLI (child_process
 * execFile). Credentials come from the encrypted store (M4d ADR-0009 — the
 * same collaborator creds the Gitea REST client uses) and ride per-command as
 * GIT_CONFIG_* env holding http.extraHeader — never in argv, never persisted
 * into .git/config. (The M4a-era host credential helper was never provisioned
 * and its sops provisioning is gone; M4e fixed the resulting interactive-prompt
 * clone failure.) In tests the remote is a local bare repo (no auth).
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { atomicWriteFileSync } from './util.js';

const exec = promisify(execFile);

export interface UpsertFile { path: string; content: string; }

export interface GitCredentials { user: string; pass: string; }

export class GitStore {
  constructor(private opts: { repoUrl: string; cloneDir: string; mainBranch: string;
    authorName: string; authorEmail: string; credentials?: GitCredentials }) {}

  private async git(args: string[], cwd = this.opts.cloneDir): Promise<string> {
    try {
      const env: NodeJS.ProcessEnv = { ...process.env };
      const { user, pass } = this.opts.credentials ?? { user: '', pass: '' };
      if (user && pass) {
        const auth = Buffer.from(`${user}:${pass}`).toString('base64');
        env.GIT_CONFIG_COUNT = '1';
        env.GIT_CONFIG_KEY_0 = 'http.extraHeader';
        env.GIT_CONFIG_VALUE_0 = `Authorization: Basic ${auth}`;
      }
      const r = await exec('git', args, { cwd, maxBuffer: 32 * 1024 * 1024, env });
      return r.stdout;
    } catch (e: any) {
      const tail = String(e.stderr ?? e.message ?? '').split('\n').filter(Boolean).slice(-3).join(' | ');
      throw new Error(`git ${args[0]} failed: ${tail}`);
    }
  }

  private idCfg(): string[] {
    return ['-c', `user.name=${this.opts.authorName}`, '-c', `user.email=${this.opts.authorEmail}`];
  }

  async ensureClone(): Promise<void> {
    if (existsSync(join(this.opts.cloneDir, '.git'))) {
      // --prune: a merge-time head-branch delete (gate side) leaves a stale
      // origin/article/* tracking ref in the clone; without pruning, the next
      // submit's origin/<branch> existence check resolves the stale ref and
      // re-creates the branch from the pre-merge tip (stale-based PR, merge
      // conflict with main's post-merge changes — live 2026-09-15, workspace).
      await this.git(['fetch', '--prune', 'origin']);
      return;
    }
    mkdirSync(this.opts.cloneDir, { recursive: true });
    await this.git(['clone', this.opts.repoUrl, '.'], this.opts.cloneDir);
  }

  async upsertBranchFiles(branch: string, files: UpsertFile[], message: string): Promise<string> {
    await this.ensureClone();
    await this.git(['fetch', 'origin', this.opts.mainBranch]);
    let exists = true;
    try { await this.git(['rev-parse', '--verify', branch]); } catch { exists = false; }
    if (exists) {
      await this.git(['checkout', branch]);
    } else {
      let remoteBranchExists = true;
      try { await this.git(['rev-parse', '--verify', `origin/${branch}`]); } catch { remoteBranchExists = false; }
      if (remoteBranchExists) await this.git(['checkout', '-B', branch, `origin/${branch}`]);
      else await this.git(['checkout', '-B', branch, `origin/${this.opts.mainBranch}`]);
    }
    for (const f of files) {
      atomicWriteFileSync(join(this.opts.cloneDir, f.path), f.content);
      await this.git(['add', f.path]);
    }
    const status = await this.git(['status', '--porcelain']);
    if (!status.trim()) return (await this.git(['rev-parse', 'HEAD'])).trim();
    await this.git([...this.idCfg(), 'commit', '-m', message]);
    await this.git(['push', '-u', 'origin', branch]);
    return (await this.git(['rev-parse', 'HEAD'])).trim();
  }

  /**
   * Fetch + hard-checkout the configured main branch in the local clone,
   * returning the clone dir so callers get the fresh checkout's path. The
   * librarian reads a clean main each poll; retireBranch uses it to advance the
   * merge-base before dropping the article branch.
   */
  async syncMain(): Promise<string> {
    await this.ensureClone();
    await this.git(['fetch', 'origin', this.opts.mainBranch]);
    await this.git(['checkout', this.opts.mainBranch]);
    await this.git(['reset', '--hard', `origin/${this.opts.mainBranch}`]);
    return this.opts.cloneDir;
  }

  /**
   * Post-merge lifecycle (spec §Commit shape: the merge-base must advance
   * with main so the next cycle's PR diff is that cycle only — independent of
   * the gate's merge style). Idempotent: terminal handling may retry after a
   * partial failure, and Gitea may have auto-deleted the merged head branch.
   */
  async retireBranch(branch: string): Promise<void> {
    await this.syncMain();
    try { await this.git(['push', 'origin', '--delete', branch]); } catch { /* Gitea may have auto-deleted the merged head branch */ }
    try { await this.git(['branch', '-D', branch]); } catch { /* already retired by an earlier attempt */ }
  }

  async showRemoteFile(path: string, ref?: string): Promise<string | null> {
    await this.ensureClone();
    await this.git(['fetch', 'origin', this.opts.mainBranch]);
    try {
      return await this.git(['show', `${ref ?? `origin/${this.opts.mainBranch}`}:${path}`]);
    } catch {
      return null;
    }
  }
}
