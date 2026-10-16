/** Настройки, место чтения, отчёты, попытки входа. */

import type { Db } from "./client";
import { iso, num } from "./rows";
import { isEffort, isModelId } from "../core/models";
import { DEFAULT_SETTINGS, type Settings } from "../types";

const SECRET_PREFIX = "secret:";

/** Проверка значения каждой настройки: мусор из базы не должен ронять приложение. */
const VALIDATORS: { [K in keyof Settings]: (v: unknown) => v is Settings[K] } = {
  translateModel: (v): v is Settings["translateModel"] => v === null || isModelId(v),
  extractModel: (v): v is Settings["extractModel"] => isModelId(v),
  translateEffort: (v): v is Settings["translateEffort"] => isEffort(v),
  monthlyLimitRub: (v): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1_000_000,
  usdRub: (v): v is number => typeof v === "number" && Number.isFinite(v) && v > 0 && v <= 10_000,
  autostart: (v): v is boolean => typeof v === "boolean",
};

export async function getSettings(d: Db): Promise<Settings> {
  const r = await d.query("select key, value from settings where key not like $1", [SECRET_PREFIX + "%"]);
  const out: Settings = { ...DEFAULT_SETTINGS };
  for (const row of r.rows) {
    const key = String(row.key) as keyof Settings;
    if (key in VALIDATORS && VALIDATORS[key](row.value)) {
      (out as unknown as Record<string, unknown>)[key] = row.value;
    }
  }
  return out;
}

export async function saveSettings(d: Db, patch: Partial<Settings>): Promise<Settings> {
  for (const [key, value] of Object.entries(patch)) {
    const k = key as keyof Settings;
    if (!(k in VALIDATORS)) continue;
    if (!VALIDATORS[k](value)) throw new Error(`Неверное значение настройки «${key}».`);
    await d.query(
      "insert into settings (key, value) values ($1, $2::jsonb) on conflict (key) do update set value = excluded.value",
      [k, JSON.stringify(value)],
    );
  }
  return getSettings(d);
}

/** Секреты приложения в settings: ключ кнопки (хеш), секрет эстафеты. */
export async function getSecret(d: Db, name: "import_token_hash" | "relay_secret"): Promise<string | null> {
  const r = await d.query("select value from settings where key = $1", [SECRET_PREFIX + name]);
  const v = r.rows[0]?.value;
  return typeof v === "string" ? v : null;
}
export async function setSecret(d: Db, name: "import_token_hash" | "relay_secret", value: string): Promise<void> {
  await d.query(
    "insert into settings (key, value) values ($1, $2::jsonb) on conflict (key) do update set value = excluded.value",
    [SECRET_PREFIX + name, JSON.stringify(value)],
  );
}
/** Взять секрет или создать его один раз (при гонке побеждает первый записанный). */
export async function getOrCreateSecret(d: Db, name: "relay_secret", make: () => string): Promise<string> {
  await d.query("insert into settings (key, value) values ($1, $2::jsonb) on conflict (key) do nothing", [
    SECRET_PREFIX + name,
    JSON.stringify(make()),
  ]);
  const v = await getSecret(d, name);
  if (!v) throw new Error("Не удалось создать секрет.");
  return v;
}

export async function savePosition(d: Db, input: { bookId: string; chapterId: string; paragraphIdx: number; device?: string }): Promise<void> {
  await d.query(
    `insert into reading_position (book_id, chapter_id, paragraph_idx, device, updated_at)
     values ($1, $2, $3, $4, now())
     on conflict (book_id) do update set chapter_id = excluded.chapter_id, paragraph_idx = excluded.paragraph_idx,
       device = excluded.device, updated_at = now()`,
    [input.bookId, input.chapterId, Math.max(0, Math.floor(input.paragraphIdx)), input.device ?? null],
  );
}
export async function getPosition(d: Db, bookId: string): Promise<{ chapterId: string; paragraphIdx: number; updatedAt: string } | null> {
  const r = await d.query("select chapter_id, paragraph_idx, updated_at from reading_position where book_id = $1", [bookId]);
  const row = r.rows[0];
  return row ? { chapterId: String(row.chapter_id), paragraphIdx: num(row.paragraph_idx), updatedAt: iso(row.updated_at) } : null;
}

export async function createReport(d: Db, input: { token: string; chapterId?: string | null; kind: string; note?: string | null; payload?: unknown }): Promise<string> {
  const r = await d.query(
    "insert into reports (token, chapter_id, kind, note, payload) values ($1, $2, $3, $4, $5::jsonb) returning id",
    [input.token, input.chapterId ?? null, input.kind, input.note ?? null, JSON.stringify(input.payload ?? null)],
  );
  return String(r.rows[0].id);
}
export async function getReportByToken(d: Db, token: string): Promise<{ id: string; kind: string; note: string | null; payload: unknown; createdAt: string; chapterId: string | null } | null> {
  const r = await d.query("select * from reports where token = $1", [token]);
  const row = r.rows[0];
  if (!row) return null;
  return {
    id: String(row.id),
    kind: String(row.kind),
    note: row.note == null ? null : String(row.note),
    payload: row.payload,
    createdAt: iso(row.created_at),
    chapterId: row.chapter_id == null ? null : String(row.chapter_id),
  };
}

/** Записать попытку входа. */
export async function recordLoginAttempt(d: Db, ok: boolean): Promise<void> {
  await d.query("insert into login_attempts (ok) values ($1)", [ok]);
  // Старые записи не нужны: держим таблицу маленькой.
  await d.query("delete from login_attempts where created_at < now() - interval '1 day'");
}
/** Число неудачных попыток входа за последние minutes минут. */
export async function failedLoginsRecent(d: Db, minutes = 15): Promise<number> {
  const r = await d.query(
    "select count(*) as n from login_attempts where not ok and created_at > now() - make_interval(mins => $1)",
    [minutes],
  );
  return num(r.rows[0]?.n);
}
