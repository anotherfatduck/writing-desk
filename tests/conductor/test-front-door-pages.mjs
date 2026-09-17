// Page-script parse regression (final review C1): the front-door pages are
// template literals — a syntax error inside one ships dead HTML that no
// API-level test catches (the /admin page once shipped an unbalanced `}` and
// rendered "Loading..." forever). Extract every inline <script> body from the
// built pages and parse-check each with new Function — parse only, no run.
import { pages } from '../../dist/server/front-door/pages.js';
import assert from 'node:assert/strict';

async function test() {
  let failed = false;

  const ok = (val, msg) => {
    if (!val) {
      console.error(`FAIL: ${msg}`);
      failed = true;
    } else {
      console.log(`ok: ${msg}`);
    }
  };

  try {
    let checked = 0;
    for (const [name, make] of Object.entries(pages)) {
      const html = make();
      const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
      if (scripts.length === 0) continue; // corrupt/adminOnly are static — no scripts
      for (let i = 0; i < scripts.length; i++) {
        let parsed = true;
        try {
          assert.doesNotThrow(() => new Function(scripts[i]), `${name} script #${i + 1} must parse`);
        } catch (e) {
          parsed = false;
          console.error(`  parse error: ${e.message}`);
        }
        ok(parsed, `${name}: script #${i + 1} parses (new Function)`);
        checked++;
      }
    }
    ok(checked >= 3, `setup/login/admin all present and checked (${checked} scripts)`);

    // NaN tripwire (M4e): the setup success screen once built its button with an
    // inline onclick holding backslash-escaped quotes — the TS template literal
    // emitted the bare quotes, the string arithmetic divided string by string,
    // and the page rendered "NaN". No page may carry that pattern again; buttons
    // are <a href> or addEventListener.
    for (const [name, make] of Object.entries(pages)) {
      ok(!make().includes('onclick="location.href'), `${name}: no inline location.href onclick (NaN pattern)`);
    }
  } catch (e) {
    console.error(`FAIL: unexpected error: ${e}`);
    failed = true;
  }

  process.exit(failed ? 1 : 0);
}

test();