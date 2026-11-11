import { createHash, randomBytes } from "node:crypto";
import { Difficulty, newId, QuestionFormat, WireQuestion } from "@censorcraft/shared";
import { z } from "zod";
import { parseAiJson } from "./ai/json";
import { AiError, AiProvider, withRetries } from "./ai/provider";
import { CourseIndex } from "./ingest/index";
import { Limiter } from "./limits";
import { Logger } from "./logger";
import { looksLikeCode, MathSanitizer } from "./math/sanitize";
import { Prompts } from "./prompts";

export const QuestionSchema = z.object({
  format: z.enum(["mc", "short", "code"]),
  question: z.string(),
  options: z.array(z.string()),
  correctIndex: z.number(),
  referenceAnswer: z.string(),
  rubric: z.string(),
  explanation: z.string(),
});
export type RawQuestion = z.infer<typeof QuestionSchema>;

export const VerdictSchema = z.object({
  correct: z.boolean(),
  score: z.number(),
  explanation: z.string(),
});
export type RawVerdict = z.infer<typeof VerdictSchema>;

function jsonSchemaOf(schema: z.ZodType): Record<string, unknown> {
  const { $schema: _drop, ...rest } = z.toJSONSchema(schema) as Record<string, unknown>;
  return rest;
}
const QUESTION_JSON_SCHEMA = jsonSchemaOf(QuestionSchema);
const VERDICT_JSON_SCHEMA = jsonSchemaOf(VerdictSchema);

/** A question with its secrets. Lives only in the companion's memory. */
export interface StoredQuestion {
  wire: WireQuestion;
  topic: string;
  /** Index into wire.opts (after shuffling) for mc. */
  correctIndex: number;
  reference: string;
  rubric: string;
  explanation: string;
  code: boolean;
  createdAt: number;
}

export interface Verdict {
  ok: boolean;
  score: number;
  explanation: string;
}

export interface GenerateOptions {
  playerId: string;
  topic: string;
  custom?: boolean;
  difficulty: Difficulty;
  preferredFormat?: QuestionFormat;
  /** Stems of questions this player already saw. */
  avoid?: string[];
}

export interface EngineOptions {
  provider: AiProvider;
  index: CourseIndex;
  sanitizer: MathSanitizer;
  limiter: Limiter;
  prompts: Prompts;
  log: Logger;
  maxOutputTokens: number;
  maxRetries: number;
  random?: () => number;
}

const MAX_QUESTION_CHARS = 900;
const MAX_OPTION_CHARS = 160;
const MAX_EXPLANATION_CHARS = 420;
const MAX_ANSWER_CHARS = 800;

export function isCodeTopic(topic: string): boolean {
  return /(^|[^a-z])c($|[^a-z+#])|\bc fundamentals\b|\bprogramming\b|\bpointers?\b|\bc\+\+|\bcoding\b|\balgorithms?\b|\bdata structures?\b/i.test(
    topic,
  );
}

export function questionHash(text: string): string {
  const key = text.toLowerCase().replace(/\s+/g, " ").trim();
  return createHash("sha1").update(key).digest("hex").slice(0, 12);
}

function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  const sentence = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("\n"));
  return (sentence > max * 0.6 ? cut.slice(0, sentence + 1) : cut).trimEnd() + "…";
}

export class Engine {
  private readonly random: () => number;

  constructor(private readonly o: EngineOptions) {
    this.random = o.random ?? Math.random;
  }

  // ---- generation ---------------------------------------------------------

  async generate(options: GenerateOptions): Promise<StoredQuestion> {
    const { log, index, prompts } = this.o;
    this.o.limiter.check(options.playerId);

    const picked = index.enabled ? index.pick(options.topic) : undefined;
    const codeTopic = isCodeTopic(options.topic) || (picked ? /\.(c|h|cpp|hpp)$/i.test(picked.chunk.file) : false);
    const formats: QuestionFormat[] = codeTopic ? ["mc", "short", "code"] : ["mc", "short"];
    const preferred = options.preferredFormat && formats.includes(options.preferredFormat) ? options.preferredFormat : undefined;

    const system = prompts.generateSystem();
    const user = prompts.generateUser({
      topic: options.topic,
      difficulty: options.difficulty,
      formats,
      preferredFormat: preferred,
      avoid: (options.avoid ?? []).slice(-6),
      material: picked
        ? { source: picked.chunk.file, text: picked.chunk.text, nonce: randomBytes(6).toString("hex") }
        : undefined,
    });
    log.debug(
      picked
        ? `Generating ${options.difficulty} question for "${options.topic}" from ${picked.chunk.id} (${picked.via})`
        : `Generating ${options.difficulty} question for "${options.topic}" from the model's own knowledge`,
    );

    const build = (raw: RawQuestion) => this.buildQuestion(raw, options, formats, picked ? "material" : "syllabus", codeTopic);
    const validate = (raw: RawQuestion) => validateRawQuestion(raw);

    // First attempt.
    const first = build(await this.callJson(system, user, "question", QUESTION_JSON_SCHEMA, QuestionSchema, validate));
    if (first.issues.length === 0) return first.question;

    // The deterministic sanitizer could not fully clean it: ask once more, then fall back to the sanitized text.
    log.info(`Question needed cleanup (${first.issues.join("; ")}); asking the model to regenerate once.`);
    try {
      const second = build(
        await this.callJson(
          system,
          user + prompts.regenerateNote(first.issues.join("; ")),
          "question",
          QUESTION_JSON_SCHEMA,
          QuestionSchema,
          validate,
        ),
      );
      if (second.issues.length > 0) log.warn(`Regenerated question still had issues (${second.issues.join("; ")}); using the sanitized version.`);
      return second.question;
    } catch (e) {
      log.warn(`Regeneration failed (${(e as Error).message}); using the sanitized first version.`);
      return first.question;
    }
  }

