# Contributing

The library is `parser.ts` (the text/event-stream parser), `read.ts` (reading a body a chunk at a time, which `readSse` and
the client share) and `connect.ts` (the reconnecting client), with `event.ts` for the types they pass around, `standalone.ts`
for what `pg-sse-client/parser` exports and `index.ts` for what the package does. Read the [pg-sse README](https://github.com/sansanth/pg-sse#frames-you-will-see) section on frames and
goodbyes first: this client's job is to follow that contract, and the integration tests check it against the real server.

## Set up

```sh
npm install
```

The integration tests need a scratch Postgres and [uv](https://docs.astral.sh/uv/). Each run of the test server creates
its own schema and drops it when it is stopped, so use a scratch database, never one you care about.

```sh
docker run -d --name pg-sse-dev -e POSTGRES_USER=sse -e POSTGRES_PASSWORD=sse -e POSTGRES_DB=pg_sse_test \
  -p 127.0.0.1:55432:5432 postgres:17
export PG_SSE_TEST_DSN=postgresql://sse:sse@127.0.0.1:55432/pg_sse_test
```

Without `PG_SSE_TEST_DSN` the integration tests are skipped, and CI fails a run that skipped them.

## Check your change

```sh
npm run typecheck
npm run lint
npm run test:coverage                    # unit tests, no database; coverage must stay at or above 95%
npx vitest run test/integration          # against a real pg-sse hub; needs PG_SSE_TEST_DSN
npm run build
npm run smoke                              # loads the built package by name, as plain Node ESM does, and reads a stream with it
npm pack --dry-run                         # what would be published
```

`npm run check` runs all but the integration tests. CI runs the unit checks on Node 22 and 24, the test tools (vitest 5,
jsdom 30) needing at least 22. The package itself supports Node 20, so the `check (20)` job runs the tools on 24 and then
`npm run smoke`, which makes a real request, on 20. The integration tests run on Node 24, on Postgres 14 and 18.

## How the tests are laid out

- `test/parser.test.ts`, `test/connect.test.ts`: unit tests with a scripted `fetch` (`test/helpers.ts`) and fake timers.
  Time moves only when a test moves it, so a wait of 750 ms is tested as 749 and 1.
- `test/resume.test.ts`: the browser-only behaviour (`online`, `visibilitychange`) under jsdom.
- `test/integration/`: the client against a real hub. `server/server.py` is a small pg-sse app on a free port, started
  by `harness.ts`. Its `pg-sse` version is pinned in `server/pyproject.toml`; raise it when pg-sse releases a change to
  the wire contract and check that the tests still pass.

Tests are sentences (`resumes from its cursor after the connection drops, and misses and repeats nothing`), and a bug fix
comes with a test that fails without it.

## Style

- Comments explain why, not what. No history ("used to", "now"); git holds it.
- No runtime dependencies. The package is bundled into other people's pages.
- A change to behaviour updates the table in `README.md` and `CHANGELOG.md` in the same commit.
- Keep `connect.ts` free of any one application's event names or auth. That goes in the caller's `onError` and
  `onEvent`.

## Releasing

Raise `version` in `package.json`, move the Unreleased entries in `CHANGELOG.md` under a dated heading, run
`npm install` so the lock file follows, and merge that to `main` through a pull request. Then push a tag `v<version>` on
the merge commit; the workflow refuses a tag that is not on `main` or does not match `package.json`. It then runs the
type check, the lint, and the unit and integration tests, builds the package, runs the smoke test on Node 24 and 20, and
publishes with provenance. Publishing needs a trusted publisher set up on npmjs.com for this repository and `release.yml`,
and a GitHub environment named `npm`.

The first release is different, because npm can only attach a trusted publisher to a package that exists. From the merge
commit on `main`, publish `0.1.0` by hand from a logged-in machine (`npm ci && npm run check && npm publish --access public`;
provenance needs CI, so this one has none). Then run
`npm trust github pg-sse-client --file release.yml --repo sansanth/pg-sse-client --env npm`, and push the tag `v0.1.0` so
the version has one. The Release run for that tag fails at the publish step, because the version is already there.
