import { MathSanitizer } from "../math/sanitize";
import { AiProvider, AiRequest, AiResponse } from "./provider";

export interface MockQuestion {
  format: "mc" | "short" | "code";
  question: string;
  options: string[];
  correctIndex: number;
  referenceAnswer: string;
  rubric: string;
  explanation: string;
}

/** Canned questions. Exported so tests can look up the expected answers. */
export const MOCK_BANK: Record<string, MockQuestion[]> = {
  calculus: [
    {
      format: "mc",
      question: "What is the derivative of f(x) = x² with respect to x?",
      options: ["2x", "x", "x²/2", "2"],
      correctIndex: 0,
      referenceAnswer: "2x",
      rubric: "Must select 2x.",
      explanation: "By the power rule, d/dx xⁿ = n·xⁿ⁻¹, so d/dx x² = 2x.",
    },
    {
      format: "short",
      question: "Evaluate ∫₀¹ x dx.",
      options: [],
      correctIndex: -1,
      referenceAnswer: "1/2",
      rubric: "The value 1/2 (or 0.5).",
      explanation: "An antiderivative of x is x²/2; evaluating from 0 to 1 gives 1/2.",
    },
    {
      format: "short",
      question: "What is lim x→∞ of 1/x?",
      options: [],
      correctIndex: -1,
      referenceAnswer: "0",
      rubric: "The value 0.",
      explanation: "As x grows without bound, 1/x gets arbitrarily close to 0.",
    },
  ],
  linear: [
    {
      format: "mc",
      question: "What is the determinant of the matrix [1 2; 3 4]?",
      options: ["−2", "2", "10", "−10"],
      correctIndex: 0,
      referenceAnswer: "−2",
      rubric: "Must select −2.",
      explanation: "det [a b; c d] = ad − bc = 1·4 − 2·3 = −2.",
    },
    {
      format: "short",
      question: "What is the length of the vector (1, 1)? Give an exact value.",
      options: [],
      correctIndex: -1,
      referenceAnswer: "√2",
      rubric: "√2, also written sqrt(2).",
      explanation: "The length is √(1² + 1²) = √2.",
    },
  ],
  c: [
    {
      format: "mc",
      question: "In C, which format specifier prints an int with printf?",
      options: ["%d", "%s", "%f", "%c"],
      correctIndex: 0,
      referenceAnswer: "%d",
      rubric: "Must select %d.",
      explanation: "%d formats a signed decimal int; %s is for strings, %f for doubles and %c for a char.",
    },
    {
      format: "code",
      question: "Write a C function `int square(int x)` that returns x multiplied by itself.",
      options: [],
      correctIndex: -1,
      referenceAnswer: "int square(int x){return x*x;}",
      rubric: "A function named square taking an int and returning x*x.",
      explanation: "Multiplying x by itself and returning the result gives the square.",
    },
  ],
  generic: [
    {
      format: "mc",
      question: "Which of these is a prime number?",
      options: ["7", "8", "9", "10"],
      correctIndex: 0,
      referenceAnswer: "7",
      rubric: "Must select 7.",
      explanation: "7 has no divisors other than 1 and itself.",
    },
    {
      format: "short",
      question: "How many sides does a hexagon have?",
      options: [],
      correctIndex: -1,
      referenceAnswer: "6",
      rubric: "The number 6.",
      explanation: "The prefix hexa- means six.",
    },
  ],
};

/** A reply full of LaTeX, used to exercise the sanitizer + regenerate path (model "mock-latex"). */
const LATEX_QUESTION: MockQuestion = {
  format: "short",
  question: "Evaluate $\\int_0^1 x^2 \\, dx$ and compare it with $\\frac{1}{3}$.",
  options: [],
  correctIndex: -1,
  referenceAnswer: "\\frac{1}{3}",
  rubric: "The value 1/3.",
  explanation: "An antiderivative is $\\frac{x^3}{3}$, so the value is $\\frac{1}{3}$.",
};

