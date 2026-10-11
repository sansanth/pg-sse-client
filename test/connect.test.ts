import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { connect, StreamEndedEarly, StreamRefused, StreamTimeout, type ConnectOptions, type Connection } from '../src/connect';
import type { SseEvent } from '../src/parser';
import { openStream, refusal, scriptedFetch, settle } from './helpers';

let open: Connection[] = [];

// Starts a connection on a scripted fetch and records what it reports.
function start(script: ReturnType<typeof scriptedFetch>, extra: Partial<ConnectOptions> = {}, url: Parameters<typeof connect>[0] = 'https://api.example/stream') {
  const seen = {
    events: [] as SseEvent[],
    ends: [] as string[],
    errors: [] as Array<{ error: unknown; failures: number }>,
    opens: 0,
    disconnects: 0,
    closes: [] as unknown[],
  };
  const connection = connect(url, {
    fetch: script.fetch,
    onEvent: (event) => seen.events.push(event),
    onOpen: () => (seen.opens += 1),
    onDisconnect: () => (seen.disconnects += 1),
    onEnd: (reason) => seen.ends.push(reason),
    onError: (error, info) => {
      seen.errors.push({ error, failures: info.failures });
    },
    onClose: (error) => seen.closes.push(error),
    ...extra,
  });
  open.push(connection);
  return { connection, seen };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(Math, 'random').mockReturnValue(0.5);
});

