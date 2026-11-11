import { readFile } from "node:fs/promises";
import path from "node:path";
import { strFromU8, unzipSync } from "fflate";

export const TEXT_EXTENSIONS = new Set([".txt", ".md", ".markdown", ".c", ".h", ".cpp", ".hpp", ".py", ".java", ".tex", ".csv"]);
export const SUPPORTED_EXTENSIONS = new Set([...TEXT_EXTENSIONS, ".pdf", ".docx", ".pptx"]);

/** Files larger than this are skipped (protects memory; a 40 MB scan is rarely useful text). */
export const MAX_FILE_BYTES = 40 * 1024 * 1024;

export function isSupported(file: string): boolean {
  return SUPPORTED_EXTENSIONS.has(path.extname(file).toLowerCase());
}

/** Extract plain text from one course file. Throws with a readable message on failure. */
export async function extractText(file: string): Promise<string> {
  const ext = path.extname(file).toLowerCase();
  const buffer = await readFile(file);
  if (buffer.byteLength > MAX_FILE_BYTES) throw new Error(`file is larger than ${MAX_FILE_BYTES / 1024 / 1024} MB`);
  if (TEXT_EXTENSIONS.has(ext)) return decodeText(buffer);
  if (ext === ".pdf") return extractPdf(buffer);
  if (ext === ".docx") return extractDocx(buffer);
  if (ext === ".pptx") return extractPptx(buffer);
  throw new Error(`unsupported file type ${ext}`);
}

function decodeText(buffer: Buffer): string {
  // UTF-16 LE/BE BOMs show up in files saved by Windows Notepad.
  if (buffer[0] === 0xff && buffer[1] === 0xfe) return new TextDecoder("utf-16le").decode(buffer.subarray(2));
  if (buffer[0] === 0xfe && buffer[1] === 0xff) return new TextDecoder("utf-16be").decode(buffer.subarray(2));
  return new TextDecoder("utf-8").decode(buffer).replace(/^﻿/, "");
}

async function extractPdf(buffer: Buffer): Promise<string> {
  const { extractText: pdfText, getDocumentProxy } = await import("unpdf");
  const pdf = await getDocumentProxy(new Uint8Array(buffer));
  const { text } = await pdfText(pdf, { mergePages: false });
  return (Array.isArray(text) ? text : [text]).join("\n\n");
}

async function extractDocx(buffer: Buffer): Promise<string> {
  const mammoth = await import("mammoth");
  const result = await (mammoth.default ?? mammoth).extractRawText({ buffer });
  return result.value;
}

/** PowerPoint: a zip of slide XML files; text lives in <a:t> runs, paragraphs in <a:p>. */
export function extractPptx(buffer: Uint8Array): string {
  const files = unzipSync(buffer, { filter: (f) => /^ppt\/(slides|notesSlides)\/[^/]+\.xml$/.test(f.name) });
  const number = (name: string) => Number(/(\d+)\.xml$/.exec(name)?.[1] ?? 0);
  const slides = Object.keys(files)
    .filter((n) => n.startsWith("ppt/slides/"))
    .sort((a, b) => number(a) - number(b));
  const out: string[] = [];
  for (const name of slides) {
    const body = xmlParagraphs(strFromU8(files[name] as Uint8Array));
    const notesFile = files[`ppt/notesSlides/notesSlide${number(name)}.xml`];
    const notes = notesFile ? xmlParagraphs(strFromU8(notesFile)).replace(/^\d+$/gm, "").trim() : "";
    const slide = [body, notes].filter(Boolean).join("\n");
    if (slide.trim()) out.push(slide);
  }
  return out.join("\n\n");
}

function xmlParagraphs(xml: string): string {
  const paragraphs: string[] = [];
  for (const p of xml.split(/<\/a:p>/)) {
    const runs = [...p.matchAll(/<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/g)].map((m) => decodeXml(m[1] as string));
    const line = runs.join("").trim();
    if (line) paragraphs.push(line);
  }
  return paragraphs.join("\n");
}

function decodeXml(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_m, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, n: string) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, "&");
}
