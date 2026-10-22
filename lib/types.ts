/**
 * Общие типы «Толмача»: предметная область и форма запросов/ответов API.
 *
 * Это договор между частями: ядро (lib/core), снятие текста (lib/extract),
 * база (lib/db), сервер (lib/server, app/api) и интерфейс (app/*).
 * Меняется только осознанно — от этих форм зависят все части сразу.
 */

// ── Модели ──────────────────────────────────────────────────────────────

export type ModelId = "claude-haiku-5-5" | "claude-sonnet-5-5" | "claude-opus-5-5";
export type Effort = "low" | "medium" | "high";

// ── Книга, глава, перевод ───────────────────────────────────────────────

/** Как передавать текст: живо, ровно или возвышенно. */
export type Register = "live" | "plain" | "elevated";

export interface Book {
  id: string;
  /** Ключ книги из адреса (см. lib/core/url.ts) или null для книг без адреса. */
  bookKey: string | null;
  title: string;
  sourceLang: string; // "en" сейчас; поле заложено под будущие языки
  site: string | null; // хост сайта-источника
  register: Register;
  /** Лицо рассказчика: 1 — «я», 3 — «он/она»; null — не определено. */
  narratorPerson: 1 | 3 | null;
  narratorGender: Gender | null;
  /** Как передавать обращения вроде «shixiong», «senpai»: свободный текст для промпта. */
  honorifics: string | null;
  glossaryVersion: number;
  coverUrl: string | null;
  createdAt: string;
  updatedAt: string;
}

export type ChapterSource = "button" | "share" | "paste" | "file" | "server" | "bridge";

export interface Chapter {
  id: string;
  bookId: string;
  /** Номер главы из заголовка или адреса; null — не удалось понять. */
  number: number | null;
  titleSrc: string;
  url: string | null; // нормализованный адрес
  nextUrl: string | null;
  prevUrl: string | null;
  contentSha256: string;
  words: number;
  source: ChapterSource;
  currentTranslationId: string | null;
  createdAt: string;
}

/** Абзац оригинала. idx 0 — название главы; текст главы — с idx 1. */
export interface Paragraph {
  idx: number;
  text: string;
}

export type TranslationStatus = "in_progress" | "done" | "failed";

export interface Translation {
  id: string;
  chapterId: string;
  model: ModelId;
  mode: "sync" | "batch";
  glossaryVersion: number;
  status: TranslationStatus;
  costUsd: number;
  createdAt: string;
}

/** Абзац перевода; idx совпадает с idx абзаца оригинала. */
export interface TranslatedParagraph {
  idx: number;
  text: string;
  /** Модель отказалась переводить этот абзац — показан заменитель. */
  refused?: boolean;
  /** Монотонный номер записи — для опроса «что нового с seq». */
  seq: number;
}

// ── Глоссарий ───────────────────────────────────────────────────────────

export type Gender = "m" | "f" | "n" | "unknown";
export type TermKind = "name" | "title" | "technique" | "place" | "org" | "item" | "other";
export type TermStatus = "proposed" | "checked";

export interface Term {
  id: string;
  bookId: string;
  en: string;
  ru: string;
  kind: TermKind;
  /** Род — только для персонажей (kind = "name"); для прочего null. */
  gender: Gender | null;
  /** Другие имена того же персонажа/предмета по-английски: "Gu", "Master Gu". */
  aliases: string[];
  note: string | null;
  status: TermStatus;
  firstChapterId: string | null;
  /** Откуда термин: auto — разбор главы, reference — готовый перевод. */
  source: TermSource;
}

export type TermSource = "auto" | "reference";

export interface Address {
  id: string;
  bookId: string;
  fromTermId: string;
  toTermId: string;
  form: "ty" | "vy";
  /** С какой главы действует (номер главы); null — с начала. */
  fromChapter: number | null;
  status: TermStatus;
}

// ── Задачи ──────────────────────────────────────────────────────────────

export type JobState =
  | "queued"
  | "running"
  | "done"
  | "failed"
  | "blocked_budget" // лимит месяца не пускает — ждём решения
  | "blocked_credit"; // на счёте Anthropic кончились деньги

export type JobKind = "translate";

