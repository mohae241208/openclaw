import fs from "node:fs/promises";
import path from "node:path";
import { isPathInside } from "../../infra/path-guards.js";
import { logVerbose } from "../../globals.js";
import { getMediaDir } from "../../media/store.js";
import { extractPdfContent } from "../../media/pdf-extract.js";
import type { MsgContext } from "../templating.js";
import type { CommandHandler, CommandHandlerResult } from "./commands-types.js";
import { buildManualContext, listManuals, saveManual } from "./manual-store.js";

const MANUAL_COMMAND = "/매뉴얼";
const MANUAL_USAGE = [
  "⚠️ 형식 오류입니다.",
  "/매뉴얼 등록  (PDF 첨부 필요)",
  "/매뉴얼 목록",
  "/매뉴얼 질문 질문내용",
].join("\n");

function normalizeTokens(input: string): string[] {
  return input.trim().split(/\s+/).filter(Boolean);
}

function isPdfType(rawType: string | undefined): boolean {
  if (!rawType) {
    return false;
  }
  return rawType.toLowerCase().includes("pdf");
}

function resolveMediaPairs(ctx: MsgContext): Array<{ mediaPath: string; mediaType?: string }> {
  const pathsFromArray = Array.isArray(ctx.MediaPaths) ? ctx.MediaPaths : [];
  const typesFromArray = Array.isArray(ctx.MediaTypes) ? ctx.MediaTypes : [];
  if (pathsFromArray.length > 0) {
    return pathsFromArray
      .map((value, index) => {
        const mediaPath = value?.trim();
        if (!mediaPath) {
          return null;
        }
        const mediaType = typesFromArray[index] ?? undefined;
        return { mediaPath, mediaType };
      })
      .filter((entry): entry is { mediaPath: string; mediaType?: string } => entry != null);
  }
  if (ctx.MediaPath?.trim()) {
    return [{ mediaPath: ctx.MediaPath.trim(), mediaType: ctx.MediaType }];
  }
  return [];
}

async function findPdfAttachment(ctx: MsgContext): Promise<{ path: string; fileName: string } | null> {
  const pairs = resolveMediaPairs(ctx);
  for (const pair of pairs) {
    const ext = path.extname(pair.mediaPath).toLowerCase();
    if (isPdfType(pair.mediaType) || ext === ".pdf") {
      const fileName = path.basename(pair.mediaPath) || "manual.pdf";
      return { path: pair.mediaPath, fileName };
    }
  }
  return null;
}

function resolveSafeAttachmentPath(rawPath: string, workspaceDir: string): string | null {
  const trimmed = rawPath.trim();
  if (!trimmed) {
    return null;
  }
  const absolute = path.isAbsolute(trimmed) ? path.resolve(trimmed) : path.resolve(workspaceDir, trimmed);
  const allowedRoots = [path.resolve(workspaceDir, "media"), getMediaDir()];
  for (const root of allowedRoots) {
    if (isPathInside(root, absolute)) {
      return absolute;
    }
  }
  return null;
}

async function handleManualRegister(params: Parameters<CommandHandler>[0]): Promise<CommandHandlerResult> {
  const attachment = await findPdfAttachment(params.ctx);
  if (!attachment) {
    return {
      shouldContinue: false,
      reply: { text: "⚠️ PDF 파일을 첨부한 뒤 `/매뉴얼 등록`을 사용해 주세요." },
    };
  }
  if (params.ctx.MediaRemoteHost) {
    return {
      shouldContinue: false,
      reply: {
        text: "⚠️ 원격 첨부 PDF는 아직 지원하지 않습니다. 로컬 업로드 파일로 다시 시도해 주세요.",
      },
    };
  }

  try {
    const safePath = resolveSafeAttachmentPath(attachment.path, params.workspaceDir);
    if (!safePath) {
      return {
        shouldContinue: false,
        reply: { text: "⚠️ 첨부 PDF 경로가 허용되지 않았습니다." },
      };
    }
    const buffer = await fs.readFile(safePath);
    const extracted = await extractPdfContent({
      buffer,
      maxPages: 80,
      maxPixels: 1024 * 1024,
      minTextChars: 1,
    });
    const text = extracted.text?.trim() || "";
    const saved = await saveManual({
      title: attachment.fileName.replace(/\.pdf$/i, "").trim() || attachment.fileName,
      sourceFileName: attachment.fileName,
      pdfBuffer: buffer,
      text,
    });
    return {
      shouldContinue: false,
      reply: {
        text: `✅ 매뉴얼 등록 완료: ${saved.entry.title}\n문자 수: ${saved.entry.textChars}자`,
      },
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      shouldContinue: false,
      reply: { text: `❌ 매뉴얼 등록 실패: ${message}` },
    };
  }
}

