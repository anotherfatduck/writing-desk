/** Standalone front-door pages — vanilla HTML+JS strings, styled to feel
 * continuous with the writer's desk: same paper ground, same slate-blue
 * accent, same Charter serif for headings (light+dark via prefers-color-scheme).
 * No build step, no deps.
 *
 * Template-literal gotcha (M4e): never write backslash-escaped quotes inside
 * these TS templates — TS emits the bare quote and any surrounding string
 * arithmetic turns into NaN in the browser. Buttons are <a href> or addEventListener. */
import { DEFAULT_SITE_NAME } from '../../shared/store.js';
import { CHAT_PERSONA_DEFAULT, CHAT_PERSONA_SEEDS } from '../../shared/chat-persona.js';

const seedsJson = JSON.stringify(Object.fromEntries(CHAT_PERSONA_SEEDS.map((s) => [s.key, s.persona]))).replace(/</g, '\\u003c');

const FONT_DISPLAY = "Charter, 'Bitstream Charter', 'Sitka Text', Cambria, serif";

const escTitle = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');

const SHELL = (title: string, body: string) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escTitle(title)}</title><script>
// Theme continuity with the desk: the appearance store keeps the user's mode
// in localStorage (same origin). Explicit choice wins over the OS preference,
// so the settings page follows the desk instead of blinding anyone.
try { const m = localStorage.getItem('ow-theme-mode');
  if (m === 'dark' || m === 'light') document.documentElement.setAttribute('data-theme', m); } catch (e) { /* fresh browser */ }
</script><style>
:root {
  color-scheme: light dark;
  --bg:#f4f1ec; --ink:#2b2a27; --ink-dim:#6f6b62;
  --field:#fff; --line:#c9c2b4; --line-soft:#e3ded4;
  --accent:#5b7a9d; --accent-hover:#4c6885; --on-accent:#fff;
  --danger:#b3402e; --ok:#3e7048;
}
@media (prefers-color-scheme: dark) { :root:not([data-theme=light]) {
  --bg:#181817; --ink:#e4e2dd; --ink-dim:#96928a;
  --field:#22221f; --line:#4a4740; --line-soft:#33312c;
  --accent:#7d9bba; --accent-hover:#93aec9; --on-accent:#10161d;
  --danger:#e07a67; --ok:#7fae88;
} }
:root[data-theme=dark] {
  --bg:#181817; --ink:#e4e2dd; --ink-dim:#96928a;
  --field:#22221f; --line:#4a4740; --line-soft:#33312c;
  --accent:#7d9bba; --accent-hover:#93aec9; --on-accent:#10161d;
  --danger:#e07a67; --ok:#7fae88;
}
:root[data-theme=light] {
  --bg:#f4f1ec; --ink:#2b2a27; --ink-dim:#6f6b62;
  --field:#fff; --line:#c9c2b4; --line-soft:#e3ded4;
  --accent:#5b7a9d; --accent-hover:#4c6885; --on-accent:#fff;
  --danger:#b3402e; --ok:#3e7048;
}
* { box-sizing:border-box; }
body { margin:0; font:16px/1.55 system-ui,sans-serif; background:var(--bg); color:var(--ink);
  display:grid; place-items:center; min-height:100vh; padding:24px; }
.col { width:min(460px, 100%); }
.col.wide { width:min(640px, 100%); }
h1 { font-family:${FONT_DISPLAY}; font-weight:600; font-size:26px; line-height:1.25; margin:0 0 6px; letter-spacing:-0.01em; }
.lede { color:var(--ink-dim); margin:0 0 28px; font-size:15px; }
label { display:block; margin:16px 0 0; font-size:14px; font-weight:600; }
label .hint { display:block; margin:2px 0 5px; font-size:13px; font-weight:400; color:var(--ink-dim); }
input, select, textarea { width:100%; padding:10px 12px; border:1px solid var(--line); border-radius:6px;
  background:var(--field); color:var(--ink); font:inherit; }
input:focus, select:focus, textarea:focus { outline:2px solid var(--accent); outline-offset:1px; border-color:var(--accent); }
input[readonly] { cursor:pointer; }
.btn { display:block; margin-top:24px; width:100%; padding:11px; border:0; border-radius:6px;
  background:var(--accent); color:var(--on-accent); font:inherit; font-weight:600;
  cursor:pointer; text-align:center; text-decoration:none; }
.btn:hover { background:var(--accent-hover); }
button.inline { width:auto; margin:0; padding:5px 10px; font-size:13px; font-weight:500; }
.err { color:var(--danger); font-size:14px; margin-top:12px; min-height:20px; }
.ok { color:var(--ok); font-size:14px; }
.hint { font-size:13px; color:var(--ink-dim); }
.back { display:inline-block; margin-bottom:20px; font-size:14px; color:var(--ink-dim);
  text-decoration:none; }
