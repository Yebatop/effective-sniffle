import { describe, expect, it } from "vitest";
import {
  ApiError,
  NETWORK_MESSAGE,
  createApi,
  errorFromResponse,
  errorText,
  loginHref,
  messageForStatus,
  safeNext,
} from "@/lib/client/api";

type Call = { url: string; init?: RequestInit };

function fakeFetch(status: number, body: unknown) {
  const calls: Call[] = [];
  const fetch = async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const text = body === undefined ? "" : typeof body === "string" ? body : JSON.stringify(body);
    return new Response(text, { status, headers: { "content-type": "application/json" } });
  };
  return { fetch, calls };
}

describe("ошибки API → русский текст", () => {
  it("берёт текст сервера, если он есть", () => {
    const e = errorFromResponse(500, { message: "База не отвечает", code: "db" });
    expect(e).toBeInstanceOf(ApiError);
    expect(e.message).toBe("База не отвечает");
    expect(e.code).toBe("db");
    expect(e.status).toBe(500);
    expect(errorFromResponse(400, { error: "Плохое тело" }).message).toBe("Плохое тело");
    expect(errorFromResponse(400, { error: { message: "Вложенная", code: "x" } }).message).toBe("Вложенная");
  });

  it("без текста — понятная фраза по коду", () => {
    expect(errorFromResponse(404, null).message).toBe(messageForStatus(404));
    expect(errorFromResponse(502, "<html>Bad gateway</html>").message).toBe(messageForStatus(502));
    expect(messageForStatus(429)).toMatch(/Слишком часто/);
    expect(messageForStatus(418)).toMatch(/418/);
  });

  it("errorText понимает что угодно", () => {
    expect(errorText(new ApiError("Ой", 500))).toBe("Ой");
    expect(errorText(new Error("not implemented: lib/db"))).toMatch(/ещё не готова/);
    expect(errorText("строка")).toBe("Что-то пошло не так.");
  });
});

describe("клиент API", () => {
  it("GET возвращает JSON", async () => {
    const f = fakeFetch(200, [{ book: { id: "b1" } }]);
    const api = createApi({ fetch: f.fetch, onUnauthorized: () => undefined, currentPath: () => "/" });
    const list = await api.books();
    expect(list).toEqual([{ book: { id: "b1" } }]);
    expect(f.calls[0].url).toBe("/api/books");
    expect(f.calls[0].init?.method).toBe("GET");
  });

  it("PATCH шлёт JSON-тело", async () => {
    const f = fakeFetch(200, { ok: true });
    const api = createApi({ fetch: f.fetch, onUnauthorized: () => undefined, currentPath: () => "/" });
    await api.patchTerm("t/1", { ru: "Гу" });
    expect(f.calls[0].url).toBe("/api/terms/t%2F1");
    expect(f.calls[0].init?.method).toBe("PATCH");
    expect(JSON.parse(String(f.calls[0].init?.body))).toEqual({ ru: "Гу" });
  });

  it("401 → уводит на вход с адресом возврата", async () => {
    const f = fakeFetch(401, { error: "unauthorized" });
    const went: string[] = [];
    const api = createApi({ fetch: f.fetch, onUnauthorized: (p) => went.push(loginHref(p)), currentPath: () => "/read/abc?x=1" });
    await expect(api.chapter("abc")).rejects.toMatchObject({ status: 401 });
    expect(went).toEqual(["/login?next=%2Fread%2Fabc%3Fx%3D1"]);
  });

  it("вход и проверка версии не уводят на вход при 401", async () => {
    const f = fakeFetch(401, { ok: false, code: "wrong_password", message: "Неверный пароль" });
    let went = 0;
    const api = createApi({ fetch: f.fetch, onUnauthorized: () => (went += 1), currentPath: () => "/login" });
    await expect(api.login("x")).resolves.toEqual({ ok: false, code: "wrong_password", message: "Неверный пароль" });
    await expect(api.version()).rejects.toBeInstanceOf(ApiError);
    expect(went).toBe(0);
  });

  it("{ok:false, code} у /api/fetch — обычный ответ при любом HTTP-коде", async () => {
    const f = fakeFetch(422, { ok: false, code: "site_blocked", message: "Сайт не пускает" });
    const api = createApi({ fetch: f.fetch, onUnauthorized: () => undefined, currentPath: () => "/" });
    await expect(api.fetchUrl("https://x.example/1")).resolves.toEqual({
      ok: false,
      code: "site_blocked",
      message: "Сайт не пускает",
    });
  });

  it("для обычных адресов {ok:false} с ошибкой HTTP — исключение", async () => {
    const f = fakeFetch(409, { ok: false, code: "busy", message: "Уже идёт" });
    const api = createApi({ fetch: f.fetch, onUnauthorized: () => undefined, currentPath: () => "/" });
    await expect(api.settings()).rejects.toMatchObject({ message: "Уже идёт", status: 409, code: "busy" });
  });

  it("нет сети → понятная ошибка", async () => {
    const api = createApi({
      fetch: async () => {
        throw new TypeError("Failed to fetch");
      },
      onUnauthorized: () => undefined,
      currentPath: () => "/",
    });
    await expect(api.status()).rejects.toMatchObject({ message: NETWORK_MESSAGE, code: "network" });
  });

  it("опрос задачи передаёт since целым неотрицательным числом", async () => {
    const f = fakeFetch(200, { job: {}, paragraphs: [], seq: 0, costUsd: 0 });
    const api = createApi({ fetch: f.fetch, onUnauthorized: () => undefined, currentPath: () => "/" });
    await api.job("j1", 7.9);
    await api.job("j1", -3);
    expect(f.calls.map((c) => c.url)).toEqual(["/api/jobs/j1?since=7", "/api/jobs/j1?since=0"]);
  });
});

describe("куда вернуться после входа", () => {
  it("только свои пути", () => {
    expect(safeNext("/book/1")).toBe("/book/1");
    expect(safeNext("//evil.example")).toBe("/");
    // Браузер выбрасывает табуляции и переводы строк: «/\t/evil» стал бы «//evil».
    expect(safeNext("/\t/evil.example")).toBe("/");
    expect(safeNext("/\n/evil.example")).toBe("/");
    expect(safeNext("/\\evil.example")).toBe("/");
    expect(safeNext("/read/abc?x=1#p5")).toBe("/read/abc?x=1#p5");
    expect(safeNext("https://evil.example")).toBe("/");
    expect(safeNext("/\\evil")).toBe("/");
    expect(safeNext("/login?next=/x")).toBe("/");
    expect(safeNext(null)).toBe("/");
    expect(loginHref("/")).toBe("/login");
  });
});
