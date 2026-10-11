import { describe, expect, it } from 'vitest';
import { createSseParser, SseEventTooLarge } from '../src/parser';
import { readChunks } from '../src/read';

describe('readChunks', () => {
  it('yields what each chunk completes, an empty array too, and reports the chunk first', async () => {
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(': ping\n\n'));
        controller.enqueue(encoder.encode('id: 1\n\n'));
        controller.enqueue(encoder.encode('data: a\n\ndata: b\n\n'));
        controller.close();
      },
    });
    const parser = createSseParser();
    const seen: string[] = [];

    const batches: string[][] = [];
    for await (const events of readChunks(body, () => seen.push(`activity at ${parser.lastEventId || 'none'}`), parser)) {
      batches.push(events.map((event) => event.data));
    }

    expect(batches).toEqual([[], ['a', 'b']]);
    expect(seen).toEqual(['activity at none', 'activity at none', 'activity at 1']);
  });

  it('fails on an event past the parser limit once the events before it are yielded, with no more bytes to come', async () => {
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(`data: ok\n\ndata: ${'x'.repeat(60)}`));
      },
    });
    const batches: string[][] = [];

    const reading = (async () => {
      for await (const events of readChunks(body, undefined, createSseParser({}, { maxEventChars: 50 }))) {
        batches.push(events.map((event) => event.data));
      }
    })();

    await expect(reading).rejects.toThrow(SseEventTooLarge);
    expect(batches).toEqual([['ok']]);
  });

  it('fails on an event past the limit that has no events before it just the same', async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(`data: ${'x'.repeat(60)}`));
      },
    });
    const batches: unknown[] = [];

    const reading = (async () => {
      for await (const events of readChunks(body, undefined, createSseParser({}, { maxEventChars: 50 }))) batches.push(events);
    })();

    await expect(reading).rejects.toThrow(SseEventTooLarge);
    expect(batches).toEqual([]);
  });

  it('does not wait for bytes when the signal is already aborted, and frees the body', async () => {
    const cancelled: unknown[] = [];
    const body = new ReadableStream<Uint8Array>({ cancel: (reason) => void cancelled.push(reason) });
    const controller = new AbortController();
    controller.abort();
    const batches: unknown[] = [];

    for await (const events of readChunks(body, undefined, createSseParser(), controller.signal)) batches.push(events);

    expect(batches).toEqual([]);
    expect(cancelled).toHaveLength(1);
  });
});
