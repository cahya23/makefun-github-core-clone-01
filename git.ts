// The git layer: pkt-lines, packfiles (plain objects only on write; deltas resolved defensively
// on read), commit/tree parsing, and the smart-HTTP surface — protocol v2 ls-refs and fetch, v0
// advertisements for both services, and receive-pack v0 with fast-forward enforcement.
//
// Wire facts the implementation is built against (kit program/env/src/git-client.ts):
//   - v2 advertisement: "# service=git-upload-pack", flush, "version 2", capability lines; the
//     client requires fetch (value includes "shallow"), ls-refs (value includes "unborn") and
//     object-format=sha1. v2 ls-refs answers "<oid> <ref> [symref-target:<t>] [peeled:<oid>]" lines,
//     "unborn HEAD ..." for an empty repository, ref-prefix filtered server-side.
//   - v2 fetch answers sections acknowledgments (NAK), shallow-info, packfile; the packfile section
//     must carry >= 1 sideband packet even for an empty (0-object) pack. Shallow/deepen: BFS from
//     the wants, depth-limited when deepen is set; commits at the depth limit become new shallow
//     boundaries; haves and request shallow boundaries (and their ancestors) are never re-sent.
//   - v0 advertisements carry capabilities after NUL on the first ref line; peeled tags ride as
//     "<oid> <ref>^{}" lines; HEAD's symref rides as symref=HEAD:<target> in the capability list.
//   - receive-pack: commands, flush, pack; the answer is report-status pkt-lines inside sideband
//     band 1 ("unpack ok", "ok <ref>" / "ng <ref> <reason>"), then flush. A non-fast-forward push
//     still unpacks (objects land) but the ref does not move; a mixed push applies the FF ref only.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import type { GitObject, Repo } from './store.ts';

export const ZERO_OID = '0000000000000000000000000000000000000000';
const AGENT = 'forge/1.0';

/** SHA-1 of a git object: "<type> <len>\0" + raw bytes. */
export function hashObject(type: string, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return createHash('sha1').update(header).update(data).digest('hex');
}

export function storeObject(repo: Repo, type: GitObject['type'], data: Buffer): string {
  const oid = hashObject(type, data);
  if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
  return oid;
}

// ---------------------------------------------------------------- pkt-lines

export function pktLine(text: string): Buffer {
  const payload = Buffer.from(text, 'utf8');
  const len = payload.length + 4;
  const head = Buffer.alloc(4);
  head.write(len.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([head, payload]);
}

export function pktLineBuf(payload: Buffer): Buffer {
  const len = payload.length + 4;
  const head = Buffer.alloc(4);
  head.write(len.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([head, payload]);
}

export const FLUSH_PKT = Buffer.from('0000', 'ascii');
export const DELIM_PKT = Buffer.from('0001', 'ascii');

export interface Pkt {
  kind: 'data' | 'flush' | 'delim';
  payload: Buffer;
}

/** Decode pkt-lines from the start of a buffer; `rest` is everything after the first flush packet. */
export function decodePktLines(buf: Buffer): { packets: Pkt[]; rest: Buffer } {
  const packets: Pkt[] = [];
  let off = 0;
  while (off + 4 <= buf.length) {
    const lenHex = buf.subarray(off, off + 4).toString('ascii');
    if (lenHex === '0000') {
      packets.push({ kind: 'flush', payload: Buffer.alloc(0) });
      off += 4;
      break;
    }
    if (lenHex === '0001') {
      packets.push({ kind: 'delim', payload: Buffer.alloc(0) });
      off += 4;
      continue;
    }
    const len = parseInt(lenHex, 16);
    if (!Number.isFinite(len) || len < 4 || off + len > buf.length) break;
    packets.push({ kind: 'data', payload: buf.subarray(off + 4, off + len) });
    off += len;
  }
  return { packets, rest: buf.subarray(off) };
}

/** The text lines (without trailing \n) of the data packets, in order. */
export function pktTextLines(packets: Pkt[]): string[] {
  const lines: string[] = [];
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    lines.push(packet.payload.toString('utf8').replace(/\n$/, ''));
  }
  return lines;
}

// ---------------------------------------------------------------- packfiles

const OBJ_COMMIT = 1;
const OBJ_TREE = 2;
const OBJ_BLOB = 3;
const OBJ_TAG = 4;
const OBJ_OFS_DELTA = 6;
const OBJ_REF_DELTA = 7;

const TYPE_BY_CODE: Record<number, GitObject['type']> = {
  [OBJ_COMMIT]: 'commit',
  [OBJ_TREE]: 'tree',
  [OBJ_BLOB]: 'blob',
  [OBJ_TAG]: 'tag',
};

const CODE_BY_TYPE: Record<string, number> = { commit: OBJ_COMMIT, tree: OBJ_TREE, blob: OBJ_BLOB, tag: OBJ_TAG };

/** Write a packfile of plain (undeltified) objects, in the order given. */
export function writePack(objects: Array<{ type: GitObject['type']; data: Buffer }>): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const obj of objects) {
    const code = CODE_BY_TYPE[obj.type] ?? OBJ_BLOB;
    let remaining = obj.data.length;
    const head: number[] = [];
    let first = (remaining & 0x0f) | (code << 4);
    remaining >>= 4;
    if (remaining > 0) first |= 0x80;
    head.push(first);
    while (remaining > 0) {
      let byte = remaining & 0x7f;
      remaining >>= 7;
      if (remaining > 0) byte |= 0x80;
      head.push(byte);
    }
    parts.push(Buffer.from(head));
    parts.push(deflateSync(obj.data, { level: 1 }));
  }
  const pack = Buffer.concat(parts);
  return Buffer.concat([pack, createHash('sha1').update(pack).digest()]);
}

