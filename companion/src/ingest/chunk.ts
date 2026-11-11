export interface ChunkOptions {
  /** Target maximum characters per chunk. */
  maxChars: number;
  /** Chunks shorter than this are merged into a neighbour or dropped. */
  minChars?: number;
}

/** Normalize extracted text: unify newlines, drop control characters, squeeze blank runs. */
export function cleanText(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Split text into chunks of at most `maxChars`, preferring paragraph
 * boundaries, then sentence boundaries, then a hard cut. Never splits in the
 * middle of a surrogate pair.
 */
export function chunkText(input: string, options: ChunkOptions): string[] {
  const maxChars = Math.max(200, options.maxChars);
  const minChars = options.minChars ?? Math.min(200, Math.floor(maxChars / 8));
  const text = cleanText(input);
  if (!text) return [];

  const pieces: string[] = [];
  for (const paragraph of text.split(/\n\n+/)) {
    if (paragraph.length <= maxChars) {
      pieces.push(paragraph);
      continue;
    }
    // Oversized paragraph: split on lines / sentences, then hard-cut what is still too long.
    for (const part of paragraph.split(/(?<=[.!?;])\s+|\n/)) {
      if (part.length <= maxChars) {
        pieces.push(part);
        continue;
      }
      let rest = part;
      while (rest.length > maxChars) {
        let cut = rest.lastIndexOf(" ", maxChars);
        if (cut < maxChars / 2) cut = maxChars;
        const code = rest.charCodeAt(cut - 1);
        if (code >= 0xd800 && code <= 0xdbff) cut--; // keep surrogate pairs together
        pieces.push(rest.slice(0, cut).trim());
        rest = rest.slice(cut).trim();
      }
      if (rest) pieces.push(rest);
    }
  }

  const chunks: string[] = [];
  let current = "";
  for (const piece of pieces) {
    if (!piece) continue;
    if (current && current.length + piece.length + 2 > maxChars) {
      chunks.push(current);
      current = piece;
    } else {
      current = current ? `${current}\n\n${piece}` : piece;
    }
  }
  if (current) {
    const last = chunks[chunks.length - 1];
    if (current.length < minChars && last !== undefined && last.length + current.length + 2 <= maxChars) {
      chunks[chunks.length - 1] = `${last}\n\n${current}`;
    } else {
      chunks.push(current);
    }
  }
  // A lone fragment with almost no content (page number, title) is not worth a question.
  return chunks.filter((c, _i, all) => all.length === 1 || c.length >= Math.min(minChars, 40));
}