export interface Job {
  id: string;
  kind: JobKind;
  chapterId: string;
  translationId: string | null;
  state: JobState;
  model: ModelId;
  effort: Effort;
  /** Сколько частей главы уже готово; всего частей — chunksTotal. */
  nextChunk: number;
  chunksTotal: number | null;
  /** Разбор терминов перед переводом выполнен. */
  termsExtracted: boolean;
  leaseUntil: string | null;
  attempt: number;
  /** Повторы после временных ошибок на текущей части (не путать с attempt — тот растёт на каждой эстафете). */
  retries: number;
  /** Сколько заходов уже начинали текущую часть. */
  chunkTries: number;
  /** Сколько долларов задача держит в резерве бюджета прямо сейчас. */
  reservedUsd: number;
  reservedMonth: string | null;
  /** Код ошибки для экрана: см. ErrorCode. */
  errorCode: ErrorCode | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Ошибки, которые интерфейс показывает человеческими словами. */
export type ErrorCode =
  | "budget_limit" // упёрлись в месячный лимит Толмача
  | "credit_low" // «Your credit balance is too low» — пополнить Anthropic
  | "console_limit" // сработал лимит трат в Anthropic Console
  | "auth" // ключ Anthropic не подходит
  | "rate_limit" // слишком часто — подождать
  | "overloaded" // Anthropic перегружен — повторим
  | "refused" // модель отказалась, повторы не помогли
  | "network" // не достучались
  | "site_blocked" // сайт показал «вы не робот?»
  | "not_chapter" // страница не похожа на главу
  | "too_large"
  | "unknown";

// ── Деньги ──────────────────────────────────────────────────────────────

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheWrite5mTokens: number;
  cacheWrite1hTokens: number;
  cacheReadTokens: number;
}

export interface Settings {
  /** Модель перевода; null — ещё не выбрана (первый запуск спрашивает). */
  translateModel: ModelId | null;
  /** Модель разбора терминов. */
  extractModel: ModelId;
  translateEffort: Effort;
  monthlyLimitRub: number;
  usdRub: number;
  /** Переводить сразу при открытии главы, без карточки с ценой. */
  autostart: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  translateModel: null,
  extractModel: "claude-sonnet-5-5",
  translateEffort: "medium",
  monthlyLimitRub: 300,
  usdRub: 92,
  autostart: false,
};

export interface BudgetState {
  month: string; // "2026-10"
  limitUsd: number;
  spentUsd: number;
  reservedUsd: number;
}

// ── Снятие текста ───────────────────────────────────────────────────────

/** То, что получается со страницы, файла или вставки — до записи в базу. */
export interface ExtractedChapter {
  url: string | null;
  bookTitle: string | null;
  chapterTitle: string;
  /** Абзацы текста главы без названия. */
  paragraphs: string[];
  nextUrl: string | null;
  prevUrl: string | null;
  coverUrl: string | null;
  words: number;
  /** Похоже на закрытую (платную) главу: мало текста и есть маркер. */
  looksLocked: boolean;
  /** Похоже на оглавление/страницу книги, а не главу. */
  looksLikeIndex: boolean;
}

// ── API: запросы и ответы ───────────────────────────────────────────────

/** POST /api/import — от кнопки на сайте (Bearer-ключ) или из приложения (cookie). */
export interface ImportRequest {
  chapters: Array<ExtractedChapter & { source: ChapterSource; bookId?: string }>;
}
export interface ImportResponseItem {
  chapterId: string;
  bookId: string;
  /** false — такая глава уже была (повтор по содержимому), ничего не создано. */
  created: boolean;
  title: string;
  words: number;
  hasTranslation: boolean;
}
export interface ImportResponse {
  items: ImportResponseItem[];
}

/** POST /api/fetch — сервер пробует сам открыть страницу. */
export interface FetchRequest {
  url: string;
}
export type FetchResponse =
  | { ok: true; chapter: ExtractedChapter }
  | { ok: false; code: ErrorCode; message: string };

/** GET /api/chapters/:id */
export interface ChapterView {
  chapter: Chapter;
  book: Book;
  paragraphs: Paragraph[];
  translation: (Translation & { paragraphs: TranslatedParagraph[] }) | null;
  job: Job | null;
  prev: NeighborView;
  next: NeighborView;
  /** Термины книги для подсветки и карточек. */
  terms: Term[];
  position: { paragraphIdx: number } | null;
  /** Оценка цены перевода этой главы текущей моделью, ₽ и $. */
  estimate: { usd: number; rub: number; model: ModelId } | null;
}
export interface NeighborView {
  chapterId: string | null; // уже взята в библиотеку
  url: string | null; // адрес на сайте, если известен
  translated: boolean;
}

