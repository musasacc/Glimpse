/**
 * The last `max` characters of terminal output, cut where a terminal can start reading: after a line break
 * near the cut (escape sequences never span one), else before an escape sequence, and never inside a
 * surrogate pair. A late-joining terminal then doesn't start with stray "[38;5;12m" text or a broken character.
 */
export function trimOutput(text: string, max: number): string {
  if (text.length <= max) return text;
  let out = text.slice(-max);
  const near = Math.min(out.length, 4096);
  const nl = out.indexOf("\n");
  const esc = out.indexOf("\x1b");
  if (nl >= 0 && nl < near) out = out.slice(nl + 1);
  else if (esc >= 0 && esc < near) out = out.slice(esc);
  else if (/^[\udc00-\udfff]/.test(out)) out = out.slice(1);
  return out;
}

/**
 * The last `limit` characters of a stream of text (terminal output), kept as
 * chunks: appending never copies what is already there, unlike `buf += data;
 * buf = buf.slice(-limit)`, which copies the whole buffer on every chunk.
 */
export class Scrollback {
  private chunks: string[] = [];
  private size = 0;

  constructor(readonly limit: number) {}

  push(data: string): void {
    if (!data) return;
    this.chunks.push(data);
    this.size += data.length;
    // Drop whole chunks that lie entirely before the last `limit` characters; text() trims the rest.
    while (this.chunks.length > 1 && this.size - this.chunks[0]!.length >= this.limit) this.size -= this.chunks.shift()!.length;
  }

  clear(): void {
    this.chunks = [];
    this.size = 0;
  }

  /** The kept output, cut at a safe boundary (see trimOutput) once it is longer than `limit`. */
  text(): string {
    const all = this.chunks.length === 1 ? this.chunks[0]! : this.chunks.join("");
    // Keep the joined text as one chunk, so reading it again is free.
    if (this.chunks.length > 1) this.chunks = [all];
    return trimOutput(all, this.limit);
  }
}
