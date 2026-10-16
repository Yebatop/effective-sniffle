/**
 * Подключение к Postgres.
 *
 * На Vercel строку подставляет интеграция Neon (DATABASE_URL, POSTGRES_URL
 * и др. — имя у поставщиков разное). Пул маленький: функция обслуживает
 * одного читателя, а у бесплатной базы мало соединений. Пул отдаётся
 * Vercel через attachDatabasePool, чтобы простаивающие соединения
 * закрывались, когда экземпляр функции замораживается.
 *
 * Схема проверяется один раз на процесс (ensureSchema), а не на каждый
 * запрос — в «Толмаче» прежней версии создание таблиц шло на каждом
 * обращении.
 */

import pg from "pg";
import { attachDatabasePool } from "@vercel/functions";
import { SCHEMA_SQL, SCHEMA_VERSION } from "./schema";

export interface Db {
  query<R = Record<string, unknown>>(text: string, params?: unknown[]): Promise<{ rows: R[]; rowCount: number }>;
}

const URL_VARS = ["DATABASE_URL", "POSTGRES_URL", "TOLMACH_DATABASE_URL", "NEON_DATABASE_URL"] as const;

export function databaseUrl(): string | null {
  for (const name of URL_VARS) {
    const v = process.env[name];
    if (v && v.trim()) return v.trim();
  }
  return null;
}

let pool: pg.Pool | null = null;
let schemaReady: Promise<void> | null = null;

function createPool(url: string): pg.Pool {
  const local = /@(localhost|127\.0\.0\.1)(:|\/)/.test(url);
  const p = new pg.Pool({
    connectionString: url,
    max: 3,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 15_000, // бесплатная база просыпается несколько секунд
    ssl: local ? undefined : { rejectUnauthorized: true },
  });
  try {
    attachDatabasePool(p);
  } catch {
    // Вне Vercel attachDatabasePool не нужен.
  }
  return p;
}

/** База приложения. Бросает понятную ошибку, если строка подключения не задана. */
export async function db(): Promise<Db> {
  if (!pool) {
    const url = databaseUrl();
    if (!url) throw new Error("База не подключена: нет DATABASE_URL.");
    pool = createPool(url);
  }
  const p = pool;
  if (!schemaReady) {
    schemaReady = migrate(p).catch((e) => {
      schemaReady = null; // следующий запрос попробует снова
      throw e;
    });
  }
  await schemaReady;
  return p as unknown as Db;
}

/** Применить схему, если версия в базе ниже текущей. */
export async function migrate(target: Db | pg.Pool): Promise<void> {
  const q = target as Db;
  await q.query(
    "create table if not exists schema_meta (id int primary key default 1 check (id = 1), version int not null)",
  );
  const { rows } = await q.query<{ version: number }>("select version from schema_meta where id = 1");
  const current = rows[0]?.version ?? 0;
  if (current >= SCHEMA_VERSION) return;
  // Две функции могут мигрировать одновременно: берём рекомендательную блокировку.
  await q.query("select pg_advisory_lock(727272)");
  try {
    const again = await q.query<{ version: number }>("select version from schema_meta where id = 1");
    if ((again.rows[0]?.version ?? 0) >= SCHEMA_VERSION) return;
    await q.query(SCHEMA_SQL);
    await q.query(
      "insert into schema_meta (id, version) values (1, $1) on conflict (id) do update set version = excluded.version",
      [SCHEMA_VERSION],
    );
  } finally {
    await q.query("select pg_advisory_unlock(727272)");
  }
}

/**
 * Выполнить несколько запросов одной транзакцией. На пуле берёт отдельное
 * соединение; если передан уже клиент транзакции (нет connect), выполняет
 * как есть — вложенные вызовы не открывают новую транзакцию.
 */
export async function withTx<T>(d: Db, fn: (tx: Db) => Promise<T>): Promise<T> {
  const maybePool = d as unknown as { connect?: () => Promise<pg.PoolClient> };
  if (typeof maybePool.connect !== "function") return fn(d);
  const client = await maybePool.connect();
  try {
    await client.query("begin");
    const result = await fn(client as unknown as Db);
    await client.query("commit");
    return result;
  } catch (e) {
    await client.query("rollback").catch(() => undefined);
    throw e;
  } finally {
    client.release();
  }
}

/**
 * Для тестов: отдельный пул к указанной базе, с чистой схемой.
 * Не трогает пул приложения.
 */
export async function testDb(url = process.env.TEST_DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/tolmach_test"): Promise<Db & { end(): Promise<void>; reset(): Promise<void> }> {
  const p = new pg.Pool({ connectionString: url, max: 5 });
  const reset = async () => {
    await p.query("drop schema public cascade; create schema public;");
    await migrate(p);
  };
  await reset();
  // end сохраняем заранее: Object.assign подменяет метод самого пула.
  const end = p.end.bind(p);
  return Object.assign(p as unknown as Db, { end: () => end(), reset });
}

/** Подменить базу приложения (тесты сервера и e2e). */
export function __setDbForTests(p: Db | null): void {
  pool = p as unknown as pg.Pool | null;
  schemaReady = p ? Promise.resolve() : null;
}
