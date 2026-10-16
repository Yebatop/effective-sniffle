/**
 * Обёртки над API приложения для экранов (docs/CONTRACTS.md).
 *
 * - Ошибка в ответе → брошенный ApiError с русским текстом (берём текст
 *   сервера, если он есть, иначе понятную фразу по коду ответа).
 * - 401 → переход на /login?next=<текущий адрес> (кроме самого входа и
 *   тихих проверок вроде /api/version).
 * - Ответы вида {ok:false, code, message} у /api/fetch, /api/login и
 *   /api/chapters/:id/translate — это не исключение, а обычный ответ: их
 *   возвращаем как есть, какой бы ни был код HTTP.
 */

import type {
  Address,
  Book,
  BookListItem,
  BudgetState,
  Chapter,
  ChapterView,
  ExtractedChapter,
  FetchResponse,
  ImportRequest,
  ImportResponse,
  JobPoll,
  PositionRequest,
  ReportRequest,
  ReportResponse,
  Settings,
  StatusView,
  Term,
  TranslateRequest,
  TranslateResponse,
} from "../types";

// ── Формы ответов, описанные в CONTRACTS.md, но без имени в lib/types.ts ──

export interface LoginResponse {
  ok: boolean;
  code?: string;
  message?: string;
}

export interface BookDetail {
  book: Book;
  chapters: Array<Chapter & { translated: boolean }>;
  spentUsd: number;
}

export type BookPatch = Partial<Pick<Book, "title" | "register" | "narratorPerson" | "narratorGender" | "honorifics">>;

export interface GlossaryView {
  terms: Term[];
  addresses: Address[];
}

export type TermPatch = Partial<Pick<Term, "ru" | "kind" | "gender" | "aliases" | "note" | "status">>;

export interface SpendByBook {
  bookId: string | null;
  title: string | null;
  usd: number;
  calls?: number;
}

export interface SpendCall {
  createdAt: string;
  chapterId?: string | null;
  chapterTitle?: string | null;
  bookId?: string | null;
  model: string;
  usd: number;
  purpose?: string;
  batch?: boolean;
}

export interface SpendView {
  budget: BudgetState;
  byBook: SpendByBook[];
  recent: SpendCall[];
}

export interface VersionView {
  version: string;
  commit: string | null;
}

export interface UnblockResponse {
  unblocked: number | boolean;
}

// ── Ошибки ──────────────────────────────────────────────────────────────

