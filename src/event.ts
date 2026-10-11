export interface SseEvent {
  /** The `event:` field, or `message` when the frame had none. */
  event: string;
  /** The `data:` lines joined with `\n`. */
  data: string;
  /** The stream's last event id once this frame was read: `''` when the server never sent one and the parser was not given one. */
  id: string;
}

/** An event, or a line of one that has not ended yet, grew past `maxEventChars`. */
export class SseEventTooLarge extends Error {
  constructor(
    readonly limit: number,
    /** The events the same chunk completed before the one that is too large, which `push` could not return. */
    readonly events: SseEvent[] = [],
  ) {
    super(`An event grew past ${limit} characters`);
    this.name = 'SseEventTooLarge';
  }
}
