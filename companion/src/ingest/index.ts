import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import type { FSWatcher } from "chokidar";
import { Logger } from "../logger";
import { chunkText } from "./chunk";
import { extractText, isSupported } from "./extract";

export interface Chunk {
  id: string;
  /** Path relative to the course folder, forward slashes. */
  file: string;
  /** First path segment under the course folder ("" for files in the root). */
  folder: string;
  index: number;
  text: string;
}

interface FileEntry {
  mtimeMs: number;
  size: number;
  chunks: Chunk[];
}

export interface CourseIndexOptions {
  root: string;
  topicFolders: Record<string, string>;
  maxChunkChars: number;
  log: Logger;
  random?: () => number;
}

export interface PickResult {
  chunk: Chunk;
  /** How the chunk was matched (for logs). */
  via: "topicFolders" | "folder-name" | "keywords";
}

const SKIP_DIRS = new Set(["node_modules", ".git", "__pycache__", ".obsidian", ".censor-cache"]);

export function normalizeName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

/**
 * Lightweight in-memory index of the course folder: file -> text chunks.
 * Re-extracts only files whose size or mtime changed.
 */
export class CourseIndex {
  private readonly files = new Map<string, FileEntry>();
  private readonly lastUsed = new Map<string, number>();
  private useCounter = 0;
  private watcher: FSWatcher | undefined;
  private rescanTimer: NodeJS.Timeout | undefined;
  private scanning: Promise<void> | undefined;
  private readonly random: () => number;

  constructor(private readonly options: CourseIndexOptions) {
    this.random = options.random ?? Math.random;
  }

  get enabled(): boolean {
    return this.options.root !== "";
  }

  get stats(): { files: number; chunks: number; folders: string[] } {
    const folders = new Set<string>();
    let chunks = 0;
    for (const entry of this.files.values()) {
      chunks += entry.chunks.length;
      for (const c of entry.chunks) folders.add(c.folder);
    }
    return { files: this.files.size, chunks, folders: [...folders].filter(Boolean).sort() };
  }

  /** Full scan (incremental after the first). Safe to call concurrently. */
  async scan(): Promise<void> {
    if (!this.enabled) return;
    if (this.scanning) return this.scanning;
    this.scanning = this.doScan().finally(() => (this.scanning = undefined));
    return this.scanning;
  }

