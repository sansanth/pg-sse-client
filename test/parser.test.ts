import { describe, expect, it } from 'vitest';
import { createSseParser, SseEventTooLarge, type SseEvent } from '../src/parser';
import { readSse } from '../src/read';

function bodyOf(chunks: Array<string | Uint8Array>): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(typeof chunk === 'string' ? encoder.encode(chunk) : chunk);
      controller.close();
    },
  });
}

describe('createSseParser', () => {
  it('returns each completed frame with its event name and data', () => {
    expect(createSseParser().push('event: change\ndata: {"a":1}\n\nevent: ready\ndata: {}\n\n')).toEqual([
      { event: 'change', data: '{"a":1}', id: '' },
      { event: 'ready', data: '{}', id: '' },
    ]);
  });

  it('names a frame with no event field message', () => {
    expect(createSseParser().push('data: hi\n\n')).toEqual([{ event: 'message', data: 'hi', id: '' }]);
  });

  it('holds a frame until it is complete, wherever the chunks split it', () => {
    const parser = createSseParser();
    expect(parser.push('event: del')).toEqual([]);
    expect(parser.push('ta\ndata: {"te')).toEqual([]);
    expect(parser.push('xt":"x"}\n')).toEqual([]);
    expect(parser.push('\n')).toEqual([{ event: 'delta', data: '{"text":"x"}', id: '' }]);
  });

  it('reads a long line that arrives in many chunks once, and gives it whole', () => {
    const parser = createSseParser();
    const piece = 'x'.repeat(1000);
    for (let i = 0; i < 200; i += 1) expect(parser.push(i === 0 ? `data: ${piece}` : piece)).toEqual([]);

    expect(parser.push('\n\n')).toEqual([{ event: 'message', data: piece.repeat(200), id: '' }]);
  });

  it('accepts \\r\\n and lone \\r line endings, including a \\r\\n split across chunks', () => {
    const parser = createSseParser();
    expect(parser.push('event: a\r\ndata: 1\r\n\r\n')).toEqual([{ event: 'a', data: '1', id: '' }]);
    // A lone \r ends its line at once, even at the end of a chunk; a \n that opens the next chunk is then its other half.
    expect(parser.push('event: b\rdata: 2\r\r')).toEqual([{ event: 'b', data: '2', id: '' }]);
    expect(parser.push('event: c\r')).toEqual([]);
    expect(parser.push('\ndata: 3\r')).toEqual([]);
    expect(parser.push('\n\r\n')).toEqual([{ event: 'c', data: '3', id: '' }]);
    // Only the first character of the next chunk can be that \n.
    expect(parser.push('data: 4\r')).toEqual([]);
    expect(parser.push('\n\n')).toEqual([{ event: 'message', data: '4', id: '' }]);
    expect(parser.push('data: 5\r')).toEqual([]);
    expect(parser.push('')).toEqual([]);
    expect(parser.push('\n\n')).toEqual([{ event: 'message', data: '5', id: '' }]);
  });

  it('strips one leading space from a value and no more', () => {
    expect(createSseParser().push('data:  a\ndata: b\ndata\n\n')).toEqual([{ event: 'message', data: ' a\nb\n', id: '' }]);
  });

  it('skips comments, drops a frame with no data and ignores fields it does not know', () => {
    expect(createSseParser().push(': ping\n\nevent: nothing\n\nx-other: 1\ndata: one\ndata: two\n\n')).toEqual([
      { event: 'message', data: 'one\ntwo', id: '' },
    ]);
  });

  it('never emits a frame the stream ended in the middle of', () => {
    expect(createSseParser().push('event: b\ndata: 1\n')).toEqual([]);
  });

  it('does not carry the event name of a dropped frame into the next one', () => {
    expect(createSseParser().push('event: a\n\ndata: x\n\n')).toEqual([{ event: 'message', data: 'x', id: '' }]);
  });
});

describe('lastEventId', () => {
  it('starts empty, or at the cursor it is given', () => {
    expect(createSseParser().lastEventId).toBe('');
    expect(createSseParser({ lastEventId: '7' }).lastEventId).toBe('7');
  });

  it('moves when a frame ends, and labels the frame it came with', () => {
    const parser = createSseParser();
    expect(parser.push('id: 42\nevent: change\ndata: {}\n\n')).toEqual([{ event: 'change', data: '{}', id: '42' }]);
    expect(parser.lastEventId).toBe('42');
  });

  it('moves on a frame that carries only an id and dispatches nothing', () => {
    const parser = createSseParser();
    expect(parser.push('id: 42\n\n')).toEqual([]);
    expect(parser.lastEventId).toBe('42');
  });

  it('stays put while the frame that sets it is still open', () => {
    const parser = createSseParser({ lastEventId: '1' });
    parser.push('id: 2\ndata: x\n');
    expect(parser.lastEventId).toBe('1');
  });

  it('stays on later frames that send no id', () => {
    const parser = createSseParser();
    parser.push('id: 5\ndata: a\n\n');
    expect(parser.push('data: b\n\n')).toEqual([{ event: 'message', data: 'b', id: '5' }]);
  });

  it('is cleared by an empty id', () => {
    const parser = createSseParser({ lastEventId: '5' });
    parser.push('id:\n\n');
    expect(parser.lastEventId).toBe('');
  });

  it('ignores an id with a NUL in it', () => {
    const parser = createSseParser({ lastEventId: '5' });
    parser.push('id: 6\0\ndata: a\n\n');
    expect(parser.lastEventId).toBe('5');
  });
});

