// The entry's HTTP server: one in-memory forge behind four surfaces — git smart HTTP, REST v3,
// GraphQL v4 and MCP — plus the env's /healthz probe. Routing is by path prefix; every response
// carries X-GitHub-Request-Id and a JSON body unless it is a git pack stream (whose content-type
// the git client asserts). Bodies are read whole before dispatch: packs are small (the largest the
// suite sends holds a few hundred objects), and a whole-body read keeps the git parsers simple.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { nextRequestId } from './store.ts';
import { handleRest } from './rest.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import {
  advertisementV0,
  advertisementV2,
  decodePktLines,
  fetchResponseV0,
  fetchResponseV2,
  handleLsRefs,
  handleReceivePack,
  parseFetchV0,
  parseFetchV2,
  planFetch,
} from './git.ts';
import { getRepoByName } from './store.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
const MAX_BODY_BYTES = 64 * 1024 * 1024;

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Readonly<Record<string, string>> = {}): void {
  const text = body === null ? '' : `${JSON.stringify(body)}\n`;
  res.writeHead(status, { 'content-type': JSON_TYPE, 'content-length': Buffer.byteLength(text), ...headers });
  res.end(text);
}

function sendBytes(res: ServerResponse, status: number, body: Buffer, contentType: string, headers: Readonly<Record<string, string>> = {}): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': body.length, ...headers });
  res.end(body);
}

function authed(req: IncomingMessage): boolean {
  const header = req.headers.authorization ?? '';
  return header.startsWith('Bearer ') && header.slice('Bearer '.length).trim() !== '';
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    req.on('data', (chunk: Buffer) => {
      if (settled) return;
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        settled = true;
        req.destroy();
        reject(new Error('request body too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!settled) {
        settled = true;
        resolve(Buffer.concat(chunks));
      }
    });
    req.on('error', (err: Error) => {
      if (!settled) {
        settled = true;
        reject(err);
      }
    });
  });
}

/** Build the server. It binds nothing until the caller listens; the entry listens on an ephemeral port. */
export function createApp(): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const requestId = nextRequestId();
      const baseHeaders: Record<string, string> = { 'x-github-request-id': requestId };
      const method = req.method ?? 'GET';
      let url: URL;
      try {
        url = new URL(req.url ?? '/', 'http://entry');
      } catch {
        sendJson(res, 400, { message: 'bad request URL' }, baseHeaders);
        return;
      }
      const path = url.pathname;
      const origin = `http://${req.headers.host ?? 'entry'}`;

      // The env's boot check calls this twice: 200 {"ok":true}.
      if (method === 'GET' && path === '/healthz') {
        sendJson(res, 200, { ok: true }, baseHeaders);
        return;
      }

      // MCP (JSON-RPC 2.0, Streamable HTTP without the stream: plain JSON answers).
      if (path === '/mcp') {
        const body = method === 'POST' || method === 'DELETE' ? await readBody(req) : Buffer.alloc(0);
        const outcome = handleMcp(method, body.length === 0 ? null : body.toString('utf8'), authed(req));
        if (outcome.body === null) {
          res.writeHead(outcome.status, { ...baseHeaders });
          res.end();
          return;
        }
        sendJson(res, outcome.status, outcome.body, baseHeaders);
        return;
      }

      // GraphQL v4.
      if (path === '/api/graphql') {
        if (method !== 'POST') {
          sendJson(res, 405, { message: 'Method Not Allowed' }, baseHeaders);
          return;
        }
        const body = await readBody(req);
        const outcome = handleGraphQL(body.toString('utf8'), authed(req));
        sendJson(res, outcome.status, outcome.body, baseHeaders);
        return;
      }

      // REST v3 (the handler answers null for anything outside /api/v3).
      const needsBody = method === 'POST' || method === 'PATCH' || method === 'PUT' || method === 'DELETE';
      const restBody = path.startsWith('/api/v3') && needsBody ? await readBody(req) : null;
      const rest = handleRest(method, path, url.searchParams, restBody === null ? null : restBody.toString('utf8'), authed(req), origin);
      if (rest !== null) {
        if (rest.status === 204) {
          res.writeHead(204, { ...baseHeaders, ...(rest.headers ?? {}) });
          res.end();
          return;
        }
        sendJson(res, rest.status, rest.body, { ...baseHeaders, ...(rest.headers ?? {}) });
        return;
      }

      // Git smart HTTP: /{owner}/{repo}.git/info/refs and .../git-upload-pack, .../git-receive-pack.
      const gitMatch = /^\/([^/]+)\/([^/]+?)(?:\.git)?\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(path);
      if (gitMatch !== null) {
        const repoName = decodeURIComponent(gitMatch[2]!);
        const repo = getRepoByName(repoName);
        if (!authed(req)) {
          sendJson(res, 401, { message: 'Requires authentication' }, baseHeaders);
          return;
        }
        if (repo === null) {
          sendJson(res, 404, { message: 'Not Found' }, baseHeaders);
          return;
        }
        const action = gitMatch[3]!;
        if (method === 'GET' && action === 'info/refs') {
          const service = url.searchParams.get('service');
          if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
            sendJson(res, 400, { message: 'service is required' }, baseHeaders);
            return;
          }
          const wantsV2 = service === 'git-upload-pack' && (req.headers['git-protocol'] ?? '').includes('version=2');
          const body = wantsV2 ? advertisementV2() : advertisementV0(repo, service);
          sendBytes(res, 200, body, `application/x-${service}-advertisement`, baseHeaders);
          return;
        }
        if (method === 'POST' && action === 'git-upload-pack') {
          const body = await readBody(req);
          const { packets } = decodePktLines(body);
          const firstLine = packets.find((packet) => packet.kind === 'data')?.payload.toString('utf8').replace(/\n$/, '') ?? '';
          if (firstLine.startsWith('command=ls-refs')) {
            sendBytes(res, 200, handleLsRefs(repo, body), 'application/x-git-upload-pack-result', baseHeaders);
            return;
          }
          if (firstLine.startsWith('command=fetch')) {
            const plan = planFetch(repo, parseFetchV2(body));
            sendBytes(res, 200, fetchResponseV2(plan), 'application/x-git-upload-pack-result', baseHeaders);
            return;
          }
          if (firstLine.startsWith('want ')) {
            const plan = planFetch(repo, parseFetchV0(body));
            sendBytes(res, 200, fetchResponseV0(plan), 'application/x-git-upload-pack-result', baseHeaders);
            return;
          }
          sendJson(res, 400, { message: 'unknown git-upload-pack command' }, baseHeaders);
          return;
        }
        if (method === 'POST' && action === 'git-receive-pack') {
          const body = await readBody(req);
          const { response } = handleReceivePack(repo, body);
          sendBytes(res, 200, response, 'application/x-git-receive-pack-result', baseHeaders);
          return;
        }
        sendJson(res, 405, { message: 'Method Not Allowed' }, baseHeaders);
        return;
      }

      // Everything else, every method: GitHub's 404 body.
      sendJson(res, 404, { message: 'Not Found' }, baseHeaders);
    })().catch((err: unknown) => {
      if (!res.headersSent) {
        sendJson(res, 500, { message: err instanceof Error ? err.message : 'internal error' }, { 'x-github-request-id': nextRequestId() });
      } else {
        try { res.end(); } catch { /* the socket is already gone */ }
      }
    });
  });
}