afterEach(() => {
  for (const connection of open) connection.close();
  open = [];
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('the request', () => {
  it('calls a fetch it is given without a receiver, as fetch itself is called', async () => {
    const receivers: unknown[] = [];
    const holder = {
      fetch(this: unknown) {
        receivers.push(this);
        return Promise.resolve(openStream().response);
      },
    };
    start(scriptedFetch(), { fetch: holder.fetch as typeof fetch });
    await settle();

    expect(receivers).toEqual([undefined]);
  });

  it('sends the cursor it holds, not a Last-Event-ID of the headers option, and none when it holds none', async () => {
    const script = scriptedFetch();
    script.answer(openStream());
    script.answer(openStream());
    start(script, { headers: { 'Last-Event-ID': 'stale' } });
    start(script, { headers: { 'Last-Event-ID': 'stale' }, lastEventId: '7' });
    await settle();

    expect(script.calls[0]!.headers.has('last-event-id')).toBe(false);
    expect(script.calls[1]!.headers.get('last-event-id')).toBe('7');
  });

  it('passes the init option on, but never a body, and no cache mode of its own', async () => {
    const script = scriptedFetch();
    script.answer(openStream());
    script.answer(openStream());
    start(script);
    start(script, { init: { cache: 'no-store', credentials: 'include', body: 'x' } as ConnectOptions['init'] });
    await settle();

    expect(script.calls[0]!.init.cache).toBeUndefined();
    expect(script.calls[1]!.init).toMatchObject({ cache: 'no-store', credentials: 'include', method: 'GET', body: undefined });
  });

  it('asks for an event stream with a GET and no cursor the first time', async () => {
    const script = scriptedFetch();
    script.answer(openStream());

    start(script);
    await settle();

    expect(script.calls).toHaveLength(1);
    expect(script.calls[0]!.url).toBe('https://api.example/stream');
    expect(script.calls[0]!.init.method).toBe('GET');
    expect(script.calls[0]!.headers.get('accept')).toBe('text/event-stream');
    expect(script.calls[0]!.headers.has('last-event-id')).toBe(false);
  });

  it('starts from the cursor it is given', async () => {
    const script = scriptedFetch();
    script.answer(openStream());

    start(script, { lastEventId: '41' });
    await settle();

    expect(script.calls[0]!.headers.get('last-event-id')).toBe('41');
  });

  it('sends the headers it is given, and asks a function for them before every attempt', async () => {
    const script = scriptedFetch();
    const first = openStream();
    script.answer(first);
    script.answer(openStream());
    let token = 'one';

    start(script, { headers: async () => ({ Authorization: `Bearer ${token}` }) });
    await settle();
    token = 'two';
    first.end();
    await vi.advanceTimersByTimeAsync(5000);

    expect(script.calls.map((call) => call.headers.get('authorization'))).toEqual(['Bearer one', 'Bearer two']);
  });

  it('takes plain headers and keeps its own Accept', async () => {
    const script = scriptedFetch();
    script.answer(openStream());

    start(script, { headers: { 'X-Key': 'k', Accept: 'text/plain' } });
    await settle();

    expect(script.calls[0]!.headers.get('x-key')).toBe('k');
    expect(script.calls[0]!.headers.get('accept')).toBe('text/event-stream');
  });

  it('passes fetch options through but not over its own method or signal', async () => {
    const script = scriptedFetch();
    script.answer(openStream());

    start(script, { init: { credentials: 'include', method: 'POST' } as RequestInit });
    await settle();

    expect(script.calls[0]!.init.credentials).toBe('include');
    expect(script.calls[0]!.init.method).toBe('GET');
    expect(script.calls[0]!.init.signal).toBeInstanceOf(AbortSignal);
  });

  it("with cursorIn: 'url' hands the cursor to the url function and sends no Last-Event-ID header", async () => {
    const script = scriptedFetch();
    const first = openStream();
    script.answer(first);
    script.answer(openStream());
    start(script, { cursorIn: 'url' }, (cursor: string) => `https://api.example/stream?cursor=${encodeURIComponent(cursor)}`);
    await settle();

    first.send('id: 7\ndata: x\n\n');
    first.end();
    await vi.advanceTimersByTimeAsync(1250);

    expect(script.calls.map((call) => call.url)).toEqual([
      'https://api.example/stream?cursor=',
      'https://api.example/stream?cursor=7',
    ]);
    expect(script.calls.map((call) => call.headers.has('last-event-id'))).toEqual([false, false]);
  });

  it("gives a url function the lastEventId option first with cursorIn: 'url', and drops a Last-Event-ID of the headers option", async () => {
    const script = scriptedFetch();
    script.answer(openStream());
    start(
      script,
      { cursorIn: 'url', lastEventId: 'a&b=1', headers: { 'Last-Event-ID': 'stale' } },
      (cursor: string) => `https://api.example/stream?cursor=${encodeURIComponent(cursor)}`,
    );
    await settle();

    expect(script.calls[0]!.url).toBe('https://api.example/stream?cursor=a%26b%3D1');
    expect(script.calls[0]!.headers.has('last-event-id')).toBe(false);
  });

  it('gives a url function the cursor and sends the header too by default, whatever the function declares', async () => {
    const script = scriptedFetch();
    const first = openStream();
    script.answer(first);
    script.answer(openStream());
    const seenCursors: string[] = [];
    start(script, {}, (...args: string[]) => {
      seenCursors.push(args[0]!);
      return 'https://api.example/stream';
    });
    await settle();

    first.send('id: 7\ndata: x\n\n');
    first.end();
    await vi.advanceTimersByTimeAsync(1250);

    expect(seenCursors).toEqual(['', '7']);
    expect(script.calls[1]!.headers.get('last-event-id')).toBe('7');
  });

  it.each(['URL', 'query', '', null])('throws from connect for a cursorIn of %j, which TypeScript would refuse', (cursorIn) => {
    const options = { onEvent: () => {}, cursorIn } as unknown as ConnectOptions;

    expect(() => connect(() => 'https://api.example/stream', options)).toThrow(TypeError);
  });

  it("throws from connect for cursorIn: 'url' without a url function", () => {
    expect(() => connect('https://api.example/stream', { onEvent: () => {}, cursorIn: 'url' })).toThrow(TypeError);
  });

  it('asks a function for the url before every attempt', async () => {
    const script = scriptedFetch();
    const first = openStream();
    script.answer(first);
    script.answer(openStream());
    let n = 0;

    start(script, {}, (() => `https://api.example/stream?n=${(n += 1)}`) as never);
    await settle();
    first.end();
    await vi.advanceTimersByTimeAsync(5000);

    expect(script.calls.map((call) => call.url)).toEqual(['https://api.example/stream?n=1', 'https://api.example/stream?n=2']);
  });

  it('uses the global fetch when none is given, looked up when it is called', async () => {
    const script = scriptedFetch();
    script.answer(openStream());
    vi.stubGlobal('fetch', script.fetch);

    open.push(connect('https://api.example/stream', { onEvent: () => {} }));
    await settle();

    expect(script.calls).toHaveLength(1);
  });
});

describe('events', () => {
  it('reports the open, then each event with the cursor it carries', async () => {
    const script = scriptedFetch();
    const stream = openStream();
    script.answer(stream);
    const { connection, seen } = start(script);
    await settle();

    expect(seen.opens).toBe(1);
    stream.send(': ping\n\nid: 1\nevent: change\ndata: {"a":1}\n\nid: 2\ndata: b\n\n');
    await settle();

    expect(seen.events).toEqual([
      { event: 'change', data: '{"a":1}', id: '1' },
      { event: 'message', data: 'b', id: '2' },
    ]);
    expect(connection.lastEventId).toBe('2');
  });

  it('keeps the cursor an id-only frame set', async () => {
    const script = scriptedFetch();
    const stream = openStream();
    script.answer(stream);
    const { connection } = start(script);
    await settle();

    stream.send('id: 42\n\n');
    await settle();

    expect(connection.lastEventId).toBe('42');
  });

  it('moves the cursor event by event, so it is the event being handled inside the callback', async () => {
    const script = scriptedFetch();
    const stream = openStream();
    script.answer(stream);
    const seenInside: string[] = [];
    const holder: { connection?: Connection } = {};
    holder.connection = start(script, { onEvent: () => void seenInside.push(holder.connection!.lastEventId) }).connection;
    await settle();

    stream.send('id: 1\ndata: a\n\nid: 2\ndata: b\n\n');
    await settle();

    expect(seenInside).toEqual(['1', '2']);
    expect(holder.connection.lastEventId).toBe('2');
  });

  it('resumes after the event it was handling when it is closed in the middle of a chunk', async () => {
    const script = scriptedFetch();
    const stream = openStream();
    script.answer(stream);
    const holder: { connection?: Connection } = {};
    const delivered: string[] = [];
    holder.connection = start(script, {
      onEvent: (event) => {
        delivered.push(event.data);
        holder.connection!.close();
      },
    }).connection;
    await settle();

    stream.send('id: 1\ndata: a\n\nid: 2\ndata: b\n\n');
    await settle();

    expect(delivered).toEqual(['a']);
    expect(holder.connection.lastEventId).toBe('1');
  });

  it('frees the body, unread, when onOpen closes the connection', async () => {
    const script = scriptedFetch();
    const cancelled: unknown[] = [];
    const body = new ReadableStream<Uint8Array>({ cancel: (reason) => void cancelled.push(reason) });
    const holder: { connection?: Connection } = {};
    const { seen } = start(script, {
      fetch: async () => new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
      onOpen: () => holder.connection?.close(),
    });
    holder.connection = open[open.length - 1];
    await settle();

    expect(seen.closes).toEqual([undefined]);
    expect(cancelled).toHaveLength(1);
  });

  it('does not reconnect when the goodbye callback closes the connection', async () => {
    const script = scriptedFetch();
    const first = openStream();
    script.answer(first);
    script.answer(openStream());
    const holder: { connection?: Connection } = {};
    const { seen } = start(script, { onEnd: () => holder.connection!.close() });
    holder.connection = open[open.length - 1];
    await settle();

    first.send('retry: 1000\nevent: end\ndata: {"reason":"max_age"}\n\n');
    await vi.advanceTimersByTimeAsync(60_000);

    expect(script.calls).toHaveLength(1);
    expect(seen.closes).toEqual([undefined]);
    expect(seen.errors).toEqual([]);
  });

  it('does not move the cursor past frames it dropped after the goodbye', async () => {
    const script = scriptedFetch();
    const first = openStream();
    script.answer(first);
    script.answer(openStream());
    const { seen, connection } = start(script);
    await settle();

    first.send('id: 1\ndata: a\n\nretry: 1000\nevent: end\ndata: {"reason":"max_age"}\n\nid: 42\ndata: late\n\n');
    await vi.advanceTimersByTimeAsync(1000);

    expect(seen.events.map((event) => event.data)).toEqual(['a']);
    expect(connection.lastEventId).toBe('1');
    expect(script.calls[1]!.headers.get('last-event-id')).toBe('1');
  });

  it('follows an id-only frame that ends a chunk once the events before it are handed over', async () => {
    const script = scriptedFetch();
    const stream = openStream();
    script.answer(stream);
    const { connection } = start(script);
    await settle();

    stream.send('id: 1\ndata: a\n\nid: 2\n\n');
    await settle();
    expect(connection.lastEventId).toBe('2');

    stream.send('id: 3\n\ndata: b\n\nid: 4\n\n');
    await settle();
    expect(connection.lastEventId).toBe('4');
  });

  it('ignores a lastEventId option that cannot be a header value', async () => {
    const script = scriptedFetch();
    script.answer(openStream());
    const { connection } = start(script, { lastEventId: 'a\nb' });
    await settle();

    expect(script.calls[0]!.headers.has('last-event-id')).toBe(false);
    expect(connection.lastEventId).toBe('');
  });

  it('sends a cursor outside Latin-1 as its UTF-8 bytes instead of failing every attempt', async () => {
    const script = scriptedFetch();
    const first = openStream();
    script.answer(first);
    script.answer(openStream());
    const { seen } = start(script);
    await settle();

    first.send('id: 2026€1\ndata: x\n\n');
    first.end();
    await vi.advanceTimersByTimeAsync(1250);

    expect(seen.errors).toEqual([expect.objectContaining({ failures: 1 })]);
    expect(script.calls).toHaveLength(2);
    expect(script.calls[1]!.headers.get('last-event-id')).toBe('2026\u00e2\u0082\u00ac1');
  });

  it('times out a headers function that never settles, and tries it again', async () => {
    const script = scriptedFetch();
    script.answer(openStream());
    let calls = 0;
    const { seen } = start(script, {
      headers: () => (++calls === 1 ? new Promise<HeadersInit>(() => {}) : {}),
    });
    await settle();
    await vi.advanceTimersByTimeAsync(15_000);

    expect(seen.errors).toEqual([{ error: new StreamTimeout('connect'), failures: 1 }]);
    await vi.advanceTimersByTimeAsync(750);
    expect(script.calls).toHaveLength(1);
    expect(seen.opens).toBe(1);
  });

  it('ends a headers function that never settles when the connection is closed', async () => {
    const script = scriptedFetch();
    const { connection, seen } = start(script, { headers: () => new Promise<HeadersInit>(() => {}) });
    await settle();

    connection.close();
    await settle();

    expect(seen.closes).toEqual([undefined]);
    expect(seen.errors).toEqual([]);
    expect(script.calls).toHaveLength(0);
  });

  it('counts how long a stream lasted from when it opened, not from when the attempt began', async () => {
    const script = scriptedFetch();
    const slow = openStream();
    script.answer(() => new Promise((resolve) => setTimeout(() => resolve(slow.response), 6000)));
    script.answer(openStream());
    const { seen } = start(script);
    await vi.advanceTimersByTimeAsync(6000);
    slow.end();
    await settle();

    expect(seen.errors).toEqual([{ error: new StreamEndedEarly(0, null), failures: 1 }]);
  });

  it('counts a stream that failed after it had been open for a while as the first failure again', async () => {
    const script = scriptedFetch();
    script.answer(refusal(503));
    const second = openStream();
    script.answer(second);
    script.answer(openStream());
    const { seen } = start(script);
    await settle();
    await vi.advanceTimersByTimeAsync(750);
    await vi.advanceTimersByTimeAsync(6000);
    second.fail();
    await settle();

    expect(seen.errors.map((entry) => entry.failures)).toEqual([1, 1]);
  });

  it('does not take a refusal that was slow to arrive for a healthy stream that failed', async () => {
    const script = scriptedFetch();
    script.answer(refusal(503));
    script.answer(() => new Promise((resolve) => setTimeout(() => resolve(refusal(503)), 65_000)));
    const { seen } = start(script, { connectTimeoutMs: 120_000 });
    await settle();
    await vi.advanceTimersByTimeAsync(750 + 65_000);

    expect(seen.errors.map((entry) => entry.failures)).toEqual([1, 2]);
  });

  it('times out a fetch that ignores the abort signal', async () => {
    const script = scriptedFetch();
    const { seen } = start(script, { fetch: () => new Promise<Response>(() => {}) });
    await settle();
    await vi.advanceTimersByTimeAsync(15_000);

    expect(seen.errors).toEqual([{ error: new StreamTimeout('connect'), failures: 1 }]);
  });

  it('tells onError about an attempt that failed with undefined, and honours what it answers', async () => {
    const script = scriptedFetch();
    const { seen } = start(script, {
      fetch: () => Promise.reject(undefined),
      onError: (error) => {
        seen.errors.push({ error, failures: 0 });
        return 'stop';
      },
    });
    await settle();

    expect(seen.errors).toEqual([{ error: undefined, failures: 0 }]);
    expect(seen.closes).toEqual([undefined]);
  });

  it('stops on a 401 when onError returns a wait that is not a number', async () => {
    const script = scriptedFetch();
    script.answer(refusal(401));
    const { seen } = start(script, { onError: () => ({ retryAfterMs: Number.NaN }) });
    await settle();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(script.calls).toHaveLength(1);
    expect(seen.closes).toEqual([new StreamRefused(401)]);
  });

  it('frees a response a fetch that ignored the abort signal gives after the timeout', async () => {
    const script = scriptedFetch();
    const cancelled: unknown[] = [];
    const body = new ReadableStream<Uint8Array>({ cancel: (reason) => void cancelled.push(reason) });
    start(script, {
      fetch: () =>
        new Promise<Response>((resolve) =>
          setTimeout(() => resolve(new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })), 20_000),
        ),
    });
    await settle();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(cancelled).toEqual([]);
    await vi.advanceTimersByTimeAsync(5000);

    expect(cancelled).toHaveLength(1);
  });

  it('times out a stream whose body ignores the abort signal and frees it, and so with a fetch that closes the connection itself', async () => {
    const script = scriptedFetch();
    const cancelled: unknown[] = [];
    const body = new ReadableStream<Uint8Array>({ cancel: (reason) => void cancelled.push(reason) });
    const { seen } = start(script, {
      fetch: async () => new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
    });
    await settle();
    await vi.advanceTimersByTimeAsync(45_000);

    expect(seen.errors[0]).toEqual({ error: new StreamTimeout('idle'), failures: 1 });
    expect(cancelled).toHaveLength(1);

    const holder: { connection?: Connection } = {};
    const calls: number[] = [];
    const closing = start(script, {
      headers: async () => ({}),
      fetch: () => {
        calls.push(1);
        holder.connection?.close();
        return new Promise<Response>(() => {});
      },
    });
    holder.connection = closing.connection;
    await settle();

    expect(calls).toEqual([1]);
    expect(closing.seen.closes).toEqual([undefined]);
  });

  it.each([Number.POSITIVE_INFINITY, 3e9])('takes an idle timeout of %s as none, without a timer that fires over and over', async (idleTimeoutMs) => {
    const script = scriptedFetch();
    script.answer(openStream());
    const { seen } = start(script, { idleTimeoutMs });
    await settle();
    await vi.advanceTimersByTimeAsync(3_600_000);

    expect(seen.errors).toEqual([]);
    expect(seen.opens).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([Number.NaN, -1])('uses the default connect timeout for %s', async (connectTimeoutMs) => {
    const script = scriptedFetch();
    const { seen } = start(script, { connectTimeoutMs, fetch: () => new Promise<Response>(() => {}) });
    await settle();
    await vi.advanceTimersByTimeAsync(14_999);
    expect(seen.errors).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);

    expect(seen.errors).toEqual([{ error: new StreamTimeout('connect'), failures: 1 }]);
  });

  it.each([-1, Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY])('keeps the default of a backoff entry of %s', async (value) => {
    const script = scriptedFetch();
    script.answer(refusal(503));
    script.answer(openStream());
    start(script, { backoff: { baseMs: value } });
    await settle();
    expect(script.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(750);

    expect(script.calls).toHaveLength(2);
  });

  it('keeps the default of a backoff entry that is undefined or NaN', async () => {
    const script = scriptedFetch();
    script.answer(refusal(503));
    script.answer(openStream());
    start(script, { backoff: { baseMs: undefined, maxMs: Number.NaN } });
    await settle();
    expect(script.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(750);

    expect(script.calls).toHaveLength(2);
  });

  it('gives what a callback threw to onCallbackError, and logs what onCallbackError throws', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const script = scriptedFetch();
    const stream = openStream();
    script.answer(stream);
    const reported: unknown[] = [];
    const { seen } = start(script, {
      onEvent: (event) => {
        throw new Error(`bug in ${event.data}`);
      },
      onCallbackError: (error) => {
        reported.push(error);
        if (reported.length === 2) throw new Error('sink bug');
      },
    });
    await settle();

    stream.send('data: a\n\ndata: b\n\n');
    await settle();

    expect(reported).toEqual([new Error('bug in a'), new Error('bug in b')]);
    expect(logged).toHaveBeenCalledExactlyOnceWith(new Error('sink bug'));
    expect(seen.opens).toBe(1);
  });

  it('leaves a relative URL to a fetch it is given, which may read it its own way', () => {
    const script = scriptedFetch();

    expect(() => connect('/events', { fetch: script.fetch, onEvent: () => {} })).not.toThrow();
    expect(() => connect('/events', { onEvent: () => {} })).toThrow(TypeError);
  });

  it('reads a goodbye whose data is a JSON string as the reason', async () => {
    const script = scriptedFetch();
    const first = openStream();
    script.answer(first);
    const { seen } = start(script);
    await settle();

    first.send('retry: 1000\nevent: end\ndata: "shutdown"\n\n');
    await settle();

    expect(seen.ends).toEqual(['shutdown']);
  });

  it('reads a goodbye whose data is JSON null as having no reason', async () => {
    const script = scriptedFetch();
    const first = openStream();
    script.answer(first);
    const { seen } = start(script);
    await settle();

    first.send('retry: 1000\nevent: end\ndata: null\n\n');
    await settle();

    expect(seen.ends).toEqual(['unknown']);
  });

  it('calls onClose with no argument at all when close() ends the connection', async () => {
    const script = scriptedFetch();
    script.answer(openStream());
    const argumentCounts: number[] = [];
    const { connection } = start(script, { onClose: (...args: unknown[]) => void argumentCounts.push(args.length) });
    await settle();

    connection.close();

    expect(argumentCounts).toEqual([0]);
  });

  it('fails at once on headers given as a value that cannot be sent, and not on a function that returns them', () => {
    const never = () => new Promise<Response>(() => {});

    expect(() => connect('https://api.example/stream', { onEvent: () => {}, headers: { 'bad name': 'x' } })).toThrow(TypeError);
    expect(() => connect('https://api.example/stream', { onEvent: () => {}, headers: () => ({ 'bad name': 'x' }), fetch: never }).close()).not.toThrow();
  });

  it('fails at once on a URL that can never be fetched', async () => {
    const script = scriptedFetch();

    expect(() => connect('not a url', { onEvent: () => {} })).toThrow(TypeError);
    expect(() => connect('localhost:3000/stream', { onEvent: () => {} })).toThrow(TypeError);
    expect(() => connect('ftp://api.example/stream', { onEvent: () => {} })).toThrow(TypeError);
    expect(() => connect(new URL('https://api.example/stream'), { fetch: () => new Promise<Response>(() => {}), onEvent: () => {} }).close()).not.toThrow();
    expect(script.calls).toHaveLength(0);
  });

  it('rethrows a callback error on its own in a worker, as in a page', async () => {
    vi.stubGlobal('WorkerGlobalScope', class {});
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
    start(script, {
      onEvent: () => {
        throw new Error('handler bug');
      },
    });
    await settle();

    stream.send('data: a\n\n');
    await settle();

    expect(thrown).toEqual([new Error('handler bug')]);
  });

  it('gives the rejection of an async callback to onCallbackError, called as a method of the options like the others', async () => {
    const script = scriptedFetch();
    const stream = openStream();
    script.answer(stream);
    const reported: unknown[] = [];
    start(script, {
      onEvent: async () => {
        throw new Error('async bug');
      },
      onOpen: () => Promise.reject(new Error('async open')),
      onCallbackError(this: unknown, error: unknown) {
        reported.push([this === undefined ? 'detached' : 'method', error]);
      },
    });
    await settle();

    stream.send('data: a\n\n');
    await settle();

    expect(reported).toEqual([
      ['method', new Error('async open')],
      ['method', new Error('async bug')],
    ]);
  });

  it('delivers the events before an event that passes maxEventChars, then fails with SseEventTooLarge and stops', async () => {
    const script = scriptedFetch();
    const first = openStream();
    script.answer(first);
    script.answer(openStream());
    const { seen, connection } = start(script, { maxEventChars: 50 });
    await settle();

    first.send(`id: 1\ndata: ok\n\ndata: ${'x'.repeat(60)}`);
    await settle();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(seen.events.map((event) => event.data)).toEqual(['ok']);
    const tooLarge = expect.objectContaining({ name: 'SseEventTooLarge', limit: 50 });
    expect(seen.errors).toEqual([{ error: tooLarge, failures: 1 }]);
    // The same event would come again from the same cursor, so the default is to stop.
    expect(seen.closes).toEqual([tooLarge]);
    expect(script.calls).toHaveLength(1);
    expect(connection.lastEventId).toBe('1');
  });

  it('logs what an async onCallbackError rejects with, as it logs what one throws', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const script = scriptedFetch();
    const stream = openStream();
    script.answer(stream);
    start(script, {
      onEvent: () => {
        throw new Error('handler bug');
      },
      onCallbackError: async () => {
        throw new Error('sentry down');
      },
    });
    await settle();

    stream.send('data: a\n\n');
    await settle();

    expect(logged).toHaveBeenCalledExactlyOnceWith(new Error('sentry down'));
  });

  it('reports a throw from any lifecycle callback too, and goes on', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const script = scriptedFetch();
    const first = openStream();
    script.answer(first);
    script.answer(openStream());
    const bug = (name: string) => () => {
      throw new Error(`${name} bug`);
    };
    const { connection, seen } = start(script, {
      onOpen: bug('open'),
      onEnd: bug('end'),
      onDisconnect: bug('disconnect'),
      onClose: bug('close'),
    });
    await settle();

    first.send('retry: 1000\nevent: end\ndata: {"reason":"max_age"}\n\n');
    await vi.advanceTimersByTimeAsync(1000);
    connection.close();

    expect(seen.ends).toEqual([]);
    expect(script.calls).toHaveLength(2);
    expect(logged.mock.calls.map(([error]) => (error as Error).message)).toEqual(['open bug', 'end bug', 'disconnect bug', 'open bug', 'close bug']);
  });

  it('keeps reading when a callback throws, and logs the error where there is no page to rethrow it to', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const script = scriptedFetch();
    const stream = openStream();
    script.answer(stream);
    const delivered: string[] = [];
    start(script, {
      onEvent: (event) => {
        delivered.push(event.data);
        if (event.data === 'a') throw new Error('handler bug');
      },
    });
    await settle();

    stream.send('data: a\n\ndata: b\n\n');
    await settle();

    expect(delivered).toEqual(['a', 'b']);
    expect(logged).toHaveBeenCalledExactlyOnceWith(new Error('handler bug'));
  });
});

