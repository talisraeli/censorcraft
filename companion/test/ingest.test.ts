import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { strToU8, zipSync } from "fflate";
import { afterAll, describe, expect, it } from "vitest";
import { chunkText, cleanText } from "../src/ingest/chunk";
import { extractPptx, extractText, isSupported } from "../src/ingest/extract";
import { CourseIndex } from "../src/ingest/index";
import { silentLogger } from "../src/logger";

describe("chunking", () => {
  it("returns nothing for empty text and one chunk for short text", () => {
    expect(chunkText("", { maxChars: 500 })).toEqual([]);
    expect(chunkText("   \n\n  ", { maxChars: 500 })).toEqual([]);
    expect(chunkText("A short note.", { maxChars: 500 })).toEqual(["A short note."]);
  });

  it("never exceeds the maximum size and loses no words", () => {
    const paragraphs = Array.from({ length: 40 }, (_v, i) => `Paragraph ${i}: ` + "lorem ipsum dolor sit amet ".repeat(8).trim() + ".");
    const text = paragraphs.join("\n\n");
    const chunks = chunkText(text, { maxChars: 600 });
    expect(chunks.length).toBeGreaterThan(5);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(600);
    const words = (t: string) => t.split(/\s+/).filter(Boolean);
    expect(words(chunks.join(" "))).toEqual(words(text));
  });

  it("prefers paragraph boundaries", () => {
    const a = "A".repeat(300);
    const b = "B".repeat(300);
    const c = "C".repeat(300);
    expect(chunkText(`${a}\n\n${b}\n\n${c}`, { maxChars: 650 })).toEqual([`${a}\n\n${b}`, c]);
  });

  it("splits an oversized paragraph on sentences, then hard-cuts", () => {
    const sentences = Array.from({ length: 30 }, (_v, i) => `Sentence number ${i} is here.`).join(" ");
    for (const c of chunkText(sentences, { maxChars: 250 })) expect(c.length).toBeLessThanOrEqual(250);
    const blob = "x".repeat(2000);
    const hard = chunkText(blob, { maxChars: 300 });
    expect(hard.join("")).toBe(blob);
    for (const c of hard) expect(c.length).toBeLessThanOrEqual(300);
  });

  it("keeps Unicode math intact and never splits a surrogate pair", () => {
    const text = ("∫₀¹ x² dx = 1/3. 😀 " as string).repeat(200);
    const chunks = chunkText(text, { maxChars: 301 });
    for (const c of chunks) {
      expect(c).not.toMatch(/[\ud800-\udbff]$/);
      expect(c).not.toMatch(/^[\udc00-\udfff]/);
    }
    expect(chunks.join(" ").replace(/\s+/g, "")).toBe(text.replace(/\s+/g, ""));
  });

  it("cleans control characters and blank runs", () => {
    expect(cleanText("a\r\nb\u0000c\n\n\n\n\nd   e")).toBe("a\nb c\n\nd e");
  });
});

