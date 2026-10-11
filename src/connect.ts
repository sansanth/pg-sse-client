import { SseEventTooLarge, type SseEvent } from './event.js';
import { createSseParser } from './parser.js';
import { readChunks } from './read.js';

/** The server answered, but not with a stream: a non-2xx status, or a 2xx that is not `text/event-stream`. */
export class StreamRefused extends Error {
  constructor(
    readonly status: number,
    /** The server's `Retry-After`, in milliseconds, when it sent one it could be read. */
    readonly retryAfterMs: number | null = null,
    message = `Stream refused: HTTP ${status}`,
  ) {
    super(message);
    this.name = 'StreamRefused';
  }
}

/** The server went quiet: no response headers within `connectTimeoutMs`, or no bytes at all within `idleTimeoutMs`. */
export class StreamTimeout extends Error {
  constructor(readonly phase: 'connect' | 'idle') {
    super(`Stream timed out waiting for ${phase === 'connect' ? 'a response' : 'data'}`);
    this.name = 'StreamTimeout';
  }
}

/** A stream opened and then closed within `backoff.shortMs`, with or without a goodbye: a server that keeps dropping clients. */
export class StreamEndedEarly extends Error {
  constructor(
    readonly lastedMs: number,
    /** The goodbye reason, or null when the server just closed. */
    readonly reason: string | null,
  ) {
    super(`The stream closed ${Math.round(lastedMs)} ms after it opened`);
    this.name = 'StreamEndedEarly';
  }
}

/**
 * What `onError` decides. `retry` waits as long as the backoff and the server's hints say, `stop` ends the connection
 * for good, and `{ retryAfterMs }` waits exactly that long, for example to rest while the caller polls instead. With
 * `wakeOnResume` the browser coming back online, or the tab becoming visible, ends that rest early, once it has run a second. A `retryAfterMs`
 * that is not a finite number of at least 0 is ignored, as if `onError` had returned nothing.
 */
export type ErrorAction = 'retry' | 'stop' | { retryAfterMs: number; wakeOnResume?: boolean };

export interface ErrorInfo {
  /**
   * Attempts in a row that failed, or that ended within `backoff.shortMs` of opening, this one included. A stream that was
   * open for `backoff.shortMs` before it failed starts the count again, so it is 1.
   */
  failures: number;
}

export interface Backoff {
  /** The first retry waits about this long, then doubles. */
  baseMs: number;
  maxMs: number;
  /**
   * A stream that closed within this long of opening counts as a failure, even if it closed cleanly: `onError` hears a
   * `StreamEndedEarly`. One that lasted this long was healthy, however it ended: the failure count starts again, at 0 for a
   * clean end and at 1 for an error.
   */
  shortMs: number;
  /** After a stream that ended cleanly and long enough, and with no `retry:` from the server, wait this long plus up to `reconnectSpreadMs`. */
  reconnectFloorMs: number;
  reconnectSpreadMs: number;
  /** The longest the client waits on the server's word, a `Retry-After` or a `retry:`. A mistake there must not stop a stream for weeks. */
  serverMaxMs: number;
}

