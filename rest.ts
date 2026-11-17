// The REST v3 surface: repositories, branches, commits, git refs, contents, labels, issues,
// pull requests. Every reply is JSON with a string `message` on errors; list endpoints honour
// per_page/page when given; issue and pull request numbers share one per-repository counter, as
// GitHub does. The store's viewer login is the scenario viewer until a repo claim names another
// login (the forge cannot derive a login from the token value, so the first owner-bearing request
// for a repository claims it for that login).

import {
  VIEWER_EMAIL,
  VIEWER_LOGIN,
  claimOwner,
  createRepo,
  deleteRepo,
  getRepo,
  listRepos,
  nextIssueId,
  nextPullId,
  nextTimestamp,
  viewerLogin,
  type Issue,
  type Label,
  type Pull,
  type Repo,
} from './store.ts';
import {
  ZERO_OID,
  applyFileChanges,
  buildCommit,
  buildTree,
  diffTrees,
  flattenTree,
  hashObject,
  parseCommit,
  parseTree,
  storeObject,
} from './git.ts';

export interface RestResult {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

const err = (status: number, message: string): RestResult => ({ status, body: { message } });

export function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    private: repo.private,
    owner: { login: repo.owner, id: 1000, type: 'User' },
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
  };
}

function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => ({ name })),
    user: { login: issue.user, type: 'User' },
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    comments: issue.comments.length,
  };
}

function commentJson(comment: { id: number; body: string; user: string; createdAt: string }): Record<string, unknown> {
  return { id: comment.id, body: comment.body, user: { login: comment.user, type: 'User' }, created_at: comment.createdAt, updated_at: comment.createdAt };
}

function pullJson(repo: Repo, pull: Pull): Record<string, unknown> {
  return {
    id: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    head: { ref: pull.headRef, sha: pull.headSha },
    base: { ref: pull.baseRef, sha: pull.baseSha },
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    user: { login: pull.user, type: 'User' },
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
  };
}

function branchJson(name: string, sha: string): Record<string, unknown> {
  return { name, commit: { sha } };
}

/** Create an issue in a repository (shared by REST and GraphQL). Labels must already exist. */
export function createIssueInRepo(
  repo: Repo,
  viewer: string,
  title: string,
  bodyText: string,
  labels: string[],
): Issue | { error: string } {
  for (const name of labels) if (!repo.labels.has(name)) return { error: `unknown label: ${name}` };
  const stamp = nextTimestamp();
  const issue: Issue = {
    id: nextIssueId(),
    number: repo.nextNumber,
    title,
    body: bodyText,
    state: 'open',
    labels: [...labels],
    comments: [],
    user: viewer,
    createdSeq: stamp.seq,
    createdAt: stamp.iso,
    updatedAt: stamp.iso,
  };
  repo.nextNumber += 1;
  repo.issues.push(issue);
  return issue;
}

/** Create a pull request in a repository (shared by REST and GraphQL). */
export function createPullInRepo(
  repo: Repo,
  viewer: string,
  title: string,
  bodyText: string,
  headRef: string,
  baseRef: string,
): Pull | { error: string } {
  const headSha = repo.refs.get(`refs/heads/${headRef}`);
  const baseSha = repo.refs.get(`refs/heads/${baseRef}`);
  if (headSha === undefined || baseSha === undefined) return { error: 'head or base branch does not exist' };
  const duplicate = repo.pulls.find((pull) => pull.state === 'open' && pull.headRef === headRef && pull.baseRef === baseRef);
  if (duplicate !== undefined) return { error: 'a pull request already exists for this head and base' };
  const stamp = nextTimestamp();
  const pull: Pull = {
    id: nextPullId(),
    number: repo.nextNumber,
    title,
    body: bodyText,
    state: 'open',
    headRef,
    headSha,
    baseRef,
    baseSha,
    merged: false,
    mergedAt: null,
    mergeCommitSha: null,
    user: viewer,
    createdSeq: stamp.seq,
    createdAt: stamp.iso,
    updatedAt: stamp.iso,
  };
  repo.nextNumber += 1;
  repo.pulls.push(pull);
  return pull;
}