describe("extraction and index", () => {
  const root = mkdtempSync(path.join(tmpdir(), "censor-course-"));
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  mkdirSync(path.join(root, "calculus1"));
  mkdirSync(path.join(root, "lin-alg-notes"));
  mkdirSync(path.join(root, "misc"));
  writeFileSync(path.join(root, "calculus1", "derivatives.md"), "# Derivatives\n\nThe derivative of x² is 2x. The power rule says d/dx xⁿ = n·xⁿ⁻¹.");
  writeFileSync(path.join(root, "calculus1", "integrals.txt"), "An integral accumulates area. ∫₀¹ x dx = 1/2.");
  writeFileSync(path.join(root, "lin-alg-notes", "matrices.txt"), "A matrix is invertible exactly when its determinant is nonzero.");
  writeFileSync(path.join(root, "misc", "pointers.c"), "int *p = &x; /* a pointer stores an address */\nint y = *p;");
  writeFileSync(path.join(root, "misc", "thermo.txt"), "Entropy never decreases in an isolated system. Entropy is a state function.");
  writeFileSync(path.join(root, "misc", "image.png"), "not text");
  const slide = (t: string) => `<p:sld><a:p><a:r><a:t>${t}</a:t></a:r></a:p><a:p><a:r><a:t>second &amp; line</a:t></a:r></a:p></p:sld>`;
  writeFileSync(
    path.join(root, "misc", "deck.pptx"),
    zipSync({
      "ppt/slides/slide2.xml": strToU8(slide("Eigenvalues slide two")),
      "ppt/slides/slide1.xml": strToU8(slide("Eigenvalues slide one")),
      "ppt/slides/_rels/slide1.xml.rels": strToU8("<x/>"),
      "docProps/app.xml": strToU8("<x/>"),
    }),
  );

  const make = (topicFolders: Record<string, string> = {}, random = () => 0) =>
    new CourseIndex({ root, topicFolders, maxChunkChars: 2000, log: silentLogger, random });

  it("recognises supported file types", () => {
    for (const f of ["a.txt", "a.MD", "a.pdf", "a.docx", "a.pptx", "a.c", "a.h"]) expect(isSupported(f)).toBe(true);
    for (const f of ["a.png", "a.exe", "a.zip", "a"]) expect(isSupported(f)).toBe(false);
  });

  it("extracts text files with Unicode and pptx slides in order", async () => {
    expect(await extractText(path.join(root, "calculus1", "integrals.txt"))).toContain("∫₀¹ x dx");
    const deck = extractPptx(
      zipSync({ "ppt/slides/slide10.xml": strToU8(slide("ten")), "ppt/slides/slide9.xml": strToU8(slide("nine")) }),
    );
    expect(deck.indexOf("nine")).toBeLessThan(deck.indexOf("ten"));
    expect(deck).toContain("second & line");
  });

  it("indexes supported files and skips the rest", async () => {
    const index = make();
    await index.scan();
    expect(index.stats.files).toBe(6);
    expect(index.stats.folders).toEqual(["calculus1", "lin-alg-notes", "misc"]);
  });

  it("maps topics to subfolders by name", async () => {
    const index = make();
    await index.scan();
    expect(index.candidates("Calculus 1")?.via).toBe("folder-name");
    expect(index.candidates("Calculus 1")?.chunks.every((c) => c.folder === "calculus1")).toBe(true);
  });

  it("uses the topicFolders map when given", async () => {
    const index = make({ "Linear Algebra": "lin-alg-notes" });
    await index.scan();
    const found = index.candidates("linear algebra");
    expect(found?.via).toBe("topicFolders");
    expect(found?.chunks[0]?.text).toContain("determinant");
  });

  it("finds custom topics by keywords and reports no material when nothing matches", async () => {
    const index = make();
    await index.scan();
    const found = index.candidates("entropy");
    expect(found?.via).toBe("keywords");
    expect(found?.chunks[0]?.file).toBe("misc/thermo.txt");
    expect(index.candidates("Eigenvalues")?.chunks[0]?.file).toBe("misc/deck.pptx");
    expect(index.candidates("organic chemistry")).toBeUndefined();
    expect(index.pick("organic chemistry")).toBeUndefined();
  });

  it("favours chunks that were not used recently", async () => {
    const index = make({}, () => 0);
    await index.scan();
    const first = index.pick("Calculus 1")?.chunk.id;
    const second = index.pick("Calculus 1")?.chunk.id;
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect(second).not.toBe(first);
    // Both used: the next pick is the least recently used one again.
    expect(index.pick("Calculus 1")?.chunk.id).toBe(first);
  });

  it("picks up changes on rescan", async () => {
    const index = make();
    await index.scan();
    writeFileSync(path.join(root, "misc", "new-topic.txt"), "Photosynthesis converts light into chemical energy.");
    await index.scan();
    expect(index.candidates("photosynthesis")?.chunks[0]?.file).toBe("misc/new-topic.txt");
    rmSync(path.join(root, "misc", "new-topic.txt"));
    await index.scan();
    expect(index.candidates("photosynthesis")).toBeUndefined();
  });
});