export interface ConnectOptions {
  /**
   * Called for every event except the `end` event. A callback that throws does not stop the stream: see `onCallbackError`
   * for where the error goes.
   */
  onEvent(event: SseEvent): void;
  /** The server accepted the request and a stream is open. It has sent nothing yet. */
  onOpen?(): void;
  /**
   * A stream that had opened has ended, for any reason: a goodbye, the server closing, or an error. It is called before
   * `onError` and before the wait, so it is the place to mark the stream no longer live. It follows `onEnd`. Not called by
   * `close()`.
   */
  onDisconnect?(): void;
  /** The server said goodbye (`max_age`, `shutdown`, `behind`, `revoked`, `recheck`) and the client is about to reconnect. */
  onEnd?(reason: string): void;
  /**
   * Every failed attempt, whether or not it will be retried. Return what to do; return nothing for the default: stop
   * on a 4xx other than 408 and 429, a 3xx that was not followed, a 2xx that is not an event stream, and an event past
   * `maxEventChars` (answers that repeating will not change), retry anything else. Returning `{ retryAfterMs }` also resets `failures`, so the next attempts are counted afresh. It
   * may be `async`: the client waits for the answer.
   */
  onError?(error: unknown, info: ErrorInfo): ErrorAction | void | Promise<ErrorAction | void>;
  /** The connection is over for good: `close()` was called, or an error ended it (passed in). Called once. */
  onClose?(error?: unknown): void;
  /**
   * Gets the error a callback threw, or the rejection of one that is `async` (this one's and every other's), instead of
   * the default: in a page or a worker the error is rethrown on its own, so `window.onerror` sees it, and elsewhere it is
   * logged with `console.error`. If this throws, that error goes the default way.
   */
  onCallbackError?(error: unknown): void;
  /** Request headers. A function is called before every attempt, so a token can be refreshed. `Accept` and `Last-Event-ID` are the client's: the cursor goes in the header, or in the URL for a URL function that takes it. */
  headers?: HeadersInit | (() => HeadersInit | Promise<HeadersInit>);
  /** More `fetch` options, such as `credentials` or `mode`. `method`, `headers` and `signal` are the client's. */
  init?: Omit<RequestInit, 'method' | 'headers' | 'signal' | 'body'>;
  /** A `fetch` to use instead of the global one, looked up on every attempt. */
  fetch?: typeof fetch;
  /**
   * Where the cursor goes: the `Last-Event-ID` header (default), or the URL. `'url'` needs a URL function, which is given
   * the cursor (`''` at first) whatever this is, and sends no header: a cross-origin server then needs no CORS permission
   * for one.
   */
  cursorIn?: 'header' | 'url';
  /** Where to resume from on the first attempt, sent as `Last-Event-ID` or given to a URL function. An id with a line break or NUL cannot be one and is ignored. */
  lastEventId?: string;
  /** The name of the goodbye event, as set with `end_event` on the hub. Default `end`. */
  endEvent?: string;
  /** The most characters of one event to hold, a line still arriving included. More fails the attempt with `SseEventTooLarge`. No limit by default, or when 0. */
  maxEventChars?: number;
  /** How long to wait for the response headers, the `headers` function included. Default 15000. */
  connectTimeoutMs?: number;
  /** Default 45000, which is more than the 25 s between pg-sse's longest pings, with room for a slow network. 0, or a value too long for a timer, turns it off. */
  idleTimeoutMs?: number;
  backoff?: Partial<Backoff>;
}

export interface Connection {
  /** Ends the connection for good. */
  close(): void;
  /** Cuts a wait before the next attempt short, or the wait that is about to begin. Does nothing while a stream is open. */
  retryNow(): void;
  /** The cursor the next attempt will send, as `Last-Event-ID` or to a URL function. */
  readonly lastEventId: string;
}

// `setTimeout` runs a longer delay than this (24.8 days) at once.
const MAX_TIMER_MS = 2 ** 31 - 1;

// A timeout of any length, made of several when it is longer than a timer can be. Returns what cancels it.
function longTimeout(ms: number, run: () => void): () => void {
  let timer: ReturnType<typeof setTimeout>;
  const sleep = (left: number) => {
    timer = setTimeout(left > MAX_TIMER_MS ? () => sleep(left - MAX_TIMER_MS) : run, Math.min(left, MAX_TIMER_MS));
  };
  sleep(ms);
  return () => clearTimeout(timer);
}

// Monotonic: a step of the wall clock must not read as a stream gone quiet or a wait that is over.
const now = () => performance.now();

// How long a wait must have run before `online` or `visibilitychange` may end it.
const EARLY_RETRY_MS = 1000;

const DEFAULT_BACKOFF: Backoff = {
  baseMs: 1000,
  maxMs: 30_000,
  shortMs: 5000,
  reconnectFloorMs: 500,
  reconnectSpreadMs: 1500,
  serverMaxMs: 3_600_000,
};