/** POST /api/chapters/:id/translate */
export interface TranslateRequest {
  model?: ModelId;
}
export type TranslateResponse =
  | { ok: true; jobId: string }
  | { ok: false; code: ErrorCode; message: string };

/** GET /api/jobs/:id?since=<seq> */
export interface JobPoll {
  job: Job;
  /** Новые абзацы перевода с seq > since. */
  paragraphs: TranslatedParagraph[];
  /** Максимальный seq в ответе — передать в следующий опрос. */
  seq: number;
  costUsd: number;
}

/** POST /api/position */
export interface PositionRequest {
  bookId: string;
  chapterId: string;
  paragraphIdx: number;
  device?: string;
}

/** POST /api/report */
export interface ReportRequest {
  chapterId?: string;
  kind: "wrong_text" | "bad_translation" | "error" | "other";
  note?: string;
  /** Что было на странице: снятый текст, адрес, сведения от кнопки. */
  snapshot?: unknown;
}
export interface ReportResponse {
  id: string;
  /** Ссылка, по которой отчёт можно прочитать без пароля (длинный секрет). */
  url: string;
}

/** GET /api/status */
export interface StatusView {
  version: string;
  commit: string | null;
  checks: Array<{ key: string; ok: boolean; label: string; detail?: string }>;
  budget: BudgetState;
}

/** Библиотека: GET /api/books */
export interface BookListItem {
  book: Book;
  chapters: number;
  translated: number;
  lastRead: { chapterId: string; chapterTitle: string; number: number | null; at: string } | null;
  nextReady: boolean;
  spentUsd: number;
}

// ── Готовый перевод и глоссарий по нему ─────────────────────────────────

/** Глава чужого готового перевода, присланная кнопкой с русского сайта. */
export interface RefChapterInput {
  url: string | null;
  chapterTitle: string;
  paragraphs: string[];
  /** Номер, который ждёт кнопка (прошлый + 1), — если в заголовке и адресе номера нет. */
  expectedNumber?: number | null;
  /** Ссылка «назад» со страницы: если она уже записана, номер — следующий за ней. */
  prevUrl?: string | null;
}

/** POST /api/reference/import */
export interface RefImportRequest {
  bookId: string;
  chapters: RefChapterInput[];
}
export interface RefImportResponse {
  items: Array<{ number: number; created: boolean; updated: boolean }>;
}

/** 409 от /api/reference/import: под номером уже глава с другого адреса. */
export interface RefImportConflict {
  ok: false;
  code: "conflict";
  number: number;
  message: string;
}

/** GET /api/reference/books — для выбора книги в кнопке. */
export interface RefBookItem {
  id: string;
  title: string;
  chapters: number;
  refChapters: number;
}

/** Имя или термин готового перевода (по-русски). */
export interface RefTerm {
  id: string;
  bookId: string;
  ru: string;
  kind: TermKind;
  gender: Gender | null;
  note: string | null;
  mentions: number;
  firstNumber: number | null;
  lastNumber: number | null;
  /** Сопоставленный английский термин глоссария; null — пока подсказка. */
  termId: string | null;
}

export type GlossaryJobState = JobState | "stopped";
export type GlossaryJobStage = "scan" | "align" | "done";

export interface GlossaryJob {
  id: string;
  bookId: string;
  state: GlossaryJobState;
  stage: GlossaryJobStage;
  model: ModelId;
  scanDone: number;
  scanTotal: number;
  alignDone: number;
  alignTotal: number;
  alignNumbers: number[];
  leaseUntil: string | null;
  attempt: number;
  retries: number;
  reservedUsd: number;
  reservedMonth: string | null;
  spentUsd: number;
  errorCode: ErrorCode | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
}

/** GET /api/books/:id/reference — что есть из готового перевода и что с глоссарием. */
export interface RefSummary {
  count: number;
  minNumber: number | null;
  maxNumber: number | null;
  /** Номера глав, которые есть и по-английски, и в готовом переводе (для сверки). */
  pairs: number;
  /** Глав, из которых имена ещё не собраны. */
  unscanned: number;
  hints: number;
  matched: number;
  /** Цена сбора глоссария сейчас, $ (оценка сверху). */
  estimateUsd: number;
  job: GlossaryJob | null;
}
