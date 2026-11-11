/** LaTeX command tables used by the sanitizer. */

export const SYMBOL_COMMANDS: Record<string, string> = {
  // Greek
  alpha: "α", beta: "β", gamma: "γ", delta: "δ", epsilon: "ε", varepsilon: "ε", zeta: "ζ", eta: "η",
  theta: "θ", vartheta: "θ", iota: "ι", kappa: "κ", lambda: "λ", mu: "μ", nu: "ν", xi: "ξ", pi: "π",
  rho: "ρ", sigma: "σ", tau: "τ", upsilon: "υ", phi: "φ", varphi: "φ", chi: "χ", psi: "ψ", omega: "ω",
  Gamma: "Γ", Delta: "Δ", Theta: "Θ", Lambda: "Λ", Xi: "Ξ", Pi: "Π", Sigma: "Σ", Phi: "Φ", Psi: "Ψ", Omega: "Ω",
  // Big operators
  int: "∫", iint: "∫∫", iiint: "∫∫∫", oint: "∮", sum: "∑", prod: "∏",
  // Operators
  cdot: "·", times: "×", div: "÷", pm: "±", mp: "∓", ast: "*", star: "*", circ: "∘", bullet: "·",
  partial: "∂", nabla: "∇", infty: "∞", surd: "√", prime: "′", degree: "°",
  // Relations
  leq: "≤", le: "≤", geq: "≥", ge: "≥", neq: "≠", ne: "≠", approx: "≈", equiv: "≡", sim: "~", simeq: "≈",
  cong: "≈", propto: "∝", ll: "<<", gg: ">>", in: "∈", notin: "∉", ni: "∋", subset: "⊂", subseteq: "⊆",
  supset: "⊃", supseteq: "⊇", cup: "∪", cap: "∩", emptyset: "∅", varnothing: "∅", setminus: "\\",
  mid: "|", parallel: "‖", perp: "⊥",
  // Logic
  forall: "∀", exists: "∃", neg: "¬", lnot: "¬", land: "∧", wedge: "∧", lor: "∨", vee: "∨",
  therefore: "∴", because: "∵",
  // Arrows
  to: "→", rightarrow: "→", longrightarrow: "→", leftarrow: "←", gets: "←", leftrightarrow: "↔",
  Rightarrow: "⇒", implies: "⇒", Longrightarrow: "⇒", Leftrightarrow: "⇔", iff: "⇔", mapsto: "→",
  // Brackets
  langle: "⟨", rangle: "⟩", lfloor: "⌊", rfloor: "⌋", lceil: "⌈", rceil: "⌉", lvert: "|", rvert: "|",
  lVert: "‖", rVert: "‖", vert: "|", Vert: "‖", lbrace: "{", rbrace: "}", lbrack: "[", rbrack: "]",
  // Dots and misc
  ldots: "…", cdots: "…", dots: "…", vdots: "…", ddots: "…", ell: "l", hbar: "ℏ", angle: "∠",
  oplus: "⊕", otimes: "⊗", top: "T", dagger: "†", colon: ":", backslash: "\\",
};

/** Commands that simply print their own name (functions). */
export const FUNCTION_COMMANDS = new Set([
  "sin", "cos", "tan", "cot", "sec", "csc", "arcsin", "arccos", "arctan", "sinh", "cosh", "tanh",
  "ln", "log", "lg", "exp", "lim", "limsup", "liminf", "max", "min", "sup", "inf", "det", "dim", "ker",
  "gcd", "deg", "arg", "mod", "bmod", "pmod", "Pr", "tr", "rank", "span",
]);

/** Commands that are dropped entirely (layout only). */
export const DROP_COMMANDS = new Set([
  "left", "right", "big", "Big", "bigg", "Bigg", "bigl", "bigr", "Bigl", "Bigr", "displaystyle", "textstyle",
  "scriptstyle", "limits", "nolimits", "quad", "qquad", "hline", "noindent", "centering", "middle",
]);

/** One-argument commands whose argument is kept as-is. */
export const UNWRAP_COMMANDS = new Set([
  "text", "textrm", "textbf", "textit", "texttt", "textsf", "mathrm", "mathbf", "mathit", "mathsf", "mathtt",
  "mathcal", "mathscr", "mathfrak", "boldsymbol", "bm", "operatorname", "vec", "overrightarrow", "mbox", "hbox",
  "underline", "emph", "phantom", "boxed",
]);

/** One-argument accents rendered as a suffix word. */
export const ACCENT_COMMANDS: Record<string, string> = {
  hat: "-hat", widehat: "-hat", bar: "-bar", overline: "-bar", tilde: "-tilde", widetilde: "-tilde",
  dot: "'", ddot: "''",
};

export const BLACKBOARD: Record<string, string> = { R: "ℝ", N: "ℕ", Z: "ℤ", Q: "ℚ", C: "ℂ" };

/** Words a player may type on a keyboard -> canonical symbol (answer normalization). */
export const ASCII_WORDS: Record<string, string> = {
  pi: "π", inf: "∞", infinity: "∞", infty: "∞", oo: "∞",
  alpha: "α", beta: "β", gamma: "γ", delta: "δ", epsilon: "ε", theta: "θ", lambda: "λ", mu: "μ",
  sigma: "σ", tau: "τ", phi: "φ", omega: "ω", rho: "ρ",
};

/** Operator spellings -> canonical symbol (answer normalization). Longest first. */
export const ASCII_OPERATORS: [string, string][] = [
  ["<=>", "⇔"], ["<->", "↔"], ["=>", "⇒"], ["->", "→"], ["<=", "≤"], ["=<", "≤"], [">=", "≥"], ["!=", "≠"],
  ["<>", "≠"], ["=/=", "≠"], ["~=", "≈"], ["+-", "±"], ["+/-", "±"],
];