function retryAfterOf(header: string | null): number | null {
  if (header === null) return null;
  // Clamped, as a very long string of digits is Infinity.
  if (/^\d+$/.test(header.trim())) return Math.min(Number(header) * 1000, Number.MAX_SAFE_INTEGER);
  // An HTTP date starts with a day name and has a time in it. `Date.parse` alone also reads '1.5' or 'May 5' as a date.
  if (!/^[a-z]{3,9}\b.*\d{2}:\d{2}:\d{2}/i.test(header.trim())) return null;
  // The asctime form has no zone, and `Date.parse` would read it as local time.
  const date = Date.parse(/\b(GMT|UTC)\b|\s[+-]\d{4}\s*$/i.test(header) ? header : `${header} GMT`);
  return Number.isNaN(date) ? null : Math.max(0, date - Date.now());
}

// A finite number of at least 0. NaN, a negative and Infinity would each run a timer at once.
function isDelay(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

// What one attempt tells the loop: when its stream opened (never, if it failed before), and the `retry:` it sent.
interface Outcome {
  openedAt: number | null;
  retry: number | null;
}

// What `onError` returned, if it is something to act on. Anything else leaves it to the default.
function actionOf(returned: unknown): ErrorAction | null {
  if (returned === 'retry' || returned === 'stop') return returned;
  if (typeof returned !== 'object' || returned === null) return null;
  const ms = (returned as { retryAfterMs?: unknown }).retryAfterMs;
  if (!isDelay(ms)) return null;
  return { retryAfterMs: ms, wakeOnResume: (returned as { wakeOnResume?: unknown }).wakeOnResume === true };
}

// Not a usable number: the default. Too long for a timer, Infinity say: none, as 0.
function timeoutOf(value: number | undefined, fallback: number): number {
  if (value === Number.POSITIVE_INFINITY) return 0;
  if (!isDelay(value)) return fallback;
  return value > MAX_TIMER_MS ? 0 : value;
}

// Stop on what repeating will not change: as `EventSource` does, a 4xx (a timeout and a rate limit aside) and a 2xx that is
// no stream, and an event that will be as large when sent again.
function defaultAction(error: unknown): ErrorAction {
  if (error instanceof SseEventTooLarge) return 'stop';
  if (!(error instanceof StreamRefused)) return 'retry';
  if (error.status < 400) return 'stop';
  return error.status < 500 && error.status !== 408 && error.status !== 429 ? 'stop' : 'retry';
}

// The id goes as its UTF-8 bytes, as `EventSource` sends it: `Headers` throws on a character outside Latin-1.
function headerValue(id: string): string {
  return Array.from(new TextEncoder().encode(id), (byte) => String.fromCharCode(byte)).join('');
}

// Settles with `work`, or rejects when the signal aborts, so work that never settles cannot hold an attempt. `late` gets
// what `work` settles with after that.
function untilAborted<T>(signal: AbortSignal, work: T | Promise<T>, late?: (value: T) => void): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    Promise.resolve(work)
      .then((value) => {
        if (signal.aborted) late?.(value);
        resolve(value);
      }, reject)
      .finally(() => signal.removeEventListener('abort', abort));
    // `work` may have aborted the signal itself.
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
  });
}

// The media type is case-insensitive and may have parameters.
function isEventStream(response: Response): boolean {
  return (response.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase() === 'text/event-stream';
}

// Frees an answer the client will not read. Not awaited: a cancel that hangs must not hold up the refusal.
async function discard(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    /* nothing to free */
  }
}

function endReason(data: string): string {
  try {
    const parsed = JSON.parse(data) as string | { reason?: unknown } | null;
    const reason = typeof parsed === 'string' ? parsed : parsed?.reason;
    return typeof reason === 'string' ? reason : 'unknown';
  } catch {
    return data || 'unknown';
  }
}

function rethrowLater(error: unknown): void {
  queueMicrotask(() => {
    throw error;
  });
}

