import { vi } from 'vitest';

export interface FakeStream {
  response: Response;
  /** Delivers text as one chunk. */
  send(text: string): void;
  /** Closes the body the way a server closing the connection does. */
  end(): void;
  /** Breaks the body the way a dropped connection does. */
  fail(error?: unknown): void;
}

/** An open event stream the test feeds by hand. */
export function openStream(init: ResponseInit = {}): FakeStream {
  const encoder = new TextEncoder();
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  const response = new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
    ...init,
  });
  return {
    response,
    send: (text) => controller.enqueue(encoder.encode(text)),
    end: () => {
      // A server closing a request the client already aborted has nothing left to close.
      try {
        controller.close();
      } catch {
        /* already closed or errored */
      }
    },
    fail: (error = new TypeError('network error')) => controller.error(error),
  };
}

export function refusal(status: number, headers: Record<string, string> = {}): Response {
  return new Response('no', { status, headers });
}

/** A `fetch` the test scripts one answer at a time; it fails the test if the client asks for one more than scripted. */
export function scriptedFetch() {
  const answers: Array<(init: RequestInit) => Response | Promise<Response>> = [];
  const calls: Array<{ url: string; init: RequestInit; headers: Headers }> = [];
  const fetchFn = vi.fn<typeof fetch>(async (input, init = {}) => {
    calls.push({ url: String(input), init, headers: new Headers(init.headers) });
    const next = answers.shift();
    if (!next) throw new Error(`unscripted request #${calls.length}`);
    return next(init);
  });
  return {
    fetch: fetchFn,
    calls,
    /**
     * Answers the next request. A stream is wired to the request's signal, as a real body is: aborting the request breaks
     * the body with an AbortError.
     */
    answer(answer: FakeStream | Response | ((init: RequestInit) => Response | Promise<Response>)) {
      if (typeof answer === 'function') answers.push(answer);
      else if ('response' in answer) {
        answers.push((init) => {
          init.signal?.addEventListener('abort', () => answer.fail(new DOMException('aborted', 'AbortError')));
          return answer.response;
        });
      } else answers.push(() => answer);
    },
    /** Answers the next request with a response that arrives only when the client aborts: a server that never replies. */
    hang() {
      answers.push(
        (init) =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
          }),
      );
    },
  };
}

/** Lets promises and zero-delay timers settle without moving the clock. */
export async function settle(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}
