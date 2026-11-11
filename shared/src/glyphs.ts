import data from "../glyphs.json";

export interface GlyphData {
  categories: Record<string, string>;
  superscriptMap: Record<string, string>;
  subscriptMap: Record<string, string>;
  fallbacks: Record<string, string>;
}

export const glyphData = data as unknown as GlyphData;

/** Category name -> characters, in file order. */
export function glyphCategories(source: GlyphData = glyphData): [string, string[]][] {
  return Object.entries(source.categories).map(([name, chars]) => [name, Array.from(chars)]);
}

/** Every non-ASCII character that may be shown in game. */
export function buildAllowlist(source: GlyphData = glyphData): Set<string> {
  const set = new Set<string>();
  for (const chars of Object.values(source.categories)) for (const ch of Array.from(chars)) set.add(ch);
  return set;
}
