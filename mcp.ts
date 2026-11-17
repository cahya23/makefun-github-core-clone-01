// The MCP endpoint (/mcp): JSON-RPC 2.0 over plain HTTP (no SSE — the client accepts a plain
// JSON answer). Modern era 2026-07-28: server/discover answers supportedVersions, capabilities
// and serverInfo; the legacy initialize handshake is answered too, for completeness. Only
// tools/call requires an Authorization header (an unauthenticated tools/call is a 401); discover,
// initialize and tools/list answer without one, because the client's connect() must not 401.
// The six tools act on the same store as REST and GraphQL, so ids are stable across surfaces.

import { createRepo, getRepo, viewerLogin, claimOwner } from './store.ts';
import { createIssueInRepo, createPullInRepo, mergePullRequest, repoJson } from './rest.ts';

export const MCP_SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const SERVER_INFO = { name: 'forge', version: '1.0.0' };

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, Record<string, unknown>>;
    required: string[];
  };
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a repository owned by the viewer.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The login that will own the repository.' },
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Read one repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'open, closed or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        body: { type: 'string', description: 'The pull request body.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Squash-merge a pull request.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'integer', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

function textResult(text: string): Record<string, unknown> {
  return { content: [{ type: 'text', text }], isError: false };
}

function errorResult(text: string): Record<string, unknown> {
  return { content: [{ type: 'text', text }], isError: true };
}

function callTool(name: string, args: Record<string, unknown>): { rpcError: { code: number; message: string } | null; result: Record<string, unknown> | null } {
  const viewer = viewerLogin();
  const str = (value: unknown): string => (typeof value === 'string' ? value : '');
  switch (name) {
    case 'create_repo': {
      const repoName = str(args.name);
      if (repoName === '') return { rpcError: { code: -32602, message: 'create_repo requires name' }, result: null };
      const owner = str(args.owner) !== '' ? str(args.owner) : claimOwner(viewer);
      const repo = createRepo(repoName, owner, {
        description: str(args.description),
        private: args.private === true,
      });
      if (repo === null) return { rpcError: null, result: errorResult(`repository ${owner}/${repoName} already exists`) };
      return { rpcError: null, result: textResult(JSON.stringify(repoJson(repo))) };
    }
    case 'get_repo': {
      const repo = getRepo(str(args.owner), str(args.repo));
      if (repo === null) return { rpcError: null, result: errorResult(`repository ${str(args.owner)}/${str(args.repo)} not found`) };
      return { rpcError: null, result: textResult(JSON.stringify(repoJson(repo))) };
    }
    case 'create_issue': {
      if (str(args.owner) === '' || str(args.repo) === '' || str(args.title) === '') {
        return { rpcError: { code: -32602, message: 'create_issue requires owner, repo and title' }, result: null };
      }
      const repo = getRepo(str(args.owner), str(args.repo));
      if (repo === null) return { rpcError: null, result: errorResult(`repository ${str(args.owner)}/${str(args.repo)} not found`) };
      const created = createIssueInRepo(repo, viewer, str(args.title), str(args.body), []);
      if ('error' in created) return { rpcError: null, result: errorResult(created.error) };
      const issue = {
        id: created.id,
        number: created.number,
        title: created.title,
        body: created.body,
        state: created.state,
        labels: created.labels.map((label) => ({ name: label })),
        user: { login: created.user },
        created_at: created.createdAt,
        updated_at: created.updatedAt,
      };
      return { rpcError: null, result: textResult(JSON.stringify(issue)) };
    }
    case 'list_issues': {
      const repo = getRepo(str(args.owner), str(args.repo));
      if (repo === null) return { rpcError: null, result: errorResult(`repository ${str(args.owner)}/${str(args.repo)} not found`) };
      const state = str(args.state) !== '' ? str(args.state) : 'open';
      const list = repo.issues
        .filter((issue) => state === 'all' || issue.state === state)
        .map((issue) => ({
          id: issue.id,
          number: issue.number,
          title: issue.title,
          body: issue.body,
          state: issue.state,
          labels: issue.labels.map((label) => ({ name: label })),
          user: { login: issue.user },
          created_at: issue.createdAt,
          updated_at: issue.updatedAt,
        }));
      return { rpcError: null, result: textResult(JSON.stringify(list)) };
    }
    case 'create_pull_request': {
      if (str(args.owner) === '' || str(args.repo) === '' || str(args.title) === '' || str(args.head) === '' || str(args.base) === '') {
        return { rpcError: { code: -32602, message: 'create_pull_request requires owner, repo, title, head and base' }, result: null };
      }
      const repo = getRepo(str(args.owner), str(args.repo));
      if (repo === null) return { rpcError: null, result: errorResult(`repository ${str(args.owner)}/${str(args.repo)} not found`) };
      const created = createPullInRepo(repo, viewer, str(args.title), str(args.body), str(args.head), str(args.base));
      if ('error' in created) return { rpcError: null, result: errorResult(created.error) };
      const pull = {
        id: created.id,
        number: created.number,
        title: created.title,
        body: created.body,
        state: created.state,
        head: { ref: created.headRef, sha: created.headSha },
        base: { ref: created.baseRef, sha: created.baseSha },
        merged: created.merged,
        merged_at: created.mergedAt,
        merge_commit_sha: created.mergeCommitSha,
      };
      return { rpcError: null, result: textResult(JSON.stringify(pull)) };
    }
    case 'merge_pull_request': {
      const pullNumber = typeof args.pull_number === 'number' ? args.pull_number : Number(args.pull_number);
      if (str(args.owner) === '' || str(args.repo) === '' || !Number.isSafeInteger(pullNumber)) {
        return { rpcError: { code: -32602, message: 'merge_pull_request requires owner, repo and pull_number' }, result: null };
      }
      const repo = getRepo(str(args.owner), str(args.repo));
      if (repo === null) return { rpcError: null, result: errorResult(`repository ${str(args.owner)}/${str(args.repo)} not found`) };
      const pull = repo.pulls.find((entry) => entry.number === pullNumber);
      if (pull === undefined) return { rpcError: null, result: errorResult(`pull request #${pullNumber} not found`) };
      const merged = mergePullRequest(repo, pull);
      if (!merged.ok) return { rpcError: null, result: errorResult(merged.message) };
      return { rpcError: null, result: textResult(JSON.stringify({ merged: true, sha: merged.sha, number: pull.number })) };
    }
    default:
      return { rpcError: { code: -32601, message: `unknown tool ${name}` }, result: null };
  }
}

