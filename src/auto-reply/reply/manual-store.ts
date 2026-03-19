import fs from "node:fs/promises";
import path from "node:path";
import { resolveStateDir } from "../../config/paths.js";
import { createAsyncLock } from "../../infra/json-files.js";
import { readJsonFileWithFallback, writeJsonFileAtomically } from "../../plugin-sdk/json-store.js";

const DATA_DIR_NAME = "data";
const MANUAL_DIR_NAME = "manual";
const PDF_DIR_NAME = "pdf";
const MARKDOWN_DIR_NAME = "markdown";
const INDEX_FILE_NAME = "index.json";
const withManualLock = createAsyncLock();

export type ManualEntry = {
  id: string;
  title: string;
  sourceFileName: string;
  pdfRelativePath: string;
  markdownRelativePath: string;
  createdAt: number;
  updatedAt: number;
  textChars: number;
};

type ManualIndexFile = {
  version: 1;
  manuals: ManualEntry[];
};

type SavedManualResult = {
  entry: ManualEntry;
  markdownPath: string;
  pdfPath: string;
};

function resolveManualBaseDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveStateDir(env), DATA_DIR_NAME, MANUAL_DIR_NAME);
}

function resolveManualPdfDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveManualBaseDir(env), PDF_DIR_NAME);
}

function resolveManualMarkdownDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveManualBaseDir(env), MARKDOWN_DIR_NAME);
}

export function resolveManualIndexPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveManualBaseDir(env), INDEX_FILE_NAME);
}

function normalizeString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeManualEntry(raw: unknown): ManualEntry | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const candidate = raw as Partial<ManualEntry>;
  const id = normalizeString(candidate.id);
  const title = normalizeString(candidate.title);
  const sourceFileName = normalizeString(candidate.sourceFileName);
  const pdfRelativePath = normalizeString(candidate.pdfRelativePath);
  const markdownRelativePath = normalizeString(candidate.markdownRelativePath);
  const createdAt =
    typeof candidate.createdAt === "number" && Number.isFinite(candidate.createdAt)
      ? Math.floor(candidate.createdAt)
      : 0;
  const updatedAt =
    typeof candidate.updatedAt === "number" && Number.isFinite(candidate.updatedAt)
      ? Math.floor(candidate.updatedAt)
      : createdAt;
  const textChars =
    typeof candidate.textChars === "number" && Number.isFinite(candidate.textChars)
      ? Math.max(0, Math.floor(candidate.textChars))
      : 0;
  if (!id || !title || !sourceFileName || !pdfRelativePath || !markdownRelativePath || createdAt <= 0) {
    return null;
  }
  return {
    id,
    title,
    sourceFileName,
    pdfRelativePath,
    markdownRelativePath,
    createdAt,
    updatedAt,
    textChars,
  };
}

function normalizeManualIndex(raw: unknown): ManualIndexFile {
  if (!raw || typeof raw !== "object") {
    return { version: 1, manuals: [] };
  }
  const candidate = raw as Partial<ManualIndexFile>;
  const manualsRaw = Array.isArray(candidate.manuals) ? candidate.manuals : [];
  const manuals = manualsRaw
    .map((entry) => normalizeManualEntry(entry))
    .filter((entry): entry is ManualEntry => entry != null)
    .sort((a, b) => b.createdAt - a.createdAt);
  return {
    version: 1,
    manuals,
  };
}

async function readManualIndex(env: NodeJS.ProcessEnv = process.env): Promise<ManualIndexFile> {
  const indexPath = resolveManualIndexPath(env);
  const { value } = await readJsonFileWithFallback<ManualIndexFile | null>(indexPath, null);
  return normalizeManualIndex(value);
}

async function writeManualIndex(index: ManualIndexFile, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const normalized = normalizeManualIndex(index);
  await writeJsonFileAtomically(resolveManualIndexPath(env), normalized);
}

function slugify(value: string): string {
  const compact = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  return compact || "manual";
}

function resolveManualId(title: string, now = Date.now()): string {
  const stamp = now.toString(36);
  const random = Math.random().toString(36).slice(2, 8);
  return `${stamp}-${random}-${slugify(title).slice(0, 30)}`;
}

function clipText(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }
  return `${value.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

function tokenizeQuery(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[\s`~!@#$%^&*()\-_=+[{\]}\\|;:'",.<>/?]+/)
    .map((token) => token.trim())
    .filter(Boolean);
}

function countTokenMatches(text: string, tokens: string[]): number {
  let score = 0;
  for (const token of tokens) {
    if (text.includes(token)) {
      score += 1;
    }
  }
  return score;
}

function toMarkdown(text: string, sourceFileName: string): string {
  const normalized = text.replace(/\r\n/g, "\n").trim();
  if (!normalized) {
    return `# ${sourceFileName}\n\n_Extracted text is empty._\n`;
  }
  return `# ${sourceFileName}\n\n${normalized}\n`;
}