describe('a stream that ends', () => {
  it('reconnects with the cursor after the wait the server asked for', async () => {
    const script = scriptedFetch();
    const first = openStream();
    script.answer(first);
    script.answer(openStream());
    start(script);
    await settle();

    first.send('id: 7\ndata: x\n\nretry: 3000\n\n');
    await vi.advanceTimersByTimeAsync(10_000);
    first.end();
    await vi.advanceTimersByTimeAsync(2999);
    expect(script.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);

    expect(script.calls).toHaveLength(2);
    expect(script.calls[1]!.headers.get('last-event-id')).toBe('7');
  });

  it('waits between half a second and two when the server named no delay', async () => {
    const script = scriptedFetch();
    const first = openStream();
    script.answer(first);
    script.answer(openStream());
    start(script);
    await settle();

    await vi.advanceTimersByTimeAsync(10_000);
    first.end();
    // random() is 0.5: 500 + 0.5 * 1500
    await vi.advanceTimersByTimeAsync(1249);
    expect(script.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);

    expect(script.calls).toHaveLength(2);
  });

  it('reports the goodbye reason, hides the end event from onEvent and reconnects at the server delay', async () => {
    const script = scriptedFetch();
    const first = openStream();
    script.answer(first);
    script.answer(openStream());
    const { seen } = start(script);
    await settle();

    first.send('id: 3\ndata: x\n\nretry: 4000\nevent: end\ndata: {"reason":"shutdown"}\n\n');
    await vi.advanceTimersByTimeAsync(3999);
    expect(seen.ends).toEqual(['shutdown']);
    expect(seen.events.map((event) => event.data)).toEqual(['x']);
    expect(script.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);

    expect(script.calls).toHaveLength(2);
    expect(script.calls[1]!.headers.get('last-event-id')).toBe('3');
  });

  it('stops reading the old stream at the goodbye', async () => {
    const script = scriptedFetch();
    const first = openStream();
    script.answer(first);
    const { seen } = start(script);
    await settle();

    first.send('retry: 60000\nevent: end\ndata: {"reason":"max_age"}\n\ndata: late\n\n');
    await settle();

    expect(seen.events).toEqual([]);
  });

  it('counts a goodbye after a short stream as a failure, so a hot loop backs off', async () => {
    const script = scriptedFetch();
    const first = openStream();
    script.answer(first);
    script.answer(openStream());
    const { seen } = start(script);
    await settle();

    first.send('retry: 1000\nevent: end\ndata: {"reason":"behind"}\n\n');
    await vi.advanceTimersByTimeAsync(1000);

    expect(seen.ends).toEqual(['behind']);
    expect(script.calls).toHaveLength(2);
  });

  it('floors the wait at the delay of a goodbye however short the stream was', async () => {
    const script = scriptedFetch();
    const first = openStream();
    script.answer(first);
    script.answer(openStream());
    start(script);
    await settle();

    first.send('retry: 30000\nevent: end\ndata: {"reason":"shutdown"}\n\n');
    await vi.advanceTimersByTimeAsync(29_999);
    expect(script.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);

    expect(script.calls).toHaveLength(2);
  });

  it('listens for the end event name it is given, and reads data that is not JSON as the reason', async () => {
    const script = scriptedFetch();
    const first = openStream();
    script.answer(first);
    const { seen } = start(script, { endEvent: 'reconnect' });
    await settle();

    first.send('event: reconnect\ndata: age\n\n');
    await settle();

    expect(seen.ends).toEqual(['age']);
  });

  it('calls the reason unknown when the end event has none', async () => {
    const script = scriptedFetch();
    const first = openStream();
    script.answer(first);
    const { seen } = start(script);
    await settle();

    first.send('event: end\ndata: {"other":1}\n\n');
    await settle();
    expect(seen.ends).toEqual(['unknown']);
  });

  it('calls the reason unknown when the end event has no data to read', async () => {
    const script = scriptedFetch();
    const first = openStream();
    script.answer(first);
    const { seen } = start(script);
    await settle();

    first.send('event: end\ndata:\n\n');
    await settle();
    expect(seen.ends).toEqual(['unknown']);
  });
});

