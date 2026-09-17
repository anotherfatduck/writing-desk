// tests/packaging/test-postinst.mjs — postinst lint, dry-run contract, and
// self-enable / cloudflared gating logic.
import { readFileSync, mkdtempSync, writeFileSync, rmSync, mkdirSync, symlinkSync } from 'fs';
import { execFileSync } from 'child_process';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { tmpdir } from 'os';
const PKG = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', 'packaging');
let failed = 0;
const assert = (cond, msg) => { if (cond) console.log(`  ok: ${msg}`); else { failed++; console.error(`  FAIL: ${msg}`); } };

const postinst = readFileSync(join(PKG, 'postinst'), 'utf8');

// Lint: shellcheck (present on the build host) — the real static gate.
try {
  execFileSync('shellcheck', ['--severity', 'warning', join(PKG, 'postinst')]);
  console.log('  ok: shellcheck clean');
} catch (e) {
  failed++; console.error(`  FAIL: shellcheck: ${e.stdout?.toString() || e.message}`);
}

// Dry-run: the new M4d action sequence, including self-enable, with no real side effects.
let dry;
try {
  dry = execFileSync('bash', [join(PKG, 'postinst')], { env: { ...process.env, WRITER_DRY_RUN: '1' }, encoding: 'utf8' });
} catch (e) {
  dry = e.stdout?.toString() || '';
  failed++; console.error(`  FAIL: postinst dry-run exited non-zero: ${e.message}`);
}
for (const want of [
  '[postinst:dry] useradd --system --shell /usr/sbin/nologin --home-dir /nonexistent writing-desk',
  '[postinst:dry] useradd --system --shell /usr/sbin/nologin --home-dir /nonexistent writing-desk-orch',
  '[postinst:dry] install -d -o writing-desk -g writing-desk -m 0750 /srv/writer-app/workspaces',
  '[postinst:dry] install -d -o writing-desk -g writing-desk -m 2750 /etc/writing-desk/runtime',
  '[postinst:dry] install -d -o writing-desk -g writing-desk -m 2750 /var/lib/writing-desk',
  '[postinst:dry] install -d -o writing-desk -g writing-desk -m 0700 /var/lib/writing-desk/.local/share',
  '[postinst:dry] usermod -aG writing-desk writing-desk-orch',
  '[postinst:dry] chown root:writing-desk /etc/writing-desk/orchestrator.config.json',
  '[postinst:dry] chmod 0640 /etc/writing-desk/orchestrator.config.json',
  '[postinst:dry] chown root:writing-desk /etc/writing-desk/app.env',
  '[postinst:dry] chmod 0640 /etc/writing-desk/app.env',
  '/opt/writing-desk/lib/render.mjs', '/etc/writing-desk/upstream', 'nginx-splice.mjs',
  '[postinst:dry] nginx -t', '[postinst:dry] systemctl reload nginx', 'daemon-reload',
  '[postinst:dry] systemctl enable writing-desk.service writing-desk-orchestrator.service',
  '[postinst:dry] systemctl restart writing-desk.service writing-desk-orchestrator.service',
]) assert(dry.includes(want), `dry-run prints ${want}`);
assert(postinst.includes('getent passwd'), 'user creation is guarded by getent');
assert(postinst.includes('set -euo pipefail'), 'postinst fails loudly');

// Self-enable: the postinst enables + restarts the app + orchestrator — restart
// (not enable --now) so an upgrade swaps the running processes to the new
// payload too (--now is a no-op on a running unit).
assert(/systemctl enable writing-desk\.service writing-desk-orchestrator\.service/.test(postinst), 'postinst enables writer + orchestrator');
assert(/systemctl restart writing-desk\.service writing-desk-orchestrator\.service/.test(postinst), 'postinst restarts writer + orchestrator (upgrades must swap running code)');
assert(!postinst.includes('enable --now'), 'no enable --now (a no-op on running units — upgrades would serve stale code)');