.back:hover { color:var(--ink); }
.foot { margin-top:28px; font-size:12px; color:var(--ink-dim); line-height:1.6; }
.foot a { color:var(--ink-dim); }
.foot a:hover { color:var(--ink); }
.section { margin-top:36px; border-top:1px solid var(--line-soft); padding-top:20px; }
.section h2 { font-family:${FONT_DISPLAY}; font-weight:600; font-size:19px; margin:0 0 4px; }
.section .lede { margin-bottom:8px; font-size:14px; }
.row { display:flex; align-items:center; gap:8px; margin:10px 0; }
.row input { flex:1; width:auto; }
.copy-box { font-family:ui-monospace,monospace; font-size:13px; margin:8px 0; }
code { font-family:ui-monospace,monospace; font-size:0.9em; background:var(--field);
  border:1px solid var(--line-soft); border-radius:4px; padding:1px 5px; }
</style></head><body><div class="col">${body}</div></body></html>`;

export const pages = {
  setup: (site: string = DEFAULT_SITE_NAME) => SHELL(`${site} · Set up your writing desk`, `
    <h1>Set up your writing desk</h1>
    <p class="lede">One-time setup — you are the first person here, and this creates your account.</p>
    <form data-setup-form>
      <label>Project name
        <span class="hint">Shown in the browser tab. Pre-filled — change it if this desk serves a different project.</span>
        <input name="siteName" value="${escTitle(site)}" required autocomplete="off"></label>
      <label>Your name
        <span class="hint">Shown in the app.</span>
        <input name="name" required autocomplete="off"></label>
      <label>Library address
        <span class="hint">Where finished writing is kept — the repository URL.</span>
        <input name="repoUrl" required placeholder="https://…" autocomplete="off"></label>
      <label>Library username
        <span class="hint">An account that can write to the library.</span>
        <input name="giteaUser" required autocomplete="off"></label>
      <label>Library password
        <input name="giteaPass" type="password" required></label>
      <label>Model key <span class="hint">(optional)</span>
        <span class="hint">For the writing assistant. You can add or change it later.</span>
        <input name="vk" type="password" autocomplete="off"></label>
      <label>Assistant profile
        <span class="hint">The writing agent's character — pick a starting point, then edit the text below. You can change it later in Settings.</span>
        <select name="personaSeed" data-persona-seed>
          <option value="neutral">Neutral (default)</option>
          <option value="medical">Medical &amp; clinical</option>
          <option value="tech">Tech publication</option>
          <option value="food">Food &amp; cooking</option>
        </select></label>
      <label>Chat persona
        <span class="hint">What the writing agent is and how it works — pre-filled from your pick, edit freely.</span>
        <textarea name="chatPersona" data-persona-text rows="9">${escTitle(CHAT_PERSONA_DEFAULT)}</textarea></label>
      <button class="btn">Set up</button>
      <div class="err" data-err></div>
    </form>
    <script>
      const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
      const f = document.querySelector('[data-setup-form]');
      const SEEDS = ${seedsJson};
      const seedSel = f.querySelector('[data-persona-seed]');
      const personaText = f.querySelector('[data-persona-text]');
      seedSel.onchange = () => { if (SEEDS[seedSel.value]) personaText.value = SEEDS[seedSel.value]; };
      f.onsubmit = async (e) => { e.preventDefault();
        const d = new FormData(f);
        const res = await fetch('/api/setup/init', { method: 'POST',
          headers: { 'content-type': 'application/json' }, body: JSON.stringify(Object.fromEntries(d)) });
        if (res.ok) {
          const j = await res.json();
          // Auto-session: init already set the cookie. Show the admin token ONCE
          // (copy-now) — it is the only way back in after a session expiry.
          // Swap the whole column so the wizard header goes with the form.
          f.closest('.col').innerHTML = '<h1>You are set up</h1>' +
            '<p class="lede">Your login token — copy it now. It is shown only this once.</p>' +
            '<input value="' + esc(j.adminToken) + '" readonly onclick="this.select()" title="Click to select">' +
            '<p class="hint">To log in again later, paste it at <code>' + esc(location.origin) + '/login</code></p>' +
            '<a class="btn" href="/">Go to your desk</a>';
          return;
        }
        const j = await res.json().catch(() => ({ error: 'Setup failed' }));
        f.querySelector('[data-err]').textContent = j.error || 'Setup failed';
      };
    </script>`),
  login: (site: string = DEFAULT_SITE_NAME) => SHELL(`${site} · Log in to your writing desk`, `
    <h1>Log in</h1>
    <p class="lede">Paste the writer token you were given.</p>
    <form data-login-form>
      <label>Writer token
        <input name="token" required autocomplete="off"></label>
      <button class="btn">Log in</button>
      <div class="err" data-err></div>
    </form>
    <script>
      const f = document.querySelector('[data-login-form]');
      f.onsubmit = async (e) => { e.preventDefault();
        const d = new FormData(f); const res = await fetch('/api/login', { method: 'POST',
          headers: { 'content-type': 'application/json' }, body: JSON.stringify(Object.fromEntries(d)) });
        if (res.ok) {
          const j = await res.json();
          location.href = j.redirect;
          return;
        }
        const j = await res.json().catch(() => ({ error: 'Login failed' }));
        f.querySelector('[data-err]').textContent = j.error || 'Login failed';
      };
    </script>
    <p class="foot">© Writing Desk 2026. All rights reserved.<br>A writing desk by <a href="https://thereisnospoon.dev">thereisnospoon.dev</a> built on <a href="https://github.com/travsteward/openwriter">openwriter</a> (MIT)</p>`),
  corrupt: (site: string = DEFAULT_SITE_NAME) => SHELL(`${site} · Settings problem`, `
    <h1>Something is wrong with the settings</h1>
    <p class="lede">This app is set up but its settings file is damaged.</p>
    <p>The host admin must restore a backup of the settings file, or remove it and set the app up again.</p>`),
  adminOnly: (site: string = DEFAULT_SITE_NAME) => SHELL(`${site} · Admin only`, `
    <h1>Admin only</h1>
    <p class="lede">This page is restricted to administrators.</p>
    <a class="back" href="/">← Back to your desk</a>`),
  admin: (site: string = DEFAULT_SITE_NAME) => SHELL(`${site} · Settings`, `
    <a class="back" href="/">← Back to your desk</a>
    <div id="app">Loading…</div>
    <style>
      #app .row button { margin:0; }
      #app .row .who { flex:1; }
      /* Model-key indicator light (M4e UAT review): green = a model key is set
         for this writer, red = none. The button itself is the light. */
      #app .row button.vk-set { box-shadow: inset 0 0 0 2px var(--ok); color: var(--ok); }
      #app .row button.vk-missing { box-shadow: inset 0 0 0 2px var(--danger); color: var(--danger); }
    </style>
    <script>
      // Escape interpolations before they reach innerHTML/onclick (M2 hardening —
      // names are admin-typed, ids server-generated; escape regardless).
      const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
      const root = document.getElementById('app');
      async function load() {
        const res = await fetch('/api/session');
        if (res.status === 401) { location.href = '/login'; return; }
        const { user } = await res.json();
        const usersRes = await fetch('/api/admin/users');
        const users = await usersRes.json();
        const giteaRes = await fetch('/api/admin/gitea');
        const gitea = await giteaRes.json();
        const personaRes = await fetch('/api/admin/persona');
        const persona = await personaRes.json();
        root.innerHTML = \`
          <h1>Settings</h1>
          <p class="lede">Signed in as \${esc(user.name)}</p>
          <div class="section">
            <h2>Writers</h2>
            <p class="lede">Each writer logs in with a token. Create one per person.</p>
            <div id="users-list"></div>
            <form id="add-user" style="margin-top:16px">
              <label>Name
                <span class="hint">Shown in the app.</span>
                <input name="name" required autocomplete="off"></label>
              <label>Model key <span class="hint">(optional)</span>
                <input name="vk" type="password" autocomplete="off"></label>
              <button class="btn">Add writer</button>
              <div id="add-err" class="err"></div>
            </form>
            <div id="token-box"></div>
          </div>
          <div class="section">
            <h2>Library account</h2>
            <p class="lede">The credentials used to file finished writing into the library.</p>
            <form id="gitea-form">
              <label>Username
                <input name="username" value="\${esc(gitea.username)}" autocomplete="off"></label>
              <label>Password
                <input name="password" type="password" autocomplete="off"></label>
              <button class="btn">Update credentials</button>
              <div id="gitea-err" class="err"></div>
            </form>
          </div>
          <div class="section">
            <h2>Chat persona</h2>
            <p class="lede">The writing agent's character — its role and rules of voice. Applies to chats from the writer's next message; leave empty for the built-in neutral persona.</p>
            <form id="persona-form">
              <label>Persona
                <textarea name="persona" rows="10">\${esc(persona.chatPersona)}</textarea></label>
              <button class="btn">Save persona</button>
              <div id="persona-msg" class="err"></div>
            </form>
          </div>
        \`;
        const list = root.querySelector('#users-list');
        const renderUsers = (users) => {
          list.innerHTML = users.map(u => \`
            <div class="row">
              <div class="who">\${esc(u.name)} <span class="hint">\${u.hasVk ? '· model key set' : ''}</span></div>
              <button class="inline" onclick="resetToken('\${esc(u.id)}')">Reset token</button>
              <button class="inline vk-\${u.hasVk ? 'set' : 'missing'}" onclick="editVk('\${esc(u.id)}')">Model key</button>
              <button class="inline" onclick="deleteUser('\${esc(u.id)}')">Delete</button>
            </div>
          \`).join('');
        };
        // The roster must render on page load — load() fetches the list, so
        // paint it. (It previously only filled after an add: to see how many
        // writers exist you had to add one — UAT finding, 2026-09-11.)
        window.__renderUsers = renderUsers;
        renderUsers(users);
        // Add-writer keeps the page (and the one-time token box) intact — only
        // the list refreshes. A full re-render here would wipe the token (M4e).
        root.querySelector('#add-user').onsubmit = async (e) => {
          e.preventDefault();
          const d = new FormData(e.target);
          const r = await fetch('/api/admin/users', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(Object.fromEntries(d))
          });
          if (r.ok) {
            const j = await r.json();
            renderUsers(await (await fetch('/api/admin/users')).json());
            document.getElementById('token-box').innerHTML = \`
              <p class="hint">Give this login token to the writer — it is shown only this once:</p>
              <input class="copy-box" value="\${esc(j.loginToken)}" readonly onclick="this.select()" title="Click to select">
              <p class="hint">Login URL: \${esc(j.url)}</p>
            \`;
            document.getElementById('add-err').textContent = '';
            e.target.reset();
          } else {
            const j = await r.json();
            document.getElementById('add-err').textContent = j.error;
          }
        };
        root.querySelector('#gitea-form').onsubmit = async (e) => {
          e.preventDefault();
          const d = new FormData(e.target);
          const r = await fetch('/api/admin/gitea', {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(Object.fromEntries(d))
          });
          if (r.ok) {
            document.getElementById('gitea-err').textContent = 'Updated';
            document.getElementById('gitea-err').className = 'ok';
          } else {
            const j = await r.json().catch(() => ({}));
            document.getElementById('gitea-err').textContent = j.error || 'Failed to update credentials';
          }
        };
        root.querySelector('#persona-form').onsubmit = async (e) => {
          e.preventDefault();
          const d = new FormData(e.target);
          const r = await fetch('/api/admin/persona', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(Object.fromEntries(d)) });
          if (r.ok) {
            const msg = document.getElementById('persona-msg');
            msg.textContent = 'Updated';
            msg.className = 'ok';
          } else {
            const j = await r.json().catch(() => ({}));
            document.getElementById('persona-msg').textContent = j.error || 'Failed to update persona';
          }
        };
      }
      window.resetToken = async (id) => {
        const r = await fetch(\`/api/admin/users/\${id}/reset-token\`, { method: 'POST' });
        if (r.ok) {
          const j = await r.json();
          // Same copy-box pattern as the init and add-writer flows — an
          // alert()'s text is not selectable (UAT finding, 2026-09-11).
          window.__renderUsers(await (await fetch('/api/admin/users')).json());
          document.getElementById('token-box').innerHTML = \`
            <p class="hint">New login token — copy it now. It is shown only this once:</p>
            <input class="copy-box" value="\${esc(j.loginToken)}" readonly onclick="this.select()" title="Click to select">
            <p class="hint">Login URL: \${esc(j.url)}</p>\`;
        } else {
          alert('Failed to reset token');
        }
      };
      window.deleteUser = async (id) => {
        if (!confirm('Delete this writer?')) return;
        const r = await fetch(\`/api/admin/users/\${id}\`, { method: 'DELETE' });
        if (r.ok) {
          // Roster-only refresh — a full load() would re-render the page and
          // wipe any just-minted one-time token still on screen.
          window.__renderUsers(await (await fetch('/api/admin/users')).json());
        } else {
          const j = await r.json();
          alert(j.error || 'Failed to delete');
        }
      };
      window.editVk = async (id) => {
        const vk = prompt('Enter new model key (leave empty to clear):');
        if (vk === null) return;
        const r = await fetch(\`/api/admin/users/\${id}/vk\`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ vk })
        });
        if (r.ok) window.__renderUsers(await (await fetch('/api/admin/users')).json());
        else alert('Failed to update model key');
      };
      load();
  </script>`),
};