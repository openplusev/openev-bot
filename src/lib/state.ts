import { logger } from "@/lib/logger";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const DATA_DIR = process.env.DATA_DIR?.trim() || "/app/data";

export function dataFile(name: string): string {
  return join(DATA_DIR, name);
}

// Null when the file is missing or unreadable; callers treat that as a first start.
export async function readJson(file: string): Promise<unknown> {
  try {
    const parsed: unknown = JSON.parse(await readFile(file, "utf-8"));
    return parsed;
  } catch (err) {
    logger.info("No state on disk", { file, error: String(err) });
    return null;
  }
}

// Write then rename so a crash mid write never leaves a truncated file.
export async function writeJson(file: string, value: unknown): Promise<void> {
  try {
    await mkdir(DATA_DIR, { recursive: true });
    const tmp = `${file}.tmp`;
    await writeFile(tmp, JSON.stringify(value));
    await rename(tmp, file);
  } catch (err) {
    logger.warn("Saving state failed", { file, error: String(err) });
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