/** Adler-32, the checksum a zlib stream ends with. */
function adler32(buf: Buffer): number {
  let a = 1;
  let b = 0;
  for (let i = 0; i < buf.length; i += 1) {
    a = (a + (buf[i] ?? 0)) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

/**
 * Inflate one zlib stream starting at `off` and return its bytes plus the offset just past the
 * stream. Node's inflateSync ignores trailing bytes, so the stream's end is found by scanning for
 * the Adler-32 of the inflated data (the stream's last four bytes).
 */
function inflateOne(pack: Buffer, off: number): { data: Buffer; end: number } {
  const data = inflateSync(pack.subarray(off));
  const checksum = adler32(data);
  for (let end = off + 6; end <= pack.length; end += 1) {
    if (pack.readUInt32BE(end - 4) === checksum) return { data, end };
  }
  return { data, end: pack.length };
}

/** Apply a git delta stream to a base object, returning the reconstructed bytes. */
function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let off = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[off] ?? 0;
      off += 1;
      value |= (byte & 0x7f) << shift;
      shift += 7;
      if ((byte & 0x80) === 0) break;
    }
    return value;
  };
  readVarint();
  const targetSize = readVarint();
  const out: Buffer[] = [];
  while (off < delta.length) {
    const op = delta[off] ?? 0;
    off += 1;
    if ((op & 0x80) !== 0) {
      let cpOff = 0;
      let cpSize = 0;
      for (let i = 0; i < 4; i += 1) if ((op & (1 << i)) !== 0) { cpOff |= (delta[off] ?? 0) << (8 * i); off += 1; }
      for (let i = 0; i < 3; i += 1) if ((op & (0x10 << i)) !== 0) { cpSize |= (delta[off] ?? 0) << (8 * i); off += 1; }
      if (cpSize === 0) cpSize = 0x10000;
      out.push(base.subarray(cpOff, cpOff + cpSize));
    } else if (op !== 0) {
      out.push(delta.subarray(off, off + op));
      off += op;
    }
  }
  const result = Buffer.concat(out);
  if (result.length !== targetSize) throw new Error('delta application produced the wrong size');
  return result;
}

export interface ReadPackResult {
  objects: Map<string, GitObject>;
}

/**
 * Read a packfile. Deltas resolve against objects in the same pack, the repository, or an optional
 * thin-pack base map (the client's writePack sends no deltas; this is defensive).
 */
