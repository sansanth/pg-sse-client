import { SseEventTooLarge, type SseEvent } from './event.js';
import { createSseParser, type SseParser } from './parser.js';

/**
 * Reads a response body a chunk at a time and yields what each chunk completed, an empty array included: a chunk that
 * completes no event may still have moved the parser's cursor, and the consumer decides when to look at it. Aborting
 * `signal` cancels the reader, which ends a read still pending even when the body itself ignores the signal. Not exported
 * from the package: `readSse` is the public way in.
 */
export async function* readChunks(
  body: ReadableStream<Uint8Array>,
  onActivity: (() => void) | undefined,
  parser: SseParser,
  signal?: AbortSignal,
): AsyncGenerator<SseEvent[]> {
  const reader = body.getReader();
  // The parser takes a leading byte order mark off, once, wherever its text comes from.
  const decoder = new TextDecoder('utf-8', { ignoreBOM: true });
  const cancel = () => void reader.cancel().catch(() => {});
  // Aborted already: there is no event to wait for, and the read below must not either.
  if (signal?.aborted) cancel();
  else signal?.addEventListener('abort', cancel, { once: true });
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      onActivity?.();
      let events: SseEvent[];
      const before = parser.lastEventId;
      try {
        events = parser.push(decoder.decode(value, { stream: true }));
      } catch (error) {
        // The events before the one that is too large are still the consumer's.
        if (error instanceof SseEventTooLarge && error.events.length > 0) yield error.events;
        throw error;
      }
      // A ping completes nothing and moves no cursor: nothing for the consumer to look at.
      if (events.length > 0 || parser.lastEventId !== before) yield events;
    }
  } finally {
    // Also runs when the consumer stops early or the read throws (an abort): free the connection.
    signal?.removeEventListener('abort', cancel);
    cancel();
  }
}

/**
 * Yields the events of an SSE response body as they arrive. `onActivity` fires for every chunk of bytes read, comments
 * and pings included, which is what an idle timeout wants to reset on. Pass a `parser` to read its `lastEventId` and
 * `retry` while the stream is open or after it has ended. The parser reads a whole chunk before the first of its events
 * is yielded, so its `lastEventId` can be ahead of the event you hold: to resume, use the `id` of the last event you handled.
 * Give it a parser made for this body: one that has read before does not take a byte order mark off the start of the next.
 */
export async function* readSse(
  body: ReadableStream<Uint8Array>,
  onActivity?: () => void,
  parser: SseParser = createSseParser(),
): AsyncGenerator<SseEvent> {
  // The reader is freed when the consumer stops early or the read throws, because the generator below is closed too.
  for await (const events of readChunks(body, onActivity, parser)) yield* events;
}
