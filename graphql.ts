// The GraphQL v4 surface: a small parser and executor for exactly the documents the suite
// sends (the eighteen fixed documents in program/env/src/checks-graphql.ts). No fragments beyond
// `... on Repository`, no directives, no subscriptions. Unknown fields answer HTTP 200 with an
// errors array naming the field; an unknown repository reads data.repository = null with no
// errors; a JSON array body is a batch answered in order.

import {
  commentGlobalId,
  getRepo,
  issueByGlobalId,
  issueGlobalId,
  listRepos,
  nextTimestamp,
  parseGlobalId,
  pullByGlobalId,
  pullGlobalId,
  repoByGlobalId,
  repoGlobalId,
  viewerLogin,
  type Issue,
  type Pull,
  type Repo,
} from './store.ts';
import { createIssueInRepo, createPullInRepo, mergePullRequest, pullMergeable } from './rest.ts';
import { diffTrees, parseCommit } from './git.ts';

// ---------------------------------------------------------------- parsing

type ValueNode =
  | { kind: 'var'; name: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: Array<{ name: string; value: ValueNode }> };

interface FieldNode {
  kind: 'field';
  alias: string | null;
  name: string;
  args: Array<{ name: string; value: ValueNode }>;
  selections: SelectionNode[] | null;
}

interface InlineFragmentNode {
  kind: 'inlineFragment';
  typeCondition: string | null;
  selections: SelectionNode[];
}

type SelectionNode = FieldNode | InlineFragmentNode;

interface OperationNode {
  type: 'query' | 'mutation';
  name: string | null;
  selections: SelectionNode[];
}