export class ApiError extends Error {
  readonly status: number;
  readonly code: string | null;
  constructor(message: string, status: number, code: string | null = null) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

export const NETWORK_MESSAGE = "Нет связи с сервером. Проверьте интернет и попробуйте ещё раз.";
export const UNAUTHORIZED_MESSAGE = "Нужно снова войти.";

/** Понятная фраза по коду ответа, если сервер не прислал свою. */
export function messageForStatus(status: number): string {
  if (status === 400) return "Сервер не понял запрос. Обновите страницу и попробуйте ещё раз.";
  if (status === 401) return UNAUTHORIZED_MESSAGE;
  if (status === 403) return "Нет доступа.";
  if (status === 404) return "Не нашлось — возможно, это уже удалено.";
  if (status === 409) return "Это уже делается — подождите немного.";
  if (status === 413) return "Слишком большой текст. Попробуйте по одной главе.";
  if (status === 429) return "Слишком часто. Подождите минуту и попробуйте ещё раз.";
  if (status === 502 || status === 503 || status === 504) return "Сервер не отвечает. Попробуйте через минуту.";
  if (status >= 500) return "На сервере что-то сломалось. Попробуйте ещё раз; если повторится — нажмите «Что-то не так».";
  return `Не получилось (код ${status}).`;
}

function pickString(o: Record<string, unknown>, key: string): string | null {
  const v = o[key];
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

/** Ответ с ошибкой → ApiError. Текст сервера важнее общей фразы. */
export function errorFromResponse(status: number, body: unknown): ApiError {
  let message: string | null = null;
  let code: string | null = null;
  if (body && typeof body === "object") {
    const o = body as Record<string, unknown>;
    message = pickString(o, "message") ?? pickString(o, "error");
    code = pickString(o, "code");
    if (!message && o.error && typeof o.error === "object") {
      const e = o.error as Record<string, unknown>;
      message = pickString(e, "message");
      code = code ?? pickString(e, "code");
    }
  } else if (typeof body === "string" && body.trim() && body.length < 300 && !/^\s*</.test(body)) {
    message = body.trim();
  }
  return new ApiError(message ?? messageForStatus(status), status, code);
}

/** Ответ вида {ok:false, code, ...} — обычный ответ, а не исключение. */
export function isOkFalse(body: unknown): body is { ok: false; code: string; message?: string } {
  return !!body && typeof body === "object" && (body as Record<string, unknown>).ok === false &&
    typeof (body as Record<string, unknown>).code === "string";
}

/** Куда вернуться после входа: только свой путь, без «//чужой-сайт». */
/**
 * Куда вернуться после входа — только внутрь приложения. Проверяем, куда
 * адрес укажет на самом деле: браузер выбрасывает табуляции и переводы
 * строк, и «/\t/evil.example» превратился бы в «//evil.example».
 */
export function safeNext(next: string | null | undefined): string {
  if (!next || typeof next !== "string") return "/";
  if (/[\u0000-\u001f\\]/.test(next) || !next.startsWith("/") || next.startsWith("//")) return "/";
  try {
    const base = "https://tolmach.invalid";
    const u = new URL(next, base);
    if (u.origin !== base || u.pathname.startsWith("/login")) return "/";
    return u.pathname + u.search + u.hash;
  } catch {
    return "/";
  }
}

export function loginHref(currentPath: string): string {
  const next = safeNext(currentPath);
  return next === "/" ? "/login" : `/login?next=${encodeURIComponent(next)}`;
}

// ── Клиент ──────────────────────────────────────────────────────────────

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface ApiDeps {
  fetch: FetchLike;
  /** Что делать на 401: по умолчанию — уйти на страницу входа. */
  onUnauthorized: (currentPath: string) => void;
  currentPath: () => string;
}

interface RequestOpts {
  /** Вернуть {ok:false, code} как обычный ответ. */
  allowOkFalse?: boolean;
  /** Не уводить на вход при 401 (вход сам, тихие проверки). */
  silent401?: boolean;
  signal?: AbortSignal;
}

let redirecting = false;

function defaultDeps(): ApiDeps {
  return {
    fetch: (input, init) => fetch(input, init),
    currentPath: () =>
      typeof window === "undefined" ? "/" : window.location.pathname + window.location.search,
    onUnauthorized: (path) => {
      if (typeof window === "undefined" || redirecting) return;
      if (window.location.pathname.startsWith("/login")) return;
      redirecting = true;
      window.location.href = loginHref(path);
    },
  };
}

export function createApi(partial: Partial<ApiDeps> = {}) {
  const deps: ApiDeps = { ...defaultDeps(), ...partial };

  async function request<T>(method: string, path: string, body?: unknown, opts: RequestOpts = {}): Promise<T> {
    const init: RequestInit = {
      method,
      headers: body === undefined ? { accept: "application/json" } : { "content-type": "application/json", accept: "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: "no-store",
      credentials: "same-origin",
      signal: opts.signal,
    };
    let res: Response;
    try {
      res = await deps.fetch(path, init);
    } catch (e) {
      if (e && typeof e === "object" && (e as { name?: string }).name === "AbortError") throw e;
      throw new ApiError(NETWORK_MESSAGE, 0, "network");
    }
    let text = "";
    try {
      text = await res.text();
    } catch {
      text = "";
    }
    let data: unknown = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }
    }
    if (res.status === 401 && !opts.silent401) {
      deps.onUnauthorized(deps.currentPath());
      throw new ApiError(UNAUTHORIZED_MESSAGE, 401, "unauthorized");
    }
    if (opts.allowOkFalse && isOkFalse(data)) return data as T;
    if (!res.ok) throw errorFromResponse(res.status, data);
    return data as T;
  }

  const id = (s: string) => encodeURIComponent(s);

  return {
    request,
    login: (password: string) =>
      request<LoginResponse>("POST", "/api/login", { password }, { allowOkFalse: true, silent401: true }),
    logout: () => request<{ ok: boolean }>("POST", "/api/logout", {}),

    books: () => request<BookListItem[]>("GET", "/api/books"),
    book: (bookId: string) => request<BookDetail>("GET", `/api/books/${id(bookId)}`),
    patchBook: (bookId: string, patch: BookPatch) => request<Book>("PATCH", `/api/books/${id(bookId)}`, patch),
    glossary: (bookId: string) => request<GlossaryView>("GET", `/api/books/${id(bookId)}/glossary`),
    patchTerm: (termId: string, patch: TermPatch) => request<Term>("PATCH", `/api/terms/${id(termId)}`, patch),
    deleteTerm: (termId: string) => request<{ ok: boolean }>("DELETE", `/api/terms/${id(termId)}`),
    patchAddress: (addressId: string, form: "ty" | "vy") =>
      request<{ ok: boolean }>("PATCH", `/api/addresses/${id(addressId)}`, { form }),

    importChapters: (req: ImportRequest) => request<ImportResponse>("POST", "/api/import", req),
    fetchUrl: (url: string) => request<FetchResponse>("POST", "/api/fetch", { url }, { allowOkFalse: true }),

    chapter: (chapterId: string) => request<ChapterView>("GET", `/api/chapters/${id(chapterId)}`),
    deleteChapter: (chapterId: string) => request<{ ok: boolean }>("DELETE", `/api/chapters/${id(chapterId)}`),
    translate: (chapterId: string, req: TranslateRequest = {}) =>
      request<TranslateResponse>("POST", `/api/chapters/${id(chapterId)}/translate`, req, { allowOkFalse: true }),
    job: (jobId: string, since: number, signal?: AbortSignal) =>
      request<JobPoll>("GET", `/api/jobs/${id(jobId)}?since=${Math.max(0, Math.floor(since))}`, undefined, { signal }),

    position: (req: PositionRequest) => request<{ ok: boolean }>("POST", "/api/position", req),
    report: (req: ReportRequest) => request<ReportResponse>("POST", "/api/report", req),

    settings: () => request<Settings>("GET", "/api/settings"),
    patchSettings: (patch: Partial<Settings>) => request<Settings>("PATCH", "/api/settings", patch),
    unblockBudget: () => request<UnblockResponse>("POST", "/api/budget/unblock", {}),
    spend: () => request<SpendView>("GET", "/api/spend"),
    status: () => request<StatusView>("GET", "/api/status"),
    version: () => request<VersionView>("GET", "/api/version", undefined, { silent401: true }),
    buttonToken: () => request<{ installUrl: string }>("POST", "/api/button-token", {}),
    buttonTokenStatus: () => request<{ exists: boolean }>("GET", "/api/button-token"),
  };
}

export type Api = ReturnType<typeof createApi>;

export const api: Api = createApi();

// ── Настройки: одна загрузка на открытую вкладку ───────────────────────

let settingsPromise: Promise<Settings> | null = null;

/** Настройки с памятью на время жизни вкладки (сбрасываются при сохранении). */
export function getSettingsCached(): Promise<Settings> {
  if (!settingsPromise) {
    settingsPromise = api.settings().catch((e) => {
      settingsPromise = null;
      throw e;
    });
  }
  return settingsPromise;
}

export async function saveSettings(patch: Partial<Settings>): Promise<Settings> {
  const s = await api.patchSettings(patch);
  settingsPromise = Promise.resolve(s);
  return s;
}

/** Текст ошибки для экрана из чего угодно брошенного. */
export function errorText(e: unknown): string {
  if (e instanceof ApiError) return e.message;
  if (e instanceof Error && e.message) {
    if (/not implemented/i.test(e.message)) return "Эта часть приложения ещё не готова.";
    return e.message;
  }
  return "Что-то пошло не так.";
}

/** Импорт одной снятой главы — общий шаг для «Добавить», «Поделиться» и «Дальше». */
export function importOne(
  chapter: ExtractedChapter,
  source: ImportRequest["chapters"][number]["source"],
  bookId?: string,
) {
  const item: ImportRequest["chapters"][number] = { ...chapter, source };
  if (bookId) item.bookId = bookId;
  return api.importChapters({ chapters: [item] }).then((r) => {
    const first = r.items && r.items[0];
    if (!first) throw new ApiError("Сервер не сохранил главу. Попробуйте ещё раз.", 500, "unknown");
    return first;
  });
}
