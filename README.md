# pg-sse-client

[![CI](https://github.com/sansanth/pg-sse-client/actions/workflows/ci.yml/badge.svg)](https://github.com/sansanth/pg-sse-client/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/pg-sse-client)](https://www.npmjs.com/package/pg-sse-client)
[![Node versions](https://img.shields.io/node/v/pg-sse-client)](https://www.npmjs.com/package/pg-sse-client)
[![Minified and gzipped](https://img.shields.io/bundlephobia/minzip/pg-sse-client)](https://bundlephobia.com/package/pg-sse-client)
[![License](https://img.shields.io/npm/l/pg-sse-client)](https://github.com/sansanth/pg-sse-client/blob/main/LICENSE)

The browser and Node client for [pg-sse](https://github.com/sansanth/pg-sse) streams, for when `EventSource` is not enough. pg-sse is a Python library (`pip install pg-sse`) that streams Postgres changes from a FastAPI or other Python server; this package is its JavaScript side, not the unrelated `pg-sse` package on npm.

It is `EventSource` on top of `fetch`: it can send an `Authorization` header, and it keeps the parts of the pg-sse contract that `EventSource` handles for you (resume from the last id, the server's reconnect delay, the goodbye frame).

No dependencies, ESM only, about 3.7 kB minified and gzipped (1.2 kB for `pg-sse-client/parser`).

## Do you need it?

If your stream authenticates with a cookie sent to the same origin, or with `withCredentials`, use `EventSource`. It reconnects by itself and sends `Last-Event-ID`, and pg-sse is written for it. Use this package when you need what `EventSource` cannot do:

- send a header (`Authorization: Bearer ...`), or read a token that changes between attempts
- see why a stream ended and why a request was refused (a 401, a 503 with `Retry-After`)
- stop retrying on an error that repeating will not fix
- decide what to do after repeated failures, such as falling back to polling

```sh
npm install pg-sse-client
```

## Use it

```ts
import { connect } from 'pg-sse-client';

const stream = connect('https://api.example/rooms/lobby/stream', {
  headers: async () => ({ Authorization: `Bearer ${await getToken()}` }), // read before every attempt
  onEvent: (event) => render(JSON.parse(event.data)),                     // { event, data, id }
  onEnd: (reason) => console.debug('the server said goodbye:', reason),
  onClose: (error) => error && showSignIn(),                              // over for good
});

stream.close();
```

It starts at once, like `new EventSource(url)`. On the server, set `end_event="end"` on the hub if you want `onEnd` to hear why a stream ended; without it the client still reconnects correctly, it just does not know the reason.

## What it does

| Situation | Behaviour |
|---|---|
| Request | `GET` with `Accept: text/event-stream`, your headers, and `Last-Event-ID` once it has a cursor, sent as UTF-8 bytes as `EventSource` does. |
| `id:` | Moves the cursor when the frame ends. A frame with only an `id:` moves it and delivers nothing (pg-sse sends one first when you pass a cursor). |
| `retry:` | After a stream that stayed open 5 s or more, the next reconnect waits exactly that long. After a shorter one it is the backoff below, never less than that. No later wait is shorter than the last `retry:` the server sent. |
| `end` event (`max_age`, `shutdown`, `behind`, `revoked`, `recheck`) | `onEnd(reason)`, then reconnect after the `retry:` that came with it (after a stream open 5 s or more; a shorter one is backed off from, below). The event is not passed to `onEvent`. A reason the client does not know is passed through unchanged. |
| Stream closes with no goodbye | Reconnect after 0.5 to 2 s, random (never less than the last `retry:`). |
| Failure (network error, timeout, non-2xx, not an event stream) | `onError`, then wait. The wait doubles from 1 s to 30 s with jitter, never less than a `Retry-After` (plus 0 to 1.5 s of spread) or the last `retry:` the server sent. Those two are capped at `backoff.serverMaxMs`, an hour. |
| A stream that closed within 5 s of opening | Counts as a failure even if it closed cleanly, so a server that keeps dropping clients is backed off from. `onError` hears a `StreamEndedEarly`. |
| A stream that stayed open 5 s or more | Healthy, however it ended: the failure count starts again. A clean end reconnects as above; an error is failure 1, backed off from as such. A stream that fails sooner adds to the count. |
| 4xx other than 408 and 429, a 3xx you chose not to follow, a 2xx that is not an event stream (a 204, say), or an event past `maxEventChars` | Stops, and `onClose(error)` says why. A repeat would only get the same answer, and `EventSource` stops too. A 401 is one of these: when your `headers` function can get a fresh token, return `'retry'` from `onError` for it. |
| Silence | No bytes (pings count) for 45 s aborts and retries. No response headers in 15 s does too, and a `headers` function that takes that long counts. |
| Browser | A wait of the client's own choosing ends early when the browser comes back `online` or the tab becomes visible, once it has run a second and as long as the last `retry:`. A wait the server asked for, or `onError` chose with `{ retryAfterMs }`, does not (`retryNow()` still ends it). |

### Options

| Option | Default | |
|---|---|---|
| `onEvent(event)` | required | Every event but the goodbye. A throw does not stop the stream: it goes to `onCallbackError`. |
| `onCallbackError(error)` | | Gets what any callback threw, or the rejection of one that is `async`. Without it a page or a worker has the error rethrown on its own, to `window.onerror`, and anything else logs it with `console.error`. If it throws, that goes the default way. |
| `onOpen()` | | The server accepted the request. It has sent nothing yet. |
| `onDisconnect()` | | A stream that had opened has ended, for any reason, before `onError` and the wait. Where a "live" flag goes false. Not called by `close()`. |
| `onEnd(reason)` | | The goodbye event's `reason`, or `unknown`. Data that is not JSON is the reason as it came. |
| `onError(error, { failures })` | | Every failed attempt. Return `'retry'`, `'stop'` or `{ retryAfterMs }` (which also resets `failures`), or nothing for the default. `{ retryAfterMs, wakeOnResume: true }` also ends the rest early when the browser comes back `online` or the tab becomes visible, after the first second. May be `async`. |
| `onClose(error?)` | | The connection is over: `close()` was called (no argument), or an error stopped it. Once. |
| `headers` | | `HeadersInit`, or a function returning one (or a promise of one), called before every attempt. |
| `init` | | More `fetch` options, such as `credentials: 'include'`. `method`, `headers`, `body` and `signal` are the client's. `EventSource` sends `cache: 'no-store'`; pg-sse's `Cache-Control: no-cache` does the same job. |
| `fetch` | global `fetch` | For tests, or a wrapped fetch. Looked up on every attempt, and called with no receiver, as `fetch` must be: bind a method. |
| `cursorIn` | `'header'` | `'url'` sends the cursor to the URL function and no `Last-Event-ID` header. |
| `lastEventId` | | Resume from here on the first attempt. |
| `endEvent` | `end` | The hub's `end_event`. An event of your own with this name is taken for the goodbye, so name yours otherwise or set this. |
| `maxEventChars` | no limit | The most characters of one event to hold: its lines, field names included, and the line still arriving. More fails the attempt with `SseEventTooLarge`. `EventSource` has no limit and neither does this by default; set one when you do not trust the server to stay small. |
| `connectTimeoutMs`, `idleTimeoutMs` | 15000, 45000 | `0` turns a timeout off, and so does a value too long for a timer, such as `Infinity`. |
| `backoff` | see `Backoff` in `src/connect.ts` | `baseMs`, `maxMs`, `shortMs`, `reconnectFloorMs`, `reconnectSpreadMs`, `serverMaxMs`. An entry that is not a finite number of at least 0 keeps its default. |

The first argument is a URL string, a `URL`, or a function returning one, called before every attempt. A function is given the cursor (`''` at first). With `cursorIn: 'url'` it is the only place the cursor goes, and no `Last-Event-ID` header is sent: `` url: (id) => `${base}?cursor=${encodeURIComponent(id)}` ``, encoded. `cursorIn: 'url'` without a URL function, or any `cursorIn` but `'header'` and `'url'`, throws a `TypeError` from `connect`. A string or `URL` that can never be fetched, and `headers` given as a value that cannot be sent, throw a `TypeError` from `connect`, as `new EventSource` throws.

`connect` returns `{ close(), retryNow(), lastEventId }`. `retryNow()` cuts a wait short, for example when your own app learns the network is back.

Errors are `SseEventTooLarge` (`limit`) for an event past `maxEventChars`, `StreamRefused` (`status`, `retryAfterMs`) for a non-2xx answer or a body that is not an event stream, `StreamTimeout` (`phase`) for silence, and `StreamEndedEarly` (`lastedMs`, `reason`) for a stream that closed within `backoff.shortMs` of opening. Anything else is what `fetch` threw.

### Falling back to polling

`failures` in `onError` is the number of attempts in a row that failed. Use it to hand over to polling and rest:

```ts
onError: (error, { failures }) => {
  if (failures >= 3) {
    startPolling();
    return { retryAfterMs: 3 * 60_000, wakeOnResume: true }; // try the stream again in three minutes, or when the tab is back
  }
},
onOpen: stopPolling,
```

### Cross-origin requests

`Last-Event-ID` is not a header a cross-origin `fetch` may send without permission (`EventSource` is exempt). If you cannot change the server's CORS, carry the cursor in the URL with `cursorIn: 'url'` (above). Otherwise the server must answer the preflight with `Access-Control-Allow-Headers: Last-Event-ID` (plus `Authorization` if you send it), or the first reconnect fails and the stream never resumes. To read a `Retry-After` from a refusal, the response needs `Access-Control-Expose-Headers: Retry-After`; without it `retryAfterMs` is null.

### Only the parser

```ts
import { createSseParser, readSse } from 'pg-sse-client/parser';

for await (const event of readSse(response.body!, onActivity)) { /* { event, data, id } */ }
```

For a stream you open yourself, such as a `POST` that answers with events. The parser follows the WHATWG rules; `parser.lastEventId` and `parser.retry` hold the connection-level state. The parser reads a whole chunk before the first of its events reaches you, so to resume use the `id` of the last event you handled, not `parser.lastEventId`.

## Testing your code

Pass your own `fetch` and the stream is whatever you hand back, with no server:

```ts
const body = new ReadableStream<Uint8Array>({
  start(controller) {
    controller.enqueue(new TextEncoder().encode('id: 1\nevent: change\ndata: {"n":1}\n\n'));
  },
});
const stream = connect('https://api.example/stream', {
  fetch: async () => new Response(body, { headers: { 'content-type': 'text/event-stream' } }),
  onEvent: (event) => seen.push(JSON.parse(event.data)),
});
// ...assert on `seen`, then
stream.close();
```

Fake timers work for the waits: a failed attempt, or a `retry:`, is a timer of the length the table above says, with the jitter from `Math.random()`. Stub that too if a test needs an exact wait.

## What is not here

- **The meaning of your events.** The client does not know `change` from `ready`; that is your server's protocol.
- **A message queue.** It delivers what the stream sends; a gap is closed by the server re-reading from the cursor it was sent.
- **React or any framework.** Wrap `connect` in your own hook; `close()` is the cleanup.

## Development

If you are generating code with this package, [llms.txt](https://github.com/sansanth/pg-sse-client/blob/main/llms.txt) carries the rules in a form meant to be fed to an agent. Runnable examples are in [examples/](examples/): a Node script, a page that carries the cursor in the URL and falls back to polling, and a React hook. See [CONTRIBUTING.md](CONTRIBUTING.md). The wire contract this client follows is in the [pg-sse README](https://github.com/sansanth/pg-sse#frames-you-will-see).
