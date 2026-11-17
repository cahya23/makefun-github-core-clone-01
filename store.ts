// The forge's in-memory store: repositories, git objects, issues, pull requests, labels.
//
// Everything lives in process memory: the trial is a single process, the suite never restarts the
// entry mid-trial, and speed is the perf column's whole game, so no disk, no index rebuilds, no
// serialization round-trips on the hot paths. Ids are global counters (stable across reads, which
// the MCP rest-parity check asserts); timestamps derive from MAKEFUN_TRIAL_NOW plus a monotonic
// sequence, so ordering is deterministic and created_at is strictly increasing per object.

export interface GitObject {
  type: 'commit' | 'tree' | 'blob' | 'tag';
  data: Buffer;
}

export interface IssueComment {
  id: number;
  body: string;
  user: string;
  createdAt: string;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: IssueComment[];
  user: string;
  createdSeq: number;
  createdAt: string;
  updatedAt: string;
}

export interface Pull {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  headRef: string;
  headSha: string;
  baseRef: string;
  baseSha: string;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  user: string;
  createdSeq: number;
  createdAt: string;
  updatedAt: string;
}

export interface Label {
  name: string;
  color: string;
}

export interface Repo {
  id: number;
  name: string;
  owner: string;
  private: boolean;
  description: string;
  defaultBranch: string;
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  issues: Issue[];
  pulls: Pull[];
  labels: Map<string, Label>;
  nextNumber: number;
  nextCommentId: number;
  createdSeq: number;
  createdAt: string;
  updatedAt: string;
}

/** The scenario's viewer login (wire.ts buildScenario): the login a token names before any repo is claimed. */
export const VIEWER_LOGIN = 'adaiversen';
export const VIEWER_EMAIL = 'adaiversen@example.invalid';
export const STRANGER_LOGIN = 'olgabauer';

const TRIAL_NOW_RAW = (process.env.MAKEFUN_TRIAL_NOW ?? '').trim();
const TRIAL_EPOCH_MS = Number.isNaN(Date.parse(TRIAL_NOW_RAW)) ? Date.now() : Date.parse(TRIAL_NOW_RAW);

let seq = 0;
let repoIdSeq = 0;
let issueIdSeq = 0;
let pullIdSeq = 0;
let requestSeq = 0;

/** One strictly increasing timestamp per created object, rooted at the trial's frozen clock. */
export function nextTimestamp(): { iso: string; epochSec: number; seq: number } {
  seq += 1;
  const ms = TRIAL_EPOCH_MS + seq * 1000;
  return { iso: new Date(ms).toISOString(), epochSec: Math.floor(ms / 1000), seq };
}

export function nextRepoId(): number {
  repoIdSeq += 1;
  return repoIdSeq;
}

export function nextIssueId(): number {
  issueIdSeq += 1;
  return issueIdSeq;
}

export function nextPullId(): number {
  pullIdSeq += 1;
  return pullIdSeq;
}

export function nextRequestId(): string {
  requestSeq += 1;
  return `req_${requestSeq.toString(16).padStart(8, '0')}`;
}

/** The one token identity the trial uses: the first owner-bearing request claims the viewer login. */
let claimedOwner: string | null = null;

export function viewerLogin(): string {
  return claimedOwner ?? VIEWER_LOGIN;
}

/** Record that this token's owner is `login` (the first claim wins; every trial token names the viewer). */
export function claimOwner(login: string): string {
  if (claimedOwner === null) claimedOwner = login;
  return claimedOwner;
}

const reposByName = new Map<string, Repo>();

export function createRepo(name: string, owner: string, opts: { description?: string; private?: boolean }): Repo | null {
  if (reposByName.has(name)) return null;
  const stamp = nextTimestamp();
  const repo: Repo = {
    id: nextRepoId(),
    name,
    owner,
    private: opts.private ?? false,
    description: opts.description ?? '',
    defaultBranch: 'main',
    objects: new Map(),
    refs: new Map(),
    issues: [],
    pulls: [],
    labels: new Map(),
    nextNumber: 1,
    nextCommentId: 1,
    createdSeq: stamp.seq,
    createdAt: stamp.iso,
    updatedAt: stamp.iso,
  };
  reposByName.set(name, repo);
  return repo;
}

/** A repository by name, only when the path's owner is its owner (another owner is a 404). */
export function getRepo(owner: string, name: string): Repo | null {
  const repo = reposByName.get(name);
  if (repo === undefined || repo.owner !== owner) return null;
  return repo;
}

export function getRepoByName(name: string): Repo | null {
  return reposByName.get(name) ?? null;
}

export function deleteRepo(name: string): boolean {
  return reposByName.delete(name);
}

/** Every repository in creation order (the user/repos pagination walks this list). */
export function listRepos(): Repo[] {
  return [...reposByName.values()];
}

/** Opaque, stable GraphQL global ids: base64url of a typed key, never the plain database id. */
export function globalId(kind: string, key: string): string {
  return Buffer.from(`${kind}:${key}`, 'utf8').toString('base64url');
}

export function parseGlobalId(id: string): { kind: string; key: string } | null {
  try {
    const text = Buffer.from(id, 'base64url').toString('utf8');
    const colon = text.indexOf(':');
    if (colon < 1) return null;
    return { kind: text.slice(0, colon), key: text.slice(colon + 1) };
  } catch {
    return null;
  }
}

export function repoGlobalId(repo: Repo): string {
  return globalId('repo', String(repo.id));
}

export function issueGlobalId(repo: Repo, issue: Issue): string {
  return globalId('issue', `${repo.id}:${issue.number}`);
}

export function pullGlobalId(repo: Repo, pull: Pull): string {
  return globalId('pr', `${repo.id}:${pull.number}`);
}

export function commentGlobalId(repo: Repo, issue: Issue, comment: IssueComment): string {
  return globalId('comment', `${repo.id}:${issue.number}:${comment.id}`);
}

/** Find a repository by its GraphQL global id. */
export function repoByGlobalId(id: string): Repo | null {
  const parsed = parseGlobalId(id);
  if (parsed === null || parsed.kind !== 'repo') return null;
  const num = Number(parsed.key);
  if (!Number.isSafeInteger(num)) return null;
  for (const repo of reposByName.values()) if (repo.id === num) return repo;
  return null;
}

/** Find an issue by its GraphQL global id. */
export function issueByGlobalId(id: string): { repo: Repo; issue: Issue } | null {
  const parsed = parseGlobalId(id);
  if (parsed === null || parsed.kind !== 'issue') return null;
  const [repoId, number] = parsed.key.split(':').map(Number);
  if (!Number.isSafeInteger(repoId) || !Number.isSafeInteger(number)) return null;
  for (const repo of reposByName.values()) {
    if (repo.id !== repoId) continue;
    const issue = repo.issues.find((entry) => entry.number === number);
    return issue === undefined ? null : { repo, issue };
  }
  return null;
}

/** Find a pull request by its GraphQL global id. */
export function pullByGlobalId(id: string): { repo: Repo; pull: Pull } | null {
  const parsed = parseGlobalId(id);
  if (parsed === null || parsed.kind !== 'pr') return null;
  const [repoId, number] = parsed.key.split(':').map(Number);
  if (!Number.isSafeInteger(repoId) || !Number.isSafeInteger(number)) return null;
  for (const repo of reposByName.values()) {
    if (repo.id !== repoId) continue;
    const pull = repo.pulls.find((entry) => entry.number === number);
    return pull === undefined ? null : { repo, pull };
  }
  return null;
}
