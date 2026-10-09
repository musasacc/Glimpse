/** Terminal input in pieces of at most `size` characters, never splitting a surrogate pair. */
export function chunkInput(data: string, size = 16 * 1024): string[] {
  if (data.length <= size) return [data];
  const out: string[] = [];
  let i = 0;
  while (i < data.length) {
    let end = Math.min(i + size, data.length);
    const last = data.charCodeAt(end - 1);
    if (end < data.length && last >= 0xd800 && last <= 0xdbff) end--;
    out.push(data.slice(i, end));
    i = end;
  }
  return out;
}
