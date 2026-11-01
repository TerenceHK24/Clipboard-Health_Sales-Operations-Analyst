import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { randomBytes, timingSafeEqual } from 'node:crypto';

const STATIC = { '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'], '/styles.css': ['styles.css', 'text/css; charset=utf-8'] };
const publicRoot = new URL('../public/', import.meta.url);
function authorized(value, key) {
  const input = Buffer.from(typeof value === 'string' ? value : '');
  const expected = Buffer.from(key);
  return input.length === expected.length && timingSafeEqual(input, expected);
}
async function jsonBody(request) {
  if (request.headers['content-type']?.split(';')[0] !== 'application/json') throw new Error('Only application/json request bodies are accepted.');
  let size = 0; const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 131072) throw new Error('Request body exceeds 128 KB.');
    chunks.push(chunk);
  }
  const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error('Expected a JSON object.');
  return value;
}

/** Loopback-only, same-origin local UI. The CRM credential never leaves this process. */
export async function startReviewServer(service, { port = 4310, fields = {} } = {}) {
  const key = randomBytes(32).toString('hex');
  let origin;
  const server = createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('X-Frame-Options', 'DENY');
    response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    const send = (status, payload) => {
      response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify(payload));
    };
    try {
      if (request.headers.host !== new URL(origin).host) { send(403, { error: 'Unexpected Host header.' }); return; }
      const url = new URL(request.url, origin);
      if (request.method === 'GET' && STATIC[url.pathname]) {
        const [filename, type] = STATIC[url.pathname];
        response.writeHead(200, { 'Content-Type': type });
        response.end(await readFile(new URL(filename, publicRoot))); return;
      }
      if (!authorized(request.headers['x-review-key'], key)) { send(401, { error: 'Open the private review URL printed in your terminal.' }); return; }
      if (request.headers.origin && request.headers.origin !== origin) { send(403, { error: 'Cross-origin access is not allowed.' }); return; }
      if (request.method === 'GET' && url.pathname === '/api/state') { send(200, { ...service.view(), fields }); return; }
      if (request.method !== 'POST' || request.headers.origin !== origin) { send(403, { error: 'State changes require an authenticated same-origin POST.' }); return; }
      const body = await jsonBody(request);
      if (url.pathname === '/api/scan') { send(200, await service.scan()); return; }
      if (url.pathname === '/api/groups/decision') {
        const { groupKey, members, decision, reviewer, note } = body;
        send(200, await service.decideGroup({ groupKey, members, decision, reviewer, note })); return;
      }
      if (url.pathname === '/api/manual-match') {
        const { action, siteUrl, accountId, reviewer } = body;
        send(200, await service.manualMatch({ action, siteUrl, accountId, reviewer })); return;
      }
      const route = url.pathname.match(/^\/api\/proposals\/([a-f0-9]{64})\/decision$/);
      if (route) {
        // No client-supplied patch, account ID, endpoint, or token is accepted.
        const { decision, revision, reviewer, note } = body;
        send(200, await service.decide(route[1], { decision, revision, reviewer, note })); return;
      }
      send(404, { error: 'Unknown endpoint.' });
    } catch (error) { if (!response.headersSent) send(409, { error: error.message }); else response.end(); }
  });
  server.requestTimeout = 30000;
  server.headersTimeout = 10000;
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => { origin = `http://127.0.0.1:${server.address().port}`; resolve(); });
  });
  return { server, key, origin, url: `${origin}/#${key}`,
    close: () => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())) };
}