  private buildQuestion(
    raw: RawQuestion,
    options: GenerateOptions,
    formats: QuestionFormat[],
    src: "material" | "syllabus",
    codeTopic: boolean,
  ): { question: StoredQuestion; issues: string[] } {
    const { sanitizer, log } = this.o;
    const issues: string[] = [];
    let format: QuestionFormat = raw.format;
    if (!formats.includes(format)) format = "short";

    const allText = [raw.question, ...raw.options, raw.referenceAnswer].join("\n");
    const code = format === "code" || (codeTopic && looksLikeCode(allText));

    const clean = (text: string, label: string, forceCode = code): string => {
      const result = sanitizer.sanitize(text, { code: forceCode });
      for (const r of result.replaced) log.debug(`Replaced unsupported character "${r.char}" with "${r.with}" in ${label}`);
      for (const issue of sanitizer.findIssues(result, { code: forceCode })) issues.push(`${label}: ${issue}`);
      return result.text;
    };

    const text = clip(clean(raw.question, "question"), MAX_QUESTION_CHARS);
    const explanation = clip(clean(raw.explanation, "explanation"), MAX_EXPLANATION_CHARS);
    let reference = clean(raw.referenceAnswer, "referenceAnswer");
    const rubric = sanitizer.sanitize(raw.rubric, { code }).text;

    let opts: string[] | undefined;
    let correctIndex = -1;
    if (format === "mc") {
      const cleaned = raw.options.map((o, i) => clip(clean(o, `option ${i + 1}`), MAX_OPTION_CHARS));
      // Shuffle so the position of the correct option carries no information.
      const order = cleaned.map((_o, i) => i);
      for (let i = order.length - 1; i > 0; i--) {
        const j = Math.floor(this.random() * (i + 1));
        [order[i], order[j]] = [order[j] as number, order[i] as number];
      }
      opts = order.map((i) => cleaned[i] as string);
      correctIndex = order.indexOf(raw.correctIndex);
      reference = opts[correctIndex] as string;
    }

    const wire: WireQuestion = {
      qid: newId(),
      fmt: format,
      text,
      hash: questionHash(text),
      diff: options.difficulty,
      src,
      ...(opts ? { opts } : {}),
    };
    return {
      question: { wire, topic: options.topic, correctIndex, reference, rubric, explanation, code, createdAt: Date.now() },
      issues,
    };
  }

  // ---- grading -------------------------------------------------------------

