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

/**
 * Таблицы «Толмача» и колонка, по которой их можно узнать. Если в базе уже
 * есть таблица с таким именем, но без этой колонки, — она чужая (например,
 * осталась от прошлой версии «Толмача», где books была с ключом key).
 */
const OWN_TABLES: Record<string, string> = {
  settings: "value",
  books: "book_key",
  chapters: "content_sha256",
  chapter_paragraphs: "chapter_id",
  translations: "chapter_id",
  translation_paragraphs: "translation_id",
  paragraph_overrides: "chapter_id",
  terms: "en",
  addresses: "from_term_id",
  summaries: "chapter_id",
  jobs: "chapter_id",
  api_calls: "purpose",
  budget: "month",
  reading_position: "paragraph_idx",
  reports: "token",
  login_attempts: "ok",
  ref_chapters: "scanned",
  ref_terms: "mentions",
  glossary_jobs: "align_total",
};

/**
 * Чужие таблицы с нашими именами — переименовать в legacy_*, вместе с их
 * индексами (иначе имя «books_pkey» столкнулось бы с нашим). Данные не
 * удаляются. Вызывается только для базы, где наша схема ещё не ставилась.
 */
async function moveAsideForeignTables(tx: Db): Promise<string[]> {
  const moved: string[] = [];
  for (const [table, column] of Object.entries(OWN_TABLES)) {
    const exists = await tx.query(
      "select 1 from information_schema.tables where table_schema = current_schema() and table_name = $1",
      [table],
    );
    if (exists.rows.length === 0) continue;
    const ours = await tx.query(
      "select 1 from information_schema.columns where table_schema = current_schema() and table_name = $1 and column_name = $2",
      [table, column],
    );
    if (ours.rows.length > 0) continue;
    let target = `legacy_${table}`;
    for (let n = 2; ; n += 1) {
      const taken = await tx.query("select 1 from information_schema.tables where table_schema = current_schema() and table_name = $1", [target]);
      if (taken.rows.length === 0) break;
      target = `legacy_${table}_${n}`;
    }
    const indexes = await tx.query<{ indexname: string }>(
      "select indexname from pg_indexes where schemaname = current_schema() and tablename = $1",
      [table],
    );
    await tx.query(`alter table "${table}" rename to "${target}"`);
    // Переименование индекса переименовывает и ограничение, которое на нём держится (primary key, unique).
    for (const { indexname } of indexes.rows) {
      await tx.query(`alter index "${indexname}" rename to "${`legacy_${indexname}`.slice(0, 63)}"`);
    }
    moved.push(`${table} → ${target}`);
  }
  return moved;
}

/**
 * Применить схему, если версия в базе ниже текущей. Всё — в одной
 * транзакции с блокировкой на время транзакции: так это безопасно и через
 * пул соединений Neon (сеансовая блокировка там могла бы «уехать» на другое
 * соединение), а при ошибке база остаётся как была.
 */
export async function migrate(target: Db | pg.Pool): Promise<void> {
  const q = target as Db;
  // Быстрый путь без блокировки: схема уже стоит.
  try {
    const { rows } = await q.query<{ version: number }>("select version from schema_meta where id = 1");
    if ((rows[0]?.version ?? 0) >= SCHEMA_VERSION) return;
  } catch {
    // Таблицы ещё нет — ставим схему ниже.
  }
  await withTx(q, async (tx) => {
    await tx.query("select pg_advisory_xact_lock(727272)");
    await tx.query("create table if not exists schema_meta (id int primary key default 1 check (id = 1), version int not null)");
    const { rows } = await tx.query<{ version: number }>("select version from schema_meta where id = 1");
    const current = rows[0]?.version ?? 0;
    if (current >= SCHEMA_VERSION) return;
    if (current < 1) {
      const moved = await moveAsideForeignTables(tx);
      if (moved.length) console.warn("Толмач: чужие таблицы отодвинуты:", moved.join(", "));
    }
    await tx.query(SCHEMA_SQL);
    await tx.query(
      "insert into schema_meta (id, version) values (1, $1) on conflict (id) do update set version = excluded.version",
      [SCHEMA_VERSION],
    );
  });
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
