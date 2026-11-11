import { Player, world } from "@minecraft/server";
import { glyphCategories } from "@censorcraft/shared";
import { S } from "./strings";

/**
 * DEV / DEBUG ONLY:  /scriptevent censor:glyphtest
 *
 * Prints every character of the supported-glyph allowlist (shared/glyphs.json)
 * to chat so you can see which ones your game's font actually renders, and
 * trim the list. It has no gameplay purpose.
 */
export function runGlyphTest(source: unknown): void {
  const send = (text: string) => {
    if (source instanceof Player && source.isValid) source.sendMessage(text);
    else world.sendMessage(text);
  };
  send(S.glyphIntro);
  for (const [name, chars] of glyphCategories()) {
    // Spaces between characters make missing glyphs easy to spot and count.
    for (let i = 0; i < chars.length; i += 24) {
      send(`§7${name}${i > 0 ? " (cont.)" : ""}:§r ${chars.slice(i, i + 24).join(" ")}`);
    }
  }
  send(S.glyphSample);
  send(S.glyphNote);
}
