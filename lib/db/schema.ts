/**
 * Схема базы «Толмача». Хранится строкой, а не .sql-файлом: так она
 * гарантированно попадает в серверную функцию на Vercel.
 *
 * Меняя схему, поднимите SCHEMA_VERSION и пишите операторы идемпотентно
 * (if not exists / add column if not exists): migrate() применяет весь
 * текст целиком к базе с версией ниже текущей.
 */

export const SCHEMA_VERSION = 1;

export const SCHEMA_SQL = `
-- Схема «Толмача». Версия схемы — в schema_meta; migrate.ts применяет файл
-- целиком, если версия ниже SCHEMA_VERSION. Все операторы идемпотентны.

create table if not exists schema_meta (
  id int primary key default 1 check (id = 1),
  version int not null
);

create table if not exists settings (
  key text primary key,
  value jsonb not null
);

create table if not exists books (
  id uuid primary key default gen_random_uuid(),
  book_key text unique,
  title text not null,
  source_lang text not null default 'en',
  site text,
  register text not null default 'plain' check (register in ('live','plain','elevated')),
  narrator_person smallint check (narrator_person in (1,3)),
  narrator_gender text check (narrator_gender in ('m','f','n','unknown')),
  honorifics text,
  glossary_version int not null default 0,
  cover_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists chapters (
  id uuid primary key default gen_random_uuid(),
  book_id uuid not null references books(id) on delete cascade,
  number int,
  title_src text not null,
  url text,
  next_url text,
  prev_url text,
  content_sha256 text not null,
  words int not null,
  source text not null,
  current_translation_id uuid,
  created_at timestamptz not null default now(),
  unique (book_id, content_sha256)
);
create index if not exists chapters_book_number on chapters(book_id, number);
create index if not exists chapters_url on chapters(url);

-- idx 0 — название главы, текст — с 1.
create table if not exists chapter_paragraphs (
  chapter_id uuid not null references chapters(id) on delete cascade,
  idx int not null,
  text text not null,
  primary key (chapter_id, idx)
);

create table if not exists translations (
  id uuid primary key default gen_random_uuid(),
  chapter_id uuid not null references chapters(id) on delete cascade,
  model text not null,
  mode text not null default 'sync' check (mode in ('sync','batch')),
  glossary_version int not null default 0,
  status text not null default 'in_progress' check (status in ('in_progress','done','failed')),
  cost_usd numeric(12,6) not null default 0,
  created_at timestamptz not null default now()
);
create index if not exists translations_chapter on translations(chapter_id);

create sequence if not exists translation_paragraph_seq;

create table if not exists translation_paragraphs (
  translation_id uuid not null references translations(id) on delete cascade,
  idx int not null,
  text text not null,
  refused boolean not null default false,
  seq bigint not null default nextval('translation_paragraph_seq'),
  primary key (translation_id, idx)
);
create index if not exists translation_paragraphs_seq on translation_paragraphs(translation_id, seq);

-- Ручные правки абзацев перевода (поверх текущей версии), с откатом.
create table if not exists paragraph_overrides (
  id uuid primary key default gen_random_uuid(),
  chapter_id uuid not null references chapters(id) on delete cascade,
  idx int not null,
  text text not null,
  source text not null,
  created_at timestamptz not null default now()
);

create table if not exists terms (
  id uuid primary key default gen_random_uuid(),
  book_id uuid not null references books(id) on delete cascade,
  en text not null,
  ru text not null,
  kind text not null default 'other' check (kind in ('name','title','technique','place','org','item','other')),
  gender text check (gender in ('m','f','n','unknown')),
  aliases text[] not null default '{}',
  note text,
  status text not null default 'proposed' check (status in ('proposed','checked')),
  first_chapter_id uuid references chapters(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists terms_book_en on terms(book_id, lower(en));

create table if not exists addresses (
  id uuid primary key default gen_random_uuid(),
  book_id uuid not null references books(id) on delete cascade,
  from_term_id uuid not null references terms(id) on delete cascade,
  to_term_id uuid not null references terms(id) on delete cascade,
  form text not null check (form in ('ty','vy')),
  from_chapter int,
  status text not null default 'proposed' check (status in ('proposed','checked')),
  created_at timestamptz not null default now()
);
create unique index if not exists addresses_pair on addresses(from_term_id, to_term_id, coalesce(from_chapter, -1));

create table if not exists summaries (
  chapter_id uuid not null references chapters(id) on delete cascade,
  source text not null check (source in ('en','ru')),
  text text not null,
  created_at timestamptz not null default now(),
  primary key (chapter_id, source)
);

create table if not exists jobs (
  id uuid primary key default gen_random_uuid(),
  kind text not null default 'translate',
  chapter_id uuid not null references chapters(id) on delete cascade,
  translation_id uuid references translations(id) on delete set null,
  state text not null default 'queued'
    check (state in ('queued','running','done','failed','blocked_budget','blocked_credit')),
  model text not null,
  effort text not null default 'medium',
  next_chunk int not null default 0,
  chunks_total int,
  terms_extracted boolean not null default false,
  lease_until timestamptz,
  attempt int not null default 0,
  error_code text,
  error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
-- Одна живая задача на главу: повторное нажатие, второе устройство и
-- повтор отправки получают id уже существующей задачи.
create unique index if not exists jobs_live_per_chapter on jobs(chapter_id, kind)
  where state in ('queued','running','blocked_budget','blocked_credit');

create table if not exists api_calls (
  id uuid primary key default gen_random_uuid(),
  job_id uuid references jobs(id) on delete set null,
  chapter_id uuid references chapters(id) on delete set null,
  book_id uuid references books(id) on delete set null,
  purpose text not null, -- 'translate' | 'extract' | 'repair' | ...
  idem_key text unique,  -- защита от двойного учёта: job:chunk:attempt:model
  model text not null,
  batch boolean not null default false,
  input_tokens int not null default 0,
  output_tokens int not null default 0,
  cache_write_5m int not null default 0,
  cache_write_1h int not null default 0,
  cache_read int not null default 0,
  stop_reason text,
  usd numeric(12,6) not null,
  created_at timestamptz not null default now()
);
create index if not exists api_calls_created on api_calls(created_at);
create index if not exists api_calls_book on api_calls(book_id);

create table if not exists budget (
  month text primary key, -- '2026-10'
  spent_usd numeric(12,6) not null default 0,
  reserved_usd numeric(12,6) not null default 0
);

create table if not exists reading_position (
  book_id uuid primary key references books(id) on delete cascade,
  chapter_id uuid not null references chapters(id) on delete cascade,
  paragraph_idx int not null default 0,
  device text,
  updated_at timestamptz not null default now()
);

create table if not exists reports (
  id uuid primary key default gen_random_uuid(),
  token text not null unique,
  chapter_id uuid references chapters(id) on delete set null,
  kind text not null,
  note text,
  payload jsonb,
  created_at timestamptz not null default now()
);

create table if not exists login_attempts (
  id bigserial primary key,
  ok boolean not null,
  created_at timestamptz not null default now()
);
`;