function bankFor(topic: string): MockQuestion[] {
  const t = topic.toLowerCase();
  if (/calc|deriv|integr|limit/.test(t)) return MOCK_BANK.calculus as MockQuestion[];
  if (/linear|matri|vector|algebra/.test(t)) return MOCK_BANK.linear as MockQuestion[];
  if (/(^|[^a-z])c($|[^a-z])|program|pointer/.test(t)) return MOCK_BANK.c as MockQuestion[];
  return MOCK_BANK.generic as MockQuestion[];
}

/**
 * Offline provider for tests and for trying the pipeline without an API key.
 *   model "mock"          - well-formed answers
 *   model "mock-latex"    - question replies contain convertible LaTeX (tests the deterministic sanitizer)
 *   model "mock-latex-bad"- first reply contains LaTeX the sanitizer cannot clean (tests the regenerate path)
 *   model "mock-badjson"  - first reply of every request is broken JSON (tests the repair path)
 * It reads the real prompts, so prompt structure regressions show up in tests.
 */
export class MockProvider implements AiProvider {
  readonly name = "mock";
  readonly calls: AiRequest[] = [];
  private counter = 0;
  private readonly sanitizer = new MathSanitizer();

  constructor(readonly model: string = "mock") {}

  async generate(request: AiRequest): Promise<AiResponse> {
    this.calls.push(request);
    const repairing = /previous reply could not be used/.test(request.user);
    if (this.model === "mock-badjson" && !repairing) {
      return { text: '{"format": "short", "question": "broken', usage: { inputTokens: 10, outputTokens: 5 } };
    }
    const value = request.schemaName === "verdict" ? this.verdict(request) : this.question(request);
    return {
      text: JSON.stringify(value),
      usage: { inputTokens: Math.ceil((request.system.length + request.user.length) / 4), outputTokens: 60 },
    };
  }

  private question(request: AiRequest): MockQuestion {
    const topic = /^topic:\s*(.*)$/m.exec(request.user)?.[1] ?? "";
    const preferred = /^preferred_format:\s*(\w+)/m.exec(request.user)?.[1];
    const allowed = (/^allowed_formats:\s*(.*)$/m.exec(request.user)?.[1] ?? "mc, short").split(/,\s*/);
    const regenerating = /previous attempt was rejected/.test(request.user);
    if (this.model === "mock-latex") return LATEX_QUESTION;
    if (this.model === "mock-latex-bad" && !regenerating) {
      // \customop is not a known command and ⚛ has no fallback: the sanitizer cannot fully clean this.
      return { ...LATEX_QUESTION, question: `${LATEX_QUESTION.question} Then apply \\customop{x} ⚛.` };
    }

    let pool = bankFor(topic).filter((q) => allowed.includes(q.format));
    if (preferred && pool.some((q) => q.format === preferred)) pool = pool.filter((q) => q.format === preferred);
    // Honour avoid_repeating when possible.
    const fresh = pool.filter((q) => !request.user.includes(q.question.slice(0, 40)));
    if (fresh.length) pool = fresh;
    return pool[this.counter++ % pool.length] as MockQuestion;
  }

  private verdict(request: AiRequest): { correct: boolean; score: number; explanation: string } {
    const reference = /<reference_answer>\n([\s\S]*?)\n<\/reference_answer>/.exec(request.user)?.[1] ?? "";
    const answer = /<student_answer-(\w+)[^>]*>\n([\s\S]*?)\n<\/student_answer-\1>/.exec(request.user)?.[2] ?? "";
    const partialAllowed = /Partial credit: ALLOWED/.test(request.system);
    const key = (s: string) => this.sanitizer.comparisonKey(s).replace(/[;{}()\s]/g, "");
    if (key(answer) === key(reference)) return { correct: true, score: 1, explanation: "Correct - that matches the expected answer." };
    if (partialAllowed && /\bpartial\b/i.test(answer)) {
      return { correct: false, score: 0.5, explanation: `Right idea, but incomplete. Expected: ${reference}.` };
    }
    return { correct: false, score: 0, explanation: `Not quite. Expected: ${reference}.` };
  }
}
