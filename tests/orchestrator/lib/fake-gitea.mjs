// Minimal Gitea PR API stub (fake-gateway pattern). Per-method queues so a
// scripted entry can never be consumed by the wrong route: `script` feeds
// GET /pulls/:n ({ state, merged }); `postScript` feeds POST /pulls
// ({ number, html_url } — openPr's channel since the M4e tea drop; a step of
// `{ status, body }` forces an error response); `listScript` feeds
// GET /pulls?state=open (the 409-adopt lookup) with an array of
// { number, html_url, head: { ref } }. `commentScript` feeds
// GET /issues/:n/comments; a step of `{ status: 404 }` forces a 404 response
// to exercise the adapter's 404 branch. `calls` records every request.
// Reused by test-cycle and test-terminal.
import { createServer } from 'node:http';

export async function startFakeGitea() {
  const script = [];
  const postScript = [];
  const listScript = [];
  const commentScript = [];
  const calls = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const call = { method: req.method, url: req.url, auth: req.headers.authorization ?? null, body, status: 200 };
      calls.push(call);
      if (req.method === 'POST' && /\/pulls$/.test(req.url)) {
        const step = postScript.shift() ?? { number: 1, html_url: 'https://gitea/pulls/1' };
        if (step.status) {
          res.statusCode = step.status;
          res.end(step.body ?? '{}');
        } else {
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ number: step.number, html_url: step.html_url }));
        }
      } else if (req.method === 'GET' && /\/pulls\?/.test(req.url)) {
        const step = listScript.shift() ?? [];
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(step));
      } else if (req.method === 'GET' && /\/pulls\/\d+$/.test(req.url)) {
        const step = script.shift() ?? { state: 'open', merged: false };
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ state: step.state, merged: !!step.merged }));
      } else if (req.method === 'GET' && /\/issues\/\d+\/comments$/.test(req.url)) {
        const step = commentScript.shift() ?? [];
        if (step && step.status === 404) {
          res.statusCode = 404;
          res.end('{}');
        } else {
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify(step));
        }
      } else {
        res.statusCode = 404;
        res.end('{}');
      }
      call.status = res.statusCode;
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  return { baseUrl: `http://127.0.0.1:${port}`, calls, script, postScript, listScript, commentScript, close: () => server.close() };
}