// A page or a worker has a handler for an error nobody caught (`window.onerror`), which an error rethrown on its own
// reaches. Node, Deno, Bun and React Native have no `document`, and an uncaught error ends them: it is logged.
function reportByDefault(error: unknown): void {
  if (typeof document !== 'undefined' || 'WorkerGlobalScope' in globalThis) rethrowLater(error);
  else console.error(error);
}

/**
 * Opens a stream the way `EventSource` would, with `fetch` underneath so it can send headers. It reconnects on its own,
 * sends `Last-Event-ID` from the last `id:` it saw, waits the `retry:` the server asked for, and backs off with jitter
 * when attempts fail. With `cursorIn: 'url'` the cursor goes to the URL function instead, and no header is sent. It starts at once; call `close()` to end it.
 */
export function connect(url: string | URL | ((lastEventId: string) => string | URL), options: ConnectOptions): Connection {
  if (options.cursorIn !== undefined && options.cursorIn !== 'header' && options.cursorIn !== 'url') {
    throw new TypeError(`cursorIn is 'header' or 'url', not ${JSON.stringify(options.cursorIn)}`);
  }
  if (options.cursorIn === 'url' && typeof url !== 'function') {
    throw new TypeError("cursorIn: 'url' needs a URL function, which is given the cursor");
  }
  // A URL that can never be fetched fails here, as `new EventSource(url)` does, instead of being retried for ever. A `fetch`
  // of the caller's may read URLs its own way.
  if (typeof url !== 'function' && !options.fetch && !/^https?:$/.test(new URL(url, globalThis.location?.href).protocol)) {
    throw new TypeError(`Not a URL fetch can read: ${String(url)}`);
  }
  // Headers given as a value, not a function, fail the same way every time: they fail here too.
  if (typeof options.headers !== 'function') new Headers(options.headers);
  // An entry that is not a usable number keeps its default.
  const entries = Object.entries(options.backoff ?? {}).filter(([, value]) => isDelay(value));
  const backoff: Backoff = { ...DEFAULT_BACKOFF, ...Object.fromEntries(entries) };
  const endEvent = options.endEvent ?? 'end';
  const connectTimeoutMs = timeoutOf(options.connectTimeoutMs, 15_000);
  const idleTimeoutMs = timeoutOf(options.idleTimeoutMs, 45_000);

  let closed = false;
  let finished = false;
  let controller: AbortController | null = null;
  let wake: (() => void) | null = null;
  // From the end of a stream or a failed attempt until the wait begins, `retryNow` has no wait to cut short, and is held.
  let between = false;
  let retryAsked = false;
  // Sent as `Last-Event-ID`: the id of the last event handed over, not the parser's, which can be ahead in the middle of a
  // chunk. An id that cannot be a header value is no cursor.
  let cursor = options.lastEventId && !/[\0\r\n]/.test(options.lastEventId) ? options.lastEventId : '';
  // The last `retry:` any stream sent.
  let serverRetry: number | null = null;

  function report(error: unknown): void {
    try {
      if (options.onCallbackError) watch(options.onCallbackError(error), reportByDefault);
      else reportByDefault(error);
    } catch (inner) {
      reportByDefault(inner);
    }
  }

  // A rejection of an `async` callback is an error like a throw, not an unhandled rejection.
  function watch(result: unknown, fail: (error: unknown) => void = report): void {
    if (typeof (result as PromiseLike<unknown> | undefined)?.then === 'function') {
      (result as PromiseLike<unknown>).then(undefined, fail);
    }
  }

  // Calls a callback as a method of the options. What it throws, or rejects with, goes to `report`.
  function notify<A extends unknown[]>(callback: ((...args: A) => unknown) | undefined, ...args: A): void {
    try {
      watch(callback?.call(options, ...args));
    } catch (error) {
      report(error);
    }
  }

  // With no argument for a close, with one, even `undefined`, for an error that ended the connection.
  function finish(...error: [] | [unknown]): void {
    if (finished) return;
    finished = true;
    notify(options.onClose, ...error);
  }

  // `holdMs` is how long the wait must run before the browser may end it: all of it when the server or `onError` chose it.
  function rest(ms: number, holdMs: number): Promise<void> {
    // The browser coming back online, or the page becoming visible, is a reason to try now. `online` needs a global event
    // target (a page, a worker), `visibilitychange` a `document`.
    const hold = Math.max(EARLY_RETRY_MS, holdMs);
    const listening = hold < ms && typeof globalThis.addEventListener === 'function';
    const page = typeof document === 'undefined' ? null : document;
    return new Promise((resolve) => {
      const begun = now();
      // An event before the hold is over sets the retry for its end, so switching tabs is not a request each time.
      let early: ReturnType<typeof setTimeout> | undefined;
      const onOnline = () => {
        const left = hold - (now() - begun);
        if (left <= 0) done();
        else early ??= setTimeout(done, Math.min(left, MAX_TIMER_MS));
      };
      const onVisible = () => {
        if (!page!.hidden) onOnline();
      };
      const done = () => {
        cancel();
        clearTimeout(early);
        wake = null;
        if (listening) {
          globalThis.removeEventListener('online', onOnline);
          page?.removeEventListener('visibilitychange', onVisible);
        }
        resolve();
      };
      const cancel = longTimeout(ms, done);
      wake = done;
      if (listening) {
        globalThis.addEventListener('online', onOnline);
        page?.addEventListener('visibilitychange', onVisible);
      }
    });
  }

  async function attempt(outcome: Outcome): Promise<string | null> {
    const current = new AbortController();
    controller = current;
    between = false;
    retryAsked = false;
    const parser = createSseParser({ lastEventId: cursor }, { maxEventChars: options.maxEventChars });
    let timedOut: 'connect' | 'idle' | null = null;
    let opened = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let deadline = 0;
    // A chunk moves the idle deadline without touching the timer, which sleeps on for what is left when it fires early.
    const arm = (phase: 'connect' | 'idle', ms: number) => {
      clearTimeout(timer);
      if (ms <= 0) return;
      deadline = now() + ms;
      const check = () => {
        const left = deadline - now();
        if (left > 0) {
          timer = setTimeout(check, left);
          return;
        }
        timedOut = phase;
        current.abort();
      };
      timer = setTimeout(check, ms);
    };
    const touch = () => {
      deadline = now() + idleTimeoutMs;
    };
    try {
      // The connect timer covers `headers()` too: a dead token endpoint is a silent server.
      arm('connect', connectTimeoutMs);
      const given = typeof options.headers === 'function' ? await untilAborted(current.signal, options.headers()) : options.headers;
      const headers = new Headers(given);
      headers.set('Accept', 'text/event-stream');
      // The client's cursor, not one from `headers`.
      if (cursor && options.cursorIn !== 'url') headers.set('Last-Event-ID', headerValue(cursor));
      else headers.delete('Last-Event-ID');
      const fetchFn = options.fetch ?? ((input, init) => fetch(input, init));
      // A `fetch` that ignores the signal is cut off, and an answer it gives later is freed.
      const response = await untilAborted(
        current.signal,
        fetchFn(typeof url === 'function' ? url(cursor) : url, {
          ...options.init,
          body: undefined,
          method: 'GET',
          headers,
          signal: current.signal,
        }),
        discard,
      );
      if (!response.ok) {
        void discard(response);
        throw new StreamRefused(response.status, retryAfterOf(response.headers.get('retry-after')));
      }
      if (!isEventStream(response)) {
        void discard(response);
        throw new StreamRefused(response.status, null, 'The response is not an event stream');
      }
      if (!response.body) {
        throw new StreamRefused(response.status, null, 'The response has no body to read: this runtime\'s fetch does not stream');
      }
      arm('idle', idleTimeoutMs);
      opened = true;
      outcome.openedAt = now();
      notify(options.onOpen);
      if (closed) {
        void discard(response);
        return null;
      }
      // The cursor is the id of the event being handled, and where the parser stands once a chunk's events are all handed
      // over, which includes a frame of only an `id:` (pg-sse sends one first).
      for await (const events of readChunks(response.body, touch, parser, current.signal)) {
        for (const event of events) {
          if (closed) return null;
          cursor = event.id;
          if (event.event === endEvent) {
            const reason = endReason(event.data);
            between = true;
            notify(options.onEnd, reason);
            return reason;
          }
          notify(options.onEvent, event);
        }
        cursor = parser.lastEventId;
      }
      current.signal.throwIfAborted();
      return null;
    } catch (error) {
      if (timedOut) throw new StreamTimeout(timedOut);
      throw error;
    } finally {
      clearTimeout(timer);
      outcome.retry = parser.retry;
      if (parser.retry !== null) serverRetry = parser.retry;
      between = true;
      if (opened && !closed) notify(options.onDisconnect);
    }
  }

  const capped = (ms: number | null) => (ms === null ? null : Math.min(ms, backoff.serverMaxMs));

  // The server's word (`retry:`, `Retry-After`) is a floor. After a clean end the `retry:` of the stream that ended is the
  // whole wait, so the pause that follows a goodbye is the server's to set; without one the wait is spread at random.
  function delayAfter(failures: number, retryAfterMs: number | null, retry: number | null): { ms: number; holdMs: number } {
    const hint = capped(retry);
    if (failures === 0 && hint !== null) return { ms: hint, holdMs: hint };
    const floor = Math.max(capped(retryAfterMs) ?? 0, capped(serverRetry) ?? 0);
    const ms =
      failures === 0
        ? backoff.reconnectFloorMs + Math.random() * backoff.reconnectSpreadMs
        : Math.min(backoff.maxMs, backoff.baseMs * 2 ** Math.min(failures - 1, 30)) * (0.5 + Math.random() / 2);
    // Spread, so the clients a full server refused together do not come back at the same moment.
    const refused = capped(retryAfterMs);
    const spread = refused === null ? 0 : refused + Math.random() * backoff.reconnectSpreadMs;
    return { ms: Math.max(floor, spread, ms), holdMs: Math.max(floor, spread) };
  }

  async function run(): Promise<void> {
    let failures = 0;
    while (!closed) {
      let wait: { ms: number; holdMs: number };
      let failure: unknown;
      let failed = false;
      const outcome: Outcome = { openedAt: null, retry: null };
      try {
        const reason = await attempt(outcome);
        if (closed) return;
        // From when the stream opened: the attempt began earlier, with a `headers()` and a connect.
        const lasted = now() - outcome.openedAt!;
        if (lasted >= backoff.shortMs) {
          failures = 0;
          wait = delayAfter(0, null, outcome.retry);
        } else {
          failures += 1;
          failed = true;
          failure = new StreamEndedEarly(lasted, reason);
          wait = delayAfter(failures, null, outcome.retry);
        }
      } catch (error) {
        if (closed) return;
        failures = outcome.openedAt !== null && now() - outcome.openedAt >= backoff.shortMs ? 1 : failures + 1;
        failed = true;
        failure = error;
        wait = delayAfter(failures, error instanceof StreamRefused ? error.retryAfterMs : null, outcome.retry);
      }
      if (failed) {
        let asked: unknown;
        try {
          asked = await options.onError?.(failure, { failures });
        } catch (error) {
          report(error);
        }
        const action = actionOf(asked) ?? defaultAction(failure);
        if (closed) return;
        if (action === 'stop') {
          finish(failure);
          return;
        }
        if (typeof action === 'object') {
          failures = 0;
          retryAsked = false;
          wait = { ms: action.retryAfterMs, holdMs: action.wakeOnResume ? 0 : action.retryAfterMs };
        }
      }
      if (retryAsked) continue;
      between = false;
      await rest(wait.ms, wait.holdMs);
    }
  }

  // Nothing in `run` is meant to throw. If something does, the connection is over.
  void run().catch((error) => finish(error));

  return {
    close() {
      closed = true;
      controller?.abort();
      wake?.();
      finish();
    },
    retryNow() {
      if (wake) wake();
      else if (between) retryAsked = true;
    },
    get lastEventId() {
      return cursor;
    },
  };
}