  private async doScan(): Promise<void> {
    const seen = new Set<string>();
    const walk = async (dir: string): Promise<void> => {
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch (e) {
        this.options.log.warn(`Cannot read folder ${dir}: ${(e as Error).message}`);
        return;
      }
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (!SKIP_DIRS.has(entry.name) && !entry.name.startsWith(".")) await walk(full);
        } else if (entry.isFile() && isSupported(entry.name) && !entry.name.startsWith("~$")) {
          const rel = path.relative(this.options.root, full).split(path.sep).join("/");
          seen.add(rel);
          await this.indexFile(full, rel);
        }
      }
    };
    await walk(this.options.root);
    for (const rel of [...this.files.keys()]) if (!seen.has(rel)) this.files.delete(rel);
  }

  private async indexFile(full: string, rel: string): Promise<void> {
    try {
      const info = await stat(full);
      const known = this.files.get(rel);
      if (known && known.mtimeMs === info.mtimeMs && known.size === info.size) return;
      const text = await extractText(full);
      const folder = rel.includes("/") ? (rel.split("/")[0] as string) : "";
      const chunks = chunkText(text, { maxChars: this.options.maxChunkChars }).map((t, index) => ({
        id: `${rel}#${index}`,
        file: rel,
        folder,
        index,
        text: t,
      }));
      this.files.set(rel, { mtimeMs: info.mtimeMs, size: info.size, chunks });
      this.options.log.debug(`Indexed ${rel}: ${chunks.length} chunk(s)`);
      if (chunks.length === 0) this.options.log.warn(`No text could be extracted from ${rel} (scanned PDF or empty file?)`);
    } catch (e) {
      this.files.delete(rel);
      this.options.log.warn(`Skipping ${rel}: ${(e as Error).message}`);
    }
  }

  /** Watch the folder and rescan (debounced) when something changes. */
  async watch(): Promise<void> {
    if (!this.enabled || this.watcher) return;
    const chokidar = await import("chokidar");
    this.watcher = chokidar.watch(this.options.root, {
      ignoreInitial: true,
      ignored: (p: string) => /(^|[\\/])(\.git|node_modules)([\\/]|$)/.test(p),
      awaitWriteFinish: { stabilityThreshold: 800, pollInterval: 200 },
    });
    const trigger = () => {
      clearTimeout(this.rescanTimer);
      this.rescanTimer = setTimeout(() => {
        this.scan()
          .then(() => {
            const s = this.stats;
            this.options.log.info(`Course folder changed: ${s.files} file(s), ${s.chunks} chunk(s) indexed.`);
          })
          .catch((e) => this.options.log.warn(`Rescan failed: ${(e as Error).message}`));
      }, 1500);
    };
    this.watcher.on("add", trigger).on("change", trigger).on("unlink", trigger).on("unlinkDir", trigger);
    this.watcher.on("error", (e) => this.options.log.warn(`File watcher error: ${(e as Error).message}`));
  }

  async close(): Promise<void> {
    clearTimeout(this.rescanTimer);
    await this.watcher?.close();
    this.watcher = undefined;
  }

  /** Chunks that belong to a topic, plus how they were matched. */
  candidates(topic: string): { chunks: Chunk[]; via: PickResult["via"] } | undefined {
    const all: Chunk[] = [];
    for (const entry of this.files.values()) all.push(...entry.chunks);
    if (all.length === 0) return undefined;

    // 1. Explicit mapping from config.
    const mappedKey = Object.keys(this.options.topicFolders).find((k) => normalizeName(k) === normalizeName(topic));
    if (mappedKey) {
      const sub = (this.options.topicFolders[mappedKey] as string).replace(/\\/g, "/").replace(/^\.?\/+|\/+$/g, "");
      const chunks = all.filter((c) => c.file === sub || c.file.startsWith(`${sub}/`));
      if (chunks.length) return { chunks, via: "topicFolders" };
    }

    // 2. Subfolder whose name matches the topic name ("Calculus 1" ~ "calculus1", "calculus-1-notes").
    const want = normalizeName(topic);
    if (want.length >= 2) {
      const folders = new Set(all.map((c) => c.folder).filter(Boolean));
      const match = [...folders].find((f) => normalizeName(f) === want) ??
        [...folders].find((f) => {
          const n = normalizeName(f);
          return n.length >= 3 && (n.includes(want) || want.includes(n));
        });
      if (match) return { chunks: all.filter((c) => c.folder === match), via: "folder-name" };
    }

    // 3. Keyword relevance across everything (used for custom topics).
    const words = topic
      .toLowerCase()
      .split(/[^\p{L}\p{N}+#]+/u)
      .filter((w) => w.length >= 3 || /^[a-z]\+*#?$/.test(w));
    if (words.length === 0) return undefined;
    const scored = all
      .map((chunk) => {
        const haystack = `${chunk.file}\n${chunk.text}`.toLowerCase();
        let score = 0;
        for (const w of words) {
          let from = 0;
          for (let n = 0; n < 20; n++) {
            const at = haystack.indexOf(w, from);
            if (at < 0) break;
            score++;
            from = at + w.length;
          }
        }
        return { chunk, score };
      })
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score);
    if (scored.length === 0) return undefined;
    const keep = Math.max(3, Math.ceil(scored.length / 4));
    return { chunks: scored.slice(0, keep).map((s) => s.chunk), via: "keywords" };
  }

  /**
   * Pick a random relevant chunk, favouring chunks that were not used
   * recently: the choice is uniform among the least-recently-used half.
   */
  pick(topic: string): PickResult | undefined {
    const found = this.candidates(topic);
    if (!found) return undefined;
    const ordered = [...found.chunks].sort((a, b) => (this.lastUsed.get(a.id) ?? 0) - (this.lastUsed.get(b.id) ?? 0));
    const never = ordered.filter((c) => !this.lastUsed.has(c.id));
    const pool = never.length > 0 ? never : ordered.slice(0, Math.max(1, Math.ceil(ordered.length / 2)));
    const chunk = pool[Math.floor(this.random() * pool.length)] as Chunk;
    this.lastUsed.set(chunk.id, ++this.useCounter);
    return { chunk, via: found.via };
  }
}