/** Squash-merge an open pull request (shared by REST and GraphQL). */
export function mergePullRequest(repo: Repo, pull: Pull): { ok: boolean; status: number; message: string; sha?: string } {
  if (pull.merged) return { ok: false, status: 405, message: 'pull request is already merged' };
  if (pull.state !== 'open') return { ok: false, status: 405, message: 'pull request is closed' };
  const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
  if (baseTip === undefined) return { ok: false, status: 404, message: 'base branch not found' };
  const baseTipTree = parseCommit(repo.objects.get(baseTip)?.data ?? Buffer.alloc(0)).tree;
  const headTree = parseCommit(repo.objects.get(pull.headSha)?.data ?? Buffer.alloc(0)).tree;
  const baseTree = parseCommit(repo.objects.get(pull.baseSha)?.data ?? Buffer.alloc(0)).tree;
  const headDiff = diffTrees(repo, baseTree, headTree);
  const baseDiff = diffTrees(repo, baseTree, baseTipTree);
  const basePaths = new Set(baseDiff.map((diff) => diff.path));
  if (headDiff.some((diff) => basePaths.has(diff.path))) return { ok: false, status: 405, message: 'merge conflict' };
  const mergedFlat = flattenTree(repo, baseTipTree);
  const headFlat = flattenTree(repo, headTree);
  for (const diff of headDiff) {
    if (diff.status === 'removed') mergedFlat.delete(diff.path);
    else {
      const entry = headFlat.get(diff.path);
      if (entry !== undefined) mergedFlat.set(diff.path, entry);
    }
  }
  const treeOid = rebuildTree(repo, mergedFlat);
  const commitOid = restCommit(repo, treeOid, [baseTip], `${pull.title} (#${pull.number})`);
  repo.refs.set(`refs/heads/${pull.baseRef}`, commitOid);
  const stamp = nextTimestamp();
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAt = stamp.iso;
  pull.mergeCommitSha = commitOid;
  pull.updatedAt = stamp.iso;
  return { ok: true, status: 200, message: 'Pull Request successfully merged', sha: commitOid };
}

/** Whether a pull request would conflict if merged now (MERGEABLE vs CONFLICTING). */
export function pullMergeable(repo: Repo, pull: Pull): boolean {
  const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
  if (baseTip === undefined) return false;
  const baseTipTree = parseCommit(repo.objects.get(baseTip)?.data ?? Buffer.alloc(0)).tree;
  const headTree = parseCommit(repo.objects.get(pull.headSha)?.data ?? Buffer.alloc(0)).tree;
  const baseTree = parseCommit(repo.objects.get(pull.baseSha)?.data ?? Buffer.alloc(0)).tree;
  const headDiff = diffTrees(repo, baseTree, headTree);
  const baseDiff = diffTrees(repo, baseTree, baseTipTree);
  const basePaths = new Set(baseDiff.map((diff) => diff.path));
  return !headDiff.some((diff) => basePaths.has(diff.path));
}

/** Create a commit object for a REST-driven change (contents write, squash merge). */
function restCommit(repo: Repo, treeOid: string, parents: string[], message: string): string {
  const stamp = nextTimestamp();
  const author = `${VIEWER_LOGIN} <${VIEWER_EMAIL}>`;
  const data = buildCommit({ tree: treeOid, parents, message, author, committer: author, timestamp: stamp.epochSec });
  return storeObject(repo, 'commit', data);
}

/** Rebuild a tree object from a flattened path map. */
function rebuildTree(repo: Repo, flat: Map<string, { mode: string; oid: string }>): string {
  const buildDir = (prefix: string): string => {
    const entries: Array<{ mode: string; name: string; oid: string }> = [];
    const subdirs = new Set<string>();
    for (const [path, entry] of flat) {
      if (prefix !== '' && !path.startsWith(`${prefix}/`)) continue;
      const rest = prefix === '' ? path : path.slice(prefix.length + 1);
      const slash = rest.indexOf('/');
      if (slash < 0) entries.push({ mode: entry.mode, name: rest, oid: entry.oid });
      else subdirs.add(rest.slice(0, slash));
    }
    for (const dir of subdirs) {
      const childPrefix = prefix === '' ? dir : `${prefix}/${dir}`;
      entries.push({ mode: '40000', name: dir, oid: buildDir(childPrefix) });
    }
    return storeObject(repo, 'tree', buildTree(entries));
  };
  return buildDir('');
}