export async function saveManual(params: {
  title: string;
  sourceFileName: string;
  pdfBuffer: Buffer;
  text: string;
  env?: NodeJS.ProcessEnv;
}): Promise<SavedManualResult> {
  const env = params.env ?? process.env;
  return await withManualLock(async () => {
    const now = Date.now();
    const title = params.title.trim() || params.sourceFileName.trim() || "Manual";
    const id = resolveManualId(title, now);
    const pdfFileName = `${id}.pdf`;
    const markdownFileName = `${id}.md`;
    const pdfRelativePath = path.join(PDF_DIR_NAME, pdfFileName);
    const markdownRelativePath = path.join(MARKDOWN_DIR_NAME, markdownFileName);
    const pdfPath = path.join(resolveManualBaseDir(env), pdfRelativePath);
    const markdownPath = path.join(resolveManualBaseDir(env), markdownRelativePath);
    const markdown = toMarkdown(params.text, params.sourceFileName);

    await fs.mkdir(resolveManualPdfDir(env), { recursive: true });
    await fs.mkdir(resolveManualMarkdownDir(env), { recursive: true });
    await fs.writeFile(pdfPath, params.pdfBuffer);
    await fs.writeFile(markdownPath, markdown, "utf-8");

    const entry: ManualEntry = {
      id,
      title,
      sourceFileName: params.sourceFileName,
      pdfRelativePath,
      markdownRelativePath,
      createdAt: now,
      updatedAt: now,
      textChars: markdown.length,
    };

    const index = await readManualIndex(env);
    const nextIndex: ManualIndexFile = {
      version: 1,
      manuals: [entry, ...index.manuals].sort((a, b) => b.createdAt - a.createdAt),
    };
    await writeManualIndex(nextIndex, env);
    return { entry, markdownPath, pdfPath };
  });
}

export async function listManuals(env: NodeJS.ProcessEnv = process.env): Promise<ManualEntry[]> {
  const index = await readManualIndex(env);
  return index.manuals.slice().sort((a, b) => b.createdAt - a.createdAt);
}

async function readManualMarkdown(entry: ManualEntry, env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const markdownPath = path.join(resolveManualBaseDir(env), entry.markdownRelativePath);
  return await fs.readFile(markdownPath, "utf-8");
}

export async function buildManualContext(params: {
  question: string;
  maxManuals?: number;
  maxCharsPerManual?: number;
  maxTotalChars?: number;
  env?: NodeJS.ProcessEnv;
}): Promise<string | null> {
  const env = params.env ?? process.env;
  const maxManuals = Math.max(1, params.maxManuals ?? 3);
  const maxCharsPerManual = Math.max(500, params.maxCharsPerManual ?? 3500);
  const maxTotalChars = Math.max(1000, params.maxTotalChars ?? 10000);
  const manuals = await listManuals(env);
  if (manuals.length === 0) {
    return null;
  }

  const tokens = tokenizeQuery(params.question);
  const scored = await Promise.all(
    manuals.map(async (entry) => {
      try {
        const markdown = await readManualMarkdown(entry, env);
        const titleScore = countTokenMatches(entry.title.toLowerCase(), tokens) * 3;
        const contentScore = countTokenMatches(markdown.toLowerCase(), tokens);
        return { entry, markdown, score: titleScore + contentScore };
      } catch {
        return null;
      }
    }),
  );

  const loaded = scored.filter(
    (candidate): candidate is { entry: ManualEntry; markdown: string; score: number } =>
      candidate != null,
  );
  if (loaded.length === 0) {
    return null;
  }

  const sorted =
    tokens.length > 0
      ? loaded
          .slice()
          .sort((a, b) => (b.score !== a.score ? b.score - a.score : b.entry.createdAt - a.entry.createdAt))
      : loaded.slice().sort((a, b) => b.entry.createdAt - a.entry.createdAt);

  const preferred = sorted.filter((entry) => entry.score > 0);
  const chosen = (preferred.length > 0 ? preferred : sorted).slice(0, maxManuals);
  const sections: string[] = [];
  let remaining = maxTotalChars;
  for (const item of chosen) {
    if (remaining <= 200) {
      break;
    }
    const clipped = clipText(item.markdown.trim(), Math.min(maxCharsPerManual, remaining));
    if (!clipped) {
      continue;
    }
    const section = [
      `### ${item.entry.title}`,
      `Source: ${item.entry.sourceFileName}`,
      clipped,
    ].join("\n\n");
    sections.push(section);
    remaining -= section.length;
  }
  if (sections.length === 0) {
    return null;
  }
  return ["## Manual excerpts", ...sections].join("\n\n");
}
