import fs from "node:fs/promises";
import path from "node:path";
import { resolveStateDir } from "../../config/paths.js";
import { createAsyncLock } from "../../infra/json-files.js";
import { readJsonFileWithFallback, writeJsonFileAtomically } from "../../plugin-sdk/json-store.js";

export type FoodBatch = {
  expiresOn: string;
  quantity: number;
};

export type FoodInventoryItem = {
  name: string;
  batches: FoodBatch[];
};

type LegacyFoodInventoryStore = {
  version: 1;
  items: Record<string, FoodInventoryItem>;
};

type FoodInventoryItemFile = {
  version: 1;
  name: string;
  batches: FoodBatch[];
};

const LEGACY_FILE_NAME = "inventory.json";
const DATA_DIR_NAME = "data";
const FOOD_DIR_NAME = "food";
const ITEM_DIR_NAME = "items";
const withInventoryLock = createAsyncLock();

function safeFoodNameForFile(name: string): string {
  return encodeURIComponent(name);
}

function isValidBatch(batch: unknown): batch is FoodBatch {
  if (!batch || typeof batch !== "object") {
    return false;
  }
  const candidate = batch as Partial<FoodBatch>;
  if (typeof candidate.expiresOn !== "string" || !candidate.expiresOn.trim()) {
    return false;
  }
  if (typeof candidate.quantity !== "number" || !Number.isInteger(candidate.quantity)) {
    return false;
  }
  return candidate.quantity > 0;
}

function normalizeItemFromUnknown(raw: unknown): FoodInventoryItem | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const candidate = raw as Partial<FoodInventoryItem>;
  const name = typeof candidate.name === "string" ? candidate.name.trim() : "";
  if (!name) {
    return null;
  }
  const batches = Array.isArray(candidate.batches) ? candidate.batches.filter(isValidBatch) : [];
  if (batches.length === 0) {
    return null;
  }
  return {
    name,
    batches: batches
      .map((batch) => ({
        expiresOn: batch.expiresOn.trim(),
        quantity: batch.quantity,
      }))
      .sort((a, b) => a.expiresOn.localeCompare(b.expiresOn)),
  };
}

export function normalizeFoodInventoryName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, " ");
}

function resolveFoodBaseDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveStateDir(env), DATA_DIR_NAME, FOOD_DIR_NAME);
}

function resolveFoodLegacyBaseDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveStateDir(env), FOOD_DIR_NAME);
}

function resolveFoodInventoryItemPathFromBase(baseDir: string, normalizedName: string): string {
  return path.join(baseDir, ITEM_DIR_NAME, `${safeFoodNameForFile(normalizedName)}.json`);
}

export function resolveFoodInventoryItemPath(
  normalizedName: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return resolveFoodInventoryItemPathFromBase(resolveFoodBaseDir(env), normalizedName);
}

function resolveLegacyFoodInventoryItemPath(
  normalizedName: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return resolveFoodInventoryItemPathFromBase(resolveFoodLegacyBaseDir(env), normalizedName);
}

function resolveLegacyInventoryPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveFoodBaseDir(env), LEGACY_FILE_NAME);
}

function resolvePreDataLegacyInventoryPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveFoodLegacyBaseDir(env), LEGACY_FILE_NAME);
}

async function readLegacyItemFromPath(
  normalizedName: string,
  filePath: string,
): Promise<FoodInventoryItem | null> {
  const { value } = await readJsonFileWithFallback<LegacyFoodInventoryStore>(filePath, {
    version: 1,
    items: {},
  });
  if (!value || typeof value !== "object" || !value.items || typeof value.items !== "object") {
    return null;
  }
  const direct = value.items[normalizedName];
  if (direct) {
    return normalizeItemFromUnknown(direct);
  }
  for (const [key, item] of Object.entries(value.items)) {
    if (normalizeFoodInventoryName(key) === normalizedName) {
      return normalizeItemFromUnknown(item);
    }
  }
  return null;
}

async function readLegacyItem(normalizedName: string, env: NodeJS.ProcessEnv): Promise<FoodInventoryItem | null> {
  const fromDataDir = await readLegacyItemFromPath(normalizedName, resolveLegacyInventoryPath(env));
  if (fromDataDir) {
    return fromDataDir;
  }
  return await readLegacyItemFromPath(normalizedName, resolvePreDataLegacyInventoryPath(env));
}

