import { logVerbose } from "../../globals.js";
import {
  deleteItemLocationByName,
  listItemLocations,
  upsertItemLocation,
} from "./item-location-store.js";
import type { CommandHandler } from "./commands-types.js";

const ITEM_COMMAND = "/물품";

type ParsedItemCommand =
  | { type: "list" }
  | { type: "add"; item: string; location: string }
  | { type: "remove"; item: string }
  | { type: "invalid" };

function parseItemCommand(normalizedCommand: string): ParsedItemCommand | null {
  const body = normalizedCommand.trim();
  if (body === ITEM_COMMAND) {
    return { type: "list" };
  }
  if (!body.startsWith(`${ITEM_COMMAND} `)) {
    return null;
  }
  const tokens = body.slice(ITEM_COMMAND.length).trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) {
    return { type: "list" };
  }
  const action = tokens[0];
  if (action === "추가") {
    if (tokens.length < 3) {
      return { type: "invalid" };
    }
    const item = tokens[1] ?? "";
    const location = tokens.slice(2).join(" ").trim();
    if (!item || !location) {
      return { type: "invalid" };
    }
    return { type: "add", item, location };
  }
  if (action === "제거") {
    if (tokens.length < 2) {
      return { type: "invalid" };
    }
    const item = tokens.slice(1).join(" ").trim();
    if (!item) {
      return { type: "invalid" };
    }
    return { type: "remove", item };
  }
  return { type: "invalid" };
}

function formatItemUsage(): string {
  return [
    "⚠️ 형식 오류입니다.",
    "/물품",
    "/물품 추가 물품명 위치",
    "/물품 제거 물품명",
  ].join("\n");
}

export const handleItemLocationCommand: CommandHandler = async (params, allowTextCommands) => {
  if (!allowTextCommands) {
    return null;
  }
  const normalized = params.command.commandBodyNormalized.trim();
  if (normalized !== ITEM_COMMAND && !normalized.startsWith(`${ITEM_COMMAND} `)) {
    return null;
  }
  if (!params.command.isAuthorizedSender) {
    logVerbose(
      `Ignoring item-location command from unauthorized sender: ${params.command.senderId || "<unknown>"}`,
    );
    return { shouldContinue: false };
  }
  const parsed = parseItemCommand(normalized);
  if (!parsed || parsed.type === "invalid") {
    return { shouldContinue: false, reply: { text: formatItemUsage() } };
  }

  if (parsed.type === "list") {
    const records = await listItemLocations();
    if (records.length === 0) {
      return { shouldContinue: false, reply: { text: "📦 등록된 물품 위치가 없습니다." } };
    }
    const lines = ["📦 등록된 물품 위치"];
    for (const record of records) {
      lines.push(`- ${record.item}: ${record.location}`);
    }
    return { shouldContinue: false, reply: { text: lines.join("\n") } };
  }

  if (parsed.type === "add") {
    const saved = await upsertItemLocation({ item: parsed.item, location: parsed.location });
    return {
      shouldContinue: false,
      reply: { text: `✅ 물품 저장 완료: ${saved.item} -> ${saved.location}` },
    };
  }

  const removed = await deleteItemLocationByName({ item: parsed.item });
  if (!removed.removed) {
    return { shouldContinue: false, reply: { text: "⚠️ 해당 물품이 등록되어 있지 않습니다." } };
  }
  return {
    shouldContinue: false,
    reply: { text: `✅ 물품 제거 완료: ${removed.item ?? parsed.item}` },
  };
};