describe('failures', () => {
  it('backs off exponentially with jitter, up to the cap', async () => {
    const script = scriptedFetch();
    for (let i = 0; i < 8; i += 1) script.answer(() => Promise.reject(new TypeError('offline')));
    const { seen } = start(script);
    await settle();

    // random() is 0.5, so each wait is 0.75 of the doubling base: 750, 1500, 3000, ...
    const waits: number[] = [];
    for (let i = 0; i < 7; i += 1) {
      const before = script.calls.length;
      let waited = 0;
      while (script.calls.length === before) {
        await vi.advanceTimersByTimeAsync(10);
        waited += 10;
      }
      waits.push(waited);
    }

    expect(waits).toEqual([750, 1500, 3000, 6000, 12_000, 22_500, 22_500]);
    expect(seen.errors.slice(0, 7).map((entry) => entry.failures)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it('waits less with low jitter and more with high', async () => {
    for (const [random, expected] of [
      [0, 500],
      [0.999, 999],
    ] as const) {
      vi.spyOn(Math, 'random').mockReturnValue(random);
      const script = scriptedFetch();
      script.answer(() => Promise.reject(new TypeError('offline')));
      script.answer(openStream());
      start(script);
      await settle();

      await vi.advanceTimersByTimeAsync(expected - 1);
      expect(script.calls).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(script.calls).toHaveLength(2);
      for (const connection of open) connection.close();
    }
  });

  it('starts again after a stream that stayed open long enough, whatever ended it', async () => {
    const script = scriptedFetch();
    const first = openStream();
    script.answer(first);
    script.answer(openStream());
    const { seen } = start(script);
    await settle();

    for (let i = 0; i < 3; i += 1) {
      await vi.advanceTimersByTimeAsync(21_000);
      first.send(': ping\n\n');
    }
    first.fail();
    // The count started again, so this is the first failure: the first backoff, 1000 * (0.5 + 0.5 / 2).
    await vi.advanceTimersByTimeAsync(750);

    expect(seen.errors[0]!.failures).toBe(1);
    expect(script.calls).toHaveLength(2);
  });

  it('counts a stream that opened and then broke at once as a failure', async () => {
    const script = scriptedFetch();
    const first = openStream();
    script.answer(first);
    const { seen } = start(script);
    await settle();

    first.fail();
    await settle();

    expect(seen.errors.map((entry) => entry.failures)).toEqual([1]);
  });

  it('counts clean closes within a few seconds of opening as failures and resets after a long one', async () => {
    const script = scriptedFetch();
    const streams = [openStream(), openStream(), openStream()];
    for (const stream of streams) script.answer(stream);
    script.answer(openStream());
    const { seen } = start(script);
    await settle();

    streams[0]!.end();
    await vi.advanceTimersByTimeAsync(750);
    streams[1]!.end();
    await vi.advanceTimersByTimeAsync(1500);
    expect(script.calls).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(6000);
    streams[2]!.end();
    // The third stream lasted over 5 s, so the wait is the plain reconnect pause again.
    await vi.advanceTimersByTimeAsync(1250);

    expect(script.calls).toHaveLength(4);
    expect(seen.errors.map((entry) => entry.failures)).toEqual([1, 2]);
    expect(seen.errors.every((entry) => entry.error instanceof StreamEndedEarly)).toBe(true);
  });

  it('tells onError how long a stream that closed early lasted, and the goodbye it came with', async () => {
    const script = scriptedFetch();
    const closed = openStream();
    const goodbye = openStream();
    script.answer(closed);
    script.answer(goodbye);
    const { seen } = start(script);
    await settle();

    await vi.advanceTimersByTimeAsync(1200);
    closed.end();
    await vi.advanceTimersByTimeAsync(750);
    goodbye.send('retry: 1000\nevent: end\ndata: {"reason":"behind"}\n\n');
    await settle();

    expect(seen.errors.map((entry) => entry.error)).toEqual([
      new StreamEndedEarly(1200, null),
      new StreamEndedEarly(0, 'behind'),
    ]);
    expect(seen.errors.map((entry) => (entry.error as StreamEndedEarly).reason)).toEqual([null, 'behind']);
    expect((seen.errors[0]!.error as StreamEndedEarly).lastedMs).toBe(1200);
  });

  it('lets onError stop a server that keeps closing early', async () => {
    const script = scriptedFetch();
    const stream = openStream();
    script.answer(stream);
    const { seen } = start(script, { onError: () => 'stop' });
    await settle();

    stream.end();
    await vi.advanceTimersByTimeAsync(120_000);

    expect(script.calls).toHaveLength(1);
    expect(seen.closes[0]).toBeInstanceOf(StreamEndedEarly);
  });

  it('ends quietly when onError closes the connection', async () => {
    const script = scriptedFetch();
    script.answer(refusal(500));
    const { connection, seen } = start(script, { onError: () => connection.close() });
    await settle();
    await vi.advanceTimersByTimeAsync(120_000);

    expect(script.calls).toHaveLength(1);
    expect(seen.closes).toEqual([undefined]);
  });

  it('reports a non-2xx answer as a refusal carrying the status', async () => {
    const script = scriptedFetch();
    script.answer(refusal(500));
    const { seen } = start(script);
    await settle();

    expect(seen.errors[0]!.error).toBeInstanceOf(StreamRefused);
    expect(seen.errors[0]!.error).toMatchObject({ status: 500, retryAfterMs: null, name: 'StreamRefused' });
  });

  it('waits at least as long as a Retry-After in seconds', async () => {
    const script = scriptedFetch();
    script.answer(refusal(503, { 'retry-after': '30' }));
    script.answer(openStream());
    start(script);
    await settle();

    // The server's 30 s and a spread of 750 ms, which is the random half of 1500.
    await vi.advanceTimersByTimeAsync(30_749);
    expect(script.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);

    expect(script.calls).toHaveLength(2);
  });

  it('waits as long as a timer can for a Retry-After too long for one, instead of retrying at once', async () => {
    const script = scriptedFetch();
    script.answer(refusal(503, { 'retry-after': '3000000' }));
    script.answer(openStream());
    start(script, { backoff: { serverMaxMs: 1e12 } });
    await settle();

    await vi.advanceTimersByTimeAsync(3e9 + 749);
    expect(script.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);

    expect(script.calls).toHaveLength(2);
  });

  it('waits exactly as long as onError says, however long that is for one timer', async () => {
    const script = scriptedFetch();
    script.answer(refusal(503));
    script.answer(openStream());
    const forty = 40 * 86_400_000;
    start(script, { onError: () => ({ retryAfterMs: forty }) });
    await settle();

    await vi.advanceTimersByTimeAsync(forty - 1);
    expect(script.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);

    expect(script.calls).toHaveLength(2);
  });

  it('does not wait longer than serverMaxMs on a Retry-After or a retry:', async () => {
    const script = scriptedFetch();
    script.answer(refusal(503, { 'retry-after': '86400' }));
    const second = openStream();
    script.answer(second);
    script.answer(openStream());
    start(script);
    await settle();

    await vi.advanceTimersByTimeAsync(3_600_749);
    expect(script.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(script.calls).toHaveLength(2);

    second.send('retry: 99999999999\nevent: end\ndata: {"reason":"max_age"}\n\n');
    await vi.advanceTimersByTimeAsync(3_599_999);
    expect(script.calls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);

    expect(script.calls).toHaveLength(3);
  });

  it('does the same for a retry: too long for a timer', async () => {
    const script = scriptedFetch();
    const first = openStream();
    script.answer(first);
    script.answer(openStream());
    start(script, { backoff: { serverMaxMs: 1e12 } });
    await settle();

    first.send('retry: 99999999999\nevent: end\ndata: {"reason":"max_age"}\n\n');
    await vi.advanceTimersByTimeAsync(99_999_999_999 - 1);
    expect(script.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);

    expect(script.calls).toHaveLength(2);
  });

  it('keeps the last retry: as the floor of every wait after it, a failure or a close', async () => {
    const script = scriptedFetch();
    const first = openStream();
    script.answer(first);
    script.answer(() => Promise.reject(new TypeError('offline')));
    const second = openStream();
    script.answer(second);
    script.answer(openStream());
    start(script);
    await settle();

    first.send('retry: 10000\ndata: x\n\n');
    await vi.advanceTimersByTimeAsync(6000);
    first.end();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(script.calls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(9999);
    expect(script.calls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(script.calls).toHaveLength(3);

    // A clean end whose stream sent no retry: the usual 500 to 2000 ms would be shorter than the 10 s the server asked for.
    await vi.advanceTimersByTimeAsync(6000);
    second.end();
    await vi.advanceTimersByTimeAsync(9999);
    expect(script.calls).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(1);
    expect(script.calls).toHaveLength(4);
  });

  it('reads a Retry-After of more digits than a number holds as the largest wait, not Infinity', async () => {
    const script = scriptedFetch();
    script.answer(refusal(503, { 'retry-after': '9'.repeat(400) }));
    const { seen } = start(script);
    await settle();

    expect(seen.errors[0]!.error).toMatchObject({ retryAfterMs: Number.MAX_SAFE_INTEGER });
  });

  it('reads a Retry-After with a numeric offset as the instant it names, not as GMT', async () => {
    const script = scriptedFetch();
    const at = new Date(Date.now() + 20_000 + 2 * 3_600_000);
    const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const pad = (n: number) => String(n).padStart(2, '0');
    const withOffset = `${days[at.getUTCDay()]}, ${pad(at.getUTCDate())} ${months[at.getUTCMonth()]} ${at.getUTCFullYear()} ${pad(at.getUTCHours())}:${pad(at.getUTCMinutes())}:${pad(at.getUTCSeconds())} +0200`;
    script.answer(refusal(503, { 'retry-after': withOffset }));
    const { seen } = start(script);
    await settle();

    const { retryAfterMs } = seen.errors[0]!.error as StreamRefused;
    expect(retryAfterMs).toBeGreaterThan(18_999);
    expect(retryAfterMs).toBeLessThanOrEqual(20_000);
  });

  it('reads a Retry-After in a dashed form with no zone as GMT too', async () => {
    const script = scriptedFetch();
    const at = new Date(Date.now() + 20_000);
    const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const pad = (n: number) => String(n).padStart(2, '0');
    const dashed = `${days[at.getUTCDay()]}, ${pad(at.getUTCDate())}-${months[at.getUTCMonth()]}-${at.getUTCFullYear()} ${pad(at.getUTCHours())}:${pad(at.getUTCMinutes())}:${pad(at.getUTCSeconds())}`;
    script.answer(refusal(503, { 'retry-after': dashed }));
    const { seen } = start(script);
    await settle();

    const { retryAfterMs } = seen.errors[0]!.error as StreamRefused;
    expect(retryAfterMs).toBeGreaterThan(18_999);
    expect(retryAfterMs).toBeLessThanOrEqual(20_000);
  });

  it('reads a Retry-After in the asctime form, which has no zone, as GMT', async () => {
    const script = scriptedFetch();
    const at = new Date(Date.now() + 20_000);
    const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const pad = (n: number) => String(n).padStart(2, '0');
    const asctime = `${days[at.getUTCDay()]} ${months[at.getUTCMonth()]} ${String(at.getUTCDate()).padStart(2)} ${pad(at.getUTCHours())}:${pad(at.getUTCMinutes())}:${pad(at.getUTCSeconds())} ${at.getUTCFullYear()}`;
    script.answer(refusal(503, { 'retry-after': asctime }));
    const { seen } = start(script);
    await settle();

    const { retryAfterMs } = seen.errors[0]!.error as StreamRefused;
    expect(retryAfterMs).toBeGreaterThan(18_999);
    expect(retryAfterMs).toBeLessThanOrEqual(20_000);
  });

  it('reads a Retry-After that is a date', async () => {
    const script = scriptedFetch();
    script.answer(refusal(503, { 'retry-after': new Date(Date.now() + 20_000).toUTCString() }));
    start(script);
    await settle();

    expect(script.fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(18_999);
    expect(script.fetch).toHaveBeenCalledTimes(1);
  });

  it('ignores a Retry-After it cannot read, and one already in the past', async () => {
    const script = scriptedFetch();
    script.answer(refusal(503, { 'retry-after': 'soon' }));
    script.answer(refusal(503, { 'retry-after': new Date(Date.now() - 60_000).toUTCString() }));
    const { seen } = start(script);
    await settle();

    expect(seen.errors[0]!.error).toMatchObject({ retryAfterMs: null });
    await vi.advanceTimersByTimeAsync(750);
    expect(seen.errors[1]!.error).toMatchObject({ retryAfterMs: 0 });
  });

  it.each(['1.5', '12 5', '-1', 'May 5', 'Sep 1 2099', 'Mon, 99 Foo 2020 99:99:99 GMT'])('does not read a Retry-After of %s as a date', async (value) => {
    const script = scriptedFetch();
    script.answer(refusal(503, { 'retry-after': value }));
    const { seen } = start(script);
    await settle();

    expect(seen.errors[0]!.error).toMatchObject({ retryAfterMs: null });
  });

  it('refuses an answer that is not an event stream', async () => {
    const script = scriptedFetch();
    script.answer(new Response('<html>', { status: 200, headers: { 'content-type': 'text/html' } }));
    script.answer(new Response(null, { status: 200, headers: { 'content-type': 'text/event-stream' } }));
    const errors: unknown[] = [];
    const { seen } = start(script, {
      onError: (error) => {
        errors.push(error);
        return 'retry';
      },
    });
    await settle();
    await vi.advanceTimersByTimeAsync(750);

    expect(errors).toEqual([
      new StreamRefused(200, null, 'The response is not an event stream'),
      new StreamRefused(200, null, "The response has no body to read: this runtime's fetch does not stream"),
    ]);
    expect(seen.opens).toBe(0);
  });

  it('refuses an answer that names no content type, and still refuses one whose body cannot be cancelled', async () => {
    const script = scriptedFetch();
    const stubborn = new ReadableStream<Uint8Array>({
      cancel() {
        throw new Error('cannot cancel');
      },
    });
    script.answer(new Response(new ReadableStream<Uint8Array>(), { status: 200 }));
    script.answer(new Response(stubborn, { status: 502 }));
    const errors: unknown[] = [];
    start(script, {
      onError: (error) => {
        errors.push(error);
        return 'retry';
      },
    });
    await settle();
    await vi.advanceTimersByTimeAsync(750);

    expect(errors).toEqual([
      new StreamRefused(200, null, 'The response is not an event stream'),
      new StreamRefused(502),
    ]);
  });

  it('retries when the headers function fails', async () => {
    const script = scriptedFetch();
    script.answer(openStream());
    let calls = 0;
    const { seen } = start(script, {
      headers: async () => {
        calls += 1;
        if (calls === 1) throw new Error('no token yet');
        return {};
      },
    });
    await settle();
    await vi.advanceTimersByTimeAsync(750);

    expect(seen.errors[0]!.error).toEqual(new Error('no token yet'));
    expect(script.calls).toHaveLength(1);
    expect(seen.opens).toBe(1);
  });
});

describe('the policy for an error', () => {
  it.each([400, 401, 403, 404, 410])('stops on a %i and tells onClose why', async (status) => {
    const script = scriptedFetch();
    script.answer(refusal(status));
    const { seen } = start(script);
    await settle();
    await vi.advanceTimersByTimeAsync(120_000);

    expect(script.calls).toHaveLength(1);
    expect(seen.closes).toEqual([new StreamRefused(status)]);
  });

  it.each([0, 301, 307])('stops on a %i that was not followed', async (status) => {
    const script = scriptedFetch();
    script.answer(status === 0 ? Response.error() : refusal(status));
    const { seen } = start(script);
    await settle();
    await vi.advanceTimersByTimeAsync(120_000);

    expect(script.calls).toHaveLength(1);
    expect(seen.closes).toEqual([new StreamRefused(status)]);
  });

  it.each([408, 429, 500, 502, 503])('retries a %i', async (status) => {
    const script = scriptedFetch();
    script.answer(refusal(status));
    script.answer(openStream());
    const { seen } = start(script);
    await settle();
    await vi.advanceTimersByTimeAsync(750);

    expect(script.calls).toHaveLength(2);
    expect(seen.closes).toEqual([]);
  });

  it.each([
    [204, null],
    [200, 'text/html'],
  ])('stops on a %i that is not an event stream, as EventSource does', async (status, type) => {
    const script = scriptedFetch();
    script.answer(new Response(status === 204 ? null : '<html>', { status, headers: type ? { 'content-type': type } : {} }));
    const { seen } = start(script);
    await settle();
    await vi.advanceTimersByTimeAsync(120_000);

    expect(script.calls).toHaveLength(1);
    expect(seen.closes).toEqual([new StreamRefused(status, null, 'The response is not an event stream')]);
  });

  it('refuses at once even when the refused body cannot be cancelled in time', async () => {
    const script = scriptedFetch();
    script.answer(new Response(new ReadableStream<Uint8Array>({ cancel: () => new Promise(() => {}) }), { status: 401 }));
    const { seen } = start(script);
    await settle();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(script.calls).toHaveLength(1);
    expect(seen.closes).toEqual([new StreamRefused(401)]);
  });

  it('takes a media type in any case, with parameters, and refuses a different one that merely starts the same', async () => {
    const script = scriptedFetch();
    const first = openStream({ headers: { 'content-type': 'Text/Event-Stream; charset=UTF-8' } });
    script.answer(first);
    const { seen } = start(script);
    await settle();
    expect(seen.opens).toBe(1);
    first.end();

    const other = scriptedFetch();
    other.answer(new Response('x', { status: 200, headers: { 'content-type': 'text/event-streams' } }));
    const refused = start(other);
    await settle();
    expect(refused.seen.closes).toEqual([new StreamRefused(200, null, 'The response is not an event stream')]);
  });

  it.each([Number.NaN, -5, Number.POSITIVE_INFINITY])('ignores a retryAfterMs of %s from onError and waits the usual backoff', async (retryAfterMs) => {
    const script = scriptedFetch();
    script.answer(refusal(503));
    script.answer(openStream());
    const { seen } = start(script, { onError: () => ({ retryAfterMs }) });
    await settle();
    expect(script.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(750);

    expect(script.calls).toHaveLength(2);
    expect(seen.opens).toBe(1);
  });

  it('waits for an async onError, and applies the default when it rejects', async () => {
    const script = scriptedFetch();
    script.answer(refusal(503));
    script.answer(refusal(401));
    script.answer(refusal(503));
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    let calls = 0;
    const { seen } = start(script, {
      onError: async () => {
        calls += 1;
        await Promise.resolve();
        if (calls === 1) return { retryAfterMs: 5000 };
        if (calls === 2) throw new Error('logger down');
        return 'stop';
      },
    });
    await settle();
    await vi.advanceTimersByTimeAsync(4999);
    expect(script.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    // The second answer is a 401: onError throws, so the default decides, and it is to stop.
    await settle();

    expect(script.calls).toHaveLength(2);
    expect(logged).toHaveBeenCalledExactlyOnceWith(new Error('logger down'));
    expect(seen.closes).toEqual([new StreamRefused(401)]);
  });

  it('lets the wait an async onError chooses stand over a retryNow made while it decided', async () => {
    const script = scriptedFetch();
    script.answer(refusal(503));
    script.answer(openStream());
    let decide: ((action: { retryAfterMs: number }) => void) | undefined;
    const { connection } = start(script, {
      onError: () => new Promise((resolve) => (decide = resolve)),
    });
    await settle();

    connection.retryNow();
    decide!({ retryAfterMs: 5000 });
    await vi.advanceTimersByTimeAsync(4999);
    expect(script.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);

    expect(script.calls).toHaveLength(2);
  });

  it('tells onClose about an attempt that failed with undefined as an error, not as a close', async () => {
    const closes: unknown[][] = [];
    start(scriptedFetch(), {
      fetch: () => Promise.reject(undefined),
      onError: () => 'stop',
      onClose: (...args: unknown[]) => void closes.push(args),
    });
    await settle();

    expect(closes).toEqual([[undefined]]);
  });

  it('keeps a retryNow made while an async onError is deciding, and tries at once when it answers', async () => {
    const script = scriptedFetch();
    script.answer(refusal(503));
    script.answer(openStream());
    let decide: (() => void) | undefined;
    const { connection, seen } = start(script, {
      onError: () => new Promise<void>((resolve) => (decide = resolve)),
    });
    await settle();

    connection.retryNow();
    decide!();
    await settle();

    expect(script.calls).toHaveLength(2);
    expect(seen.opens).toBe(1);
  });

  it.each(['onDisconnect', 'onEnd'] as const)('keeps a retryNow made inside %s, and tries at once when the stream is over', async (name) => {
    const script = scriptedFetch();
    const first = openStream();
    script.answer(first);
    script.answer(openStream());
    const holder: { connection?: Connection } = {};
    start(script, { [name]: () => holder.connection!.retryNow() });
    holder.connection = open[open.length - 1];
    await settle();

    first.send('retry: 30000\nevent: end\ndata: {"reason":"max_age"}\n\n');
    if (name === 'onDisconnect') first.fail();
    await settle();

    expect(script.calls).toHaveLength(2);
  });

  it('does not keep a retryNow made while a stream is open for the wait after it', async () => {
    const script = scriptedFetch();
    const first = openStream();
    script.answer(first);
    script.answer(openStream());
    const { connection } = start(script);
    await settle();

    connection.retryNow();
    first.fail();
    await settle();
    expect(script.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(750);

    expect(script.calls).toHaveLength(2);
  });

  it('lets onError stop on an error the default would retry', async () => {
    const script = scriptedFetch();
    script.answer(refusal(500));
    const { seen } = start(script, { onError: () => 'stop' });
    await settle();
    await vi.advanceTimersByTimeAsync(120_000);

    expect(script.calls).toHaveLength(1);
    expect(seen.closes).toEqual([new StreamRefused(500)]);
  });

  it('lets onError retry an error the default would stop on', async () => {
    const script = scriptedFetch();
    script.answer(refusal(401));
    script.answer(openStream());
    start(script, { onError: () => 'retry' });
    await settle();
    await vi.advanceTimersByTimeAsync(750);

    expect(script.calls).toHaveLength(2);
  });

  it('waits exactly the time onError names', async () => {
    const script = scriptedFetch();
    script.answer(refusal(500));
    script.answer(openStream());
    start(script, { onError: () => ({ retryAfterMs: 180_000 }) });
    await settle();

    await vi.advanceTimersByTimeAsync(179_999);
    expect(script.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);

    expect(script.calls).toHaveLength(2);
  });

  it('counts failures afresh after a wait onError chose', async () => {
    const script = scriptedFetch();
    for (let i = 0; i < 4; i += 1) script.answer(refusal(500));
    const { seen } = start(script, {
      onError: (error, info) => {
        seen.errors.push({ error, failures: info.failures });
        return info.failures >= 3 ? { retryAfterMs: 1000 } : 'retry';
      },
    });
    await settle();
    await vi.advanceTimersByTimeAsync(750);
    await vi.advanceTimersByTimeAsync(1500);
    await vi.advanceTimersByTimeAsync(1000);

    expect(seen.errors.map((entry) => entry.failures)).toEqual([1, 2, 3, 1]);
  });

  it('applies the default when onError returns nothing, and when it throws', async () => {
    vi.stubGlobal('queueMicrotask', () => {});
    const script = scriptedFetch();
    script.answer(refusal(404));
    const { seen } = start(script, {
      onError: () => {
        throw new Error('logger down');
      },
    });
    await settle();

    expect(seen.closes).toEqual([new StreamRefused(404)]);
  });

  it('works with no onError at all', async () => {
    const script = scriptedFetch();
    script.answer(refusal(500));
    script.answer(openStream());
    const { seen } = start(script, { onError: undefined });
    await settle();
    await vi.advanceTimersByTimeAsync(750);

    expect(script.calls).toHaveLength(2);
    expect(seen.opens).toBe(1);
  });
});

describe('a stream that was open', () => {
  it('reports the disconnect when the server closes it, before it reports anything else', async () => {
    const script = scriptedFetch();
    const stream = openStream();
    script.answer(stream);
    const order: string[] = [];
    start(script, {
      onOpen: () => order.push('open'),
      onDisconnect: () => order.push('disconnect'),
      onError: () => {
        order.push('error');
      },
    });
    await settle();

    stream.fail();
    await settle();

    expect(order).toEqual(['open', 'disconnect', 'error']);
  });

  it('reports the disconnect after a goodbye and after a clean close', async () => {
    const script = scriptedFetch();
    const first = openStream();
    const second = openStream();
    script.answer(first);
    script.answer(second);
    const { seen } = start(script);
    await settle();

    first.send('event: end\ndata: {"reason":"max_age"}\n\n');
    await settle();
    expect(seen.disconnects).toBe(1);
    await vi.advanceTimersByTimeAsync(2000);
    second.end();
    await settle();

    expect(seen.disconnects).toBe(2);
  });

  it('does not report a disconnect for an attempt that never opened, or for close()', async () => {
    const script = scriptedFetch();
    script.answer(refusal(500));
    script.answer(openStream());
    const { connection, seen } = start(script);
    await settle();
    expect(seen.disconnects).toBe(0);

    await vi.advanceTimersByTimeAsync(750);
    connection.close();
    await settle();

    expect(seen.opens).toBe(1);
    expect(seen.disconnects).toBe(0);
  });
});

describe('timeouts', () => {
  it('gives up on a server that does not answer within the connect timeout', async () => {
    const script = scriptedFetch();
    script.hang();
    script.answer(openStream());
    const { seen } = start(script);
    await settle();

    await vi.advanceTimersByTimeAsync(14_999);
    expect(seen.errors).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);

    expect(seen.errors[0]!.error).toEqual(new StreamTimeout('connect'));
    expect((seen.errors[0]!.error as StreamTimeout).phase).toBe('connect');
  });

  it('gives up on a stream that sends nothing, pings included, within the idle timeout', async () => {
    const script = scriptedFetch();
    const stream = openStream();
    script.answer(stream);
    const { seen } = start(script);
    await settle();

    await vi.advanceTimersByTimeAsync(44_999);
    expect(seen.errors).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);

    expect(seen.errors[0]!.error).toEqual(new StreamTimeout('idle'));
  });

  it('counts every chunk, a comment included, as a sign of life', async () => {
    const script = scriptedFetch();
    const stream = openStream();
    script.answer(stream);
    const { seen } = start(script);
    await settle();

    for (let i = 0; i < 4; i += 1) {
      await vi.advanceTimersByTimeAsync(30_000);
      stream.send(': ping\n\n');
    }
    await settle();

    expect(seen.errors).toEqual([]);
  });

  it('does not time out an idle stream when the idle timeout is 0', async () => {
    const script = scriptedFetch();
    script.answer(openStream());
    const { seen } = start(script, { idleTimeoutMs: 0 });
    await settle();

    await vi.advanceTimersByTimeAsync(600_000);

    expect(seen.errors).toEqual([]);
  });

  it('takes its timeouts from the options', async () => {
    const script = scriptedFetch();
    script.hang();
    const { seen } = start(script, { connectTimeoutMs: 100 });
    await settle();

    await vi.advanceTimersByTimeAsync(100);

    expect(seen.errors[0]!.error).toEqual(new StreamTimeout('connect'));
  });
});

describe('the backoff option', () => {
  it('replaces the numbers it names and keeps the rest', async () => {
    const script = scriptedFetch();
    script.answer(() => Promise.reject(new TypeError('offline')));
    script.answer(openStream());
    start(script, { backoff: { baseMs: 100 } });
    await settle();

    await vi.advanceTimersByTimeAsync(74);
    expect(script.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);

    expect(script.calls).toHaveLength(2);
  });
});

describe('close', () => {
  it('aborts the open request and calls onClose once with no error', async () => {
    const script = scriptedFetch();
    script.answer(openStream());
    const { connection, seen } = start(script);
    await settle();

    connection.close();
    connection.close();
    await vi.advanceTimersByTimeAsync(120_000);

    expect((script.calls[0]!.init.signal as AbortSignal).aborted).toBe(true);
    expect(seen.closes).toEqual([undefined]);
    expect(script.calls).toHaveLength(1);
    expect(seen.errors).toEqual([]);
  });

  it('ends a wait between attempts', async () => {
    const script = scriptedFetch();
    script.answer(refusal(500));
    const { connection, seen } = start(script);
    await settle();

    connection.close();
    await vi.advanceTimersByTimeAsync(120_000);

    expect(script.calls).toHaveLength(1);
    expect(seen.closes).toEqual([undefined]);
  });

  it('works from inside onEvent', async () => {
    const script = scriptedFetch();
    const stream = openStream();
    script.answer(stream);
    const seen: string[] = [];
    const connection = connect('https://api.example/stream', {
      fetch: script.fetch,
      onEvent: (event) => {
        seen.push(event.data);
        connection.close();
      },
    });
    await settle();

    stream.send('data: a\n\ndata: b\n\n');
    await vi.advanceTimersByTimeAsync(120_000);

    expect(seen).toEqual(['a']);
    expect(script.calls).toHaveLength(1);
  });

  it('works before the first request has gone out', async () => {
    const script = scriptedFetch();
    const { connection, seen } = start(script);

    connection.close();
    await vi.advanceTimersByTimeAsync(120_000);

    expect(seen.closes).toEqual([undefined]);
    expect(seen.errors).toEqual([]);
  });

  it('does not reconnect after the stream closes while it is being closed', async () => {
    const script = scriptedFetch();
    const stream = openStream();
    script.answer(stream);
    const { connection } = start(script);
    await settle();

    connection.close();
    stream.end();
    await vi.advanceTimersByTimeAsync(120_000);

    expect(script.calls).toHaveLength(1);
  });
});

describe('retryNow', () => {
  it('cuts a wait short', async () => {
    const script = scriptedFetch();
    script.answer(refusal(500));
    script.answer(openStream());
    const { connection } = start(script);
    await settle();

    connection.retryNow();
    await settle();

    expect(script.calls).toHaveLength(2);
  });

  it('does nothing while a stream is open', async () => {
    const script = scriptedFetch();
    script.answer(openStream());
    const { connection } = start(script);
    await settle();

    connection.retryNow();
    await settle();

    expect(script.calls).toHaveLength(1);
  });
});