describe('retry', () => {
  it('is null until the server sends one', () => {
    expect(createSseParser().retry).toBeNull();
  });

  it('takes a frame of digits, and a frame with only that dispatches nothing', () => {
    const parser = createSseParser();
    expect(parser.push('retry: 1500\n\n')).toEqual([]);
    expect(parser.retry).toBe(1500);
  });

  it('ignores a value that is not all digits', () => {
    const parser = createSseParser();
    parser.push('retry: 1.5\nretry: -3\nretry: soon\nretry:\n\n');
    expect(parser.retry).toBeNull();
  });

  it('takes the retry of the goodbye frame that ends with an event', () => {
    const parser = createSseParser();
    expect(parser.push('retry: 30000\nevent: end\ndata: {"reason":"busy"}\n\n')).toEqual([
      { event: 'end', data: '{"reason":"busy"}', id: '' },
    ]);
    expect(parser.retry).toBe(30_000);
  });
});

describe('a chunk split inside a CRLF', () => {
  it('leaves no empty piece behind, so a comment after it is still dropped, not held', () => {
    const parser = createSseParser({}, { maxEventChars: 8 });

    for (const chunk of ['event:', ' e\r', '\n', ':', '\r']) expect(parser.push(chunk)).toEqual([]);
  });
});

describe('a byte order mark', () => {
  it('may be a chunk of its own, and the comment after it is still dropped, not held', () => {
    const parser = createSseParser({}, { maxEventChars: 10 });

    expect(parser.push('\uFEFF')).toEqual([]);
    expect(parser.push(`: ${'c'.repeat(100)}`)).toEqual([]);
    expect(parser.push('\ndata: a\n\n')).toEqual([{ event: 'message', data: 'a', id: '' }]);
  });

  it('is no part of the first line of the first chunk, and only there', () => {
    const parser = createSseParser();

    expect(parser.push('')).toEqual([]);
    expect(parser.push('\uFEFFdata: a\n\n')).toEqual([{ event: 'message', data: 'a', id: '' }]);
    expect(parser.push('\uFEFFdata: b\n\n')).toEqual([]);
  });
});

