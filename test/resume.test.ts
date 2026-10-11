// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { connect, type Connection } from '../src/connect';
import { openStream, refusal, scriptedFetch, settle } from './helpers';

let connection: Connection | undefined;

// A wait of 5 to 10 s, so the events below come well inside it.
const LONG_BACKOFF = { baseMs: 10_000 };

function setHidden(hidden: boolean) {
  Object.defineProperty(document, 'hidden', { value: hidden, configurable: true });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(Math, 'random').mockReturnValue(0.5);
});

afterEach(() => {
  vi.unstubAllGlobals();
  connection?.close();
  setHidden(false);
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('a callback that throws, in a page', () => {
  it('keeps reading and rethrows the error on its own, where window.onerror sees it', async () => {
    const thrown: unknown[] = [];
    vi.stubGlobal('queueMicrotask', (run: () => void) => {
      try {
        run();
      } catch (error) {
        thrown.push(error);
      }
    });
    const script = scriptedFetch();
    const stream = openStream();
    script.answer(stream);
    const delivered: string[] = [];
    connection = connect('https://api.example/stream', {
      fetch: script.fetch,
      onEvent: (event) => {
        delivered.push(event.data);
        throw new Error('handler bug');
      },
    });
    await settle();

    stream.send('data: a\n\ndata: b\n\n');
    await settle();

    expect(delivered).toEqual(['a', 'b']);
    expect(thrown).toEqual([new Error('handler bug'), new Error('handler bug')]);
  });
});

describe('a callback that throws, where there is a window and no document', () => {
  it('is logged, not rethrown, as in React Native or Deno', async () => {
    vi.stubGlobal('document', undefined);
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const script = scriptedFetch();
    const stream = openStream();
    script.answer(stream);
    connection = connect('https://api.example/stream', {
      fetch: script.fetch,
      onEvent: () => {
        throw new Error('handler bug');
      },
    });
    await settle();

    stream.send('data: a\n\n');
    await settle();

    expect(logged).toHaveBeenCalledExactlyOnceWith(new Error('handler bug'));
  });
});

describe('a failure inside the client', () => {
  it('ends the connection and tells onClose, instead of an unhandled rejection', async () => {
    vi.stubGlobal('addEventListener', () => {
      throw new Error('no events here');
    });
    const script = scriptedFetch();
    script.answer(() => Promise.reject(new TypeError('offline')));
    const closes: unknown[] = [];
    connection = connect('https://api.example/stream', {
      fetch: script.fetch,
      onEvent: () => {},
      onClose: (error) => closes.push(error),
      backoff: LONG_BACKOFF,
    });
    await settle();

    expect(closes).toEqual([new Error('no events here')]);
  });
});

describe('waiting to reconnect in a page', () => {
  it('lets the browser cut a wait short only once the floor the server set has passed', async () => {
    const script = scriptedFetch();
    const first = openStream();
    script.answer(first);
    script.answer(openStream());
    connection = connect('https://api.example/stream', { fetch: script.fetch, onEvent: () => {}, backoff: LONG_BACKOFF });
    await settle();

    first.send('retry: 3000\ndata: x\n\n');
    first.fail();
    // The failure's own wait is 7500 ms, the client's guess; the server's retry: of 3000 is the floor under it.
    await vi.advanceTimersByTimeAsync(2000);
    window.dispatchEvent(new Event('online'));
    await vi.advanceTimersByTimeAsync(999);
    expect(script.calls).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(1);

    expect(script.calls).toHaveLength(2);
  });

  it('tries at once when the browser comes back online', async () => {
    const script = scriptedFetch();
    script.answer(() => Promise.reject(new TypeError('offline')));
    script.answer(openStream());
    connection = connect('https://api.example/stream', { fetch: script.fetch, onEvent: () => {}, backoff: LONG_BACKOFF });
    await vi.advanceTimersByTimeAsync(1000);

    window.dispatchEvent(new Event('online'));
    await settle();

    expect(script.calls).toHaveLength(2);
  });

  it('tries at once when the page becomes visible, and not while it is still hidden', async () => {
    const script = scriptedFetch();
    script.answer(() => Promise.reject(new TypeError('offline')));
    script.answer(openStream());
    connection = connect('https://api.example/stream', { fetch: script.fetch, onEvent: () => {}, backoff: LONG_BACKOFF });
    await vi.advanceTimersByTimeAsync(1000);

    setHidden(true);
    document.dispatchEvent(new Event('visibilitychange'));
    await settle();
    expect(script.calls).toHaveLength(1);

    setHidden(false);
    document.dispatchEvent(new Event('visibilitychange'));
    await settle();

    expect(script.calls).toHaveLength(2);
  });

  it('tries at once when the browser comes back online even while the page is hidden', async () => {
    const script = scriptedFetch();
    script.answer(() => Promise.reject(new TypeError('offline')));
    script.answer(openStream());
    connection = connect('https://api.example/stream', { fetch: script.fetch, onEvent: () => {}, backoff: LONG_BACKOFF });
    await vi.advanceTimersByTimeAsync(1000);

    setHidden(true);
    window.dispatchEvent(new Event('online'));
    await settle();

    expect(script.calls).toHaveLength(2);
  });

  it('keeps a wait the server asked for', async () => {
    const script = scriptedFetch();
    script.answer(refusal(503, { 'retry-after': '30' }));
    script.answer(openStream());
    connection = connect('https://api.example/stream', { fetch: script.fetch, onEvent: () => {}, backoff: LONG_BACKOFF });
    await vi.advanceTimersByTimeAsync(1000);

    window.dispatchEvent(new Event('online'));
    document.dispatchEvent(new Event('visibilitychange'));
    await settle();

    expect(script.calls).toHaveLength(1);
  });

  it('lets a wait onError chooses end early when the tab becomes visible, if it asked for wakeOnResume', async () => {
    const script = scriptedFetch();
    script.answer(() => Promise.reject(new TypeError('offline')));
    script.answer(openStream());
    connection = connect('https://api.example/stream', {
      fetch: script.fetch,
      onEvent: () => {},
      onError: () => ({ retryAfterMs: 180_000, wakeOnResume: true }),
    });
    await vi.advanceTimersByTimeAsync(1000);

    setHidden(true);
    document.dispatchEvent(new Event('visibilitychange'));
    await settle();
    expect(script.calls).toHaveLength(1);
    setHidden(false);
    document.dispatchEvent(new Event('visibilitychange'));
    await settle();

    expect(script.calls).toHaveLength(2);
  });

  it('keeps the rest when wakeOnResume is anything but true', async () => {
    const script = scriptedFetch();
    script.answer(() => Promise.reject(new TypeError('offline')));
    script.answer(openStream());
    connection = connect('https://api.example/stream', {
      fetch: script.fetch,
      onEvent: () => {},
      onError: () => ({ retryAfterMs: 180_000, wakeOnResume: 'yes' as unknown as boolean }),
    });
    await vi.advanceTimersByTimeAsync(1000);

    window.dispatchEvent(new Event('online'));
    await settle();

    expect(script.calls).toHaveLength(1);
  });

  it('lets a wait onError chose end early when it asked for wakeOnResume', async () => {
    const script = scriptedFetch();
    script.answer(() => Promise.reject(new TypeError('offline')));
    script.answer(openStream());
    connection = connect('https://api.example/stream', {
      fetch: script.fetch,
      onEvent: () => {},
      onError: () => ({ retryAfterMs: 180_000, wakeOnResume: true }),
    });
    await vi.advanceTimersByTimeAsync(500);

    window.dispatchEvent(new Event('online'));
    await vi.advanceTimersByTimeAsync(499);
    expect(script.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);

    expect(script.calls).toHaveLength(2);
  });

  it('keeps a wait that onError asked for', async () => {
    const script = scriptedFetch();
    script.answer(() => Promise.reject(new TypeError('offline')));
    script.answer(openStream());
    connection = connect('https://api.example/stream', {
      fetch: script.fetch,
      onEvent: () => {},
      onError: () => ({ retryAfterMs: 180_000 }),
    });
    await vi.advanceTimersByTimeAsync(1000);

    window.dispatchEvent(new Event('online'));
    document.dispatchEvent(new Event('visibilitychange'));
    await settle();

    expect(script.calls).toHaveLength(1);
    connection.retryNow();
    await settle();
    expect(script.calls).toHaveLength(2);
  });

  it('counts the second from when the wait began, not from when the attempt did', async () => {
    const script = scriptedFetch();
    script.answer(
      (init) =>
        new Promise((_, reject) => init.signal!.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))),
    );
    script.answer(openStream());
    connection = connect('https://api.example/stream', { fetch: script.fetch, onEvent: () => {}, backoff: LONG_BACKOFF });
    // The attempt times out after 15 s and the wait begins.
    await vi.advanceTimersByTimeAsync(15_500);

    window.dispatchEvent(new Event('online'));
    await settle();
    expect(script.calls).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(600);
    window.dispatchEvent(new Event('online'));
    await settle();

    expect(script.calls).toHaveLength(2);
  });

  it('holds the browser back for the first second of a wait, so switching tabs is not a request each time', async () => {
    const script = scriptedFetch();
    script.answer(() => Promise.reject(new TypeError('offline')));
    script.answer(openStream());
    connection = connect('https://api.example/stream', { fetch: script.fetch, onEvent: () => {}, backoff: LONG_BACKOFF });
    await vi.advanceTimersByTimeAsync(500);

    // Sooner than that the retry is set for the end of the first second, once however many events come.
    window.dispatchEvent(new Event('online'));
    window.dispatchEvent(new Event('online'));
    await vi.advanceTimersByTimeAsync(499);
    expect(script.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);

    expect(script.calls).toHaveLength(2);
  });

  it('still hears the browser come back online where there is no document, as in a worker', async () => {
    vi.stubGlobal('document', undefined);
    const script = scriptedFetch();
    script.answer(() => Promise.reject(new TypeError('offline')));
    script.answer(openStream());
    connection = connect('https://api.example/stream', { fetch: script.fetch, onEvent: () => {}, backoff: LONG_BACKOFF });
    await vi.advanceTimersByTimeAsync(1000);

    window.dispatchEvent(new Event('online'));
    await settle();

    expect(script.calls).toHaveLength(2);
  });

  it('stops listening once the wait is over', async () => {
    const remove = vi.spyOn(window, 'removeEventListener');
    const script = scriptedFetch();
    script.answer(() => Promise.reject(new TypeError('offline')));
    script.answer(openStream());
    connection = connect('https://api.example/stream', { fetch: script.fetch, onEvent: () => {}, backoff: LONG_BACKOFF });
    await vi.advanceTimersByTimeAsync(1000);

    await vi.advanceTimersByTimeAsync(10_000);

    expect(remove).toHaveBeenCalledWith('online', expect.any(Function));
  });
});