interface Token {
  kind: 'name' | 'int' | 'float' | 'string' | 'punct';
  value: string;
}

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i]!;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') { i += 1; continue; }
    if (ch === '#') { while (i < src.length && src[i] !== '\n') i += 1; continue; }
    if (ch === '{' || ch === '}' || ch === '(' || ch === ')' || ch === '[' || ch === ']' || ch === ':' || ch === '$' || ch === '!' || ch === '=') {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (src.startsWith('...', i)) {
      tokens.push({ kind: 'punct', value: '...' });
      i += 3;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let out = '';
      while (j < src.length && src[j] !== '"') {
        if (src[j] === '\\' && j + 1 < src.length) {
          const esc = src[j + 1]!;
          out += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc;
          j += 2;
        } else {
          out += src[j];
          j += 1;
        }
      }
      tokens.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let j = i;
      while (j < src.length && /[0-9.eE+-]/.test(src[j]!)) j += 1;
      const text = src.slice(i, j);
      tokens.push({ kind: text.includes('.') || text.includes('e') || text.includes('E') ? 'float' : 'int', value: text });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j]!)) j += 1;
      tokens.push({ kind: 'name', value: src.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)} in GraphQL document`);
  }
  return tokens;
}

class Parser {
  private pos = 0;
  private readonly tokens: Token[];

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private next(): Token {
    const token = this.tokens[this.pos];
    if (token === undefined) throw new Error('unexpected end of GraphQL document');
    this.pos += 1;
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) throw new Error(`expected ${value} in GraphQL document`);
  }

  private expectName(value?: string): string {
    const token = this.next();
    if (token.kind !== 'name') throw new Error('expected a name in GraphQL document');
    if (value !== undefined && token.value !== value) throw new Error(`expected ${value} in GraphQL document`);
    return token.value;
  }

  parseDocument(): OperationNode[] {
    const operations: OperationNode[] = [];
    while (this.peek() !== undefined) {
      const token = this.peek()!;
      if (token.kind === 'punct' && token.value === '{') {
        operations.push({ type: 'query', name: null, selections: this.parseSelections() });
        continue;
      }
      if (token.kind === 'name' && (token.value === 'query' || token.value === 'mutation')) {
        const type = this.next().value as 'query' | 'mutation';
        let name: string | null = null;
        if (this.peek()?.kind === 'name') name = this.next().value;
        if (this.peek()?.kind === 'punct' && this.peek()!.value === '(') this.skipVariableDefinitions();
        operations.push({ type, name, selections: this.parseSelections() });
        continue;
      }
      if (token.kind === 'name' && token.value === 'fragment') throw new Error('named fragments are not supported');
      throw new Error(`unexpected token ${token.value} in GraphQL document`);
    }
    return operations;
  }

  private skipVariableDefinitions(): void {
    this.expectPunct('(');
    let depth = 1;
    while (depth > 0) {
      const token = this.next();
      if (token.kind === 'punct' && token.value === '(') depth += 1;
      else if (token.kind === 'punct' && token.value === ')') depth -= 1;
    }
  }

  private parseSelections(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (!(this.peek()?.kind === 'punct' && this.peek()!.value === '}')) {
      selections.push(this.parseSelection());
    }
    this.expectPunct('}');
    return selections;
  }

  private parseSelection(): SelectionNode {
    const token = this.peek()!;
    if (token.kind === 'punct' && token.value === '...') {
      this.next();
      let typeCondition: string | null = null;
      if (this.peek()?.kind === 'name' && this.peek()!.value === 'on') {
        this.next();
        typeCondition = this.expectName();
      }
      return { kind: 'inlineFragment', typeCondition, selections: this.parseSelections() };
    }
    let alias: string | null = null;
    let name = this.expectName();
    if (this.peek()?.kind === 'punct' && this.peek()!.value === ':') {
      this.next();
      alias = name;
      name = this.expectName();
    }
    const args: Array<{ name: string; value: ValueNode }> = [];
    if (this.peek()?.kind === 'punct' && this.peek()!.value === '(') {
      this.next();
      while (!(this.peek()?.kind === 'punct' && this.peek()!.value === ')')) {
        const argName = this.expectName();
        this.expectPunct(':');
        args.push({ name: argName, value: this.parseValue() });
      }
      this.expectPunct(')');
    }
    let selections: SelectionNode[] | null = null;
    if (this.peek()?.kind === 'punct' && this.peek()!.value === '{') selections = this.parseSelections();
    return { kind: 'field', alias, name, args, selections };
  }

  private parseValue(): ValueNode {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') return { kind: 'var', name: this.expectName() };
    if (token.kind === 'punct' && token.value === '[') {
      const values: ValueNode[] = [];
      while (!(this.peek()?.kind === 'punct' && this.peek()!.value === ']')) values.push(this.parseValue());
      this.expectPunct(']');
      return { kind: 'list', values };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: Array<{ name: string; value: ValueNode }> = [];
      while (!(this.peek()?.kind === 'punct' && this.peek()!.value === '}')) {
        const name = this.expectName();
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue() });
      }
      this.expectPunct('}');
      return { kind: 'object', fields };
    }
    if (token.kind === 'int') return { kind: 'int', value: Number(token.value) };
    if (token.kind === 'float') return { kind: 'float', value: Number(token.value) };
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    throw new Error(`unexpected value token ${token.value}`);
  }
}

// ---------------------------------------------------------------- execution

interface Resolved {
  /** The GraphQL type name for objects, or null for scalars. */
  type: string | null;
  data: unknown;
}

interface Ctx {
  viewer: string;
  errors: Array<{ message: string }>;
}

function resolveValue(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'var': return variables[node.name] ?? null;
    case 'int':
    case 'float':
    case 'string':
    case 'boolean':
    case 'enum': return node.value;
    case 'null': return null;
    case 'list': return node.values.map((entry) => resolveValue(entry, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of node.fields) out[field.name] = resolveValue(field.value, variables);
      return out;
    }
  }
}

function argsOf(field: FieldNode, variables: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const arg of field.args) out[arg.name] = resolveValue(arg.value, variables);
  return out;
}

const ISSUE_TYPE_FIELDS = ['id', 'number', 'title', 'state', 'body'];
const PULL_REQUEST_TYPE_FIELDS = ['id', 'number', 'headRefName', 'baseRefName', 'mergeable', 'state', 'merged', 'files'];
const REPOSITORY_TYPE_FIELDS = ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest'];
const SEARCH_TYPE_VALUES = ['ISSUE', 'REPOSITORY', 'USER', 'COMMIT', 'DISCUSSION', 'CODE'];

function cursorOf(index: number): string {
  return Buffer.from(`cursor:${index}`, 'utf8').toString('base64url');
}

function indexOfCursor(cursor: string | null | undefined): number {
  if (typeof cursor !== 'string' || cursor === '') return -1;
  try {
    const text = Buffer.from(cursor, 'base64url').toString('utf8');
    if (!text.startsWith('cursor:')) return -1;
    const n = Number(text.slice('cursor:'.length));
    return Number.isSafeInteger(n) ? n : -1;
  } catch {
    return -1;
  }
}

function issueState(issue: Issue): string {
  return issue.state === 'open' ? 'OPEN' : 'CLOSED';
}

function pullState(pull: Pull): string {
  return pull.state === 'open' ? 'OPEN' : 'CLOSED';
}

function sortedIssues(repo: Repo, states: string[] | null, direction: string): Issue[] {
  let list = [...repo.issues];
  if (states !== null) {
    const wanted = new Set(states.map((state) => state.toLowerCase()));
    list = list.filter((issue) => wanted.has(issue.state));
  }
  list.sort((a, b) => (direction === 'ASC' ? a.createdSeq - b.createdSeq : b.createdSeq - a.createdSeq));
  return list;
}

function resolveField(ctx: Ctx, parentType: string, parent: unknown, field: FieldNode, variables: Record<string, unknown>): Resolved | null {
  const args = argsOf(field, variables);
  const fail = (message: string): null => {
    ctx.errors.push({ message });
    return null;
  };
  switch (parentType) {
    case 'Query': {
      if (field.name === 'viewer') return { type: 'User', data: { login: ctx.viewer } };
      if (field.name === 'repository') {
        const repo = getRepo(String(args.owner ?? ''), String(args.name ?? ''));
        return { type: 'Repository', data: repo };
      }
      if (field.name === 'node') {
        const parsed = parseGlobalId(String(args.id ?? ''));
        if (parsed !== null && parsed.kind === 'repo') {
          const repo = repoByGlobalId(String(args.id ?? ''));
          return { type: 'Repository', data: repo };
        }
        return { type: 'Repository', data: null };
      }
      if (field.name === '__type') {
        const name = String(args.name ?? '');
        if (name === 'Issue') return { type: '__Type', data: { kind: 'OBJECT', fields: ISSUE_TYPE_FIELDS, enumValues: null } };
        if (name === 'PullRequest') return { type: '__Type', data: { kind: 'OBJECT', fields: PULL_REQUEST_TYPE_FIELDS, enumValues: null } };
        if (name === 'Repository') return { type: '__Type', data: { kind: 'OBJECT', fields: REPOSITORY_TYPE_FIELDS, enumValues: null } };
        if (name === 'SearchType') return { type: '__Type', data: { kind: 'ENUM', fields: null, enumValues: SEARCH_TYPE_VALUES } };
        return { type: '__Type', data: null };
      }
      return fail(`Cannot query field "${field.name}" on type "Query".`);
    }
    case 'User': {
      if (field.name === 'login') return { type: null, data: (parent as { login: string }).login };
      return fail(`Cannot query field "${field.name}" on type "User".`);
    }
    case 'Repository': {
      const repo = parent as Repo;
      switch (field.name) {
        case 'id': return { type: null, data: repoGlobalId(repo) };
        case 'databaseId': return { type: null, data: repo.id };
        case 'name': return { type: null, data: repo.name };
        case 'nameWithOwner': return { type: null, data: `${repo.owner}/${repo.name}` };
        case 'owner': return { type: 'User', data: { login: repo.owner } };
        case 'defaultBranchRef': {
          const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
          return { type: 'Ref', data: tip === undefined ? null : { name: repo.defaultBranch } };
        }
        case 'viewerPermission': return { type: null, data: 'ADMIN' };
        case 'hasIssuesEnabled': return { type: null, data: true };
        case 'issue': {
          const issue = repo.issues.find((entry) => entry.number === Number(args.number));
          return { type: 'Issue', data: issue ?? null };
        }
        case 'issues': {
          const states = Array.isArray(args.states) ? (args.states as string[]) : null;
          const orderBy = (args.orderBy ?? {}) as Record<string, unknown>;
          const direction = String(orderBy.direction ?? 'DESC');
          const all = sortedIssues(repo, states, direction);
          const after = indexOfCursor(args.after as string | null | undefined);
          const first = typeof args.first === 'number' ? args.first : all.length;
          const start = after + 1;
          const page = all.slice(start, start + first);
          const endCursor = page.length > 0 ? cursorOf(start + page.length - 1) : null;
          return {
            type: 'IssueConnection',
            data: { nodes: page, pageInfo: { hasNextPage: start + page.length < all.length, endCursor } },
          };
        }
        case 'pullRequests': {
          const first = typeof args.first === 'number' ? args.first : repo.pulls.length;
          const list = [...repo.pulls].sort((a, b) => b.createdSeq - a.createdSeq).slice(0, first);
          return { type: 'PullRequestConnection', data: { nodes: list } };
        }
        case 'pullRequest': {
          const pull = repo.pulls.find((entry) => entry.number === Number(args.number));
          return { type: 'PullRequest', data: pull ?? null };
        }
        default: return fail(`Cannot query field "${field.name}" on type "Repository".`);
      }
    }
    case 'Ref': {
      if (field.name === 'name') return { type: null, data: (parent as { name: string }).name };
      return fail(`Cannot query field "${field.name}" on type "Ref".`);
    }
    case 'Issue': {
      const issue = parent as Issue;
      switch (field.name) {
        case 'id': {
          const repo = findIssueRepo(issue);
          return { type: null, data: repo !== undefined ? issueGlobalId(repo, issue) : '' };
        }
        case 'number': return { type: null, data: issue.number };
        case 'title': return { type: null, data: issue.title };
        case 'body': return { type: null, data: issue.body };
        case 'state': return { type: null, data: issueState(issue) };
        default: return fail(`Cannot query field "${field.name}" on type "Issue".`);
      }
    }
    case 'IssueConnection': {
      const conn = parent as { nodes: Issue[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } };
      if (field.name === 'nodes') return { type: 'IssueList', data: conn.nodes };
      if (field.name === 'pageInfo') return { type: 'PageInfo', data: conn.pageInfo };
      return fail(`Cannot query field "${field.name}" on type "IssueConnection".`);
    }
    case 'IssueList': {
      return fail(`Cannot query field "${field.name}" on type "IssueList".`);
    }
    case 'PageInfo': {
      const info = parent as { hasNextPage: boolean; endCursor: string | null };
      if (field.name === 'hasNextPage') return { type: null, data: info.hasNextPage };
      if (field.name === 'endCursor') return { type: null, data: info.endCursor };
      return fail(`Cannot query field "${field.name}" on type "PageInfo".`);
    }
    case 'PullRequest': {
      const pull = parent as Pull;
      switch (field.name) {
        case 'id': {
          const repo = findPullRepo(pull);
          return { type: null, data: repo !== undefined ? pullGlobalId(repo, pull) : '' };
        }
        case 'number': return { type: null, data: pull.number };
        case 'headRefName': return { type: null, data: pull.headRef };
        case 'baseRefName': return { type: null, data: pull.baseRef };
        case 'mergeable': {
          const repo = findPullRepo(pull);
          return { type: null, data: repo === undefined ? 'UNKNOWN' : pullMergeable(repo, pull) ? 'MERGEABLE' : 'CONFLICTING' };
        }
        case 'state': return { type: null, data: pullState(pull) };
        case 'merged': return { type: null, data: pull.merged };
        case 'files': {
          const repo = findPullRepo(pull);
          if (repo === undefined) return { type: 'ChangedFileConnection', data: { nodes: [] } };
          const headTree = parseCommit(repo.objects.get(pull.headSha)?.data ?? Buffer.alloc(0)).tree;
          const baseTree = parseCommit(repo.objects.get(pull.baseSha)?.data ?? Buffer.alloc(0)).tree;
          const first = typeof args.first === 'number' ? args.first : 100;
          const nodes = diffTrees(repo, baseTree, headTree).slice(0, first).map((diff) => ({ path: diff.path }));
          return { type: 'ChangedFileConnection', data: { nodes } };
        }
        default: return fail(`Cannot query field "${field.name}" on type "PullRequest".`);
      }
    }
    case 'PullRequestConnection': {
      if (field.name === 'nodes') return { type: 'PullRequestList', data: (parent as { nodes: Pull[] }).nodes };
      return fail(`Cannot query field "${field.name}" on type "PullRequestConnection".`);
    }
    case 'ChangedFileConnection': {
      if (field.name === 'nodes') return { type: 'ChangedFileList', data: (parent as { nodes: Array<{ path: string }> }).nodes };
      return fail(`Cannot query field "${field.name}" on type "ChangedFileConnection".`);
    }
    case 'ChangedFile': {
      if (field.name === 'path') return { type: null, data: (parent as { path: string }).path };
      return fail(`Cannot query field "${field.name}" on type "ChangedFile".`);
    }
    case '__Type': {
      const info = parent as { kind: string; fields: string[] | null; enumValues: string[] | null };
      if (field.name === 'fields') return { type: 'TypeFieldList', data: (info.fields ?? []).map((name) => ({ name })) };
      if (field.name === 'enumValues') return { type: 'TypeFieldList', data: (info.enumValues ?? []).map((name) => ({ name })) };
      if (field.name === 'name') return { type: null, data: '' };
      return fail(`Cannot query field "${field.name}" on type "__Type".`);
    }
    case 'TypeFieldList': {
      return fail(`Cannot query field "${field.name}" on type "TypeFieldList".`);
    }
    case '__TypeField': {
      if (field.name === 'name') return { type: null, data: (parent as { name: string }).name };
      return fail(`Cannot query field "${field.name}" on type "__TypeField".`);
    }
    case 'Mutation': {
      switch (field.name) {
        case 'createIssue': {
          const input = (args.input ?? {}) as Record<string, unknown>;
          const repo = repoByGlobalId(String(input.repositoryId ?? ''));
          if (repo === null) return fail('createIssue: unknown repositoryId');
          const created = createIssueInRepo(repo, ctx.viewer, String(input.title ?? ''), String(input.body ?? ''), []);
          if ('error' in created) return fail(`createIssue: ${created.error}`);
          return { type: 'CreateIssuePayload', data: { issue: created } };
        }
        case 'closeIssue': {
          const input = (args.input ?? {}) as Record<string, unknown>;
          const found = issueByGlobalId(String(input.issueId ?? ''));
          if (found === null) return fail('closeIssue: unknown issueId');
          found.issue.state = 'closed';
          found.issue.updatedAt = nextTimestamp().iso;
          return { type: 'CloseIssuePayload', data: { issue: found.issue } };
        }
        case 'createPullRequest': {
          const input = (args.input ?? {}) as Record<string, unknown>;
          const repo = repoByGlobalId(String(input.repositoryId ?? ''));
          if (repo === null) return fail('createPullRequest: unknown repositoryId');
          const created = createPullInRepo(repo, ctx.viewer, String(input.title ?? ''), String(input.body ?? ''), String(input.headRefName ?? ''), String(input.baseRefName ?? ''));
          if ('error' in created) return fail(`createPullRequest: ${created.error}`);
          return { type: 'CreatePullRequestPayload', data: { pullRequest: created } };
        }
        case 'mergePullRequest': {
          const input = (args.input ?? {}) as Record<string, unknown>;
          const found = pullByGlobalId(String(input.pullRequestId ?? ''));
          if (found === null) return fail('mergePullRequest: unknown pullRequestId');
          const merged = mergePullRequest(found.repo, found.pull);
          if (!merged.ok) return fail(`mergePullRequest: ${merged.message}`);
          return { type: 'MergePullRequestPayload', data: { pullRequest: found.pull } };
        }
        case 'addComment': {
          const input = (args.input ?? {}) as Record<string, unknown>;
          const found = issueByGlobalId(String(input.subjectId ?? ''));
          if (found === null) return fail('addComment: unknown subjectId');
          const stamp = nextTimestamp();
          const comment = { id: found.repo.nextCommentId, body: String(input.body ?? ''), user: ctx.viewer, createdAt: stamp.iso };
          found.repo.nextCommentId += 1;
          found.issue.comments.push(comment);
          return { type: 'AddCommentPayload', data: { commentEdge: { node: { id: commentGlobalId(found.repo, found.issue, comment), body: comment.body } } } };
        }
        default: return fail(`Cannot query field "${field.name}" on type "Mutation".`);
      }
    }
    case 'CreateIssuePayload':
    case 'CloseIssuePayload': {
      if (field.name === 'issue') return { type: 'Issue', data: (parent as { issue: Issue }).issue };
      return fail(`Cannot query field "${field.name}" on type "${parentType}".`);
    }
    case 'CreatePullRequestPayload':
    case 'MergePullRequestPayload': {
      if (field.name === 'pullRequest') return { type: 'PullRequest', data: (parent as { pullRequest: Pull }).pullRequest };
      return fail(`Cannot query field "${field.name}" on type "${parentType}".`);
    }
    case 'AddCommentPayload': {
      if (field.name === 'commentEdge') return { type: 'CommentEdge', data: (parent as { commentEdge: unknown }).commentEdge };
      return fail(`Cannot query field "${field.name}" on type "AddCommentPayload".`);
    }
    case 'CommentEdge': {
      if (field.name === 'node') return { type: 'Comment', data: (parent as { node: unknown }).node };
      return fail(`Cannot query field "${field.name}" on type "CommentEdge".`);
    }
    case 'Comment': {
      const comment = parent as { id: string; body: string };
      if (field.name === 'id') return { type: null, data: comment.id };
      if (field.name === 'body') return { type: null, data: comment.body };
      return fail(`Cannot query field "${field.name}" on type "Comment".`);
    }
    default:
      return fail(`Cannot query field "${field.name}" on type "${parentType}".`);
  }
}

// The Issue/PullRequest resolvers need their repository for global ids; the store is searched by
// object identity (the trial holds few repositories, so a scan is cheap and exact).
function findIssueRepo(issue: Issue): Repo | undefined {
  for (const repo of listRepos()) if (repo.issues.includes(issue)) return repo;
  return undefined;
}

function findPullRepo(pull: Pull): Repo | undefined {
  for (const repo of listRepos()) if (repo.pulls.includes(pull)) return repo;
  return undefined;
}

function executeSelections(
  ctx: Ctx,
  parentType: string,
  parent: unknown,
  selections: SelectionNode[],
  variables: Record<string, unknown>,
): Record<string, unknown> | null {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'inlineFragment') {
      if (selection.typeCondition !== null && selection.typeCondition !== parentType) continue;
      const fragment = executeSelections(ctx, parentType, parent, selection.selections, variables);
      if (fragment === null) return null;
      Object.assign(out, fragment);
      continue;
    }
    const responseKey = selection.alias ?? selection.name;
    const resolved = resolveField(ctx, parentType, parent, selection, variables);
    if (resolved === null) return null;
    if (resolved.data === null || resolved.type === null) {
      out[responseKey] = resolved.data;
      continue;
    }
    if (selection.selections === null) {
      out[responseKey] = resolved.data;
      continue;
    }
    if (resolved.type === 'IssueList' || resolved.type === 'PullRequestList' || resolved.type === 'ChangedFileList' || resolved.type === 'TypeFieldList') {
      const itemType = resolved.type === 'IssueList' ? 'Issue' : resolved.type === 'PullRequestList' ? 'PullRequest' : resolved.type === 'ChangedFileList' ? 'ChangedFile' : '__TypeField';
      const items = resolved.data as unknown[];
      const list: unknown[] = [];
      for (const item of items) {
        const row = executeSelections(ctx, itemType, item, selection.selections, variables);
        if (row === null) return null;
        list.push(row);
      }
      out[responseKey] = list;
      continue;
    }
    const nested = executeSelections(ctx, resolved.type, resolved.data, selection.selections, variables);
    if (nested === null) return null;
    out[responseKey] = nested;
  }
  return out;
}

function executeOperation(operation: OperationNode, variables: Record<string, unknown>, viewer: string): Record<string, unknown> {
  const ctx: Ctx = { viewer, errors: [] };
  const rootType = operation.type === 'mutation' ? 'Mutation' : 'Query';
  const data = executeSelections(ctx, rootType, null, operation.selections, variables);
  if (ctx.errors.length > 0) return { data: data ?? null, errors: ctx.errors };
  return { data };
}

/**
 * Handle one GraphQL request body (a single operation object or an array of them for batching).
 * Returns the HTTP status and JSON body. `authed` is false when no bearer token was presented.
 */
export function handleGraphQL(bodyText: string | null, authed: boolean): { status: number; body: unknown } {
  if (!authed) return { status: 401, body: { message: 'Requires authentication' } };
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText ?? '');
  } catch {
    return { status: 400, body: { errors: [{ message: 'malformed JSON body' }] } };
  }
  const viewer = viewerLogin();
  const runOne = (entry: unknown): Record<string, unknown> => {
    if (typeof entry !== 'object' || entry === null) return { errors: [{ message: 'request must be an object' }] };
    const record = entry as Record<string, unknown>;
    const query = typeof record.query === 'string' ? record.query : '';
    const variables = (record.variables ?? {}) as Record<string, unknown>;
    if (query === '') return { errors: [{ message: 'query is required' }] };
    let operations: OperationNode[];
    try {
      operations = new Parser(tokenize(query)).parseDocument();
    } catch (err) {
      return { errors: [{ message: err instanceof Error ? err.message : 'failed to parse query' }] };
    }
    const operation = operations[0];
    if (operation === undefined) return { errors: [{ message: 'no operation in query' }] };
    return executeOperation(operation, variables, viewer);
  };
  if (Array.isArray(parsed)) return { status: 200, body: parsed.map(runOne) };
  return { status: 200, body: runOne(parsed) };
}