  async grade(question: StoredQuestion, rawAnswer: string): Promise<Verdict> {
    const { sanitizer, prompts, log } = this.o;
    const hard = question.wire.diff === "hard";

    if (question.wire.fmt === "mc") {
      const choice = /^\s*[0-3]\s*$/.test(rawAnswer) ? Number(rawAnswer) : -1;
      const ok = choice === question.correctIndex;
      const right = question.wire.opts?.[question.correctIndex] ?? question.reference;
      return {
        ok,
        score: ok ? 1 : 0,
        explanation: clip(ok ? question.explanation : `The correct answer was: ${right}. ${question.explanation}`, MAX_EXPLANATION_CHARS + 120),
      };
    }

    const answer = rawAnswer.replace(/[\u0000-\u0008\u000b-\u001f]/g, " ").trim().slice(0, MAX_ANSWER_CHARS);
    if (!answer) {
      return { ok: false, score: 0, explanation: clip(`No answer was given. Expected: ${question.reference}. ${question.explanation}`, MAX_EXPLANATION_CHARS + 120) };
    }

    // Normalize both sides (ASCII spellings -> canonical symbols) before any comparison.
    const code = question.wire.fmt === "code";
    const normAnswer = sanitizer.normalizeAnswer(answer, { code });
    const normReference = sanitizer.normalizeAnswer(question.reference, { code });
    if (!code && obviouslyEqual(sanitizer, answer, question.reference)) {
      return { ok: true, score: 1, explanation: question.explanation };
    }

    const nonce = randomBytes(6).toString("hex");
    const user = prompts.gradeUser({
      question: question.wire.text + (question.wire.opts ? `\nOptions: ${question.wire.opts.join(" | ")}` : ""),
      reference: normReference,
      rubric: question.rubric,
      difficulty: question.wire.diff,
      // The answer cannot close its own delimiter: the tag carries a random nonce.
      answer: normAnswer,
      nonce,
    });
    const raw = await this.callJson(prompts.gradeSystem(hard), user, "verdict", VERDICT_JSON_SCHEMA, VerdictSchema);

    let score = Number.isFinite(raw.score) ? Math.min(1, Math.max(0, raw.score)) : raw.correct ? 1 : 0;
    if (raw.correct && score < 1) score = 1;
    if (!raw.correct && score >= 1) score = hard ? 0.9 : 0;
    if (!hard) score = raw.correct ? 1 : 0; // partial credit only exists on Hard
    const ok = score >= 0.999;

    const result = sanitizer.sanitize(raw.explanation, { code });
    for (const r of result.replaced) log.debug(`Replaced unsupported character "${r.char}" in verdict explanation`);
    const explanation = clip(result.text || question.explanation, MAX_EXPLANATION_CHARS);
    return { ok, score: Math.round(score * 100) / 100, explanation };
  }

  // ---- provider call with repair path ---------------------------------------

  private async callJson<T>(
    system: string,
    user: string,
    schemaName: string,
    jsonSchema: Record<string, unknown>,
    schema: z.ZodType<T>,
    validate?: (value: T) => void,
  ): Promise<T> {
    const { provider, limiter, log, prompts } = this.o;
    let prompt = user;
    for (let attempt = 0; ; attempt++) {
      const response = await limiter.run(() =>
        withRetries(
          () => provider.generate({ system, user: prompt, jsonSchema, schemaName, maxOutputTokens: this.o.maxOutputTokens }),
          {
            maxRetries: this.o.maxRetries,
            onRetry: (n, error, delay) => log.warn(`AI request failed (${error.kind}): ${error.message} Retry ${n} in ${delay} ms.`),
          },
        ),
      );
      if (response.usage) limiter.recordTokens(response.usage.inputTokens + response.usage.outputTokens);
      try {
        const value = parseAiJson(response.text, schema);
        validate?.(value);
        return value;
      } catch (error) {
        if (!(error instanceof AiError) || error.kind !== "malformed" || attempt >= 1) throw error;
        log.warn(`AI output was malformed (${error.message}); asking it to repair.`);
        prompt = user + prompts.repairNote(error.message);
      }
    }
  }
}

function validateRawQuestion(raw: RawQuestion): void {
  if (raw.question.trim().length < 8) throw new AiError("malformed", "question text is empty or too short", true);
  if (raw.format === "mc") {
    const options = raw.options.map((o) => o.trim());
    if (options.length !== 4 || options.some((o) => !o)) {
      throw new AiError("malformed", "a multiple choice question needs exactly 4 non-empty options", true);
    }
    if (new Set(options.map((o) => o.toLowerCase())).size !== 4) throw new AiError("malformed", "the 4 options must be distinct", true);
    if (!Number.isInteger(raw.correctIndex) || raw.correctIndex < 0 || raw.correctIndex > 3) {
      throw new AiError("malformed", "correctIndex must be 0, 1, 2 or 3 for a multiple choice question", true);
    }
  } else if (!raw.referenceAnswer.trim()) {
    throw new AiError("malformed", "referenceAnswer must not be empty", true);
  }
}

function numeric(text: string): number | undefined {
  const t = text.replace(/\s+/g, "").replace(/−/g, "-");
  let m = /^(-?\d+(?:\.\d+)?)$/.exec(t);
  if (m) return Number(m[1]);
  m = /^\(?(-?\d+(?:\.\d+)?)\)?\/\(?(\d+(?:\.\d+)?)\)?$/.exec(t);
  if (m && Number(m[2]) !== 0) return Number(m[1]) / Number(m[2]);
  return undefined;
}

/**
 * Cheap, safe "definitely the same" check (never decides that an answer is
 * wrong - that is always the AI grader's call).
 */
export function obviouslyEqual(sanitizer: MathSanitizer, answer: string, reference: string): boolean {
  const a = sanitizer.comparisonKey(answer);
  const b = sanitizer.comparisonKey(reference);
  if (a !== "" && a === b) return true;
  const na = numeric(sanitizer.normalizeAnswer(answer));
  const nb = numeric(sanitizer.normalizeAnswer(reference));
  return na !== undefined && nb !== undefined && Math.abs(na - nb) <= 1e-9 * Math.max(1, Math.abs(nb));
}
