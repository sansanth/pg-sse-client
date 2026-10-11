import { spawn, type ChildProcess } from 'node:child_process';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';

export const DSN = process.env.PG_SSE_TEST_DSN;

const ROOT = resolve(import.meta.dirname, '../..');

export interface TestServer {
  url: string;
  /** Resolves once the server holds no open stream, so the next test starts with every slot free. */
  idle(): Promise<void>;
  /** Inserts a message and returns its id. */
  post(room: string, body: string): Promise<number>;
  /** Sends SIGTERM, as a deploy does, and resolves once the server is gone. It exits 143: uvicorn re-raises the signal. */
  stop(): Promise<void>;
}

/** Starts the pg-sse server in test/integration/server on a free port, in a schema of its own. */
export async function startServer(env: Record<string, string> = {}): Promise<TestServer> {
  const child: ChildProcess = spawn(
    'uv',
    ['run', '--project', 'test/integration/server', 'python', 'test/integration/server/server.py'],
    { cwd: ROOT, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'inherit'] },
  );
  // A process that could not be started never exits: `stop()` must not wait for it.
  const exited = new Promise<number | null>((done) => {
    child.once('exit', (code) => done(code));
    child.once('error', () => done(null));
  });
  const port = await new Promise<number>((done, fail) => {
    const lines = createInterface({ input: child.stdout! });
    lines.on('line', (line) => {
      const match = /^listening (\d+)$/.exec(line);
      if (match) done(Number(match[1]));
    });
    void exited.then((code) => fail(new Error(`the test server exited with ${code} before it was listening`)));
    child.once('error', (error) => fail(new Error(`the test server could not start (is uv installed?): ${error.message}`)));
  });
  const url = `http://127.0.0.1:${port}`;
  return {
    url,
    async idle() {
      const deadline = Date.now() + 15_000;
      for (;;) {
        const response = await fetch(`${url}/stats`, { signal: AbortSignal.timeout(5000) });
        const { open_streams: held } = (await response.json()) as { open_streams: number };
        if (held === 0) return;
        if (Date.now() > deadline) throw new Error(`the server still holds ${held} stream(s) after 15 s`);
        await new Promise((done) => setTimeout(done, 20));
      }
    },
    async post(room, body) {
      const response = await fetch(`${url}/rooms/${room}/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ body }),
      });
      if (!response.ok) throw new Error(`the test server answered ${response.status} to a post: ${await response.text()}`);
      return ((await response.json()) as { id: number }).id;
    },
    async stop() {
      child.kill('SIGTERM');
      await exited;
    },
  };
}

/** Polls until the condition holds, so a test waits on what it expects instead of sleeping. */
export async function waitFor(condition: () => boolean, what: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((done) => setTimeout(done, 20));
  }
}

/**
 * A `fetch` that can drop the connection it opened, the way a network failure does: the body errors, and the real
 * request is cancelled. `requests` records what the client sent.
 */
export function droppableFetch() {
  const requests: Headers[] = [];
  let drop: (() => void) | null = null;
  const fetchFn: typeof fetch = async (input, init) => {
    requests.push(new Headers(init?.headers));
    const real = await fetch(input, init);
    if (!real.ok || !real.body) return real;
    const reader = real.body.getReader();
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    let dropped = false;
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        controller = c;
      },
      async pull(c) {
        const { done, value } = await reader.read().catch((error: unknown) => {
          if (!dropped) throw error;
          return { done: true, value: undefined };
        });
        // The body is already errored when a drop cancelled the read this answers.
        if (dropped) return;
        if (done || value === undefined) c.close();
        else c.enqueue(value);
      },
      cancel: () => reader.cancel(),
    });
    drop = () => {
      dropped = true;
      void reader.cancel();
      controller.error(new TypeError('network error'));
    };
    return new Response(body, { status: real.status, headers: real.headers });
  };
  return { fetch: fetchFn, requests, drop: () => drop?.() };
}