// Cloudflared gating: non-empty TUNNEL_TOKEN required; empty placeholder must not enable.
assert(postinst.includes('[ -f /etc/writer-host-01/cloudflared.env ]') && postinst.includes("grep -q '^TUNNEL_TOKEN=.\\+'"), 'cloudflared enable gated on non-empty TUNNEL_TOKEN');
// The dry-run in this dev environment has no cloudflared.env, so it must NOT print the cloudflared enable.
assert(!dry.includes('writing-desk-cloudflared.service'), 'dry-run without token does not enable cloudflared');

// F1 (2026-09-13): slots inherited the passwd entry's home (/nonexistent) and
// trash()'s linux resolver does lstat(os.homedir()) unconditionally — every
// delete ENOENT'd deployment-wide. The unit pins HOME + XDG_DATA_HOME into the
// service state dir so the XDG home trash resolves (spec 2026-09-13).
const writerUnit = readFileSync(join(PKG, 'units', 'writing-desk.service'), 'utf8');
assert(writerUnit.includes('Environment=HOME=/var/lib/writing-desk'), 'writer unit pins HOME to the service state dir');
assert(writerUnit.includes('Environment=XDG_DATA_HOME=/var/lib/writing-desk/.local/share'), 'writer unit pins XDG_DATA_HOME under ReadWritePaths');
assert(postinst.includes('install -d -o writing-desk -g writing-desk -m 0700 /var/lib/writing-desk/.local/share'), 'postinst creates the XDG_DATA_HOME parent');


// Verify the exact gating expression against placeholder files.
function tunnelWouldEnable(contents) {
  const d = mkdtempSync(join(tmpdir(), 'content-repo-tunnel-'));
  const f = join(d, 'cloudflared.env');
  writeFileSync(f, contents);
  let out;
  try {
    out = execFileSync('bash', ['-c', `[ -f '${f}' ] && grep -q '^TUNNEL_TOKEN=.\\+' '${f}' && echo yes || echo no`], { encoding: 'utf8' });
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
  return out.trim() === 'yes';
}
assert(tunnelWouldEnable('TUNNEL_TOKEN=abc123'), 'non-empty TUNNEL_TOKEN would enable cloudflared');
assert(!tunnelWouldEnable('TUNNEL_TOKEN='), 'empty TUNNEL_TOKEN placeholder would not enable cloudflared');
assert(!tunnelWouldEnable('# TUNNEL_TOKEN=abc123'), 'commented TUNNEL_TOKEN would not enable cloudflared');
assert(!tunnelWouldEnable(''), 'missing TUNNEL_TOKEN would not enable cloudflared');

// VHOST discovery must follow the Debian symlink layout: sites-enabled entries
// are symlinks into sites-available, and plain `grep -r` silently skips them.
assert(postinst.includes("grep -Rl 'default_server' /etc/nginx/sites-enabled/"), 'VHOST discovery uses grep -Rl (follows symlinked vhosts)');
{
  const d = mkdtempSync(join(tmpdir(), 'content-repo-vhost-'));
  try {
    const sitesAvail = join(d, 'sites-available');
    const sitesEnabled = join(d, 'sites-enabled');
    mkdirSync(sitesAvail, { recursive: true });
    mkdirSync(sitesEnabled);
    writeFileSync(join(sitesAvail, 'placeholder'), 'listen 443 ssl default_server;\nserver_name _;\n');
    symlinkSync(join(sitesAvail, 'placeholder'), join(sitesEnabled, 'placeholder'));
    let hits = [];
    try {
      hits = execFileSync('grep', ['-Rl', 'default_server', sitesEnabled], { encoding: 'utf8' }).trim().split('\n').filter(Boolean);
    } catch { /* grep exits 1 on no match */ }
    assert(hits.length === 1, 'grep -Rl finds a symlinked default_server vhost');
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
}

console.log(failed ? `test-postinst: ${failed} FAILURES` : 'test-postinst: all ok');
process.exit(failed ? 1 : 0);