/** Resolve a branch name (or oid) to a commit oid, or null. */
function resolveRef(repo: Repo, ref: string | null | undefined): string | null {
  if (ref === undefined || ref === null || ref === '') return repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
  const byBranch = repo.refs.get(`refs/heads/${ref}`);
  if (byBranch !== undefined) return byBranch;
  if (/^[0-9a-f]{40}$/.test(ref) && repo.objects.has(ref)) return ref;
  return null;
}

function parseBody(bodyText: string | null): { ok: true; value: Record<string, unknown> } | { ok: false; result: RestResult } {
  if (bodyText === null || bodyText.trim() === '') return { ok: true, value: {} };
  try {
    const value: unknown = JSON.parse(bodyText);
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return { ok: false, result: err(400, 'request body must be a JSON object') };
    return { ok: true, value: value as Record<string, unknown> };
  } catch {
    return { ok: false, result: err(400, 'malformed JSON body') };
  }
}

function pageOf(query: URLSearchParams): { perPage: number | null; page: number } {
  const perPageRaw = query.get('per_page');
  const pageRaw = query.get('page');
  const perPage = perPageRaw === null ? null : Number(perPageRaw);
  const page = pageRaw === null ? 1 : Number(pageRaw);
  return {
    perPage: perPage !== null && Number.isSafeInteger(perPage) && perPage > 0 ? perPage : null,
    page: Number.isSafeInteger(page) && page > 0 ? page : 1,
  };
}

function paginate<T>(items: T[], query: URLSearchParams, origin: string, path: string): { items: T[]; link: string | null } {
  const { perPage, page } = pageOf(query);
  if (perPage === null) return { items, link: null };
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  let link: string | null = null;
  if (start + perPage < items.length) {
    const url = new URL(`${origin}${path}`);
    url.searchParams.set('per_page', String(perPage));
    url.searchParams.set('page', String(page + 1));
    link = `<${url.toString()}>; rel="next"`;
  }
  return { items: slice, link };
}

/**
 * Route one REST request. Returns null when the path is not under /api/v3 (the caller falls
 * through to the git/MCP/404 handlers). `authed` is false when no bearer token was presented.
 */
