/**
 * content-repo git orchestrator entrypoint. ORCH_CONFIG points at the deploy
 * config (default /etc/writing-desk-orchestrator/config.json). No LLM here —
 * deterministic fs/git/tea work only. adr: adr/0007, adr/0009.
 */
import { loadConfig } from '../orchestrator/config.js';
import { makeStoreBridge } from '../orchestrator/store-bridge.js';
import { runLoop } from '../orchestrator/run.js';

const cfgPath = process.env.ORCH_CONFIG ?? '/etc/writing-desk-orchestrator/config.json';
const cfg = loadConfig(cfgPath);
runLoop(cfg, makeStoreBridge(cfg));
