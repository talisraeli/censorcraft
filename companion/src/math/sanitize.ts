import { buildAllowlist, GlyphData, glyphData } from "@censorcraft/shared";
import {
  ACCENT_COMMANDS,
  ASCII_OPERATORS,
  ASCII_WORDS,
  BLACKBOARD,
  DROP_COMMANDS,
  FUNCTION_COMMANDS,
  SYMBOL_COMMANDS,
  UNWRAP_COMMANDS,
} from "./latex";

export interface SanitizeOptions {
  /**
   * Treat the text as containing program code: C escapes (\n), XOR (^) and
   * snake_case identifiers are left alone. Auto-detected when omitted.
   */
  code?: boolean;
}

export interface SanitizeResult {
  text: string;
  /** Characters that were not in the allowlist and what replaced them. */
  replaced: { char: string; with: string }[];
  /** LaTeX commands that were not recognised (their backslash was removed). */
  unknownCommands: string[];
}

const OPEN_BRACE = "";
const CLOSE_BRACE = "";

/** Heuristic: does this text contain C-like program code? */
export function looksLikeCode(text: string): boolean {
  return /#include\b|\bprintf\s*\(|\bscanf\s*\(|\bint\s+main\b|\b(?:int|char|float|double|void|long|unsigned|size_t)\s+\**\w+\s*(?:[=;(,)]|\[)|\bsizeof\b|\bmalloc\s*\(|\breturn\b[^.\n]*;|\bfor\s*\([^)]*;|\bwhile\s*\(|\w\+\+|\+\+\w|&&|\|\||;\s*\}|\bstruct\s+\w+\s*[{*]|\bNULL\b/.test(
    text,
  );
}

/** Read a balanced {...} group starting at `i` (text[i] === "{"). Returns [content, indexAfter]. */
function readGroup(text: string, i: number): [string, number] | undefined {
  if (text[i] !== "{") return undefined;
  let depth = 0;
  for (let j = i; j < text.length; j++) {
    if (text[j] === "{") depth++;
    else if (text[j] === "}") {
      depth--;
      if (depth === 0) return [text.slice(i + 1, j), j + 1];
    }
  }
  return undefined;
}

/** Read one LaTeX argument at `i`: a {group}, a \command, or a single character. */
function readArg(text: string, i: number): [string, number] | undefined {
  while (text[i] === " ") i++;
  if (i >= text.length) return undefined;
  if (text[i] === "{") return readGroup(text, i);
  if (text[i] === "\\") {
    const m = /^\\[A-Za-z]+/.exec(text.slice(i));
    if (m) return [m[0], i + m[0].length];
    return undefined;
  }
  return [text[i] as string, i + 1];
}

export class MathSanitizer {
  private readonly allow: Set<string>;
  private readonly sup: Record<string, string> = {};
  private readonly sub: Record<string, string> = {};
  private readonly fallbacks: Record<string, string>;

  constructor(glyphs: GlyphData = glyphData) {
    this.allow = buildAllowlist(glyphs);
    this.fallbacks = glyphs.fallbacks ?? {};
    // A sup/sub conversion is only usable while its target glyph is still allowlisted.
    for (const [k, v] of Object.entries(glyphs.superscriptMap ?? {})) if (this.allow.has(v)) this.sup[k] = v;
    for (const [k, v] of Object.entries(glyphs.subscriptMap ?? {})) if (this.allow.has(v)) this.sub[k] = v;
  }