/**
 * Handle one MCP request. Returns the HTTP status and body (null body = no response, for
 * notifications). `authed` is false when no Authorization header was presented.
 */
export function handleMcp(method: string, bodyText: string | null, authed: boolean): { status: number; body: unknown } {
  if (method === 'DELETE') return { status: 204, body: null };
  if (method !== 'POST') return { status: 405, body: { message: 'Method Not Allowed' } };
  let request: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(bodyText ?? '');
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('not an object');
    request = parsed as Record<string, unknown>;
  } catch {
    return { status: 400, body: { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } } };
  }
  const id = request.id ?? null;
  const isNotification = request.id === undefined;
  const rpcResult = (result: unknown): { status: number; body: unknown } =>
    isNotification ? { status: 202, body: null } : { status: 200, body: { jsonrpc: '2.0', id, result } };
  const rpcError = (code: number, message: string, status = 200): { status: number; body: unknown } =>
    isNotification ? { status: 202, body: null } : { status, body: { jsonrpc: '2.0', id, error: { code, message } } };
  const rpcMethod = typeof request.method === 'string' ? request.method : '';
  const params = (request.params ?? {}) as Record<string, unknown>;

  if (rpcMethod === 'server/discover') {
    return rpcResult({
      protocolVersion: MCP_SUPPORTED_VERSIONS[0],
      capabilities: { tools: {} },
      serverInfo: SERVER_INFO,
      supportedVersions: MCP_SUPPORTED_VERSIONS,
    });
  }
  if (rpcMethod === 'initialize') {
    const offered = typeof (params as Record<string, unknown>).protocolVersion === 'string' ? String(params.protocolVersion) : '';
    const negotiated = MCP_SUPPORTED_VERSIONS.includes(offered) ? offered : '2025-11-25';
    return rpcResult({ protocolVersion: negotiated, capabilities: { tools: {} }, serverInfo: SERVER_INFO });
  }
  if (rpcMethod === 'notifications/initialized' || rpcMethod.startsWith('notifications/')) {
    return { status: 202, body: null };
  }
  if (rpcMethod === 'tools/list') {
    return rpcResult({ tools: TOOLS });
  }
  if (rpcMethod === 'tools/call') {
    if (!authed) return rpcError(-32001, 'Requires authentication', 401);
    const toolName = typeof params.name === 'string' ? params.name : '';
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    const known = TOOLS.some((tool) => tool.name === toolName);
    if (!known) return rpcError(-32602, `unknown tool ${toolName}`);
    const outcome = callTool(toolName, args);
    if (outcome.rpcError !== null) return rpcError(outcome.rpcError.code, outcome.rpcError.message);
    return rpcResult(outcome.result);
  }
  return rpcError(-32601, `Method not found: ${rpcMethod}`);
}