export function readPack(pack: Buffer, repo: Repo | null, thinBase?: Map<string, GitObject>): ReadPackResult {
  if (pack.length < 32 || pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('not a packfile');
  const trailer = pack.subarray(pack.length - 20);
  const expect = createHash('sha1').update(pack.subarray(0, pack.length - 20)).digest();
  if (!trailer.equals(expect)) throw new Error('pack trailer checksum mismatch');
  const count = pack.readUInt32BE(8);
  const objects = new Map<string, GitObject>();
  const oidByOffset = new Map<number, string>();
  interface DeltaEntry { type: GitObject['type']; baseOid: string; delta: Buffer }
  const deltas: DeltaEntry[] = [];
  let off = 12;
  for (let i = 0; i < count; i += 1) {
    const start = off;
    let byte = pack[off] ?? 0;
    off += 1;
    const typeCode = (byte >> 4) & 0x07;
    let size = byte & 0x0f;
    let shift = 4;
    while ((byte & 0x80) !== 0) {
      byte = pack[off] ?? 0;
      off += 1;
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    if (typeCode === OBJ_OFS_DELTA) {
      byte = pack[off] ?? 0;
      off += 1;
      let baseOff = byte & 0x7f;
      while ((byte & 0x80) !== 0) {
        byte = pack[off] ?? 0;
        off += 1;
        baseOff = ((baseOff + 1) << 7) | (byte & 0x7f);
      }
      const baseStart = start - baseOff;
      const { data: delta, end } = inflateOne(pack, off);
      off = end;
      const baseOid = oidByOffset.get(baseStart);
      if (baseOid === undefined) throw new Error('ofs-delta base not found in pack');
      deltas.push({ type: 'blob', baseOid, delta });
      continue;
    }
    if (typeCode === OBJ_REF_DELTA) {
      const baseOid = pack.subarray(off, off + 20).toString('hex');
      off += 20;
      const { data: delta, end } = inflateOne(pack, off);
      off = end;
      deltas.push({ type: 'blob', baseOid, delta });
      continue;
    }
    const type = TYPE_BY_CODE[typeCode];
    if (type === undefined) throw new Error(`unknown pack object type ${typeCode}`);
    const { data, end } = inflateOne(pack, off);
    off = end;
    if (data.length !== size) throw new Error('pack object size mismatch');
    const oid = hashObject(type, data);
    objects.set(oid, { type, data });
    oidByOffset.set(start, oid);
  }
  const findBase = (oid: string): GitObject | undefined =>
    objects.get(oid) ?? thinBase?.get(oid) ?? repo?.objects.get(oid);
  for (let round = 0; round < deltas.length + 1 && deltas.length > 0; round += 1) {
    let progressed = false;
    for (let i = deltas.length - 1; i >= 0; i -= 1) {
      const entry = deltas[i]!;
      const base = findBase(entry.baseOid);
      if (base === undefined) continue;
      const data = applyDelta(base.data, entry.delta);
      const oid = hashObject(base.type, data);
      objects.set(oid, { type: base.type, data });
      deltas.splice(i, 1);
      progressed = true;
    }
    if (!progressed) break;
  }
  if (deltas.length > 0) throw new Error('pack delta base missing');
  return { objects };
}

// ---------------------------------------------------------------- commits and trees

export interface CommitInfo {
  tree: string;
  parents: string[];
  message: string;
}

/** Parse a commit object's tree, parents and message (author/committer lines are ignored). */
export function parseCommit(data: Buffer): CommitInfo {
  const text = data.toString('utf8');
  const blank = text.indexOf('\n\n');
  const header = blank < 0 ? text : text.slice(0, blank);
  const message = blank < 0 ? '' : text.slice(blank + 2);
  let tree = '';
  const parents: string[] = [];
  for (const line of header.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
  }
  return { tree, parents, message };
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

/** Parse a tree object's entries. */
export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let off = 0;
  while (off < data.length) {
    const space = data.indexOf(0x20, off);
    if (space < 0) break;
    const nul = data.indexOf(0, space + 1);
    if (nul < 0 || nul + 21 > data.length) break;
    entries.push({
      mode: data.subarray(off, space).toString('ascii'),
      name: data.subarray(space + 1, nul).toString('utf8'),
      oid: data.subarray(nul + 1, nul + 21).toString('hex'),
    });
    off = nul + 21;
  }
  return entries;
}

/** Build a tree object from entries (git sorts directory names as if they ended with '/'). */
export function buildTree(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const ka = a.name + (a.mode === '40000' ? '/' : '');
    const kb = b.name + (b.mode === '40000' ? '/' : '');
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

/** Build a commit object. */
export function buildCommit(opts: { tree: string; parents: string[]; message: string; author: string; committer: string; timestamp: number }): Buffer {
  const lines: string[] = [`tree ${opts.tree}`];
  for (const parent of opts.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${opts.author} ${opts.timestamp} +0000`);
  lines.push(`committer ${opts.committer} ${opts.timestamp} +0000`);
  return Buffer.from(`${lines.join('\n')}\n\n${opts.message}`, 'utf8');
}

/** Flatten a tree (recursively) to path -> {mode, oid}. */
export function flattenTree(repo: Repo, treeOid: string | null): Map<string, { mode: string; oid: string }> {
  const out = new Map<string, { mode: string; oid: string }>();
  if (treeOid === null) return out;
  const walk = (oid: string, prefix: string, depth: number): void => {
    if (depth > 32) return;
    const obj = repo.objects.get(oid);
    if (obj === undefined || obj.type !== 'tree') return;
    for (const entry of parseTree(obj.data)) {
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.mode === '40000') walk(entry.oid, path, depth + 1);
      else out.set(path, { mode: entry.mode, oid: entry.oid });
    }
  };
  walk(treeOid, '', 0);
  return out;
}

/**
 * Apply file changes (path -> new bytes, or null to delete) onto a base tree and store every new
 * blob/tree object; returns the new root tree oid.
 */
export function applyFileChanges(repo: Repo, baseTreeOid: string | null, changes: Map<string, Buffer | null>): string {
  const flat = flattenTree(repo, baseTreeOid);
  for (const [path, content] of changes) {
    if (content === null) flat.delete(path);
    else flat.set(path, { mode: '100644', oid: storeObject(repo, 'blob', content) });
  }
  const buildDir = (prefix: string): string => {
    const entries: TreeEntry[] = [];
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

export interface FileDiff {
  path: string;
  status: 'added' | 'modified' | 'removed';
  additions: number;
  deletions: number;
}

function countLines(data: Buffer): number {
  if (data.length === 0) return 0;
  const text = data.toString('utf8');
  const parts = text.split('\n');
  return text.endsWith('\n') ? parts.length - 1 : parts.length;
}

function lineDiff(oldData: Buffer | null, newData: Buffer | null): { additions: number; deletions: number } {
  const oldLines = oldData === null ? [] : oldData.toString('utf8').split('\n').filter((line) => line !== '');
  const newLines = newData === null ? [] : newData.toString('utf8').split('\n').filter((line) => line !== '');
  const oldCounts = new Map<string, number>();
  for (const line of oldLines) oldCounts.set(line, (oldCounts.get(line) ?? 0) + 1);
  let additions = 0;
  for (const line of newLines) {
    const left = oldCounts.get(line) ?? 0;
    if (left > 0) oldCounts.set(line, left - 1);
    else additions += 1;
  }
  let deletions = 0;
  for (const left of oldCounts.values()) deletions += left;
  return { additions, deletions };
}

/** Diff two trees (by oid, null = empty): added/modified/removed paths with line counts. */
export function diffTrees(repo: Repo, baseTreeOid: string | null, headTreeOid: string | null): FileDiff[] {
  const base = flattenTree(repo, baseTreeOid);
  const head = flattenTree(repo, headTreeOid);
  const out: FileDiff[] = [];
  const paths = new Set([...base.keys(), ...head.keys()]);
  for (const path of paths) {
    const b = base.get(path);
    const h = head.get(path);
    if (b !== undefined && h === undefined) {
      const oldData = repo.objects.get(b.oid)?.data ?? null;
      const counts = lineDiff(oldData, null);
      out.push({ path, status: 'removed', additions: 0, deletions: counts.deletions });
    } else if (b === undefined && h !== undefined) {
      const newData = repo.objects.get(h.oid)?.data ?? null;
      const counts = lineDiff(null, newData);
      out.push({ path, status: 'added', additions: Math.max(1, counts.additions), deletions: 0 });
    } else if (b !== undefined && h !== undefined && b.oid !== h.oid) {
      const oldData = repo.objects.get(b.oid)?.data ?? null;
      const newData = repo.objects.get(h.oid)?.data ?? null;
      const counts = lineDiff(oldData, newData);
      out.push({
        path,
        status: 'modified',
        additions: counts.additions > 0 ? counts.additions : 1,
        deletions: counts.deletions,
      });
    }
  }
  out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return out;
}

/** All commits reachable from `tip` (first-parent walk plus every parent, de-duplicated). */
export function reachableCommits(repo: Repo, tip: string | null): Set<string> {
  const seen = new Set<string>();
  const queue: string[] = tip === null ? [] : [tip];
  while (queue.length > 0) {
    const oid = queue.pop()!;
    if (seen.has(oid)) continue;
    const obj = repo.objects.get(oid);
    if (obj === undefined || obj.type !== 'commit') continue;
    seen.add(oid);
    for (const parent of parseCommit(obj.data).parents) queue.push(parent);
  }
  return seen;
}

/** True when `ancestor` is reachable from `tip` (or equal to it). Walks from the tip and stops
 * the moment the ancestor is found, so a fast-forward check on a linear history costs one step,
 * not a walk of the whole history. */
export function isAncestor(repo: Repo, ancestor: string, tip: string): boolean {
  if (ancestor === tip) return true;
  const seen = new Set<string>();
  const queue: string[] = [tip];
  while (queue.length > 0) {
    const oid = queue.pop()!;
    if (oid === ancestor) return true;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = repo.objects.get(oid);
    if (obj === undefined || obj.type !== 'commit') continue;
    for (const parent of parseCommit(obj.data).parents) queue.push(parent);
  }
  return false;
}

// ---------------------------------------------------------------- advertisements

function refList(repo: Repo): Array<{ oid: string; name: string; peeled?: string }> {
  const out: Array<{ oid: string; name: string; peeled?: string }> = [];
  const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
  out.push({ oid: tip ?? ZERO_OID, name: 'HEAD' });
  const names = [...repo.refs.keys()].sort();
  for (const name of names) {
    const oid = repo.refs.get(name)!;
    out.push({ oid, name });
    const obj = repo.objects.get(oid);
    if (obj !== undefined && obj.type === 'tag') {
      const target = parseTagTarget(obj.data);
      if (target !== null) out.push({ oid: target, name: `${name}^{}` });
    }
  }
  return out;
}

function parseTagTarget(data: Buffer): string | null {
  const text = data.toString('utf8');
  const match = /^object ([0-9a-f]{40})$/m.exec(text);
  return match === null ? null : match[1]!;
}

/** v0 advertisement body for a service (upload-pack or receive-pack). */
export function advertisementV0(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const caps =
    service === 'git-receive-pack'
      ? `report-status side-band-64k delete-refs symref=HEAD:refs/heads/${repo.defaultBranch} agent=${AGENT}`
      : `symref=HEAD:refs/heads/${repo.defaultBranch} side-band-64k thin-pack ofs-delta shallow multi_ack no-progress include-tag object-format=sha1 agent=${AGENT}`;
  const refs = refList(repo);
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), FLUSH_PKT];
  if (refs.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    refs.forEach((ref, index) => {
      if (index === 0) parts.push(pktLine(`${ref.oid} ${ref.name}\0${caps}\n`));
      else parts.push(pktLine(`${ref.oid} ${ref.name}\n`));
    });
  }
  parts.push(FLUSH_PKT);
  return Buffer.concat(parts);
}

/** v2 advertisement body for git-upload-pack. */
export function advertisementV2(): Buffer {
  return Buffer.concat([
    pktLine('# service=git-upload-pack\n'),
    FLUSH_PKT,
    pktLine('version 2\n'),
    pktLine(`agent=${AGENT}\n`),
    pktLine('ls-refs=unborn\n'),
    pktLine('fetch=shallow wait-for-done filter\n'),
    pktLine('object-format=sha1\n'),
    FLUSH_PKT,
  ]);
}

// ---------------------------------------------------------------- ls-refs (v2)

export function handleLsRefs(repo: Repo, body: Buffer): Buffer {
  const { packets } = decodePktLines(body);
  let peel = false;
  let symrefs = false;
  let unborn = false;
  const prefixes: string[] = [];
  let pastDelim = false;
  for (const packet of packets) {
    if (packet.kind === 'delim') { pastDelim = true; continue; }
    if (packet.kind !== 'data' || !pastDelim) continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (line === 'peel') peel = true;
    else if (line === 'symrefs') symrefs = true;
    else if (line === 'unborn') unborn = true;
    else if (line.startsWith('ref-prefix ')) prefixes.push(line.slice('ref-prefix '.length));
  }
  const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const parts: Buffer[] = [];
  const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
  if (keep('HEAD')) {
    if (tip === null) {
      if (unborn) parts.push(pktLine(`unborn HEAD${symrefs ? ` symref-target:refs/heads/${repo.defaultBranch}` : ''}\n`));
    } else {
      parts.push(pktLine(`${tip} HEAD${symrefs ? ` symref-target:refs/heads/${repo.defaultBranch}` : ''}\n`));
    }
  }
  for (const name of [...repo.refs.keys()].sort()) {
    if (!keep(name)) continue;
    const oid = repo.refs.get(name)!;
    let line = `${oid} ${name}`;
    if (peel) {
      const obj = repo.objects.get(oid);
      if (obj !== undefined && obj.type === 'tag') {
        const target = parseTagTarget(obj.data);
        if (target !== null) line += ` peeled:${target}`;
      }
    }
    parts.push(pktLine(`${line}\n`));
  }
  parts.push(FLUSH_PKT);
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- fetch (v2 and v0)

export interface FetchRequest {
  wants: string[];
  haves: string[];
  shallowBoundaries: string[];
  depth: number | null;
}

/** Parse a v2 fetch request body (pkt-lines after the delim). */
export function parseFetchV2(body: Buffer): FetchRequest {
  const { packets } = decodePktLines(body);
  const req: FetchRequest = { wants: [], haves: [], shallowBoundaries: [], depth: null };
  let pastDelim = false;
  for (const packet of packets) {
    if (packet.kind === 'delim') { pastDelim = true; continue; }
    if (packet.kind !== 'data' || !pastDelim) continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (line.startsWith('want ')) req.wants.push(line.slice(5).trim());
    else if (line.startsWith('have ')) req.haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) req.shallowBoundaries.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) {
      const n = Number(line.slice(7).trim());
      if (Number.isSafeInteger(n) && n > 0) req.depth = n;
    }
  }
  return req;
}

/** Parse a v0 fetch request body (want/have/deepen lines, then flush). */
export function parseFetchV0(body: Buffer): FetchRequest {
  const { packets } = decodePktLines(body);
  const req: FetchRequest = { wants: [], haves: [], shallowBoundaries: [], depth: null };
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (line.startsWith('want ')) req.wants.push(line.slice(5).trim());
    else if (line.startsWith('have ')) req.haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) req.shallowBoundaries.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) {
      const n = Number(line.slice(7).trim());
      if (Number.isSafeInteger(n) && n > 0) req.depth = n;
    }
  }
  return req;
}

export interface FetchPlan {
  objects: Array<{ type: GitObject['type']; data: Buffer }>;
  shallow: string[];
  unshallow: string[];
}

/**
 * Compute what a fetch sends: BFS from the wants, depth-limited when deepen is set, never
 * re-sending anything the client already holds. What the client holds depends on whether it is
 * shallow (the request names shallow boundaries): a shallow client holds only the boundary
 * commits and their trees/blobs, never their ancestors — that is what a deepen walks past. A
 * non-shallow client's haves carry their whole ancestry. Commits at the depth limit become new
 * shallow boundaries; a boundary whose parent is now included is unshallowed.
 */
export function planFetch(repo: Repo, req: FetchRequest): FetchPlan {
  const boundarySet = new Set(req.shallowBoundaries);
  const shallow = boundarySet.size > 0;
  // Commits the client already holds.
  const heldCommits = new Set<string>();
  if (shallow) {
    for (const oid of [...req.haves, ...req.shallowBoundaries]) heldCommits.add(oid);
  } else {
    for (const have of req.haves) for (const oid of reachableCommits(repo, have)) heldCommits.add(oid);
  }
  // Objects the client already holds: a shallow-held commit contributes itself and its subtree
  // only; a full-history have contributes its whole reachable closure.
  const heldObjects = new Set<string>();
  const addSubtree = (commitOid: string): void => {
    const obj = repo.objects.get(commitOid);
    if (obj === undefined || obj.type !== 'commit') return;
    heldObjects.add(commitOid);
    const treeQueue: string[] = [parseCommit(obj.data).tree];
    while (treeQueue.length > 0) {
      const treeOid = treeQueue.pop()!;
      if (heldObjects.has(treeOid)) continue;
      const treeObj = repo.objects.get(treeOid);
      if (treeObj === undefined || treeObj.type !== 'tree') continue;
      heldObjects.add(treeOid);
      for (const entry of parseTree(treeObj.data)) {
        if (entry.mode === '40000') treeQueue.push(entry.oid);
        else heldObjects.add(entry.oid);
      }
    }
  };
  const addClosure = (commitOid: string): void => {
    for (const oid of reachableCommits(repo, commitOid)) addSubtree(oid);
  };
  if (shallow) {
    for (const oid of [...req.haves, ...req.shallowBoundaries]) addSubtree(oid);
  } else {
    for (const have of req.haves) addClosure(have);
  }
  const include = new Set<string>();
  const newShallow = new Set<string>();
  const unshallow = new Set<string>();
  const queue: Array<{ oid: string; depth: number }> = req.wants.map((oid) => ({ oid, depth: 1 }));
  const visited = new Set<string>();
  while (queue.length > 0) {
    const { oid, depth } = queue.shift()!;
    if (visited.has(oid)) continue;
    visited.add(oid);
    const obj = repo.objects.get(oid);
    if (obj === undefined) continue;
    if (obj.type === 'tag') {
      const target = parseTagTarget(obj.data);
      if (target !== null && !heldCommits.has(oid)) {
        include.add(oid);
        queue.push({ oid: target, depth });
      }
      continue;
    }
    if (obj.type !== 'commit') continue;
    if (req.depth !== null && depth > req.depth) continue;
    const commit = parseCommit(obj.data);
    if (boundarySet.has(oid)) {
      // Held as a shallow boundary, but its ancestors are not held: walk past it.
      for (const parent of commit.parents) queue.push({ oid: parent, depth: depth + 1 });
      continue;
    }
    if (heldCommits.has(oid)) {
      // Held: never re-send, but a deepen bounds the walk, so pass through to deeper history.
      if (req.depth !== null) for (const parent of commit.parents) queue.push({ oid: parent, depth: depth + 1 });
      continue;
    }
    include.add(oid);
    if (req.depth !== null && depth === req.depth) newShallow.add(oid);
    for (const parent of commit.parents) queue.push({ oid: parent, depth: depth + 1 });
  }
  for (const boundary of boundarySet) {
    const obj = repo.objects.get(boundary);
    if (obj === undefined || obj.type !== 'commit') continue;
    const commit = parseCommit(obj.data);
    if (commit.parents.some((parent) => include.has(parent))) unshallow.add(boundary);
  }
  const objects: Array<{ type: GitObject['type']; data: Buffer }> = [];
  const added = new Set<string>();
  const addObject = (oid: string): void => {
    if (added.has(oid) || heldObjects.has(oid)) return;
    const obj = repo.objects.get(oid);
    if (obj === undefined) return;
    added.add(oid);
    objects.push({ type: obj.type, data: obj.data });
  };
  for (const oid of include) {
    const obj = repo.objects.get(oid);
    if (obj === undefined) continue;
    addObject(oid);
    if (obj.type === 'commit') {
      const commit = parseCommit(obj.data);
      const treeQueue: string[] = [commit.tree];
      const seenTrees = new Set<string>();
      while (treeQueue.length > 0) {
        const treeOid = treeQueue.pop()!;
        if (seenTrees.has(treeOid) || heldObjects.has(treeOid)) continue;
        seenTrees.add(treeOid);
        addObject(treeOid);
        const treeObj = repo.objects.get(treeOid);
        if (treeObj === undefined || treeObj.type !== 'tree') continue;
        for (const entry of parseTree(treeObj.data)) {
          if (entry.mode === '40000') treeQueue.push(entry.oid);
          else addObject(entry.oid);
        }
      }
    }
  }
  return { objects, shallow: [...newShallow], unshallow: [...unshallow] };
}

/** A packfile as sideband band-1 packets (<= 32 KiB of pack per packet), then flush. */
function sidebandPack(pack: Buffer): Buffer {
  const parts: Buffer[] = [];
  const CHUNK = 32768;
  for (let off = 0; off < pack.length; off += CHUNK) {
    const slice = pack.subarray(off, Math.min(pack.length, off + CHUNK));
    const payload = Buffer.concat([Buffer.from([1]), slice]);
    parts.push(pktLineBuf(payload));
  }
  if (pack.length === 0) parts.push(pktLineBuf(Buffer.from([1])));
  parts.push(FLUSH_PKT);
  return Buffer.concat(parts);
}

/** The v2 fetch response body for a planned fetch. */
export function fetchResponseV2(plan: FetchPlan): Buffer {
  const pack = writePack(plan.objects);
  const parts: Buffer[] = [pktLine('acknowledgments\n'), pktLine('NAK\n'), DELIM_PKT];
  if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(DELIM_PKT);
  }
  parts.push(pktLine('packfile\n'));
  parts.push(sidebandPack(pack));
  return Buffer.concat(parts);
}

/** The v0 fetch response body: a NAK line, then the sideband pack, then flush. */
export function fetchResponseV0(plan: FetchPlan): Buffer {
  const pack = writePack(plan.objects);
  return Buffer.concat([pktLine('NAK\n'), sidebandPack(pack)]);
}

// ---------------------------------------------------------------- receive-pack (v0)

export interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

export interface PushOutcome {
  ref: string;
  ok: boolean;
  reason: string;
}

/**
 * Apply a receive-pack exchange: store the pack's objects, then apply each command with
 * fast-forward enforcement. Returns one outcome per command, in order.
 */
export function handleReceivePack(repo: Repo, body: Buffer): { response: Buffer; outcomes: PushOutcome[] } {
  const { packets, rest } = decodePktLines(body);
  const commands: PushCommand[] = [];
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    let line = packet.payload.toString('utf8').replace(/\n$/, '');
    const nul = line.indexOf('\0');
    if (nul >= 0) line = line.slice(0, nul);
    const parts = line.split(' ');
    if (parts.length >= 3) commands.push({ oldOid: parts[0]!, newOid: parts[1]!, ref: parts[2]! });
  }
  let unpackOk = true;
  try {
    if (rest.length >= 12) {
      const { objects } = readPack(rest, repo);
      for (const [oid, obj] of objects) repo.objects.set(oid, obj);
    }
  } catch {
    unpackOk = false;
  }
  const outcomes: PushOutcome[] = [];
  for (const cmd of commands) {
    if (!unpackOk) {
      outcomes.push({ ref: cmd.ref, ok: false, reason: 'unpack failed' });
      continue;
    }
    const current = repo.refs.get(cmd.ref) ?? null;
    if (cmd.newOid === ZERO_OID) {
      if (current === null) {
        outcomes.push({ ref: cmd.ref, ok: false, reason: 'ref does not exist' });
      } else if (cmd.oldOid !== ZERO_OID && cmd.oldOid !== current) {
        outcomes.push({ ref: cmd.ref, ok: false, reason: 'old value does not match' });
      } else {
        repo.refs.delete(cmd.ref);
        outcomes.push({ ref: cmd.ref, ok: true, reason: '' });
      }
      continue;
    }
    if (current === null) {
      if (cmd.oldOid !== ZERO_OID) {
        outcomes.push({ ref: cmd.ref, ok: false, reason: 'old value does not match' });
        continue;
      }
      if (!repo.objects.has(cmd.newOid)) {
        outcomes.push({ ref: cmd.ref, ok: false, reason: 'object not found' });
        continue;
      }
      repo.refs.set(cmd.ref, cmd.newOid);
      outcomes.push({ ref: cmd.ref, ok: true, reason: '' });
      continue;
    }
    if (cmd.oldOid !== current) {
      outcomes.push({ ref: cmd.ref, ok: false, reason: 'old value does not match' });
      continue;
    }
    if (!repo.objects.has(cmd.newOid)) {
      outcomes.push({ ref: cmd.ref, ok: false, reason: 'object not found' });
      continue;
    }
    if (cmd.newOid === current) {
      outcomes.push({ ref: cmd.ref, ok: true, reason: '' });
      continue;
    }
    if (!isAncestor(repo, current, cmd.newOid)) {
      outcomes.push({ ref: cmd.ref, ok: false, reason: 'non-fast-forward' });
      continue;
    }
    repo.refs.set(cmd.ref, cmd.newOid);
    outcomes.push({ ref: cmd.ref, ok: true, reason: '' });
  }
  const lines: Buffer[] = [pktLineBuf(Buffer.concat([Buffer.from([1]), Buffer.from(unpackOk ? 'unpack ok\n' : 'unpack failed\n')]))];
  for (const outcome of outcomes) {
    const text = outcome.ok ? `ok ${outcome.ref}\n` : `ng ${outcome.ref} ${outcome.reason}\n`;
    lines.push(pktLineBuf(Buffer.concat([Buffer.from([1]), Buffer.from(text)])));
  }
  lines.push(FLUSH_PKT);
  return { response: Buffer.concat(lines), outcomes };
}
