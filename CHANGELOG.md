# Changelog

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.2] - 2026-10-12

### Changed

- A rest chosen with `{ retryAfterMs }` from `onError` is never shorter than the server's `Retry-After` or last
  `retry:`, as every other wait already was. With `wakeOnResume` the browser cannot end it before that.
- The package includes `llms.txt`, the rules for generating code with it.

## [0.1.1] - 2026-10-12

### Changed

- Published from CI with provenance. The library is the same as 0.1.0.

## [0.1.0] - 2026-10-12

### Added

- `connect(url, options)`: a client for pg-sse streams on `fetch`. It sends your headers, resumes from the last `id:`
  with `Last-Event-ID`, waits the `retry:` and `Retry-After` the server sends, reports the goodbye reason, and backs
  off with jitter. `onError` decides whether to retry, stop or rest (`wakeOnResume` ends a rest when the browser is
  back), and `retryNow()` ends a wait. `cursorIn: 'url'` carries the cursor in the URL, which needs no CORS
  permission for a header.
- `maxEventChars`: an opt-in limit on how much of one event is held. More fails with `SseEventTooLarge`.
- `createSseParser` and `readSse`, also under `pg-sse-client/parser`: the text/event-stream parser, for a stream you
  open yourself.

[Unreleased]: https://github.com/sansanth/pg-sse-client/compare/v0.1.2...HEAD
[0.1.2]: https://github.com/sansanth/pg-sse-client/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/sansanth/pg-sse-client/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/sansanth/pg-sse-client/releases/tag/v0.1.0
