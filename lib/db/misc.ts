/** Настройки, место чтения, отчёты, попытки входа. */

import type { Db } from "./client";
import type { Settings } from "../types";

export async function getSettings(d: Db): Promise<Settings> {
  throw new Error("not implemented");
}
export async function saveSettings(d: Db, patch: Partial<Settings>): Promise<Settings> {
  throw new Error("not implemented");
}

/** Секреты приложения в settings: ключ кнопки (хеш), секрет эстафеты. */
export async function getSecret(d: Db, name: "import_token_hash" | "relay_secret"): Promise<string | null> {
  throw new Error("not implemented");
}
export async function setSecret(d: Db, name: "import_token_hash" | "relay_secret", value: string): Promise<void> {
  throw new Error("not implemented");
}

export async function savePosition(d: Db, input: { bookId: string; chapterId: string; paragraphIdx: number; device?: string }): Promise<void> {
  throw new Error("not implemented");
}
export async function getPosition(d: Db, bookId: string): Promise<{ chapterId: string; paragraphIdx: number; updatedAt: string } | null> {
  throw new Error("not implemented");
}

export async function createReport(d: Db, input: { token: string; chapterId?: string | null; kind: string; note?: string | null; payload?: unknown }): Promise<string> {
  throw new Error("not implemented");
}
export async function getReportByToken(d: Db, token: string): Promise<{ id: string; kind: string; note: string | null; payload: unknown; createdAt: string; chapterId: string | null } | null> {
  throw new Error("not implemented");
}

/** Записать попытку входа и вернуть число неудачных за последние 15 минут (до этой). */
export async function recordLoginAttempt(d: Db, ok: boolean): Promise<void> {
  throw new Error("not implemented");
}
export async function failedLoginsRecent(d: Db, minutes?: number): Promise<number> {
  throw new Error("not implemented");
}
