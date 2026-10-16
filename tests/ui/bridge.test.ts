import { describe, expect, it } from "vitest";
import { createBridge, type BridgeHost, type BridgeMessageEvent } from "@/lib/client/bridge";
import type { ExtractedChapter } from "@/lib/types";

const ORIGIN = "https://tolmach.example";

/** Окно-подделка: postMessage доставляет сообщение всем слушателям асинхронно, как браузер. */
function fakeWindow() {
  const listeners = new Set<(ev: BridgeMessageEvent) => void>();
  const sent: unknown[] = [];
  const host: BridgeHost = {
    location: { origin: ORIGIN },
    addEventListener: (_t, fn) => listeners.add(fn),
    removeEventListener: (_t, fn) => listeners.delete(fn),
    postMessage: (message) => {
      sent.push(message);
      queueMicrotask(() => listeners.forEach((fn) => fn({ data: message, origin: ORIGIN })));
    },
  };
  const deliver = (data: unknown, origin = ORIGIN) => listeners.forEach((fn) => fn({ data, origin }));
  return { host, sent, deliver, listeners };
}

const chapter: ExtractedChapter = {
  url: "https://site.example/ch-2",
  bookTitle: "Book",
  chapterTitle: "Chapter 2",
  paragraphs: ["One.", "Two."],
  nextUrl: null,
  prevUrl: null,
  coverUrl: null,
  words: 2,
  looksLocked: false,
  looksLikeIndex: false,
};

describe("мост к кнопке «Т»", () => {
  it("без сигнала «готов» не шлёт запрос", async () => {
    const w = fakeWindow();
    const b = createBridge(w.host);
    expect(b.isReady()).toBe(false);
    await expect(b.fetchChapter("https://site.example/ch-2")).resolves.toEqual({ ok: false, code: "no_bridge" });
    expect(w.sent).toEqual([]);
  });

  it("сигнал «готов» включает мост и будит подписчиков", async () => {
    const w = fakeWindow();
    const b = createBridge(w.host);
    let calls = 0;
    b.onReady(() => (calls += 1));
    w.deliver({ type: "tolmach:bridge-ready", version: "1.2" });
    expect(b.isReady()).toBe(true);
    expect(b.version()).toBe("1.2");
    expect(calls).toBe(1);
  });

  it("сигнал, пойманный заранее скриптом в <head>, тоже считается", async () => {
    const w = fakeWindow();
    w.host.__tolmachBridge = { ready: true, version: "0.9" };
    const b = createBridge(w.host);
    expect(b.isReady()).toBe(true);
    let called = false;
    b.onReady(() => (called = true));
    await Promise.resolve();
    expect(called).toBe(true);
  });

  it("сопоставляет ответ по requestId и не путает чужие ответы", async () => {
    const w = fakeWindow();
    let n = 0;
    const b = createBridge(w.host, { idFactory: () => `r${(n += 1)}` });
    w.deliver({ type: "tolmach:bridge-ready" });

    const p1 = b.fetchChapter("https://site.example/ch-2");
    const p2 = b.fetchChapter("https://site.example/ch-3");
    expect(w.sent).toEqual([
      { type: "tolmach:fetch", requestId: "r1", url: "https://site.example/ch-2" },
      { type: "tolmach:fetch", requestId: "r2", url: "https://site.example/ch-3" },
    ]);
    // Чужой и неизвестный ответы игнорируются.
    w.deliver({ type: "tolmach:fetched", requestId: "zzz", ok: true, chapter });
    w.deliver({ type: "tolmach:fetched", requestId: "r2", ok: true, chapter }, "https://evil.example");
    // Ответы в обратном порядке.
    w.deliver({ type: "tolmach:fetched", requestId: "r2", ok: false, code: "site_blocked" });
    w.deliver({ type: "tolmach:fetched", requestId: "r1", ok: true, chapter });
    await expect(p1).resolves.toEqual({ ok: true, chapter });
    await expect(p2).resolves.toEqual({ ok: false, code: "site_blocked" });
  });

  it("ok без главы — это ошибка, а не пустая глава", async () => {
    const w = fakeWindow();
    const b = createBridge(w.host, { idFactory: () => "x" });
    w.deliver({ type: "tolmach:bridge-ready" });
    const p = b.fetchChapter("https://site.example/a");
    w.deliver({ type: "tolmach:fetched", requestId: "x", ok: true });
    await expect(p).resolves.toEqual({ ok: false, code: "unknown" });
  });

  it("ждёт не дольше таймаута", async () => {
    const w = fakeWindow();
    const timers: Array<() => void> = [];
    const b = createBridge(w.host, {
      idFactory: () => "t1",
      setTimer: (fn) => {
        timers.push(fn);
        return timers.length;
      },
      clearTimer: () => undefined,
    });
    w.deliver({ type: "tolmach:bridge-ready" });
    const p = b.fetchChapter("https://site.example/slow");
    expect(timers.length).toBe(1);
    timers[0]();
    await expect(p).resolves.toEqual({ ok: false, code: "timeout" });
    // Поздний ответ после таймаута ничего не ломает.
    w.deliver({ type: "tolmach:fetched", requestId: "t1", ok: true, chapter });
  });

  it("по умолчанию таймаут — 60 секунд", () => {
    const w = fakeWindow();
    let ms = 0;
    const b = createBridge(w.host, { setTimer: (_fn, t) => ((ms = t), 1), clearTimer: () => undefined });
    w.deliver({ type: "tolmach:bridge-ready" });
    void b.fetchChapter("https://site.example/x");
    expect(ms).toBe(60_000);
  });

  it("dispose отписывается и завершает ожидающие запросы", async () => {
    const w = fakeWindow();
    const b = createBridge(w.host);
    w.deliver({ type: "tolmach:bridge-ready" });
    const p = b.fetchChapter("https://site.example/x");
    b.dispose();
    await expect(p).resolves.toEqual({ ok: false, code: "disposed" });
    expect(w.listeners.size).toBe(0);
  });

  it("ping шлёт просьбу повторить «готов»", () => {
    const w = fakeWindow();
    const b = createBridge(w.host);
    b.ping();
    expect(w.sent).toEqual([{ type: "tolmach:bridge-ping" }]);
  });
});
