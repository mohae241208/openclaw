import fs from "node:fs/promises";
import path from "node:path";
import { resolveStateDir } from "../../config/paths.js";
import { createAsyncLock } from "../../infra/json-files.js";
import { readJsonFileWithFallback, writeJsonFileAtomically } from "../../plugin-sdk/json-store.js";

export type ItemLocationRecord = {
  item: string;
  location: string;
};

type ItemLocationFile = {
  version: 1;
  item: string;
  location: string;
};

const DATA_DIR_NAME = "data";
const ITEM_LOCATIONS_DIR = "item-locations";
const ITEM_FILES_DIR = "items";
const withItemLocationLock = createAsyncLock();

function safeItemNameForFile(item: string): string {
  return encodeURIComponent(item);
}

export function normalizeItemLocationName(item: string): string {
  return item.trim().toLowerCase().replace(/\s+/g, " ");
}

function resolveItemLocationBaseDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveStateDir(env), DATA_DIR_NAME, ITEM_LOCATIONS_DIR);
}

function resolveLegacyItemLocationBaseDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveStateDir(env), ITEM_LOCATIONS_DIR);
}

function resolveItemLocationPathFromBase(baseDir: string, normalizedItem: string): string {
  return path.join(baseDir, ITEM_FILES_DIR, `${safeItemNameForFile(normalizedItem)}.json`);
}

export function resolveItemLocationPath(
  normalizedItem: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return resolveItemLocationPathFromBase(resolveItemLocationBaseDir(env), normalizedItem);
}

function resolveLegacyItemLocationPath(
  normalizedItem: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return resolveItemLocationPathFromBase(resolveLegacyItemLocationBaseDir(env), normalizedItem);
}

function normalizeRecordFromUnknown(raw: unknown): ItemLocationRecord | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const candidate = raw as Partial<ItemLocationFile>;
  const item = typeof candidate.item === "string" ? candidate.item.trim() : "";
  const location = typeof candidate.location === "string" ? candidate.location.trim() : "";
  if (!item || !location) {
    return null;
  }
  return { item, location };
}

async function readItemLocation(
  normalizedItem: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ItemLocationRecord | null> {
  const filePath = resolveItemLocationPath(normalizedItem, env);
  const { value, exists } = await readJsonFileWithFallback<ItemLocationFile | null>(filePath, null);
  const current = normalizeRecordFromUnknown(value);
  if (current) {
    return current;
  }
  if (!exists) {
    const legacyPath = resolveLegacyItemLocationPath(normalizedItem, env);
    const { value: legacyValue } = await readJsonFileWithFallback<ItemLocationFile | null>(
      legacyPath,
      null,
    );
    const legacy = normalizeRecordFromUnknown(legacyValue);
    if (legacy) {
      return legacy;
    }
  }
  return null;
}

async function writeItemLocation(
  normalizedItem: string,
  record: ItemLocationRecord,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const filePath = resolveItemLocationPath(normalizedItem, env);
  const payload: ItemLocationFile = {
    version: 1,
    item: record.item.trim(),
    location: record.location.trim(),
  };
  await writeJsonFileAtomically(filePath, payload);
}

async function removeItemLocation(normalizedItem: string, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  await fs.rm(resolveItemLocationPath(normalizedItem, env), { force: true });
}

export async function upsertItemLocation(
  params: { item: string; location: string },
  env: NodeJS.ProcessEnv = process.env,
): Promise<ItemLocationRecord> {
  return await withItemLocationLock(async () => {
    const normalizedItem = normalizeItemLocationName(params.item);
    const next: ItemLocationRecord = {
      item: params.item.trim(),
      location: params.location.trim(),
    };
    await writeItemLocation(normalizedItem, next, env);
    return next;
  });
}

export async function deleteItemLocationByName(
  params: { item: string },
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ removed: boolean; item?: string }> {
  return await withItemLocationLock(async () => {
    const normalizedItem = normalizeItemLocationName(params.item);
    const current = await readItemLocation(normalizedItem, env);
    if (!current) {
      return { removed: false };
    }
    await removeItemLocation(normalizedItem, env);
    return { removed: true, item: current.item };
  });
}

export async function listItemLocations(
  env: NodeJS.ProcessEnv = process.env,
): Promise<ItemLocationRecord[]> {
  const itemsDir = path.join(resolveItemLocationBaseDir(env), ITEM_FILES_DIR);
  let names: string[] = [];
  try {
    names = await fs.readdir(itemsDir);
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === "ENOENT") {
      return [];
    }
    throw err;
  }
  const itemFiles = names.filter((name) => name.endsWith(".json"));
  const records = await Promise.all(
    itemFiles.map(async (name) => {
      const filePath = path.join(itemsDir, name);
      const { value } = await readJsonFileWithFallback<ItemLocationFile | null>(filePath, null);
      return normalizeRecordFromUnknown(value);
    }),
  );
  return records
    .filter((record): record is ItemLocationRecord => record != null)
    .sort((a, b) => a.item.localeCompare(b.item));
}
