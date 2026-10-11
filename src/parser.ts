import { SseEventTooLarge, type SseEvent } from './event.js';

export { SseEventTooLarge };
export type { SseEvent };

export interface SseParserState {
  lastEventId?: string;
  retry?: number | null;
}

export interface SseParserLimits {
  /**
   * The most characters the parser holds for one event: the lines of the frame it is reading, field names included, and
   * the line still arriving. More throws `SseEventTooLarge`. No limit by default, as with `EventSource`, or when it is 0;
   * a client that sends credentials to a server it only half trusts wants one.
   */
  maxEventChars?: number;
}

export interface SseParser {
  /** Feeds a decoded chunk in and returns the events it completes. Throws `SseEventTooLarge` past a limit: use a new parser then. */
  push(chunk: string): SseEvent[];
  /**
   * The cursor to send as `Last-Event-ID`. It moves at the end of a frame, including a frame that carries only an `id:`
   * line, which dispatches nothing.
   */
  readonly lastEventId: string;
  /** The reconnect delay in milliseconds the server last asked for with `retry:`, or null if it never did. */
  readonly retry: number | null;
}

// Where a line ends. Searched with `lastIndex`, so a scan starts where it is told and allocates nothing.
const LINE_END = /[\r\n]/g;

/**
 * An incremental parser for the text/event-stream format, following the WHATWG rules `EventSource` uses: lines end in
 * `\n`, `\r\n` or `\r` (a chunk may split `\r\n`), `:` lines are comments, consecutive `data:` lines join with `\n`, a
 * frame with no `data:` line is dropped, and so is a frame still open when the stream ends.
 *
 * `state` carries what outlives a connection: the last event id and the retry delay. The partial frame does not.
 */
export function createSseParser(state: SseParserState = {}, limits: SseParserLimits = {}): SseParser {
  // 0, as for the timeouts, is none; so is anything that is not a number above it.
  const limit = limits.maxEventChars !== undefined && limits.maxEventChars > 0 ? limits.maxEventChars : undefined;
  // The line still arriving, in the pieces it came in: joined once, when it ends, so a long one is not copied per chunk.
  let partial: string[] = [];
  let partialLength = 0;
  let event = '';
  let data: string[] = [];
  // The characters of the open frame's lines so far, not counting the line still arriving.
  let held = 0;
  let pendingId = state.lastEventId ?? '';
  let lastEventId = pendingId;
  let retry = state.retry ?? null;
  // A line that ended in \r at the end of a chunk: a \n that opens the next chunk is the other half of its \r\n.
  let skipLf = false;
  // The first chunk of a stream may open with a byte order mark, which is no part of the first line.
  let fresh = true;
  // The line still arriving is a comment: it is dropped as it comes, and counts for nothing.
  let skipLine = false;

  return {
    get lastEventId() {
      return lastEventId;
    },
    get retry() {
      return retry;
    },
    push,
  };

  function push(chunk: string): SseEvent[] {
    if (chunk === '') return [];
    if (fresh) {
      fresh = false;
      if (chunk.startsWith('\uFEFF')) chunk = chunk.slice(1);
      if (chunk === '') return [];
    }
    if (skipLf) {
      skipLf = false;
      if (chunk.startsWith('\n')) chunk = chunk.slice(1);
      if (chunk === '') return [];
    }
    LINE_END.lastIndex = 0;
    const ends = LINE_END.test(chunk);
    if (skipLine) {
      if (!ends) return [];
      let cut = LINE_END.lastIndex;
      if (chunk[cut - 1] === '\r') {
        if (cut === chunk.length) skipLf = true;
        else if (chunk[cut] === '\n') cut += 1;
      }
      skipLine = false;
      return push(chunk.slice(cut));
    }
    if (!ends) {
      if (partial.length === 0 && chunk.startsWith(':')) {
        skipLine = true;
        return [];
      }
      partial.push(chunk);
      partialLength += chunk.length;
      if (limit !== undefined && held + partialLength > limit) throw new SseEventTooLarge(limit);
      return [];
    }
    const text = partial.length > 0 ? partial.join('') + chunk : chunk;
    partial = [];
    partialLength = 0;

    const events: SseEvent[] = [];
    let start = 0;
    let tooLarge = false;
    for (;;) {
      LINE_END.lastIndex = start;
      if (!LINE_END.test(text)) break;
      const end = LINE_END.lastIndex - 1;
      const line = text.slice(start, end);
      // A \r ends the line at once; whether a \n follows it is for the next chunk to say.
      if (text[end] === '\r' && end === text.length - 1) skipLf = true;
      start = text[end] === '\r' && text[end + 1] === '\n' ? end + 2 : end + 1;

      if (line === '') {
        lastEventId = pendingId;
        if (data.length > 0) events.push({ event: event || 'message', data: data.join('\n'), id: lastEventId });
        event = '';
        data = [];
        held = 0;
        continue;
      }
      if (line.startsWith(':')) continue;
      // The event this line belongs to is too large already, however it ends: it is not read on, so the limit does not
      // depend on where a chunk happened to end.
      if (limit !== undefined && held + line.length > limit) {
        tooLarge = true;
        break;
      }
      held += line.length;
      const colon = line.indexOf(':');
      const field = colon === -1 ? line : line.slice(0, colon);
      let value = colon === -1 ? '' : line.slice(colon + 1);
      if (value.startsWith(' ')) value = value.slice(1);
      if (field === 'event') event = value;
      else if (field === 'data') data.push(value);
      // An id with a NUL is ignored, so a hostile server cannot plant one the next request would send back.
      else if (field === 'id' && !value.includes('\0')) pendingId = value;
      else if (field === 'retry' && /^\d+$/.test(value)) retry = Math.min(Number(value), Number.MAX_SAFE_INTEGER);
    }
    const rest = text.slice(start);
    if (rest.startsWith(':')) skipLine = true;
    else if (rest !== '') {
      partial.push(rest);
      partialLength = rest.length;
    }
    if (tooLarge || (limit !== undefined && held + partialLength > limit)) throw new SseEventTooLarge(limit!, events);
    return events;
  }
}
