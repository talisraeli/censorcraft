import { z } from "zod";
import { AiError } from "./provider";

/** Pull the JSON object out of a model reply (tolerates code fences and chatter). */
export function extractJson(text: string): string {
  let t = text.trim();
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(t);
  if (fence) t = (fence[1] as string).trim();
  const first = t.indexOf("{");
  const last = t.lastIndexOf("}");
  if (first >= 0 && last > first) t = t.slice(first, last + 1);
  return t;
}

/** After "\b", "\f", "\n", "\r", "\t": text that means it was really a LaTeX command (\beta, \frac, \neq ...). */
const LATEX_TAILS: Record<string, RegExp> = {
  b: /^(eta|egin|inom|ar\b|ar\{|mod|ecause|oldsymbol|igg?)/,
  f: /^(rac|orall)/,
  n: /^(eq\b|abla|otin|eg\b|u\b)/,
  r: /^(ho\b|ight|angle|floor|ceil)/,
  t: /^(heta|au\b|imes|ext|o\b|an\b|frac|ilde|herefore)/,
};

/**
 * Repair the mistakes models actually make in JSON:
 *  - backslashes that are not valid JSON escapes (\alpha, \(, \sqrt): doubled
 *  - valid-but-unintended escapes followed by letters (\frac, \theta, \beta): doubled
 *  - raw newlines / tabs inside strings: escaped
 *  - trailing commas
 */
export function repairJson(text: string): string {
  let out = "";
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i] as string;
    if (!inString) {
      if (ch === '"') inString = true;
      if (ch === "," && /^\s*[}\]]/.test(text.slice(i + 1))) continue; // trailing comma
      out += ch;
      continue;
    }
    if (ch === "\\") {
      const next = text[i + 1] ?? "";
      if (next === '"' || next === "\\" || next === "/") {
        out += ch + next;
        i++;
      } else if (next === "u" && /^[0-9a-fA-F]{4}$/.test(text.slice(i + 2, i + 6))) {
        out += ch + next;
        i++;
      } else if (next !== "" && "bfnrt".includes(next) && !(LATEX_TAILS[next] as RegExp).test(text.slice(i + 2, i + 12))) {
        out += ch + next; // a real escape such as \n
        i++;
      } else {
        out += "\\\\"; // LaTeX-style backslash: keep it literally
      }
      continue;
    }
    if (ch === '"') inString = false;
    if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "";
    else if (ch === "\t") out += "\\t";
    else out += ch;
  }
  return out;
}

/**
 * Parse + validate a model reply. Tries the raw JSON first, then a repaired
 * version. Throws AiError("malformed") with a description that can be fed back
 * to the model for a retry.
 */
export function parseAiJson<T>(text: string, schema: z.ZodType<T>): T {
  const candidate = extractJson(text);
  let value: unknown;
  let parsed = false;
  let parseError = "";
  for (const attempt of [candidate, repairJson(candidate)]) {
    try {
      value = JSON.parse(attempt);
      parsed = true;
      break;
    } catch (e) {
      parseError = (e as Error).message;
    }
  }
  if (!parsed) {
    throw new AiError("malformed", `The reply was not valid JSON (${parseError}).`, true);
  }
  const result = schema.safeParse(value);
  if (!result.success) {
    const problems = result.error.issues
      .slice(0, 6)
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    throw new AiError("malformed", `The reply JSON did not match the schema (${problems}).`, true);
  }
  return result.data;
}
