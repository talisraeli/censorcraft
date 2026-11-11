import { glyphData, GlyphData } from "@censorcraft/shared";
import { describe, expect, it } from "vitest";
import { obviouslyEqual } from "../src/engine";
import { looksLikeCode, MathSanitizer, restoreEatenEscapes } from "../src/math/sanitize";

const s = new MathSanitizer();
const clean = (text: string, code?: boolean) => s.sanitize(text, code === undefined ? {} : { code }).text;

describe("LaTeX to Unicode", () => {
  it("converts fractions", () => {
    expect(clean("\\frac{a}{b}")).toBe("(a)/(b)");
    expect(clean("\\frac{x^2+1}{x-1}")).toBe("(x²+1)/(x-1)");
    expect(clean("\\dfrac{1}{2}")).toBe("(1)/(2)");
    expect(clean("\\frac12")).toBe("(1)/(2)");
  });

  it("converts nested fractions and roots", () => {
    expect(clean("\\frac{1}{\\sqrt{x}}")).toBe("(1)/(√(x))");
    expect(clean("\\sqrt{\\frac{a}{b}}")).toBe("√((a)/(b))");
    expect(clean("\\frac{\\frac{1}{2}}{3}")).toBe("((1)/(2))/(3)");
  });

  it("converts roots", () => {
    expect(clean("\\sqrt{x}")).toBe("√(x)");
    expect(clean("\\sqrt{x^2+1}")).toBe("√(x²+1)");
    expect(clean("\\sqrt[3]{x}")).toBe("³√(x)");
    expect(clean("\\sqrt[k]{x}")).toBe("root(k, x)");
    expect(clean("\\sqrt 2")).toBe("√(2)");
  });

  it("converts powers", () => {
    expect(clean("x^2")).toBe("x²");
    expect(clean("x^{10}")).toBe("x¹⁰");
    expect(clean("x^{-1}")).toBe("x⁻¹");
    expect(clean("A^{-1}")).toBe("A⁻¹");
    expect(clean("2^n")).toBe("2ⁿ");
    expect(clean("x^{n+1}")).toBe("xⁿ⁺¹");
    expect(clean("(x+1)^2")).toBe("(x+1)²");
  });

  it("falls back to ^( ) when a character has no superscript", () => {
    expect(clean("e^{2x}")).toBe("e^(2x)");
    expect(clean("x^{a+b}")).toBe("x^(a+b)");
    expect(clean("e^{x}")).toBe("e^x");
    expect(clean("e^x")).toBe("e^x");
  });

  it("converts subscripts", () => {
    expect(clean("x_1")).toBe("x₁");
    expect(clean("x_{12}")).toBe("x₁₂");
    expect(clean("a_n")).toBe("aₙ");
    expect(clean("a_{n+1}")).toBe("aₙ₊₁");
    expect(clean("x_{max}")).toBe("xₘₐₓ");
    expect(clean("x_{top}")).toBe("x_(top)");
    expect(clean("v_{t}")).toBe("v_t");
  });

  it("converts Greek letters and symbols", () => {
    expect(clean("\\alpha + \\beta = \\gamma")).toBe("α + β = γ");
    expect(clean("\\lambda \\pi \\theta \\Delta \\Omega")).toBe("λ π θ Δ Ω");
    expect(clean("x \\leq 3, y \\geq 2, z \\neq 0, w \\approx 1")).toBe("x ≤ 3, y ≥ 2, z ≠ 0, w ≈ 1");
    expect(clean("x \\to \\infty")).toBe("x → ∞");
    expect(clean("x \\in \\mathbb{R}")).toBe("x ∈ ℝ");
    expect(clean("a \\cdot b \\times c \\pm d")).toBe("a · b × c ± d");
  });

  it("converts integrals and sums with limits", () => {
    expect(clean("\\int_0^1 x^2 \\, dx")).toBe("∫₀¹ x² dx");
    expect(clean("\\int_{0}^{1} x^{2} dx")).toBe("∫₀¹ x² dx");
    expect(clean("\\sum_{i=1}^{n} i")).toBe("∑ᵢ₌₁ⁿ i");
    expect(clean("\\lim_{x \\to 0} \\frac{\\sin x}{x}")).toBe("lim_(x → 0) (sin x)/(x)");
  });

  it("strips math delimiters and layout commands", () => {
    expect(clean("Compute $x^2$ now")).toBe("Compute x² now");
    expect(clean("\\(a+b\\)")).toBe("a+b");
    expect(clean("$$\\left( \\frac{a}{b} \\right)$$")).toBe("( (a)/(b) )");
    expect(clean("\\text{if } x > 0")).toBe("if x > 0");
    expect(clean("\\mathbf{v} = \\vec{u}")).toBe("v = u");
  });

  it("converts matrices to inline form", () => {
    expect(clean("\\begin{pmatrix} 1 & 2 \\\\ 3 & 4 \\end{pmatrix}")).toBe("[1 2; 3 4]");
    expect(clean("A = \\begin{bmatrix} a & b \\\\ c & d \\end{bmatrix}")).toBe("A = [a b; c d]");
    expect(clean("\\begin{matrix} x+1 & 0 \\\\ 0 & 1 \\end{matrix}")).toBe("[x+1 0; 0 1]");
    expect(clean("\\begin{pmatrix} x + 1 & 0 \\end{pmatrix}")).toBe("[(x + 1) 0]");
  });

  it("keeps literal braces written as \\{ \\} and drops grouping braces", () => {
    expect(clean("S = \\{1, 2, 3\\}")).toBe("S = {1, 2, 3}");
    expect(clean("{x}^{2}")).toBe("x²");
    expect(clean("The set {1, 2, 3} has three elements.")).toBe("The set {1, 2, 3} has three elements.");
  });

  it("reports unknown commands and removes their backslash", () => {
    const result = s.sanitize("\\weirdcmd x + 1");
    expect(result.text).toBe("weirdcmd x + 1");
    expect(result.unknownCommands).toEqual(["\\weirdcmd"]);
    expect(s.findIssues(result).join(" ")).toMatch(/unknown LaTeX/);
  });

  it("leaves already-clean Unicode untouched and reports no issues", () => {
    const text = "∫₀¹ x² dx = 1/3 and √(x²+1) ≤ λ, A⁻¹, ∑ᵢ₌₁ⁿ i → ∞";
    const result = s.sanitize(text);
    expect(result.text).toBe(text);
    expect(s.findIssues(result)).toEqual([]);
    expect(result.replaced).toEqual([]);
  });
});

