/**
 * Orchestrator config — schema + loader. adr: adr/0007 (M4a), adr/0009 (M4d).
 * The config file path comes from ORCH_CONFIG (deploy default
 * /etc/writing-desk-orchestrator/config.json). Secrets (Gitea basic-auth creds)
 * now live in the encrypted store and are read per-poll by the store bridge.
 * The static config only carries repo-agnostic layout + the Gitea API settings.
 */
import { z } from 'zod';
import { readFileSync } from 'fs';

// .strict() is load-bearing (outer AND nested — a plain nested z.object
// silently strips unknown keys, so a dropped key like gitea.teaBin would parse
// forever): without it the schema-rejection tests (legacy writerRoots/repo.*
// keys must fail to parse) can never fire.
export const ConfigSchema = z.object({
  workspacesBase: z.string().min(1),
  cloneDir: z.string().min(1),
  mainBranch: z.string().min(1),
  mergeDir: z.string().min(1),
  branchPrefix: z.string().min(1),
  pollIntervalMs: z.number().int().min(1000),
  stateDir: z.string().min(1),
  git: z.object({ authorName: z.string().min(1), authorEmail: z.string().min(1) }).strict(),
  gitea: z.object({ apiBaseUrl: z.string().min(1) }).strict(),
}).strict();

export type StaticConfig = z.infer<typeof ConfigSchema>;

/** pollOnce's view — the repo view is assembled per poll from the flat static
 * fields + the store (spec §Orchestrator: repo.* leaves the file schema entirely). */
export interface OrchestratorConfig extends StaticConfig {
  writerRoots: Array<{ id: string; root: string }>;
  repo: { url: string; slug: string; cloneDir: string; mainBranch: string; mergeDir: string; branchPrefix: string };
}

export function loadConfig(path: string): StaticConfig {
  const raw = JSON.parse(readFileSync(path, 'utf-8'));
  const parsed = ConfigSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`orchestrator config invalid: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  }
  return parsed.data;
}
