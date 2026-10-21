// A terminal's output as its pages get it (see terminals.ts): numbered by
// offset, in characters (UTF-16 code units) since its program started, the
// latest kept for the pages that missed some; and for each page, what it was
// sent and has not written yet.

// Small chunks (echoes of what is typed) are joined into the last one, up to
// this many characters
const JOIN_BELOW = 16 * 1024;

export class OutputLog {
  // At least `limit` characters, the latest, in whole chunks
  private readonly limit: number;
  private readonly chunks: string[] = [];
  // Of the first chunk
  private first = 0;
  private length = 0;

  constructor(limit: number) {
    this.limit = limit;
  }

  // The oldest output kept
  get start(): number {
    return this.first;
  }

  get end(): number {
    return this.first + this.length;
  }

  append(text: string): void {
    if (!text) {
      return;
    }
    const last = this.chunks.length - 1;
    if (last >= 0 && this.chunks[last].length < JOIN_BELOW) {
      this.chunks[last] += text;
    } else {
      this.chunks.push(text);
    }
    this.length += text.length;
    while (this.chunks.length > 1 && this.length - this.chunks[0].length >= this.limit) {
      const dropped = this.chunks.shift()!;
      this.first += dropped.length;
      this.length -= dropped.length;
    }
  }

  // The output from offset on; null if it is no longer kept, or not yet
  since(offset: number): string | null {
    if (offset < this.first || offset > this.end) {
      return null;
    }
    let skip = offset - this.first;
    let index = 0;
    while (index < this.chunks.length && skip >= this.chunks[index].length) {
      skip -= this.chunks[index].length;
      index++;
    }
    return index === this.chunks.length ? '' : this.chunks[index].slice(skip) + this.chunks.slice(index + 1).join('');
  }
}

export type NextOutput = { data: string; offset: number } | 'snapshot' | null;

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

// What a page was sent of the output, and has not written yet: at most a
// window of characters, so that a slow page (or one hidden, which writes
// nothing) does not pile output up on the way, and gets the screen instead
// once it lacks too much
export class Delivery {
  // Where the page's output goes once it wrote what it was sent
  offset: number;
  // What it was sent: the offset after each message, and its size
  private readonly sent: { offset: number; size: number }[] = [];
  private size = 0;

  constructor(offset: number) {
    this.offset = offset;
  }

  // Characters sent and not written yet
  get pending(): number {
    return this.size;
  }

  // What the page should get next: the output it lacks, as much as the window
  // leaves; the screen instead if it lacks more than a window of it, or what
  // it lacks is no longer kept; null if up to date, or its window is full
  next(log: OutputLog, window: number): NextOutput {
    const room = window - this.size;
    if (this.offset === log.end || room <= 0) {
      return null;
    }
    const data = log.end - this.offset > window ? null : log.since(this.offset);
    if (data === null) {
      return 'snapshot';
    }
    let part = data.length > room ? data.slice(0, room) : data;
    if (part.length < data.length && isHighSurrogate(part.charCodeAt(part.length - 1))) {
      part = part.slice(0, -1);
    }
    return part ? { data: part, offset: this.offset + part.length } : null;
  }

  // Sent: the output up to offset, in a message of size characters
  record(offset: number, size: number): void {
    this.offset = offset;
    this.sent.push({ offset, size });
    this.size += size;
  }

  // The page wrote the output up to offset: its messages are acknowledged in
  // the order they were sent, whose offsets never go back
  ack(offset: number): void {
    while (this.sent.length > 0 && this.sent[0].offset <= offset) {
      this.size -= this.sent.shift()!.size;
    }
  }
}
