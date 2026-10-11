import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { connect, StreamRefused, type Connection } from '../../src/index';
import type { SseEvent } from '../../src/index';
import { DSN, droppableFetch, startServer, waitFor, type TestServer } from './harness';

// These run the client against a real pg-sse hub on a real Postgres, which is the only way to check that the two halves
// agree on cursors, goodbyes and retry delays. They need a scratch database: see CONTRIBUTING.md.
const suite = DSN ? describe : describe.skip;

// The hub's first frame is the cursor it will send from, once it has subscribed and run `start()`: only then does it see a
// row written next. A stream that has merely sent its headers may start after the row, and miss it.
async function ready(connection: Connection): Promise<void> {
  await waitFor(() => connection.lastEventId !== '', 'the server to open the stream');
}

function bodies(events: SseEvent[]): string[] {
  return events.map((event) => (JSON.parse(event.data) as { body: string }).body);
}

let room = 0;
const nextRoom = () => `room${(room += 1)}`;

suite('against a pg-sse server', () => {
  let server: TestServer;
  const open: Connection[] = [];

  beforeAll(async () => {
    server = await startServer({ TOKEN: 'secret', MAX_SUBSCRIBERS: '3' });
  });

  // The server holds three streams at most, so a test gives its slots back, and waits for the server to see it, before
  // the next one starts.
  afterEach(async () => {
    for (const connection of open.splice(0)) connection.close();
    await server.idle();
  });

  afterAll(async () => {
    await server.stop();
  });

  function listen(path: string, options: Partial<Parameters<typeof connect>[1]> = {}) {
    const events: SseEvent[] = [];
    const seen = { opens: 0, ends: [] as string[], closes: [] as unknown[], errors: [] as unknown[] };
    const connection = connect(`${server.url}${path}`, {
      onEvent: (event) => events.push(event),
      onOpen: () => (seen.opens += 1),
      onEnd: (reason) => seen.ends.push(reason),
      onError: (error) => {
        seen.errors.push(error);
      },
      onClose: (error) => seen.closes.push(error),
      ...options,
    });
    open.push(connection);
    return { connection, events, seen };
  }

  it('delivers what is written after it connects, in order, with each row id as the cursor', async () => {
    const name = nextRoom();
    const { connection, events } = listen(`/rooms/${name}/stream`);
    await ready(connection);

    const first = await server.post(name, 'a');
    const second = await server.post(name, 'b');
    await waitFor(() => events.length === 2, 'both messages');

    expect(bodies(events)).toEqual(['a', 'b']);
    expect(events.map((event) => event.id)).toEqual([String(first), String(second)]);
    expect(connection.lastEventId).toBe(String(second));
  });

  it('resumes from its cursor after the connection drops, and misses and repeats nothing', async () => {
    const name = nextRoom();
    const dropper = droppableFetch();
    const { connection, events, seen } = listen(`/rooms/${name}/stream`, { fetch: dropper.fetch, backoff: { baseMs: 400 } });
    await ready(connection);
    const first = await server.post(name, '1');
    await waitFor(() => events.length === 1, 'the first message');

    dropper.drop();
    await waitFor(() => seen.errors.length === 1, 'the drop to be noticed');
    await server.post(name, '2');
    await server.post(name, '3');
    await waitFor(() => events.length === 3, 'the messages written while it was down');
    await server.post(name, '4');
    await waitFor(() => events.length === 4, 'a message after it caught up');

    expect(bodies(events)).toEqual(['1', '2', '3', '4']);
    expect(dropper.requests).toHaveLength(2);
    expect(dropper.requests[0]!.has('last-event-id')).toBe(false);
    expect(dropper.requests[1]!.get('last-event-id')).toBe(String(first));
  });

  it('starts from a cursor it is given and delivers what came after it', async () => {
    const name = nextRoom();
    const first = await server.post(name, 'old');
    await server.post(name, 'new');

    const { events } = listen(`/rooms/${name}/stream`, { lastEventId: String(first) });
    await waitFor(() => events.length === 1, 'the message after the cursor');

    expect(bodies(events)).toEqual(['new']);
  });

  it('sends its headers, and stops on the 401 it gets without them', async () => {
    const name = nextRoom();
    const refused = listen(`/private/${name}/stream`);
    await waitFor(() => refused.seen.closes.length === 1, 'the refusal');

    expect(refused.seen.closes[0]).toBeInstanceOf(StreamRefused);
    expect(refused.seen.closes[0]).toMatchObject({ status: 401 });

    const allowed = listen(`/private/${name}/stream`, { headers: async () => ({ Authorization: 'Bearer secret' }) });
    await ready(allowed.connection);
    await server.post(name, 'private');
    await waitFor(() => allowed.events.length === 1, 'the message');

    expect(bodies(allowed.events)).toEqual(['private']);
  });

  it('reads the 503 and Retry-After a full server answers with', async () => {
    const name = nextRoom();
    const holders = [1, 2, 3].map(() => listen(`/rooms/${name}/stream`));
    await waitFor(() => holders.every((holder) => holder.seen.opens === 1), 'the three streams to open');

    const turnedAway = listen(`/rooms/${name}/stream`);
    await waitFor(() => turnedAway.seen.errors.length === 1, 'the refusal');

    expect(turnedAway.seen.errors[0]).toMatchObject({ status: 503, retryAfterMs: 30_000 });
  });
});

suite('a stream that reaches the age limit', () => {
  let server: TestServer;

  beforeAll(async () => {
    server = await startServer({ MAX_STREAM_SECONDS: '2' });
  });

  afterAll(async () => {
    await server.stop();
  });

  it('says max_age, reconnects with its cursor and carries on without a gap', async () => {
    // The first write opens the server's database pool, which must not eat into the stream's two seconds.
    await server.post(nextRoom(), 'warm up');
    const name = nextRoom();
    const events: SseEvent[] = [];
    const ends: string[] = [];
    const dropper = droppableFetch();
    const connection = connect(`${server.url}/rooms/${name}/stream`, {
      fetch: dropper.fetch,
      onEvent: (event) => events.push(event),
      onEnd: (reason) => ends.push(reason),
    });
    try {
      await ready(connection);
      const first = await server.post(name, 'before');
      await waitFor(() => events.length === 1, 'the first message');

      await waitFor(() => dropper.requests.length === 2, 'the reconnect', 20_000);
      await server.post(name, 'after');
      await waitFor(() => events.length === 2, 'the message after the reconnect');

      expect(ends[0]).toBe('max_age');
      expect(dropper.requests[1]!.get('last-event-id')).toBe(String(first));
      expect(bodies(events)).toEqual(['before', 'after']);
    } finally {
      connection.close();
    }
  });
});

suite('a server that shuts down', () => {
  it('says shutdown to every open stream', async () => {
    const server = await startServer();
    const name = nextRoom();
    const ends: string[] = [];
    let opened = false;
    const connection = connect(`${server.url}/rooms/${name}/stream`, {
      onEvent: () => {},
      onOpen: () => (opened = true),
      onEnd: (reason) => ends.push(reason),
      onError: () => 'stop',
    });
    try {
      await waitFor(() => opened, 'the stream to open');

      await server.stop();
      await waitFor(() => ends.length === 1, 'the goodbye');

      expect(ends).toEqual(['shutdown']);
    } finally {
      connection.close();
      // A second stop, after the one above, finds the server gone. After a failure before it, this one ends the server.
      await server.stop();
    }
  });
});
