import { readFileSync } from "node:fs";
import path from "node:path";
import { glyphCategories, GlyphData } from "@censorcraft/shared";

type Lines = string[];

interface PromptFile {
  mathRules: Lines;
  generateSystem: Lines;
  generateUser: Lines;
  materialBlock: Lines;
  noMaterial: Lines;
  regenerateNote: Lines;
  gradeSystem: Lines;
  gradeUser: Lines;
  repairNote: Lines;
  difficulty: Record<string, string>;
  partialCredit: { allowed: string; none: string };
}

const REQUIRED: (keyof PromptFile)[] = [
  "mathRules",
  "generateSystem",
  "generateUser",
  "materialBlock",
  "noMaterial",
  "regenerateNote",
  "gradeSystem",
  "gradeUser",
  "repairNote",
  "difficulty",
  "partialCredit",
];

/** Replace {{name}} placeholders. Values are inserted verbatim (never re-expanded). */
export function render(template: string, values: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (match, name: string) => (name in values ? (values[name] as string) : match));
}

export class Prompts {
  private readonly file: PromptFile;
  private readonly mathRules: string;

  constructor(file: unknown, glyphs: GlyphData) {
    const f = file as PromptFile;
    for (const key of REQUIRED) {
      if (f?.[key] === undefined) throw new Error(`prompts.json is missing "${key}"`);
    }
    this.file = f;
    const glyphList = glyphCategories(glyphs)
      .map(([name, chars]) => `${name}: ${chars.join(" ")}`)
      .join(" | ");
    this.mathRules = render(f.mathRules.join("\n"), { glyphs: glyphList });
  }

  static load(companionDir: string, glyphs: GlyphData): Prompts {
    const raw = JSON.parse(readFileSync(path.join(companionDir, "prompts.json"), "utf8"));
    return new Prompts(raw, glyphs);
  }

  generateSystem(): string {
    return render(this.file.generateSystem.join("\n"), { mathRules: this.mathRules });
  }

  generateUser(v: {
    topic: string;
    difficulty: string;
    formats: string[];
    preferredFormat?: string;
    avoid: string[];
    material?: { source: string; text: string; nonce: string };
  }): string {
    const material = v.material
      ? render(this.file.materialBlock.join("\n"), {
          nonce: v.material.nonce,
          source: v.material.source.replace(/["<>]/g, "_"),
          // The material can never close its own delimiter: the nonce is random per request.
          text: v.material.text,
        })
      : this.file.noMaterial.join("\n");
    return render(this.file.generateUser.join("\n"), {
      topic: v.topic.replace(/[\r\n<>]/g, " ").slice(0, 120),
      difficulty: this.file.difficulty[v.difficulty] ?? v.difficulty,
      formats: v.formats.join(", "),
      preferredFormat: v.preferredFormat ?? "none",
      avoid: v.avoid.length ? v.avoid.map((a) => `- ${a.replace(/\s+/g, " ").slice(0, 160)}`).join("\n") : "- (none)",
      material,
    });
  }

  regenerateNote(problem: string): string {
    return render(this.file.regenerateNote.join("\n"), { problem });
  }

  repairNote(problem: string): string {
    return render(this.file.repairNote.join("\n"), { problem });
  }

  gradeSystem(partialCredit: boolean): string {
    return render(this.file.gradeSystem.join("\n"), {
      mathRules: this.mathRules,
      partialCredit: partialCredit ? this.file.partialCredit.allowed : this.file.partialCredit.none,
    });
  }

  gradeUser(v: { question: string; reference: string; rubric: string; difficulty: string; answer: string; nonce: string }): string {
    return render(this.file.gradeUser.join("\n"), v);
  }
}
