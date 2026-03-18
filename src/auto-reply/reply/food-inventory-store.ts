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

export type FoodInventoryStore = {
  version: 1;
  items: Record<string, FoodInventoryItem>;
};

const DEFAULT_INVENTORY: FoodInventoryStore = {
  version: 1,
  items: {},
};

const withInventoryLock = createAsyncLock();

function normalizeFoodNameKey(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, " ");
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

function sanitizeInventory(value: unknown): FoodInventoryStore {
  if (!value || typeof value !== "object") {
    return { ...DEFAULT_INVENTORY };
  }
  const parsed = value as Partial<FoodInventoryStore>;
  const items = parsed.items;
  if (!items || typeof items !== "object") {
    return { ...DEFAULT_INVENTORY };
  }

  const normalizedItems: Record<string, FoodInventoryItem> = {};
  for (const [rawKey, rawItem] of Object.entries(items)) {
    if (!rawItem || typeof rawItem !== "object") {
      continue;
    }
    const candidate = rawItem as Partial<FoodInventoryItem>;
    const name = typeof candidate.name === "string" ? candidate.name.trim() : "";
    const key = normalizeFoodNameKey(rawKey || name);
    if (!key) {
      continue;
    }
    const batches = Array.isArray(candidate.batches) ? candidate.batches.filter(isValidBatch) : [];
    if (batches.length === 0) {
      continue;
    }
    normalizedItems[key] = {
      name: name || key,
      batches: batches.map((batch) => ({
        expiresOn: batch.expiresOn.trim(),
        quantity: batch.quantity,
      })),
    };
  }

  return {
    version: 1,
    items: normalizedItems,
  };
}

export function resolveFoodInventoryPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveStateDir(env), "food", "inventory.json");
}

export async function readFoodInventory(
  env: NodeJS.ProcessEnv = process.env,
): Promise<FoodInventoryStore> {
  const filePath = resolveFoodInventoryPath(env);
  const { value } = await readJsonFileWithFallback<FoodInventoryStore>(filePath, DEFAULT_INVENTORY);
  return sanitizeInventory(value);
}

export async function writeFoodInventory(
  value: FoodInventoryStore,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const filePath = resolveFoodInventoryPath(env);
  await writeJsonFileAtomically(filePath, sanitizeInventory(value));
}

export async function updateFoodInventory<T>(
  updater: (inventory: FoodInventoryStore) => Promise<T> | T,
  env: NodeJS.ProcessEnv = process.env,
): Promise<T> {
  return await withInventoryLock(async () => {
    const current = await readFoodInventory(env);
    const result = await updater(current);
    await writeFoodInventory(current, env);
    return result;
  });
}

export function normalizeFoodInventoryName(name: string): string {
  return normalizeFoodNameKey(name);
}