export function handleRest(
  method: string,
  path: string,
  query: URLSearchParams,
  bodyText: string | null,
  authed: boolean,
  origin: string,
): RestResult | null {
  if (path !== '/api/v3' && !path.startsWith('/api/v3/')) return null;
  const seg = path === '/api/v3' ? [] : path.slice('/api/v3/'.length).split('/').filter((part) => part !== '');
  const decode = (value: string): string => {
    try { return decodeURIComponent(value); } catch { return value; }
  };

  // The API root and meta need no token (the starter answered the root this way).
  if (method === 'GET' && seg.length === 0) {
    return { status: 200, body: { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, headers: { 'x-oauth-scopes': 'repo, read:org' } };
  }
  if (method === 'GET' && seg.length === 1 && seg[0] === 'meta') {
    return { status: 200, body: { installed_version: '1.0.0', verifiable_password_authentication: true } };
  }
  if (!authed) return err(401, 'Requires authentication');

  const needsBody = method === 'POST' || method === 'PATCH' || method === 'PUT' || method === 'DELETE';
  let body: Record<string, unknown> = {};
  if (needsBody) {
    const parsed = parseBody(bodyText);
    if (!parsed.ok) return parsed.result;
    body = parsed.value;
  }

  const viewer = viewerLogin();

  // GET /user — the token's login (the claimed owner, else the scenario viewer).
  if (method === 'GET' && seg.length === 1 && seg[0] === 'user') {
    return { status: 200, body: { login: viewer, id: 1000, type: 'User' } };
  }

  // GET /user/repos — paginated, creation order; POST /user/repos — create.
  if (seg.length === 2 && seg[0] === 'user' && seg[1] === 'repos') {
    if (method === 'GET') {
      const mine = listRepos().filter((repo) => repo.owner === viewer);
      const { items, link } = paginate(mine.map(repoJson), query, origin, path);
      const headers: Record<string, string> = {};
      if (link !== null) headers.link = link;
      return { status: 200, body: items, headers };
    }
    if (method === 'POST') {
      const name = typeof body.name === 'string' ? body.name.trim() : '';
      if (name === '') return err(422, 'name is required');
      const description = typeof body.description === 'string' ? body.description : '';
      const isPrivate = body.private === true;
      const repo = createRepo(name, claimOwner(viewer), { description, private: isPrivate });
      if (repo === null) return err(422, 'name already exists on this account');
      return { status: 201, body: repoJson(repo) };
    }
  }

  // Everything below addresses /repos/{owner}/{repo}/...
  if (seg.length >= 3 && seg[0] === 'repos') {
    const owner = decode(seg[1]!);
    const name = decode(seg[2]!);
    const rest = seg.slice(3);

    const repoOr404 = (): Repo | RestResult => {
      const repo = getRepo(owner, name);
      return repo === null ? err(404, 'Not Found') : repo;
    };

    // GET/PATCH/DELETE /repos/{owner}/{repo}
    if (rest.length === 0) {
      if (method === 'GET') {
        const found = repoOr404();
        return found instanceof Object && 'body' in found ? (found as RestResult) : { status: 200, body: repoJson(found as Repo) };
      }
      if (method === 'PATCH') {
        const found = repoOr404();
        if ('body' in (found as RestResult)) return found as RestResult;
        const repo = found as Repo;
        if (typeof body.description === 'string') repo.description = body.description;
        if (typeof body.private === 'boolean') repo.private = body.private;
        if (typeof body.default_branch === 'string' && body.default_branch !== '') repo.defaultBranch = body.default_branch;
        return { status: 200, body: repoJson(repo) };
      }
      if (method === 'DELETE') {
        const found = repoOr404();
        if ('body' in (found as RestResult)) return found as RestResult;
        deleteRepo(name);
        return { status: 204, body: null };
      }
    }

    // GET /repos/{o}/{r}/branches and /branches/{branch}
    if (rest.length >= 1 && rest[0] === 'branches') {
      const found = repoOr404();
      if ('body' in (found as RestResult)) return found as RestResult;
      const repo = found as Repo;
      if (method === 'GET' && rest.length === 1) {
        const list = [...repo.refs.keys()]
          .filter((ref) => ref.startsWith('refs/heads/'))
          .sort()
          .map((ref) => branchJson(ref.slice('refs/heads/'.length), repo.refs.get(ref)!));
        return { status: 200, body: list };
      }
      if (method === 'GET' && rest.length === 2) {
        const branch = decode(rest[1]!);
        const sha = repo.refs.get(`refs/heads/${branch}`);
        if (sha === undefined) return err(404, 'Branch not found');
        return { status: 200, body: branchJson(branch, sha) };
      }
    }

    // GET /repos/{o}/{r}/commits[?sha=<ref>]
    if (rest.length === 1 && rest[0] === 'commits' && method === 'GET') {
      const found = repoOr404();
      if ('body' in (found as RestResult)) return found as RestResult;
      const repo = found as Repo;
      const tip = resolveRef(repo, query.get('sha'));
      if (tip === null) return { status: 200, body: [] };
      const out: Array<Record<string, unknown>> = [];
      const seen = new Set<string>();
      let current: string | null = tip;
      while (current !== null && !seen.has(current)) {
        seen.add(current);
        const obj = repo.objects.get(current);
        if (obj === undefined || obj.type !== 'commit') break;
        const commit = parseCommit(obj.data);
        out.push({
          sha: current,
          commit: { message: commit.message, author: { name: VIEWER_LOGIN, date: repo.createdAt }, committer: { name: VIEWER_LOGIN, date: repo.createdAt } },
        });
        current = commit.parents.length > 0 ? commit.parents[0]! : null;
      }
      return { status: 200, body: out };
    }

    // GET /repos/{o}/{r}/git/refs/heads/{branch} and POST /git/refs
    if (rest.length >= 2 && rest[0] === 'git' && rest[1] === 'refs') {
      const found = repoOr404();
      if ('body' in (found as RestResult)) return found as RestResult;
      const repo = found as Repo;
      if (method === 'GET' && rest.length === 4 && rest[2] === 'heads') {
        const branch = decode(rest[3]!);
        const sha = repo.refs.get(`refs/heads/${branch}`);
        if (sha === undefined) return err(404, 'Reference does not exist');
        return { status: 200, body: { ref: `refs/heads/${branch}`, object: { sha, type: 'commit' } } };
      }
      if (method === 'POST' && rest.length === 2) {
        const ref = typeof body.ref === 'string' ? body.ref : '';
        const sha = typeof body.sha === 'string' ? body.sha : '';
        if (!ref.startsWith('refs/') || !/^[0-9a-f]{40}$/.test(sha)) return err(422, 'ref and sha are required');
        if (repo.refs.has(ref)) return err(422, 'Reference already exists');
        if (!repo.objects.has(sha)) return err(422, 'object does not exist');
        repo.refs.set(ref, sha);
        return { status: 201, body: { ref, object: { sha, type: 'commit' } } };
      }
    }

    // /contents/{path...} — GET file/dir, PUT create/update, DELETE remove.
    if (rest.length >= 1 && rest[0] === 'contents') {
      const found = repoOr404();
      if ('body' in (found as RestResult)) return found as RestResult;
      const repo = found as Repo;
      const filePath = rest.slice(1).map(decode).join('/');
      const branch = query.get('ref') ?? undefined;
      const tip = resolveRef(repo, branch ?? null);
      if (method === 'GET') {
        if (tip === null) return err(404, 'Not Found');
        const commit = parseCommit(repo.objects.get(tip)?.data ?? Buffer.alloc(0));
        const flat = flattenTree(repo, commit.tree);
        if (filePath === '') {
          const entries = dirListing(repo, flat, '');
          return { status: 200, body: entries };
        }
        const file = flat.get(filePath);
        if (file !== undefined) {
          const data = repo.objects.get(file.oid)?.data ?? Buffer.alloc(0);
          return {
            status: 200,
            body: { type: 'file', encoding: 'base64', content: data.toString('base64'), sha: file.oid, size: data.length, name: filePath.split('/').pop() ?? filePath, path: filePath },
          };
        }
        const prefix = `${filePath}/`;
        let isDir = false;
        for (const key of flat.keys()) if (key.startsWith(prefix)) { isDir = true; break; }
        if (!isDir) return err(404, 'Not Found');
        return { status: 200, body: dirListing(repo, flat, filePath) };
      }
      if (method === 'PUT') {
        const message = typeof body.message === 'string' ? body.message : 'update';
        const contentB64 = typeof body.content === 'string' ? body.content : '';
        let content: Buffer;
        try {
          content = Buffer.from(contentB64, 'base64');
          if (contentB64 !== '' && content.length === 0 && contentB64.replace(/=+$/, '') !== '') throw new Error('bad base64');
        } catch {
          return err(400, 'content is not valid base64');
        }
        const wantBranch = typeof body.branch === 'string' && body.branch !== '' ? body.branch : repo.defaultBranch;
        let refTip = repo.refs.get(`refs/heads/${wantBranch}`) ?? null;
        if (refTip === null && wantBranch !== repo.defaultBranch) {
          refTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
          if (refTip !== null) repo.refs.set(`refs/heads/${wantBranch}`, refTip);
        }
        const baseTree = refTip === null ? null : parseCommit(repo.objects.get(refTip)?.data ?? Buffer.alloc(0)).tree;
        const flat = flattenTree(repo, baseTree);
        const existing = flat.get(filePath);
        const givenSha = typeof body.sha === 'string' ? body.sha : null;
        if (existing !== undefined && givenSha === null) return err(422, 'sha is required to update a file');
        if (existing !== undefined && givenSha !== existing.oid) return err(409, 'sha does not match the current file');
        if (existing === undefined && givenSha !== null) return err(422, 'sha does not match any existing file');
        const changes = new Map<string, Buffer | null>();
        changes.set(filePath, content);
        const treeOid = applyFileChanges(repo, baseTree, changes);
        const blobOid = hashObject('blob', content);
        const commitOid = restCommit(repo, treeOid, refTip === null ? [] : [refTip], message);
        repo.refs.set(`refs/heads/${wantBranch}`, commitOid);
        return {
          status: existing === undefined ? 201 : 200,
          body: {
            content: { name: filePath.split('/').pop() ?? filePath, path: filePath, sha: blobOid, size: content.length, encoding: 'base64', content: contentB64 },
            commit: { sha: commitOid },
          },
        };
      }
      if (method === 'DELETE') {
        const wantBranch = typeof body.branch === 'string' && body.branch !== '' ? body.branch : repo.defaultBranch;
        const refTip = repo.refs.get(`refs/heads/${wantBranch}`) ?? null;
        if (refTip === null) return err(404, 'Not Found');
        const message = typeof body.message === 'string' ? body.message : 'delete';
        const givenSha = typeof body.sha === 'string' ? body.sha : null;
        const baseTree = parseCommit(repo.objects.get(refTip)?.data ?? Buffer.alloc(0)).tree;
        const flat = flattenTree(repo, baseTree);
        const existing = flat.get(filePath);
        if (existing === undefined) return err(404, 'Not Found');
        if (givenSha === null || givenSha !== existing.oid) return err(409, 'sha does not match the current file');
        const changes = new Map<string, Buffer | null>();
        changes.set(filePath, null);
        const treeOid = applyFileChanges(repo, baseTree, changes);
        const commitOid = restCommit(repo, treeOid, [refTip], message);
        repo.refs.set(`refs/heads/${wantBranch}`, commitOid);
        return { status: 200, body: { content: null, commit: { sha: commitOid } } };
      }
    }

    // /labels — GET list, POST create.
    if (rest.length === 1 && rest[0] === 'labels') {
      const found = repoOr404();
      if ('body' in (found as RestResult)) return found as RestResult;
      const repo = found as Repo;
      if (method === 'GET') return { status: 200, body: [...repo.labels.values()] };
      if (method === 'POST') {
        const name = typeof body.name === 'string' ? body.name.trim() : '';
        if (name === '') return err(422, 'name is required');
        if (repo.labels.has(name)) return err(422, 'label already exists');
        const color = typeof body.color === 'string' ? body.color.replace(/^#/, '') : 'ededed';
        const label: Label = { name, color };
        repo.labels.set(name, label);
        return { status: 201, body: label };
      }
    }

    // /issues — GET list, POST create; /issues/{n} — GET/PATCH; /issues/{n}/comments.
    if (rest.length >= 1 && rest[0] === 'issues') {
      const found = repoOr404();
      if ('body' in (found as RestResult)) return found as RestResult;
      const repo = found as Repo;
      if (rest.length === 1 && method === 'GET') {
        const state = query.get('state') ?? 'open';
        const direction = query.get('direction') ?? 'desc';
        const labelFilter = query.get('labels');
        let list = [...repo.issues];
        if (state !== 'all') list = list.filter((issue) => issue.state === state);
        if (labelFilter !== null && labelFilter !== '') {
          const wanted = new Set(labelFilter.split(',').map((part) => part.trim()));
          list = list.filter((issue) => issue.labels.some((label) => wanted.has(label)));
        }
        list.sort((a, b) => (direction === 'asc' ? a.createdSeq - b.createdSeq : b.createdSeq - a.createdSeq));
        const { items } = paginate(list.map((issue) => issueJson(repo, issue)), query, origin, path);
        return { status: 200, body: items };
      }
      if (rest.length === 1 && method === 'POST') {
        const title = typeof body.title === 'string' ? body.title : '';
        if (title === '') return err(422, 'title is required');
        const rawLabels = body.labels;
        const labels: string[] = [];
        if (Array.isArray(rawLabels)) {
          for (const entry of rawLabels) {
            const name = typeof entry === 'string' ? entry : typeof entry === 'object' && entry !== null && typeof (entry as Record<string, unknown>).name === 'string' ? String((entry as Record<string, unknown>).name) : '';
            if (name !== '') labels.push(name);
          }
        }
        const created = createIssueInRepo(repo, viewer, title, typeof body.body === 'string' ? body.body : '', labels);
        if ('error' in created) return err(422, created.error);
        return { status: 201, body: issueJson(repo, created) };
      }
      if (rest.length >= 2) {
        const number = Number(rest[1]);
        const issue = repo.issues.find((entry) => entry.number === number);
        if (issue === undefined) return err(404, 'Not Found');
        if (rest.length === 2 && method === 'GET') return { status: 200, body: issueJson(repo, issue) };
        if (rest.length === 2 && method === 'PATCH') {
          if (typeof body.state === 'string' && (body.state === 'open' || body.state === 'closed')) issue.state = body.state;
          if (typeof body.title === 'string') issue.title = body.title;
          if (typeof body.body === 'string') issue.body = body.body;
          issue.updatedAt = nextTimestamp().iso;
          return { status: 200, body: issueJson(repo, issue) };
        }
        if (rest.length === 3 && rest[2] === 'comments') {
          if (method === 'GET') return { status: 200, body: issue.comments.map(commentJson) };
          if (method === 'POST') {
            const text = typeof body.body === 'string' ? body.body : '';
            if (text === '') return err(422, 'body is required');
            const stamp = nextTimestamp();
            const comment = { id: repo.nextCommentId, body: text, user: viewer, createdAt: stamp.iso };
            repo.nextCommentId += 1;
            issue.comments.push(comment);
            return { status: 201, body: commentJson(comment) };
          }
        }
      }
    }

    // /pulls — GET list, POST create; /pulls/{n} — GET; /pulls/{n}/files; /pulls/{n}/merge.
    if (rest.length >= 1 && rest[0] === 'pulls') {
      const found = repoOr404();
      if ('body' in (found as RestResult)) return found as RestResult;
      const repo = found as Repo;
      if (rest.length === 1 && method === 'GET') {
        const state = query.get('state') ?? 'open';
        let list = [...repo.pulls];
        if (state !== 'all') list = list.filter((pull) => pull.state === state);
        list.sort((a, b) => b.createdSeq - a.createdSeq);
        const { items } = paginate(list.map((pull) => pullJson(repo, pull)), query, origin, path);
        return { status: 200, body: items };
      }
      if (rest.length === 1 && method === 'POST') {
        const title = typeof body.title === 'string' ? body.title : '';
        const headRaw = typeof body.head === 'string' ? body.head : '';
        const baseRaw = typeof body.base === 'string' ? body.base : '';
        if (title === '' || headRaw === '' || baseRaw === '') return err(422, 'title, head and base are required');
        const headRef = headRaw.includes(':') ? headRaw.split(':').pop()! : headRaw;
        const baseRef = baseRaw.includes(':') ? baseRaw.split(':').pop()! : baseRaw;
        const created = createPullInRepo(repo, viewer, title, typeof body.body === 'string' ? body.body : '', headRef, baseRef);
        if ('error' in created) return err(422, created.error);
        return { status: 201, body: pullJson(repo, created) };
      }
      if (rest.length >= 2) {
        const number = Number(rest[1]);
        const pull = repo.pulls.find((entry) => entry.number === number);
        if (pull === undefined) return err(404, 'Not Found');
        if (rest.length === 2 && method === 'GET') return { status: 200, body: pullJson(repo, pull) };
        if (rest.length === 3 && rest[2] === 'files' && method === 'GET') {
          const headTree = parseCommit(repo.objects.get(pull.headSha)?.data ?? Buffer.alloc(0)).tree;
          const baseTree = parseCommit(repo.objects.get(pull.baseSha)?.data ?? Buffer.alloc(0)).tree;
          const files = diffTrees(repo, baseTree, headTree).map((diff) => ({
            filename: diff.path,
            status: diff.status === 'removed' ? 'removed' : diff.status,
            additions: diff.additions,
            deletions: diff.deletions,
            changes: diff.additions + diff.deletions,
          }));
          return { status: 200, body: files };
        }
        if (rest.length === 3 && rest[2] === 'merge' && method === 'PUT') {
          const merged = mergePullRequest(repo, pull);
          if (!merged.ok) return err(merged.status, merged.message);
          return { status: 200, body: { merged: true, sha: merged.sha, message: 'Pull Request successfully merged' } };
        }
      }
    }
  }

  return err(404, 'Not Found');
}

function dirListing(repo: Repo, flat: Map<string, { mode: string; oid: string }>, dir: string): Array<Record<string, unknown>> {
  const prefix = dir === '' ? '' : `${dir}/`;
  const files = new Map<string, { mode: string; oid: string }>();
  const dirs = new Set<string>();
  for (const [path, entry] of flat) {
    if (!path.startsWith(prefix)) continue;
    const rest = path.slice(prefix.length);
    const slash = rest.indexOf('/');
    if (slash < 0) files.set(rest, entry);
    else dirs.add(rest.slice(0, slash));
  }
  const out: Array<Record<string, unknown>> = [];
  for (const name of [...dirs].sort()) {
    const dirPath = prefix === '' ? name : `${prefix}${name}`;
    const treeOid = rebuildTree(repo, new Map([...flat].filter(([path]) => path.startsWith(`${dirPath}/`)).map(([path, entry]) => [path.slice(dirPath.length + 1), entry] as [string, { mode: string; oid: string }])));
    out.push({ type: 'dir', name, path: dirPath, sha: treeOid });
  }
  for (const [name, entry] of [...files].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const data = repo.objects.get(entry.oid)?.data ?? Buffer.alloc(0);
    out.push({ type: 'file', name, path: `${prefix}${name}`, sha: entry.oid, size: data.length });
  }
  return out;
}
