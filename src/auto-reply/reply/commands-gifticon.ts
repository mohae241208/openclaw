import { logVerbose } from "../../globals.js";
import { addGifticon, listGifticons, removeGifticon } from "./gifticon-store.js";
import type { CommandHandler } from "./commands-types.js";

const GIFTICON_COMMAND = "/기프티콘";

type ParsedGifticonCommand =
  | { type: "list" }
  | { type: "add"; place: string; expiresOn: string }
  | { type: "remove"; place: string }
  | { type: "invalid" };

function parseExpiresOn(raw: string): string | null {
  const trimmed = raw.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    return null;
  }
  const [yearRaw, monthRaw, dayRaw] = trimmed.split("-");
  const year = Number.parseInt(yearRaw, 10);
  const month = Number.parseInt(monthRaw, 10);
  const day = Number.parseInt(dayRaw, 10);
  const utc = new Date(Date.UTC(year, month - 1, day));
  const valid =
    utc.getUTCFullYear() === year && utc.getUTCMonth() === month - 1 && utc.getUTCDate() === day;
  return valid ? trimmed : null;
}

function parseGifticonCommand(normalizedCommand: string): ParsedGifticonCommand | null {
  const body = normalizedCommand.trim();
  if (body === GIFTICON_COMMAND) {
    return { type: "list" };
  }
  if (!body.startsWith(`${GIFTICON_COMMAND} `)) {
    return null;
  }
  const tokens = body.slice(GIFTICON_COMMAND.length).trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) {
    return { type: "list" };
  }
  const action = tokens[0];
  if (action === "추가") {
    if (tokens.length < 3) {
      return { type: "invalid" };
    }
    const expiresOnToken = tokens[tokens.length - 1] ?? "";
    const place = tokens.slice(1, -1).join(" ").trim();
    const expiresOn = parseExpiresOn(expiresOnToken);
    if (!place || !expiresOn) {
      return { type: "invalid" };
    }
    return { type: "add", place, expiresOn };
  }
  if (action === "제거") {
    if (tokens.length < 2) {
      return { type: "invalid" };
    }
    const place = tokens.slice(1).join(" ").trim();
    if (!place) {
      return { type: "invalid" };
    }
    return { type: "remove", place };
  }
  return { type: "invalid" };
}

function formatGifticonUsage(): string {
  return [
    "⚠️ 형식 오류입니다.",
    "/기프티콘",
    "/기프티콘 추가 사용처 사용기한(YYYY-MM-DD)",
    "/기프티콘 제거 사용처",
  ].join("\n");
}

export const handleGifticonCommand: CommandHandler = async (params, allowTextCommands) => {
  if (!allowTextCommands) {
    return null;
  }
  const normalized = params.command.commandBodyNormalized.trim();
  if (normalized !== GIFTICON_COMMAND && !normalized.startsWith(`${GIFTICON_COMMAND} `)) {
    return null;
  }
  if (!params.command.isAuthorizedSender) {
    logVerbose(
      `Ignoring gifticon command from unauthorized sender: ${params.command.senderId || "<unknown>"}`,
    );
    return { shouldContinue: false };
  }
  const parsed = parseGifticonCommand(normalized);
  if (!parsed || parsed.type === "invalid") {
    return { shouldContinue: false, reply: { text: formatGifticonUsage() } };
  }

  if (parsed.type === "list") {
    const items = await listGifticons();
    if (items.length === 0) {
      return { shouldContinue: false, reply: { text: "🎁 현재 등록된 기프티콘이 없습니다." } };
    }
    const lines = ["🎁 현재 보유 기프티콘"];
    for (const item of items) {
      const total = item.batches.reduce((sum, batch) => sum + batch.quantity, 0);
      const details = item.batches.map((batch) => `${batch.expiresOn}(${batch.quantity})`).join(", ");
      lines.push(`- ${item.place}: ${total}개 [${details}]`);
    }
    return { shouldContinue: false, reply: { text: lines.join("\n") } };
  }

  if (parsed.type === "add") {
    const result = await addGifticon({ place: parsed.place, expiresOn: parsed.expiresOn });
    return {
      shouldContinue: false,
      reply: {
        text: `✅ 기프티콘 추가 완료: ${parsed.place} (사용기한 ${parsed.expiresOn})\n현재 수량: ${result.total}개`,
      },
    };
  }

  const removed = await removeGifticon({ place: parsed.place });
  if (!removed.ok) {
    return { shouldContinue: false, reply: { text: removed.message } };
  }
  return {
    shouldContinue: false,
    reply: {
      text: `✅ 기프티콘 제거 완료: ${removed.place} 1개\n차감 기한: ${removed.removed.expiresOn}\n현재 수량: ${removed.remaining}개`,
    },
  };
};