async function handleManualList(): Promise<CommandHandlerResult> {
  const manuals = await listManuals();
  if (manuals.length === 0) {
    return { shouldContinue: false, reply: { text: "📘 등록된 매뉴얼이 없습니다." } };
  }
  const lines = ["📘 등록된 매뉴얼"];
  for (const manual of manuals.slice(0, 20)) {
    lines.push(`- ${manual.title} (${manual.sourceFileName})`);
  }
  return { shouldContinue: false, reply: { text: lines.join("\n") } };
}

function applyManualQuestionContext(params: {
  ctx: MsgContext;
  rootCtx?: MsgContext;
  question: string;
  context: string;
}) {
  const rewritten = [
    'Use the "manual-qa" skill for this request.',
    params.context,
    "## User question",
    params.question,
  ].join("\n\n");
  params.ctx.Body = rewritten;
  params.ctx.BodyForAgent = rewritten;
  (params.ctx as Record<string, unknown>).BodyStripped = rewritten;
  params.ctx.CommandBody = params.question;
  params.ctx.BodyForCommands = params.question;
  params.ctx.RawBody = params.question;
  if (params.rootCtx && params.rootCtx !== params.ctx) {
    params.rootCtx.Body = rewritten;
    params.rootCtx.BodyForAgent = rewritten;
    (params.rootCtx as Record<string, unknown>).BodyStripped = rewritten;
    params.rootCtx.CommandBody = params.question;
    params.rootCtx.BodyForCommands = params.question;
    params.rootCtx.RawBody = params.question;
  }
}

async function handleManualQuestion(
  params: Parameters<CommandHandler>[0],
  question: string,
): Promise<CommandHandlerResult> {
  const context = await buildManualContext({ question });
  if (!context) {
    return {
      shouldContinue: false,
      reply: {
        text: "⚠️ 매뉴얼 데이터가 없어서 질문에 사용할 컨텍스트를 만들 수 없습니다. 먼저 `/매뉴얼 등록`을 사용해 주세요.",
      },
    };
  }
  applyManualQuestionContext({
    ctx: params.ctx,
    rootCtx: params.rootCtx,
    question,
    context,
  });
  return { shouldContinue: true };
}

export const handleManualCommands: CommandHandler = async (params, allowTextCommands) => {
  if (!allowTextCommands) {
    return null;
  }
  const normalized = params.command.commandBodyNormalized.trim();
  if (!params.command.isAuthorizedSender) {
    if (!normalized && (await findPdfAttachment(params.ctx))) {
      logVerbose(
        `Ignoring automatic manual ingest from unauthorized sender: ${params.command.senderId || "<unknown>"}`,
      );
      return { shouldContinue: false };
    }
    if (normalized !== MANUAL_COMMAND && !normalized.startsWith(`${MANUAL_COMMAND} `)) {
      return null;
    }
    logVerbose(
      `Ignoring manual command from unauthorized sender: ${params.command.senderId || "<unknown>"}`,
    );
    return { shouldContinue: false };
  }
  if (!normalized) {
    const attachment = await findPdfAttachment(params.ctx);
    if (!attachment) {
      return null;
    }
    return await handleManualRegister(params);
  }
  if (normalized !== MANUAL_COMMAND && !normalized.startsWith(`${MANUAL_COMMAND} `)) {
    return null;
  }

  const rest = normalized === MANUAL_COMMAND ? "" : normalized.slice(MANUAL_COMMAND.length).trim();
  const tokens = normalizeTokens(rest);
  if (tokens.length === 0) {
    return {
      shouldContinue: false,
      reply: {
        text: [
          "📘 매뉴얼 기능",
          "/매뉴얼 등록 (PDF 첨부)",
          "/매뉴얼 목록",
          "/매뉴얼 질문 질문내용",
        ].join("\n"),
      },
    };
  }

  const action = tokens[0];
  if (action === "등록") {
    return await handleManualRegister(params);
  }
  if (action === "목록") {
    return await handleManualList();
  }
  if (action === "질문") {
    const question = rest.slice("질문".length).trim();
    if (!question) {
      return { shouldContinue: false, reply: { text: MANUAL_USAGE } };
    }
    return await handleManualQuestion(params, question);
  }
  return { shouldContinue: false, reply: { text: MANUAL_USAGE } };
};
