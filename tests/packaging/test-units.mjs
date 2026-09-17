// tests/packaging/test-units.mjs — payload integrity: units parse, hardening
// present, paths match the M4d packaging contract; systemd-analyze verify when available.
import { readFileSync, existsSync } from 'fs';
import { execFileSync } from 'child_process';
import { join } from 'path';
import { fileURLToPath } from 'url';
const PKG = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', 'packaging');
let failed = 0;
const assert = (cond, msg) => { if (cond) console.log(`  ok: ${msg}`); else { failed++; console.error(`  FAIL: ${msg}`); } };

const read = (p) => readFileSync(join(PKG, p), 'utf8');

// Front-door unit: single multi-user listener, slot range, store/runtime writable.
const frontDoor = read('units/writing-desk.service');
for (const want of [
  'Description=writing-desk front door (M4d) — auth, store, per-user editor slots',
  'User=writing-desk', 'Group=writing-desk',
  'Environment=OW_PORT=5051',
  'EnvironmentFile=-/etc/writer-host-01/writer.env',
  'EnvironmentFile=-/etc/writer-host-02/writer.env',
  'EnvironmentFile=/etc/writing-desk/app.env',
  'ExecStart=/usr/bin/node /opt/writing-desk/dist/bin/front-door.js',
  'Restart=on-failure',
  'NoNewPrivileges=yes', 'ProtectSystem=strict', 'ProtectHome=yes', 'PrivateTmp=yes',
  'After=stunnel.service',
]) assert(frontDoor.includes(want), `front-door unit has ${want}`);
assert(frontDoor.includes('ReadWritePaths=/srv/writer-app/workspaces /var/lib/writing-desk /etc/writing-desk/runtime'), 'front-door ReadWritePaths include workspaces, store, runtime');
assert(!/systemctl (enable|start)/.test(frontDoor), 'front-door unit never self-enables');

// Orchestrator unit: renamed user, no orchestrator.env, config under /etc/writing-desk.
const orch = read('units/writing-desk-orchestrator.service');
for (const want of [
  'User=writing-desk-orch', 'Group=writing-desk-orch',
  'Environment=ORCH_CONFIG=/etc/writing-desk/orchestrator.config.json',
  'Environment=HOME=/srv/writer-app/orchestrator',
  'EnvironmentFile=-/etc/writer-host-01/writer.env',
  'EnvironmentFile=-/etc/writer-host-02/writer.env',
  'EnvironmentFile=/etc/writing-desk/app.env',
  'ExecStart=/usr/bin/node /opt/writing-desk/dist-orchestrator/bin/orchestrator.js',
  'ReadWritePaths=/srv/writer-app/orchestrator /srv/writer-app/workspaces',
  'NoNewPrivileges=yes', 'ProtectSystem=strict', 'PrivateTmp=yes',
]) assert(orch.includes(want), `orchestrator unit has ${want}`);
assert(!orch.includes('/etc/writer-host-01/orchestrator.env'), 'orchestrator unit does not source orchestrator.env');
assert(!orch.includes('EnvironmentFile=/etc/writer-host-01/writer.env'), 'orchestrator unit sources no un-dashed infra env (dash-prefixed only)');

// Cloudflared rider unit: inert unless token is non-empty.
const cloud = read('units/writing-desk-cloudflared.service');
for (const want of [
  'Description=content-repo cloudflared tunnel (M4d rider) — outbound-only edge',
  'User=writing-desk',
  'EnvironmentFile=-/etc/writer-host-01/cloudflared.env',
  'ExecStart=/usr/bin/cloudflared --no-autoupdate tunnel run --token ${TUNNEL_TOKEN}',
  'NoNewPrivileges=yes', 'ProtectSystem=strict', 'ProtectHome=yes', 'PrivateTmp=yes',
]) assert(cloud.includes(want), `cloudflared unit has ${want}`);
assert(!/systemctl (enable|start)/.test(cloud), 'cloudflared unit never self-enables');

// Legacy per-writer template unit is gone.
assert(!existsSync(join(PKG, 'units/writing-desk@.service')), 'legacy writing-desk@.service template removed');

// Conffiles + control + map + template exist with expected shapes.
for (const f of ['orchestrator.config.json', 'upstream', 'control', 'conffiles', 'app.env', 'nginx-map.conf', 'templates/writer.env.example']) {
  assert(existsSync(join(PKG, f)), `payload file ${f} exists`);
}
const conf = JSON.parse(read('orchestrator.config.json'));
assert(conf.workspacesBase === '/srv/writer-app/workspaces', 'orchestrator config workspacesBase is the real workspaces tree');
assert(!('writerRoots' in conf), 'orchestrator config has no writerRoots');
assert(read('upstream').trim() === 'http://127.0.0.1:5051', 'upstream conffile is the default writer upstream');
const conffiles = read('conffiles').trim().split('\n');
assert(conffiles.includes('/etc/writing-desk/orchestrator.config.json') && conffiles.includes('/etc/writing-desk/upstream') && conffiles.includes('/etc/writing-desk/app.env'), 'conffiles lists all three /etc/writing-desk files');
assert(read('nginx-map.conf').includes('map $http_upgrade $connection_upgrade'), 'nginx map drop-in carries the upgrade map');
const tmpl = read('templates/writer.env.example');
for (const v of ['OW_PORT', 'WRITER1_SITE_URL', 'WRITER2_SITE_URL']) assert(tmpl.includes(v), `writer env template mentions ${v}`);
const tmplLines = tmpl.split(/\r?\n/);
assert(tmplLines.filter((line) => line === 'WRITER1_LLM_BASE_URL=http://127.0.0.1:11440').length === 1, 'writer env template uses the local LiteLLM/stunnel base exactly once (host shape)');
assert(tmplLines.filter((line) => line === 'WRITER2_LLM_BASE_URL=http://127.0.0.1:11440').length === 1, 'writer env template uses the local LiteLLM/stunnel base exactly once (workspace shape)');
assert(!tmpl.includes('AGENT_MODEL'), 'writer env template carries no AGENT_MODEL (app-owned: app.env conffile)');
for (const v of ['LLM_API_KEY', 'OW_BEARER_TOKEN']) assert(!tmpl.includes(v), `writer env template does not mention ${v}`);
assert(!/sk-[A-Za-z0-9]{8,}/.test(tmpl), 'no secret-shaped values in template');

// App-owned env conffile (ADR-0010): non-secret route config; lives outside
// the infra-owned writer.env by contract.
const appEnv = read('app.env');
assert(appEnv.split(/\r?\n/).filter((line) => line === 'AGENT_MODEL=local-model-xhigh').length === 1, 'app.env sets the fixed gateway route exactly once');
assert(!/sk-[A-Za-z0-9]{8,}/.test(appEnv), 'no secret-shaped values in app.env');

// systemd-analyze verify (run if available; the real parser gate on build hosts).
try {
  execFileSync('systemd-analyze', ['verify', join(PKG, 'units/writing-desk.service'), join(PKG, 'units/writing-desk-orchestrator.service')], { stdio: 'pipe' });
  console.log('  ok: systemd-analyze verify clean');
} catch (e) {
  if (e.code === 'ENOENT') {
    console.log('  ok: systemd-analyze not available — skipped');
  } else {
    failed++; console.error(`  FAIL: systemd-analyze verify: ${e.stderr?.toString() || e.message}`);
  }
}

console.log(failed ? `test-units: ${failed} FAILURES` : 'test-units: all ok');
process.exit(failed ? 1 : 0);
