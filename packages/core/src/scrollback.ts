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

  text(): string {
    const all = this.chunks.length === 1 ? this.chunks[0]! : this.chunks.join("");
    // Keep the joined text as one chunk, so reading it again is free.
    if (this.chunks.length > 1) this.chunks = [all];
    return all.length > this.limit ? all.slice(-this.limit) : all;
  }
}
