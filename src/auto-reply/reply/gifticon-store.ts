import fs from "node:fs/promises";
import path from "node:path";
import { resolveStateDir } from "../../config/paths.js";
import { createAsyncLock } from "../../infra/json-files.js";
import { readJsonFileWithFallback, writeJsonFileAtomically } from "../../plugin-sdk/json-store.js";

export type GifticonBatch = {
  expiresOn: string;
  quantity: number;
};

export type GifticonItem = {
  place: string;
  batches: GifticonBatch[];
};

type GifticonItemFile = {
  version: 1;
  place: string;
  batches: GifticonBatch[];
};

const DATA_DIR_NAME = "data";
const GIFTICON_DIR_NAME = "gifticons";
const ITEM_DIR_NAME = "items";
const withGifticonLock = createAsyncLock();

function safePlaceForFile(place: string): string {
  return encodeURIComponent(place);
}

function isValidBatch(batch: unknown): batch is GifticonBatch {
  if (!batch || typeof batch !== "object") {
    return false;
  }
  const candidate = batch as Partial<GifticonBatch>;
  if (typeof candidate.expiresOn !== "string" || !candidate.expiresOn.trim()) {
    return false;
  }
  if (typeof candidate.quantity !== "number" || !Number.isInteger(candidate.quantity)) {
    return false;
  }
  return candidate.quantity > 0;
}

function normalizeItemFromUnknown(raw: unknown): GifticonItem | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const candidate = raw as Partial<GifticonItem>;
  const place = typeof candidate.place === "string" ? candidate.place.trim() : "";
  if (!place) {
    return null;
  }
  const batches = Array.isArray(candidate.batches) ? candidate.batches.filter(isValidBatch) : [];
  if (batches.length === 0) {
    return null;
  }
  return {
    place,
    batches: batches
      .map((batch) => ({
        expiresOn: batch.expiresOn.trim(),
        quantity: batch.quantity,
      }))
      .sort((a, b) => a.expiresOn.localeCompare(b.expiresOn)),
  };
}

export function normalizeGifticonPlaceName(place: string): string {
  return place.trim().toLowerCase().replace(/\s+/g, " ");
}

function resolveGifticonBaseDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveStateDir(env), DATA_DIR_NAME, GIFTICON_DIR_NAME);
}

function resolveLegacyGifticonBaseDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveStateDir(env), GIFTICON_DIR_NAME);
}

function resolveGifticonItemPathFromBase(baseDir: string, normalizedPlace: string): string {
  return path.join(baseDir, ITEM_DIR_NAME, `${safePlaceForFile(normalizedPlace)}.json`);
}

export function resolveGifticonItemPath(
  normalizedPlace: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return resolveGifticonItemPathFromBase(resolveGifticonBaseDir(env), normalizedPlace);
}

function resolveLegacyGifticonItemPath(
  normalizedPlace: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return resolveGifticonItemPathFromBase(resolveLegacyGifticonBaseDir(env), normalizedPlace);
}

async function readGifticonItem(
  normalizedPlace: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<GifticonItem | null> {
  const filePath = resolveGifticonItemPath(normalizedPlace, env);
  const { value, exists } = await readJsonFileWithFallback<GifticonItemFile | null>(filePath, null);
  const current = normalizeItemFromUnknown(value);
  if (current) {
    return current;
  }
  if (!exists) {
    const legacyPath = resolveLegacyGifticonItemPath(normalizedPlace, env);
    const { value: legacyValue } = await readJsonFileWithFallback<GifticonItemFile | null>(
      legacyPath,
      null,
    );
    const legacy = normalizeItemFromUnknown(legacyValue);
    if (legacy) {
      return legacy;
    }
  }
  return null;
}

async function writeGifticonItem(
  normalizedPlace: string,
  item: GifticonItem,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const filePath = resolveGifticonItemPath(normalizedPlace, env);
  const payload: GifticonItemFile = {
    version: 1,
    place: item.place.trim(),
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

async function removeGifticonItem(
  normalizedPlace: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const filePath = resolveGifticonItemPath(normalizedPlace, env);
  await fs.rm(filePath, { force: true });
}

export async function addGifticon(
  params: { place: string; expiresOn: string },
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ total: number }> {
  return await withGifticonLock(async () => {
    const normalizedPlace = normalizeGifticonPlaceName(params.place);
    const current = (await readGifticonItem(normalizedPlace, env)) ?? {
      place: params.place,
      batches: [],
    };
    current.place = params.place;
    const existingBatch = current.batches.find((batch) => batch.expiresOn === params.expiresOn);
    if (existingBatch) {
      existingBatch.quantity += 1;
    } else {
      current.batches.push({ expiresOn: params.expiresOn, quantity: 1 });
    }
    current.batches.sort((a, b) => a.expiresOn.localeCompare(b.expiresOn));
    await writeGifticonItem(normalizedPlace, current, env);
    return { total: current.batches.reduce((sum, batch) => sum + batch.quantity, 0) };
  });
}

export async function removeGifticon(
  params: { place: string },
  env: NodeJS.ProcessEnv = process.env,
): Promise<
  | { ok: true; removed: { expiresOn: string; quantity: number }; remaining: number; place: string }
  | { ok: false; message: string }
> {
  return await withGifticonLock(async () => {
    const normalizedPlace = normalizeGifticonPlaceName(params.place);
    const item = await readGifticonItem(normalizedPlace, env);
    if (!item) {
      return { ok: false as const, message: "⚠️ 해당 사용처 기프티콘이 없습니다." };
    }
    const earliest = item.batches[0];
    if (!earliest) {
      return { ok: false as const, message: "⚠️ 해당 사용처 기프티콘이 없습니다." };
    }
    earliest.quantity -= 1;
    const removed = { expiresOn: earliest.expiresOn, quantity: 1 };
    item.batches = item.batches.filter((batch) => batch.quantity > 0);

    if (item.batches.length === 0) {
      await removeGifticonItem(normalizedPlace, env);
      return { ok: true as const, removed, remaining: 0, place: item.place };
    }
    await writeGifticonItem(normalizedPlace, item, env);
    return {
      ok: true as const,
      removed,
      remaining: item.batches.reduce((sum, batch) => sum + batch.quantity, 0),
      place: item.place,
    };
  });
}

export async function listGifticons(env: NodeJS.ProcessEnv = process.env): Promise<GifticonItem[]> {
  const itemsDir = path.join(resolveGifticonBaseDir(env), ITEM_DIR_NAME);
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
  const loaded = await Promise.all(
    itemFiles.map(async (name) => {
      const filePath = path.join(itemsDir, name);
      const { value } = await readJsonFileWithFallback<GifticonItemFile | null>(filePath, null);
      return normalizeItemFromUnknown(value);
    }),
  );
  return loaded.filter((entry): entry is GifticonItem => entry != null).sort((a, b) => {
    const aEarliest = a.batches[0]?.expiresOn ?? "9999-99-99";
    const bEarliest = b.batches[0]?.expiresOn ?? "9999-99-99";
    if (aEarliest !== bEarliest) {
      return aEarliest.localeCompare(bEarliest);
    }
    return a.place.localeCompare(b.place);
  });
}
