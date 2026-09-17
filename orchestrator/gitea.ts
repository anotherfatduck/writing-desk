/**
 * Gitea adapter seam. Everything is Gitea REST with HTTP basic auth — the same
 * collaborator credentials sourced from the encrypted store per poll. (PR
 * creation used to shell out to the tea CLI; M4e dropped that for one
 * credential path — Gitea 1.21.11 REST covers PR create; see the M4e
 * close-out. The tea binary and `tea login add` are no longer host prereqs.)
 * Tests swap the whole port. No LLM, no tokens.
 */
import { promisify } from 'node:util';

export interface PrRef { number: number; url: string }
export type PrState = 'open' | 'merged' | 'closed';
export interface PrComment { user: string; body: string; at: string }
export interface GiteaPort {
  openPr(args: { head: string; base: string; title: string; body: string }): Promise<PrRef>;
  getPrState(prNumber: number): Promise<PrState | null>;
  getPrComments(prNumber: number): Promise<PrComment[]>;
}

const base64 = (s: string) => Buffer.from(s).toString('base64');

export function httpGitea(opts: { repoSlug: string; apiBaseUrl: string;
                                 creds?: () => { user: string; pass: string } }): GiteaPort {
  const creds = opts.creds ?? (() => ({ user: process.env.GITEA_BASIC_USER ?? '', pass: process.env.GITEA_BASIC_PASS ?? '' }));
  if (!creds().user || !creds().pass) throw new Error('Gitea credentials not configured (store or GITEA_BASIC_* env)');
  const apiFetch = async (path: string, init?: RequestInit): Promise<Response> => {
    const { user, pass } = creds();
    return fetch(`${opts.apiBaseUrl}/api/v1/repos/${opts.repoSlug}${path}`, {
      ...init,
      headers: { Authorization: `Basic ${base64(`${user}:${pass}`)}`, ...init?.headers },
    });
  };

  return {
    async openPr({ head, base: baseBranch, title, body }) {
      const res = await apiFetch('/pulls', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ head, base: baseBranch, title, body }),
      });
      const text = await res.text();
      if (!res.ok) {
        // 409 "already exists for these targets": a PR for this head/base is
        // already open — a crash between openPr and the pr-open save (the
        // recorded v1 duplicate-PR edge), or an overlapping poll. Adopt it
        // rather than fail the cycle forever: find the open PR by head branch.
        if (res.status === 409) {
          const listRes = await apiFetch('/pulls?state=open&limit=50');
          if (listRes.ok) {
            const prs = (await listRes.json()) as { number: unknown; html_url: unknown; head?: { ref?: string } }[];
            const match = Array.isArray(prs)
              ? prs.find((p) => p && p.head?.ref === head && typeof p.number === 'number' && typeof p.html_url === 'string')
              : null;
            if (match) return { number: match.number as number, url: match.html_url as string };
          }
          throw new Error(`gitea PR create failed: HTTP 409 ${text.split('\n').filter(Boolean).slice(-3).join(' | ')} (no open PR with head ${head} to adopt)`);
        }
        throw new Error(`gitea PR create failed: HTTP ${res.status} ${text.split('\n').filter(Boolean).slice(-3).join(' | ')}`);
      }
      let j: { number?: unknown; html_url?: unknown };
      try { j = JSON.parse(text); } catch {
        throw new Error(`gitea PR create: unparseable response: ${text.slice(-200)}`);
      }
      if (typeof j.number !== 'number' || typeof j.html_url !== 'string') {
        throw new Error(`gitea PR create: no PR number/url in response: ${text.slice(-200)}`);
      }
      return { number: j.number, url: j.html_url };
    },

    async getPrState(prNumber: number): Promise<PrState | null> {
      const res = await apiFetch(`/pulls/${prNumber}`);
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`gitea API ${res.status} for pulls/${prNumber}`);
      const j = (await res.json()) as { state: string; merged?: boolean };
      if (j.state === 'open') return 'open';
      if (j.state === 'closed') return j.merged ? 'merged' : 'closed';
      return null;
    },

    async getPrComments(prNumber: number): Promise<PrComment[]> {
      const res = await apiFetch(`/issues/${prNumber}/comments`);
      if (res.status === 404) return [];
      if (!res.ok) throw new Error(`gitea API ${res.status} for issues/${prNumber}/comments`);
      const j = (await res.json()) as Array<{ user?: { login?: string }; body?: string; created_at?: string }>;
      return j.map((c) => ({ user: c.user?.login ?? 'unknown', body: c.body ?? '', at: c.created_at ?? '' }));
    },
  };
}