  /** Full pipeline: LaTeX -> Unicode, sup/sub conversion, allowlist enforcement. */
  sanitize(input: string, options: SanitizeOptions = {}): SanitizeResult {
    const code = options.code ?? looksLikeCode(input);
    const unknownCommands: string[] = [];
    let text = restoreEatenEscapes(input.replace(/\r\n?/g, "\n"));
    const hadLatex = /\\[A-Za-z]{2,}|\\[()[\]]|[\^_]\{|\$[^$\n]+\$/.test(text);

    text = this.convertLatex(text, code, unknownCommands);
    text = this.convertScripts(text, code);
    if (hadLatex && !code) text = text.replace(/[{}]/g, "");
    text = text.split(OPEN_BRACE).join("{").split(CLOSE_BRACE).join("}");

    const replaced: { char: string; with: string }[] = [];
    text = this.enforceAllowlist(text, replaced);
    text = tidy(text, code);
    return { text, replaced, unknownCommands };
  }

  /**
   * Problems that survive sanitizing and justify asking the model again:
   * leftover LaTeX, unknown commands, or characters that had no fallback.
   */
  findIssues(result: SanitizeResult, options: SanitizeOptions = {}): string[] {
    const issues: string[] = [];
    const code = options.code ?? looksLikeCode(result.text);
    if (result.unknownCommands.length) issues.push(`unknown LaTeX commands: ${result.unknownCommands.join(", ")}`);
    const lost = result.replaced.filter((r) => r.with === "?");
    if (lost.length) issues.push(`unsupported characters: ${[...new Set(lost.map((r) => r.char))].join(" ")}`);
    if (!code && /\\[A-Za-z]{2,}/.test(result.text)) issues.push("leftover backslash command");
    if (/\$[^$\n]{1,80}\$/.test(result.text) && !code) issues.push("leftover $...$ math delimiters");
    if (/[\^_]\{/.test(result.text)) issues.push("leftover ^{...} or _{...}");
    return issues;
  }

  /** Is every character displayable (ASCII or allowlisted)? */
  isClean(text: string): boolean {
    for (const ch of text) if (!this.isAllowed(ch)) return false;
    return true;
  }

  /**
   * Canonical form of an answer for comparison. Players type ASCII
   * (sqrt(2), x^2, pi, inf, <=, 1/2); references come from the model in
   * Unicode. Both sides go through this so they can be compared.
   */
  normalizeAnswer(input: string, options: SanitizeOptions = {}): string {
    const code = options.code ?? false;
    let text = input.trim();
    if (code) return text.replace(/[ \t]+/g, " ");
    text = this.sanitize(text, { code: false }).text;
    for (const [from, to] of ASCII_OPERATORS) text = text.split(from).join(to);
    text = text.replace(/\bsqrt\s*\(/gi, "√(").replace(/\bsqrt\s*(\d+(?:\.\d+)?|[A-Za-z])\b/gi, "√($1)");
    text = text.replace(/√\s*(\d+(?:\.\d+)?|[A-Za-zα-ω])(?![\w(])/g, "√($1)");
    text = text.replace(/\b[A-Za-z]+\b/g, (word) => ASCII_WORDS[word.toLowerCase()] ?? word);
    // One spelling for multiplication and minus.
    text = text.replace(/[*×⋅]/g, "·").replace(/−/g, "-");
    text = text.replace(/\s+/g, " ").trim();
    return this.enforceAllowlist(text, []);
  }

  /** Key for the cheap "obviously identical" check before calling the AI grader. */
  comparisonKey(input: string, options: SanitizeOptions = {}): string {
    return this.normalizeAnswer(input, options)
      .toLowerCase()
      .replace(/\s+/g, "")
      .replace(/[.;]+$/, "");
  }

  // ---- LaTeX ---------------------------------------------------------------

  private convertLatex(input: string, code: boolean, unknown: string[]): string {
    let text = input;
    // Protect escaped literal braces before grouping braces are processed.
    if (!code) text = text.replace(/\\\{/g, OPEN_BRACE).replace(/\\\}/g, CLOSE_BRACE);

    // Math delimiters.
    if (!code) {
      text = text.replace(/\\\(|\\\)|\\\[|\\\]/g, "");
      text = text.replace(/\$\$/g, "");
      text = text.replace(/\$([^$\n]+)\$/g, "$1");
    }

    // Environments.
    text = text.replace(
      /\\begin\{([a-zA-Z]*)matrix\*?\}([\s\S]*?)\\end\{\1matrix\*?\}/g,
      (_m, _kind: string, body: string) => formatMatrix(body),
    );
    text = text.replace(/\\begin\{cases\}([\s\S]*?)\\end\{cases\}/g, (_m, body: string) => {
      const rows = body
        .split(/\\\\/)
        .map((row) => row.replace(/&/g, " ").replace(/\s+/g, " ").trim())
        .filter(Boolean);
      return `${OPEN_BRACE} ${rows.join("; ")} ${CLOSE_BRACE}`;
    });
    text = text.replace(/\\(?:begin|end)\{[a-zA-Z*]+\}/g, "");

    // Commands with arguments, innermost handled by repeated passes.
    for (let pass = 0; pass < 12; pass++) {
      const next = this.convertArgCommands(text);
      if (next === text) break;
      text = next;
    }

    if (!code) {
      // Line breaks and spacing commands.
      text = text.replace(/\\\\/g, "\n").replace(/\\[,;:! ]/g, " ");
      text = text.replace(/\\([%&#_$])/g, "$1");
    }

    // Symbol / function commands.
    text = text.replace(/\\([A-Za-z]+)( ?)/g, (match, name: string, space: string, offset: number) => {
      if (DROP_COMMANDS.has(name)) return name === "quad" || name === "qquad" ? " " : "";
      const symbol = SYMBOL_COMMANDS[name];
      if (symbol !== undefined) {
        // Keep one space after word-like output so "\alpha x" does not become "αx" ... but it may: both read fine.
        return symbol + space;
      }
      if (FUNCTION_COMMANDS.has(name)) return (name === "bmod" || name === "pmod" ? "mod" : name) + space;
      if (code) return match; // probably a C escape such as \n or \t inside a string
      if (name.length < 2 && !isLatexContext(text, offset)) return match;
      unknown.push(`\\${name}`);
      return name + space;
    });
    // "\left." / "\right." leave a stray dot.
    return text;
  }

  private convertArgCommands(text: string): string {
    const re = /\\([A-Za-z]+)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      const name = m[1] as string;
      const start = m.index;
      let i = start + m[0].length;
      let replacement: string | undefined;

      if (name === "frac" || name === "dfrac" || name === "tfrac" || name === "cfrac") {
        const a = readArg(text, i);
        const b = a && readArg(text, a[1]);
        if (a && b) {
          replacement = `(${a[0].trim()})/(${b[0].trim()})`;
          i = b[1];
        }
      } else if (name === "binom" || name === "dbinom" || name === "tbinom") {
        const a = readArg(text, i);
        const b = a && readArg(text, a[1]);
        if (a && b) {
          replacement = `C(${a[0].trim()}, ${b[0].trim()})`;
          i = b[1];
        }
      } else if (name === "sqrt") {
        let index: string | undefined;
        if (text[i] === "[") {
          const close = text.indexOf("]", i);
          if (close > 0) {
            index = text.slice(i + 1, close).trim();
            i = close + 1;
          }
        }
        const a = readArg(text, i);
        if (a) {
          const body = a[0].trim();
          if (index === undefined || index === "2" || index === "") replacement = `√(${body})`;
          else {
            const supIndex = this.mapAll(index, this.sup);
            replacement = supIndex ? `${supIndex}√(${body})` : `root(${index}, ${body})`;
          }
          i = a[1];
        }
      } else if (name === "mathbb") {
        const a = readArg(text, i);
        if (a) {
          replacement = BLACKBOARD[a[0].trim()] ?? a[0].trim();
          i = a[1];
        }
      } else if (UNWRAP_COMMANDS.has(name)) {
        const a = readArg(text, i);
        if (a) {
          replacement = a[0];
          i = a[1];
        }
      } else if (ACCENT_COMMANDS[name] !== undefined) {
        const a = readArg(text, i);
        if (a) {
          replacement = a[0].trim() + ACCENT_COMMANDS[name];
          i = a[1];
        }
      } else if (name === "abs" || name === "norm") {
        const a = readArg(text, i);
        if (a) {
          replacement = name === "abs" ? `|${a[0].trim()}|` : `‖${a[0].trim()}‖`;
          i = a[1];
        }
      } else if (name === "overset" || name === "underset" || name === "stackrel") {
        const a = readArg(text, i);
        const b = a && readArg(text, a[1]);
        if (a && b) {
          replacement = b[0];
          i = b[1];
        }
      }

      if (replacement !== undefined) {
        return text.slice(0, start) + replacement + text.slice(i);
      }
    }
    return text;
  }

  // ---- superscripts / subscripts ---------------------------------------------

  private convertScripts(input: string, code: boolean): string {
    let text = input;
    // Braced forms are unambiguous LaTeX, converted in every mode. Innermost first.
    for (let pass = 0; pass < 8; pass++) {
      const next = text.replace(/([\^_])\{([^{}]*)\}/g, (_m, op: string, body: string) => this.script(op, body.trim()));
      if (next === text) break;
      text = next;
    }
    if (code) return text;
    // Unbraced subscripts: single-letter (or big-operator) base, e.g. x_1, a_n, ∫_0. Not snake_case.
    text = text.replace(
      /(?<![\p{L}\p{N}_])([\p{L}∫∑∏])_(\d+|[A-Za-z])(?![\p{L}\p{N}_])/gu,
      (m, base: string, body: string) => {
        const mapped = this.mapAll(body, this.sub);
        return mapped ? base + mapped : m;
      },
    );
    // Unbraced superscripts: x^2, x^-1, 2^n, ∫₀^1. Requires no space before the caret.
    text = text.replace(/(?<=\S)\^(-?\d+|[A-Za-z])(?![\p{L}\p{N}])/gu, (m, body: string) => {
      const mapped = this.mapAll(body, this.sup);
      return mapped ?? m;
    });
    return text;
  }

  private script(op: string, body: string): string {
    if (body === "") return "";
    const mapped = this.mapAll(body, op === "^" ? this.sup : this.sub);
    if (mapped) return mapped;
    // Not every character has a Unicode form: fall back to ^(...) / _(...).
    return Array.from(body).length === 1 ? op + body : `${op}(${body})`;
  }

  private mapAll(body: string, table: Record<string, string>): string | undefined {
    let out = "";
    for (const ch of body.replace(/\s+/g, "")) {
      const mapped = table[ch];
      if (mapped === undefined) return undefined;
      out += mapped;
    }
    return out || undefined;
  }

  // ---- allowlist ---------------------------------------------------------------

  private isAllowed(ch: string): boolean {
    const cp = ch.codePointAt(0) as number;
    return ch === "\n" || (cp >= 0x20 && cp <= 0x7e) || this.allow.has(ch);
  }

  private enforceAllowlist(text: string, replaced: { char: string; with: string }[], depth = 0): string {
    let out = "";
    for (const ch of text) {
      if (this.isAllowed(ch)) {
        out += ch;
        continue;
      }
      if (ch === "\t") {
        out += "  ";
        continue;
      }
      const cp = ch.codePointAt(0) as number;
      // Control characters, the Minecraft formatting sigil (§) and private-use: drop silently.
      if (cp < 0x20 || cp === 0x7f || ch === "§" || (cp >= 0xe000 && cp <= 0xf8ff)) continue;
      let fallback = this.fallbacks[ch];
      if (fallback !== undefined && depth < 3) {
        // A fallback may itself use a glyph that was removed from the allowlist.
        fallback = this.enforceAllowlist(fallback, [], depth + 1);
      } else if (fallback === undefined) {
        fallback = "?";
      }
      if (depth === 0) replaced.push({ char: ch, with: fallback });
      out += fallback;
    }
    return out;
  }
}

function isLatexContext(text: string, offset: number): boolean {
  return /[$^_]|\\[A-Za-z]{2,}/.test(text.slice(Math.max(0, offset - 40), offset + 40));
}

/** `1 & 2 \\ 3 & 4` -> `[1 2; 3 4]` */
function formatMatrix(body: string): string {
  const rows = body
    .split(/\\\\/)
    .map((row) => row.trim())
    .filter(Boolean)
    .map((row) =>
      row
        .split("&")
        .map((cell) => {
          const c = cell.trim().replace(/\s+/g, " ");
          return /\s/.test(c) ? `(${c})` : c;
        })
        .join(" "),
    );
  return `[${rows.join("; ")}]`;
}

/**
 * JSON turns "\frac" into form-feed + "rac" when a model forgets to double the
 * backslash. Put the backslash back where the damage is recognisable.
 */
export function restoreEatenEscapes(text: string): string {
  const fix = (control: string, letter: string, tails: string[]) => {
    for (const tail of tails) text = text.split(control + tail).join(`\\${letter}${tail}`);
  };
  fix("\f", "f", ["rac", "orall"]);
  fix("\b", "b", ["eta", "egin", "inom", "ar{", "mod", "ecause", "oldsymbol"]);
  fix("\t", "t", ["heta", "au", "imes", "ext{", "o ", "frac", "an", "herefore", "ilde"]);
  fix("\r", "r", ["ho", "ightarrow", "angle", "ight", "floor", "ceil"]);
  fix("\v", "v", ["ec{", "arepsilon", "arphi", "ee", "dots"]);
  fix("\n", "n", ["eq ", "abla", "otin", "eg "]);
  // Any remaining \f, \b, \v are never meaningful in a question.
  return text.replace(/[\f\b\v]/g, "");
}

function tidy(text: string, code: boolean): string {
  let out = text.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n");
  if (!code) out = out.replace(/[ \t]{2,}/g, " ");
  return out.trim();
}