describe("unsupported symbols", () => {
  it("replaces characters outside the allowlist with fallbacks", () => {
    const result = s.sanitize("x ⊗ y ∴ ½ “quoted” — done");
    expect(result.text).toBe('x (x) y therefore 1/2 "quoted" - done');
    expect(result.replaced.map((r) => r.char)).toContain("⊗");
    expect(s.isClean(result.text)).toBe(true);
  });

  it("uses ? when no fallback exists and reports it as an issue", () => {
    const result = s.sanitize("x ⚛ y");
    expect(result.text).toBe("x ? y");
    expect(s.findIssues(result).join(" ")).toMatch(/unsupported characters: ⚛/);
  });

  it("drops control characters and Minecraft formatting sigils", () => {
    expect(clean("a§cb\u0007c\u200bd")).toBe("acbcd");
  });

  it("respects a trimmed allowlist (superscripts removed)", () => {
    const trimmed: GlyphData = { ...glyphData, categories: { ...glyphData.categories, superscripts: "", operators: "−×·" } };
    const t = new MathSanitizer(trimmed);
    expect(t.sanitize("x^2 + \\sqrt{y}").text).toBe("x^2 + sqrt(y)");
    expect(t.sanitize("x² ≤ ∞").text).toBe("x? ≤ infinity");
    expect(t.sanitize("x^{10}").text).toBe("x^(10)");
  });
});

describe("code awareness", () => {
  const code = 'int main(void) {\n  int my_var = a ^ b;\n  printf("%d\\n", my_var);\n  return 0;\n}';

  it("detects C code", () => {
    expect(looksLikeCode(code)).toBe(true);
    expect(looksLikeCode("What is the derivative of x^2?")).toBe(false);
  });

  it("does not touch C escapes, XOR or snake_case", () => {
    expect(clean(code)).toBe(code);
    expect(s.findIssues(s.sanitize(code))).toEqual([]);
  });

  it("does not convert snake_case in prose either", () => {
    expect(clean("Use the variable max_value and loop_count here")).toBe("Use the variable max_value and loop_count here");
    expect(clean("a ^ b is XOR")).toBe("a ^ b is XOR");
  });
});

describe("JSON escape damage", () => {
  it("restores commands whose backslash was eaten by a JSON escape", () => {
    expect(clean(restoreEatenEscapes("\frac{1}{2}"))).toBe("(1)/(2)");
    expect(clean("\theta + \beta")).toBe("θ + β");
    expect(clean("x \neq y")).toBe("x ≠ y");
  });
});

describe("answer normalization", () => {
  const norm = (t: string) => s.normalizeAnswer(t);

  it("maps ASCII spellings to canonical symbols", () => {
    expect(norm("sqrt(2)")).toBe("√(2)");
    expect(norm("sqrt 2")).toBe("√(2)");
    expect(norm("√2")).toBe("√(2)");
    expect(norm("x^2")).toBe("x²");
    expect(norm("pi")).toBe("π");
    expect(norm("2*pi")).toBe("2·π");
    expect(norm("inf")).toBe("∞");
    expect(norm("-infinity")).toBe("-∞");
    expect(norm("x <= 3")).toBe("x ≤ 3");
    expect(norm("x >= 3")).toBe("x ≥ 3");
    expect(norm("x != 3")).toBe("x ≠ 3");
    expect(norm("x -> 0")).toBe("x → 0");
    expect(norm("  1/2  ")).toBe("1/2");
    expect(norm("theta")).toBe("θ");
  });

  it("does not rewrite words that merely contain symbol names", () => {
    expect(norm("pipeline")).toBe("pipeline");
    expect(norm("information")).toBe("information");
  });

  it("leaves code answers alone", () => {
    expect(s.normalizeAnswer("int  f(int x){ return x*x; }", { code: true })).toBe("int f(int x){ return x*x; }");
  });

  it("recognises obviously equal answers", () => {
    expect(obviouslyEqual(s, "sqrt(2)", "√2")).toBe(true);
    expect(obviouslyEqual(s, "x^2", "x²")).toBe(true);
    expect(obviouslyEqual(s, "0.5", "1/2")).toBe(true);
    expect(obviouslyEqual(s, "2*PI", "2π")).toBe(false); // left to the AI grader
    expect(obviouslyEqual(s, " −2 ", "-2")).toBe(true);
    expect(obviouslyEqual(s, "X <= 3", "x ≤ 3")).toBe(true);
    expect(obviouslyEqual(s, "3", "4")).toBe(false);
    expect(obviouslyEqual(s, "", "")).toBe(false);
  });
});
