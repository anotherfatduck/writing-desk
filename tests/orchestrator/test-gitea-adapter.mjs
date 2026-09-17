// Gitea adapter: everything over the REST API with basic auth (M4e: openPr
// moved off the tea CLI to the same credential path as PR state/comments).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { startFakeGitea } from './lib/fake-gitea.mjs';

const REPO = new URL('../../', import.meta.url).pathname;
execFileSync('npx', ['tsc', '-p', 'tsconfig.orchestrator.json'], { cwd: REPO, stdio: 'inherit' });
const mod = (name) => import(new URL(`../../dist-orchestrator/orchestrator/${name}.js`, import.meta.url).href);
const { httpGitea } = await mod('gitea');

test('openPr POSTs the PR with basic auth and parses number/url', async () => {
  const fake = await startFakeGitea();
  fake.postScript.push({ number: 11, html_url: 'https://gitea.example/owner/content-repo/pulls/11' });
  process.env.GITEA_BASIC_USER = 'u';
  process.env.GITEA_BASIC_PASS = 'p';
  const ref = await httpGitea({ repoSlug: 'owner/content-repo', apiBaseUrl: fake.baseUrl })
    .openPr({ head: 'article/w1/doc-1', base: 'main', title: 'T', body: 'B' });
  assert.equal(ref.number, 11);
  assert.equal(ref.url, 'https://gitea.example/owner/content-repo/pulls/11');
  const post = fake.calls.find((c) => c.method === 'POST');
  assert.match(post.auth ?? '', /^Basic /);
  assert.match(post.url, /\/api\/v1\/repos\/the owner\/content-repo\/pulls$/);
  assert.deepEqual(JSON.parse(post.body), { head: 'article/w1/doc-1', base: 'main', title: 'T', body: 'B' });
  await fake.close();
});

test('openPr throws loudly on an API error', async () => {
  const fake = await startFakeGitea();
  fake.postScript.push({ status: 500, body: '{"message":"boom"}' });
  process.env.GITEA_BASIC_USER = 'u';
  process.env.GITEA_BASIC_PASS = 'p';
  await assert.rejects(
    httpGitea({ repoSlug: 'owner/content-repo', apiBaseUrl: fake.baseUrl })
      .openPr({ head: 'article/w1/doc-1', base: 'main', title: 'T', body: 'B' }),
    /gitea PR create failed: HTTP 500/,
  );
  await fake.close();
});

test('getPrState maps the API state/merged pair via basic auth', async () => {
  process.env.GITEA_BASIC_USER = 'writer-orchestrator';
  process.env.GITEA_BASIC_PASS = 'test-pass';
  const fake = await startFakeGitea();
  fake.script.push(
    { state: 'open', merged: false },
    { state: 'closed', merged: true },
    { state: 'closed', merged: false },
    { state: 'unknown' },   // unmapped state → null
  );
  const port = httpGitea({ repoSlug: 'owner/content-repo', apiBaseUrl: fake.baseUrl });
  assert.equal(await port.getPrState(11), 'open');
  assert.equal(await port.getPrState(11), 'merged');
  assert.equal(await port.getPrState(11), 'closed');
  assert.equal(await port.getPrState(11), null);
  const get = fake.calls.find((c) => c.method === 'GET');
  assert.match(get.auth ?? '', /^Basic /);
  assert.match(get.url ?? '', /\/api\/v1\/repos\/the owner\/content-repo\/pulls\/11$/);
  await fake.close();
});

test('getPrComments maps PR issue comments (user/body/at) over basic auth', async () => {
  const fake = await startFakeGitea();
  fake.commentScript.push([
    { user: { login: 'owner' }, body: 'Fix the unsupported claim in section 2.', created_at: '2026-09-09T10:00:00Z' },
  ]);
  process.env.GITEA_BASIC_USER = 'writer-orchestrator';
  process.env.GITEA_BASIC_PASS = 'test-pass';
  const port = httpGitea({ repoSlug: 'owner/content-repo', apiBaseUrl: fake.baseUrl });
  const comments = await port.getPrComments(11);
  assert.equal(comments.length, 1);
  assert.equal(comments[0].user, 'the owner');
  assert.equal(comments[0].body, 'Fix the unsupported claim in section 2.');
  assert.equal(comments[0].at, '2026-09-09T10:00:00Z');
  assert.equal(fake.calls[0].method, 'GET');
  assert.match(fake.calls[0].url, /\/issues\/11\/comments$/);
  await fake.close();
});

test('getPrComments returns [] on 404 (PR with no comments never 404s, but a deleted one may)', async () => {
  const fake = await startFakeGitea();
  fake.commentScript.push({ status: 404 });
  process.env.GITEA_BASIC_USER = 'writer-orchestrator';
  process.env.GITEA_BASIC_PASS = 'test-pass';
  const port = httpGitea({ repoSlug: 'owner/content-repo', apiBaseUrl: fake.baseUrl });
  const comments = await port.getPrComments(7);   // fake's comment route is forced to 404
  assert.deepEqual(comments, []);
  assert.equal(fake.calls[0].method, 'GET');
  assert.match(fake.calls[0].url, /\/issues\/7\/comments$/);
  assert.equal(fake.calls[0].status, 404);
  await fake.close();
});

test('httpGitea throws loudly when basic-auth env is missing', () => {
  delete process.env.GITEA_BASIC_USER;
  delete process.env.GITEA_BASIC_PASS;
  assert.throws(
    () => httpGitea({ repoSlug: 'owner/content-repo', apiBaseUrl: 'http://127.0.0.1:1' }),
    /GITEA_BASIC/,
  );
});

test('openPr adopts an existing open PR on 409 (crash between openPr and the save)', async () => {
  const fake = await startFakeGitea();
  fake.postScript.push({ status: 409, body: '{"message":"pull request already exists for these targets"}' });
  fake.listScript.push([
    { number: 80, html_url: 'https://gitea.example/owner/content-repo/pulls/80', head: { ref: 'article/w1/other-doc' } },
    { number: 81, html_url: 'https://gitea.example/owner/content-repo/pulls/81', head: { ref: 'article/w1/doc-1' } },
  ]);
  process.env.GITEA_BASIC_USER = 'u';
  process.env.GITEA_BASIC_PASS = 'p';
  const ref = await httpGitea({ repoSlug: 'owner/content-repo', apiBaseUrl: fake.baseUrl })
    .openPr({ head: 'article/w1/doc-1', base: 'main', title: 'T', body: 'B' });
  assert.equal(ref.number, 81);
  assert.equal(ref.url, 'https://gitea.example/owner/content-repo/pulls/81');
  const list = fake.calls.find((c) => c.method === 'GET' && /\/pulls\?/.test(c.url));
  assert.ok(list, '409 triggers a list lookup');
  await fake.close();
});

test('openPr rethrows 409 with detail when no open PR matches the head', async () => {
  const fake = await startFakeGitea();
  fake.postScript.push({ status: 409, body: '{"message":"pull request already exists for these targets"}' });
  fake.listScript.push([]);   // nothing open — cannot adopt
  process.env.GITEA_BASIC_USER = 'u';
  process.env.GITEA_BASIC_PASS = 'p';
  await assert.rejects(
    httpGitea({ repoSlug: 'owner/content-repo', apiBaseUrl: fake.baseUrl })
      .openPr({ head: 'article/w1/doc-1', base: 'main', title: 'T', body: 'B' }),
    /HTTP 409 .*no open PR with head article\/w1\/doc-1/,
  );
  await fake.close();
});
