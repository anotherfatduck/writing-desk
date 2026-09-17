/**
 * Deployment env resolution (M4b; ADR-0010: second host). Infra's per-host
 * writer.env sets WRITER2_* (writer-host-02) or WRITER1_* (writer-host-01)
 * names and they are PREFERRED (ops config is authoritative on the LXC); OW_ and
 * LLM_ stay as the dev fallback. Exactly one infra name exists per host. Read at
 * CALL time (not module load) so tests can vary the environment without re-importing.
 */

export function resolveLlmBaseUrl(): string {
  return process.env.WRITER2_LLM_BASE_URL || process.env.WRITER1_LLM_BASE_URL || process.env.LLM_BASE_URL || '';
}

export function resolveSiteOrigin(): string {
  return process.env.WRITER2_SITE_URL || process.env.WRITER1_SITE_URL || process.env.OW_ORIGIN || '';
}

export function resolveListenHost(): string {
  return process.env.OW_HOST || '127.0.0.1';
}
