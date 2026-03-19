import { logVerbose } from "../../globals.js";
import type { CommandHandler } from "./commands-types.js";
import { addFoodInventoryBatch, removeFoodInventoryQuantity } from "./food-inventory-store.js";

const ADD_COMMAND = "/추가";
const REMOVE_COMMAND = "/제거";

type ParsedAddCommand = {
  type: "add";
  name: string;
  quantity: number;
  expiresOn: string;
};

type ParsedRemoveCommand = {
  type: "remove";
  name: string;
  quantity: number;
};

function parsePositiveInt(raw: string): number | null {
  if (!/^\d+$/.test(raw)) {
    return null;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    return null;
  }
  return parsed;
}

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

function parseAddCommand(commandBodyNormalized: string): ParsedAddCommand | null {
  const body = commandBodyNormalized.trim();
  if (body === ADD_COMMAND) {
    return null;
  }
  if (!body.startsWith(`${ADD_COMMAND} `)) {
    return null;
  }
  const parts = body.slice(ADD_COMMAND.length).trim().split(/\s+/).filter(Boolean);
  if (parts.length < 3) {
    return null;
  }
  const expiresOnToken = parts[parts.length - 1] ?? "";
  const quantityToken = parts[parts.length - 2] ?? "";
  const name = parts.slice(0, -2).join(" ").trim();
  if (!name) {
    return null;
  }
  const quantity = parsePositiveInt(quantityToken);
  const expiresOn = parseExpiresOn(expiresOnToken);
  if (!quantity || !expiresOn) {
    return null;
  }
  return { type: "add", name, quantity, expiresOn };
}

function parseRemoveCommand(commandBodyNormalized: string): ParsedRemoveCommand | null {
  const body = commandBodyNormalized.trim();
  if (body === REMOVE_COMMAND) {
    return null;
  }
  if (!body.startsWith(`${REMOVE_COMMAND} `)) {
    return null;
  }
  const parts = body.slice(REMOVE_COMMAND.length).trim().split(/\s+/).filter(Boolean);
  if (parts.length < 2) {
    return null;
  }
  const quantityToken = parts[parts.length - 1] ?? "";
  const name = parts.slice(0, -1).join(" ").trim();
  if (!name) {
    return null;
  }
  const quantity = parsePositiveInt(quantityToken);
  if (!quantity) {
    return null;
  }
  return { type: "remove", name, quantity };
}

function isFoodCommand(commandBodyNormalized: string): boolean {
  return (
    commandBodyNormalized === ADD_COMMAND ||
    commandBodyNormalized.startsWith(`${ADD_COMMAND} `) ||
    commandBodyNormalized === REMOVE_COMMAND ||
    commandBodyNormalized.startsWith(`${REMOVE_COMMAND} `)
  );
}

export const handleFoodCommands: CommandHandler = async (params, allowTextCommands) => {
  if (!allowTextCommands) {
    return null;
  }

  const normalized = params.command.commandBodyNormalized.trim();
  if (!isFoodCommand(normalized)) {
    return null;
  }

  if (!params.command.isAuthorizedSender) {
    logVerbose(
      `Ignoring food command from unauthorized sender: ${params.command.senderId || "<unknown>"}`,
    );
    return { shouldContinue: false };
  }

  const parsedAdd = parseAddCommand(normalized);
  if (parsedAdd) {
    const result = await addFoodInventoryBatch({
      name: parsedAdd.name,
      quantity: parsedAdd.quantity,
      expiresOn: parsedAdd.expiresOn,
    });
    return {
      shouldContinue: false,
      reply: {
        text: `✅ 추가 완료: ${parsedAdd.name} ${parsedAdd.quantity}개 (소비기한 ${parsedAdd.expiresOn})\n현재 수량: ${result.total}개`,
      },
    };
  }

  const parsedRemove = parseRemoveCommand(normalized);
  if (parsedRemove) {
    const result = await removeFoodInventoryQuantity({
      name: parsedRemove.name,
      quantity: parsedRemove.quantity,
    });

    if (!result.ok) {
      return {
        shouldContinue: false,
        reply: {
          text: result.message,
        },
      };
    }
    const removedSummary = result.removedByExpiry
      .map((entry) => `${entry.expiresOn} ${entry.quantity}개`)
      .join(", ");
    return {
      shouldContinue: false,
      reply: {
        text: `✅ 제거 완료: ${result.itemName} ${parsedRemove.quantity}개\n차감 순서(소비기한 우선): ${removedSummary}\n현재 수량: ${result.remaining}개`,
      },
    };
  }

  return {
    shouldContinue: false,
    reply: {
      text: "⚠️ 형식 오류입니다.\n/추가 물품명 갯수 소비기한(YYYY-MM-DD)\n/제거 물품명 갯수",
    },
  };
};
