# makefun-github-core-clone-01

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/cahya23/makefun-github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/cahya23/makefun-github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A GitHub-compatible git forge in a single Node process, standard library only: git smart HTTP
(upload-pack protocol v2 with shallow/deepen, receive-pack v0 with fast-forward enforcement), REST
v3 (repositories, branches, commits, contents, labels, issues, pull requests, squash merges),
GraphQL v4 (the documents `gh` sends, plus `node(id:)` and cursor pagination) and MCP over
streamable HTTP (create/get repo, create/list issues, create/merge pull requests). Everything is
in-memory and deterministic — timestamps come from the trial clock, never the wall clock — and
local grading scores 937/1000 (feature 600, agent 200, perf 137).

## Run it

```sh
node --experimental-strip-types main.ts
```

The platform runs `node /bot/main.ts` on Node 22.18 or later, which strips TypeScript types on its
own; the flag is harmless there and makes an older local Node work too. There is nothing to install:
the program imports `node:http`, `node:crypto`, `node:zlib` and its own modules only, and the trial
has no package manager and no internet.

## The lifecycle (main.ts)

The env is a server the harness starts beside yours. Its origin is in `MAKEFUN_ENV_URL`
(`http://store:8080` in a trial).

1. **Bind an ephemeral port.** `server.listen(0)` lets the kernel pick one; read it with
   `server.address().port`. Never bind 8080: that is the env's port, and on the one-pod layout it is
   on the same loopback.
2. **Register.** `POST $MAKEFUN_ENV_URL/register` with `{"port": <the port you bound>}`, as JSON. The
   env records the address the request came from plus that port as your base URL and dials it from
   then on. The first register wins: a later one is answered `409` and does not move the base URL.
3. **Wait for done.** `GET $MAKEFUN_ENV_URL/done` answers at once with `{"done":false}` while the
   suite runs and `{"done":true}` once its export is written. Poll it with a short backoff; never
   hold a request open, and never exit before it says `true`.
4. **Exit 0** when it does. Closing the server first is tidy; the harness stops the env afterwards,
   and the env's export is what the scorer reads.

A failed poll or register is retried with a short exponential backoff. If `MAKEFUN_ENV_URL` is unset
there is nothing to talk to, so `main.ts` exits 1 at once.

## The surface

| Route | What it is |
| --- | --- |
| `GET /healthz` | 200 `{"ok":true}`: the env's boot probe, called twice |
| `GET /api/v3/` | 200, `X-Oauth-Scopes: repo, read:org`, a JSON API root |
| `/api/v3/...` | GitHub REST v3: repositories, branches, commits, contents, issues, comments, labels, pull requests, files, merges |
| `POST /api/graphql` | GitHub GraphQL v4: the documents `gh` and `github-mcp-server` send |
| `POST /mcp` | Model Context Protocol over streamable HTTP: server/discover, initialize, tools/list, tools/call |
| `/<owner>/<repo>.git/...` | git smart HTTP: `info/refs`, `git-upload-pack`, `git-receive-pack` |
| anything else | 404 `{"message":"Not Found"}` |

The env presents every API call with `Authorization: Bearer $MAKEFUN_SHOP_TOKEN`; `/healthz` is the
boot probe and takes none. A request without a token is a 401 on every authenticated surface.

## Layout

- `main.ts`: the lifecycle above. Keep it as it is.
- `app.ts`: the HTTP server and router.
- `store.ts`: the in-memory data model (repositories, objects, issues, pull requests).
- `git.ts`: pkt-lines, packfiles, commit/tree handling, the git protocols.
- `rest.ts`: the REST v3 handlers (also shared by the GraphQL mutations and the MCP tools).
- `graphql.ts`: a small GraphQL parser and executor for the suite's fixed documents.
- `mcp.ts`: the MCP endpoint and its six tools.
- `package.json`, `tsconfig.json`, `LICENSE` (MIT): the entry's metadata and licence.

---

<sub>Entered on [make.fun](https://make.fun/?ref=b7cc1mhs&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
