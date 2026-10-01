import { spawn } from 'node:child_process';
import { timingSafeEqual } from 'node:crypto';
import { createServer as createHttpServer } from 'node:http';
import { fileURLToPath } from 'node:url';

const workerPath = fileURLToPath(new URL('./worker.mjs', import.meta.url));
const MAX_BODY_BYTES = 750_000;
const MAX_RESPONSE_BYTES = 2_000_000;
const MAX_QUEUE_LENGTH = 12;
const WORKER_TIMEOUT_MS = 45_000;

function authorized(request, token) {
  const supplied = request.headers.authorization?.replace(/^Bearer\s+/i, '') ?? '';
  const expectedBytes = Buffer.from(token);
  const suppliedBytes = Buffer.from(supplied);
  return expectedBytes.length === suppliedBytes.length && timingSafeEqual(expectedBytes, suppliedBytes);
}

function send(response, status, body) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  response.end(JSON.stringify(body));
}

async function readBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error('Request body exceeds the 750 KB limit.');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function runWorker(payload) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [workerPath], { stdio: ['pipe', 'pipe', 'pipe'] });
    const stdout = [];
    let stdoutBytes = 0;
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => child.kill('SIGKILL'), WORKER_TIMEOUT_MS);

    child.stdout.on('data', (chunk) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > MAX_RESPONSE_BYTES) child.kill('SIGKILL');
      else stdout.push(chunk);
    });
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk.toString()).slice(-2000); });
    child.on('error', (error) => finish(error));
    child.on('close', (code, signal) => {
      if (settled) return;
      if (signal === 'SIGKILL' && stdoutBytes > MAX_RESPONSE_BYTES) return finish(new Error('Sandbox result exceeded the response-size limit.'));
      if (signal === 'SIGKILL') return finish(new Error('Sandbox operation exceeded its 45-second time limit.'));
      if (code !== 0) return finish(new Error(`Sandbox worker failed${stderr ? `: ${stderr.trim()}` : '.'}`));
      try { finish(null, JSON.parse(Buffer.concat(stdout).toString('utf8'))); }
      catch { finish(new Error('Sandbox worker returned an invalid response.')); }
    });
    child.stdin.end(JSON.stringify(payload));

    function finish(error, result) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(result);
    }
  });
}

export function createSandboxServer({ token = process.env.SANDBOX_SERVICE_TOKEN } = {}) {
  if (!token || token.length < 32) throw new Error('Set SANDBOX_SERVICE_TOKEN to a random value of at least 32 characters.');
  let active = false;
  const queue = [];

  async function drainQueue() {
    if (active) return;
    active = true;
    while (queue.length) {
      const job = queue.shift();
      try { job.resolve(await runWorker(job.payload)); }
      catch (error) { job.reject(error); }
    }
    active = false;
  }

  return createHttpServer(async (request, response) => {
    if (request.method === 'GET' && request.url === '/health') return send(response, 200, { ok: true, busy: active, queued: queue.length });
    if (request.method !== 'POST' || !['/validate-schema', '/execute', '/execute-many'].includes(request.url)) return send(response, 404, { error: 'Route not found.' });
    if (!authorized(request, token)) return send(response, 401, { error: 'Unauthorized sandbox request.' });

    let payload;
    try { payload = await readBody(request); }
    catch (error) { return send(response, 400, { error: error.message || 'Invalid JSON request.' }); }
    if (queue.length >= MAX_QUEUE_LENGTH) return send(response, 429, { error: 'Sandbox is busy. Retry shortly.' });

    const action = request.url.slice(1);
    const jobPayload = { ...payload, action };
    try {
      const result = await new Promise((resolve, reject) => {
        queue.push({ payload: jobPayload, resolve, reject });
        drainQueue();
      });
      send(response, 200, result);
    } catch (error) {
      console.error('sandbox worker error:', error.message);
      send(response, 503, { error: error.message || 'Sandbox worker failed.' });
    }
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const server = createSandboxServer();
  const port = Number(process.env.PORT || 8080);
  server.listen(port, '0.0.0.0', () => console.log(`SQL sandbox listening on ${port}`));
}