describe('a limit on the size of an event', () => {
  it('takes a limit of 0 as none', () => {
    expect(createSseParser({}, { maxEventChars: 0 }).push(`data: ${'x'.repeat(1000)}\n\n`)).toHaveLength(1);
  });

  it('does not hold or count a comment, however long and wherever the chunks split it', () => {
    const comment = `: ${'c'.repeat(500)}`;
    for (const ending of ['\n', '\r\n', '\r']) {
      const text = `${comment}${ending}data: a${ending}${ending}`;
      for (const cut of [1, 2, 300, comment.length, comment.length + 1, text.length - 2]) {
        const parser = createSseParser({}, { maxEventChars: 100 });
        const got = [...parser.push(text.slice(0, cut)), ...parser.push(text.slice(cut))];
        expect(got, `${JSON.stringify(ending)} cut at ${cut}`).toEqual([{ event: 'message', data: 'a', id: '' }]);
      }
    }
    const parser = createSseParser({}, { maxEventChars: 100 });
    expect(parser.push(`:${'c'.repeat(100)}`)).toEqual([]);
    for (let i = 0; i < 50; i += 1) expect(parser.push('c'.repeat(100))).toEqual([]);
    expect(parser.push(`\n\ndata: b\n\n`)).toEqual([{ event: 'message', data: 'b', id: '' }]);
  });

  it('drops a comment that ends a chunk, a \\r at the end of one included, and the \\n that follows it', () => {
    const parser = createSseParser({}, { maxEventChars: 100 });

    expect(parser.push(`data: a\n\n: ${'c'.repeat(300)}`)).toEqual([{ event: 'message', data: 'a', id: '' }]);
    expect(parser.push(`${'c'.repeat(300)}\r`)).toEqual([]);
    expect(parser.push('\ndata: b\n\n')).toEqual([{ event: 'message', data: 'b', id: '' }]);
  });

  it('carries the events a chunk completed before it failed on the event that is too large', () => {
    const parser = createSseParser({}, { maxEventChars: 50 });

    let thrown: unknown;
    try {
      parser.push(`data: ok\n\ndata: ${'x'.repeat(60)}`);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(SseEventTooLarge);
    expect(thrown).toMatchObject({ limit: 50, events: [{ event: 'message', data: 'ok', id: '' }] });
  });

  it('fails on an event that is too large whether it comes in one chunk or in many', () => {
    expect(() => createSseParser({}, { maxEventChars: 10 }).push(`data: ${'x'.repeat(50)}\n\n`)).toThrow(new SseEventTooLarge(10));
    expect(() => createSseParser({}, { maxEventChars: 10 }).push(`${'data\n'.repeat(20)}\n`)).toThrow(SseEventTooLarge);
  });

  it('throws when a line that has not ended grows past it, however many chunks it takes', () => {
    const parser = createSseParser({}, { maxEventChars: 100 });

    expect(parser.push(`data: ${'x'.repeat(50)}`)).toEqual([]);
    expect(() => parser.push('x'.repeat(50))).toThrow(new SseEventTooLarge(100));
  });

  it('throws when the lines of one event add up past it, and starts again at the next event', () => {
    const parser = createSseParser({}, { maxEventChars: 100 });

    expect(parser.push(`event: e\ndata: ${'x'.repeat(40)}\n`)).toEqual([]);
    expect(parser.push(`data: ${'y'.repeat(40)}\n\n`)).toEqual([{ event: 'e', data: `${'x'.repeat(40)}\n${'y'.repeat(40)}`, id: '' }]);
    expect(parser.push(`data: ${'z'.repeat(90)}\n\n`)).toHaveLength(1);
    expect(parser.push(`data: ${'a'.repeat(60)}\n`)).toEqual([]);
    expect(() => parser.push(`data: ${'b'.repeat(60)}\n`)).toThrow(SseEventTooLarge);
  });

  it('counts the lines of the frame, field names included, and puts no limit on a parser made without one', () => {
    const limited = createSseParser({}, { maxEventChars: 40 });
    expect(limited.push('event: aaaaaaaa\n')).toEqual([]);
    expect(limited.push('data: xxxxxxxxxxxx\n')).toEqual([]);
    expect(() => limited.push('data: yyyyyy\n')).toThrow(SseEventTooLarge);

    const unlimited = createSseParser();
    expect(unlimited.push(`data: ${'x'.repeat(100_000)}\n\n`)).toHaveLength(1);
  });

  it('gives the same answer for a line whether the chunk ends inside it or after it', () => {
    const lines = [`data: ${'x'.repeat(95)}\n\n`, `data: ${'x'.repeat(90)}\n\n`];
    for (const [index, text] of lines.entries()) {
      const outcome = (cut: number) => {
        const parser = createSseParser({}, { maxEventChars: 100 });
        try {
          return [...parser.push(text.slice(0, cut)), ...parser.push(text.slice(cut))].length;
        } catch (error) {
          return error instanceof SseEventTooLarge ? 'too large' : 'other';
        }
      };
      const whole = outcome(text.length);
      expect(whole, `line ${index}`).toBe(index === 1 ? 1 : 'too large');
      for (const cut of [1, 7, 50, text.length - 2]) expect(outcome(cut), `line ${index} cut at ${cut}`).toBe(whole);
    }
  });
});

describe('readSse', () => {
  it('yields the events of a body and reports activity per chunk', async () => {
    let activity = 0;
    const got: SseEvent[] = [];

    for await (const event of readSse(bodyOf([': ping\n\n', 'event: ready\ndata: {}\n\n']), () => (activity += 1))) got.push(event);

    expect(got).toEqual([{ event: 'ready', data: '{}', id: '' }]);
    expect(activity).toBe(2);
  });

  it('decodes a multi-byte character split between two chunks', async () => {
    const bytes = new TextEncoder().encode('data: é\n\n');
    const cut = bytes.indexOf(0xc3) + 1;
    const got: SseEvent[] = [];

    for await (const event of readSse(bodyOf([bytes.slice(0, cut), bytes.slice(cut)]))) got.push(event);

    expect(got).toEqual([{ event: 'message', data: 'é', id: '' }]);
  });

  it('leaves the cursor and retry on the parser it is given', async () => {
    const parser = createSseParser();

    for await (const _ of readSse(bodyOf(['id: 9\ndata: x\n\nretry: 2000\nid: 10\n\n']), undefined, parser)) void _;

    expect(parser.lastEventId).toBe('10');
    expect(parser.retry).toBe(2000);
  });

  it('releases the connection when the consumer stops early', async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('event: a\ndata: 1\n\n'));
      },
      cancel() {
        cancelled = true;
      },
    });

    for await (const _ of readSse(body)) break;

    expect(cancelled).toBe(true);
  });

  it('finishes quietly when the body cannot be cancelled', async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('event: a\ndata: 1\n\n'));
      },
      cancel() {
        throw new Error('cannot cancel');
      },
    });
    const got: SseEvent[] = [];

    for await (const event of readSse(body)) {
      got.push(event);
      break;
    }

    expect(got).toEqual([{ event: 'a', data: '1', id: '' }]);
  });
});
