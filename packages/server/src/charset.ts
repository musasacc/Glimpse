/**
 * The character encoding of an HTML file, the way a browser finds it without a Content-Type charset: a byte order
 * mark, else a <meta charset> (or http-equiv Content-Type) in the first 1024 bytes, else UTF-8 (what Glimpse serves).
 * Returned lower-case, as declared ("windows-1252", "shift_jis", …).
 */
export function htmlCharset(bytes: Uint8Array): string {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return "utf-8";
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return "utf-16le";
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return "utf-16be";
  const head = Buffer.from(bytes.subarray(0, 1024)).toString("latin1");
  const m = /<meta\b[^>]*?charset\s*=\s*["']?\s*([\w.:-]+)/i.exec(head);
  const label = m?.[1]?.toLowerCase();
  // A page can't declare UTF-16 in itself (it would need to be decoded already): browsers read it as UTF-8.
  if (!label || label === "utf8" || label.startsWith("utf-16") || !supported(label)) return "utf-8";
  return new TextDecoder(label).encoding === "utf-8" ? "utf-8" : label;
}

/** HTML file contents as text, decoded with the encoding the file declares (a BOM stays, as with readFile). */
export function decodeHtml(bytes: Uint8Array): string {
  return new TextDecoder(htmlCharset(bytes), { ignoreBOM: true }).decode(bytes);
}

function supported(label: string): boolean {
  try {
    new TextDecoder(label);
    return true;
  } catch {
    return false;
  }
}