async function readFoodInventoryItem(
  normalizedName: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<FoodInventoryItem | null> {
  const filePath = resolveFoodInventoryItemPath(normalizedName, env);
  const { value, exists } = await readJsonFileWithFallback<FoodInventoryItemFile | null>(filePath, null);
  const itemFromFile = normalizeItemFromUnknown(value);
  if (itemFromFile) {
    return itemFromFile;
  }
  if (!exists) {
    const legacyItemPath = resolveLegacyFoodInventoryItemPath(normalizedName, env);
    const { value: legacyValue } = await readJsonFileWithFallback<FoodInventoryItemFile | null>(
      legacyItemPath,
      null,
    );
    const legacyItemFromFile = normalizeItemFromUnknown(legacyValue);
    if (legacyItemFromFile) {
      return legacyItemFromFile;
    }
  }
  // Backward compatibility for users who already have the legacy single-file store.
  return await readLegacyItem(normalizedName, env);
}

async function writeFoodInventoryItem(
  normalizedName: string,
  item: FoodInventoryItem,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const filePath = resolveFoodInventoryItemPath(normalizedName, env);
  const payload: FoodInventoryItemFile = {
    version: 1,
    name: item.name.trim(),
    batches: item.batches
      .filter(isValidBatch)
      .map((batch) => ({
        expiresOn: batch.expiresOn.trim(),
        quantity: batch.quantity,
      }))
      .sort((a, b) => a.expiresOn.localeCompare(b.expiresOn)),
  };
  await writeJsonFileAtomically(filePath, payload);
}

async function removeFoodInventoryItem(
  normalizedName: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const filePath = resolveFoodInventoryItemPath(normalizedName, env);
  await fs.rm(filePath, { force: true });
}

export async function addFoodInventoryBatch(
  params: { name: string; quantity: number; expiresOn: string },
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ total: number }> {
  return await withInventoryLock(async () => {
    const normalizedName = normalizeFoodInventoryName(params.name);
    const current = (await readFoodInventoryItem(normalizedName, env)) ?? {
      name: params.name,
      batches: [],
    };
    current.name = params.name;
    const existingBatch = current.batches.find((batch) => batch.expiresOn === params.expiresOn);
    if (existingBatch) {
      existingBatch.quantity += params.quantity;
    } else {
      current.batches.push({ expiresOn: params.expiresOn, quantity: params.quantity });
    }
    current.batches.sort((a, b) => a.expiresOn.localeCompare(b.expiresOn));
    await writeFoodInventoryItem(normalizedName, current, env);
    return {
      total: current.batches.reduce((sum, batch) => sum + batch.quantity, 0),
    };
  });
}

export async function removeFoodInventoryQuantity(
  params: { name: string; quantity: number },
  env: NodeJS.ProcessEnv = process.env,
): Promise<
  | { ok: true; removedByExpiry: Array<{ expiresOn: string; quantity: number }>; remaining: number; itemName: string }
  | { ok: false; message: string }
> {
  return await withInventoryLock(async () => {
    const normalizedName = normalizeFoodInventoryName(params.name);
    const item = await readFoodInventoryItem(normalizedName, env);
    if (!item) {
      return { ok: false as const, message: "⚠️ 해당 물품이 재고에 없습니다." };
    }
    const total = item.batches.reduce((sum, batch) => sum + batch.quantity, 0);
    if (total < params.quantity) {
      return {
        ok: false as const,
        message: `⚠️ 재고가 부족합니다. 현재 ${item.name} 재고는 ${total}개입니다.`,
      };
    }

    let remainingToRemove = params.quantity;
    const removedByExpiry: Array<{ expiresOn: string; quantity: number }> = [];
    item.batches.sort((a, b) => a.expiresOn.localeCompare(b.expiresOn));
    for (const batch of item.batches) {
      if (remainingToRemove <= 0) {
        break;
      }
      const removed = Math.min(batch.quantity, remainingToRemove);
      if (removed <= 0) {
        continue;
      }
      batch.quantity -= removed;
      remainingToRemove -= removed;
      removedByExpiry.push({ expiresOn: batch.expiresOn, quantity: removed });
    }
    item.batches = item.batches.filter((batch) => batch.quantity > 0);

    if (item.batches.length === 0) {
      await removeFoodInventoryItem(normalizedName, env);
      return {
        ok: true as const,
        removedByExpiry,
        remaining: 0,
        itemName: item.name,
      };
    }
    await writeFoodInventoryItem(normalizedName, item, env);
    return {
      ok: true as const,
      removedByExpiry,
      remaining: item.batches.reduce((sum, batch) => sum + batch.quantity, 0),
      itemName: item.name,
    };
  });
}
