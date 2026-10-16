/**
 * Мост к кнопке «Т» (юзерскрипт) на страницах самого приложения.
 *
 * Скрипт при загрузке страницы шлёт window.postMessage({type:"tolmach:bridge-ready"}).
 * Мы просим главу: {type:"tolmach:fetch", requestId, url}; скрипт открывает
 * страницу сайта с куками человека и отвечает
 * {type:"tolmach:fetched", requestId, ok, chapter?, code?}.
 *
 * Сигнал «готов» может прийти раньше, чем загрузится этот код, — его заранее
 * ловит скрипт в <head> (lib/client/prefs.ts BOOT_SCRIPT) и кладёт в
 * window.__tolmachBridge. Дополнительно шлём «tolmach:bridge-ping»: если
 * скрипт умеет на него отвечать повтором «ready», самопроверка не зависит
 * от порядка загрузки.
 */

import type { ExtractedChapter } from "../types";

export interface BridgeMessageEvent {
  data: unknown;
  origin?: string;
}

export interface BridgeHost {
  addEventListener(type: "message", fn: (ev: BridgeMessageEvent) => void): void;
  removeEventListener(type: "message", fn: (ev: BridgeMessageEvent) => void): void;
  postMessage(message: unknown, targetOrigin: string): void;
  location?: { origin: string };
  __tolmachBridge?: { ready: boolean; version?: string | null };
}

export type BridgeFetchResult =
  | { ok: true; chapter: ExtractedChapter }
  | { ok: false; code: string };

export interface Bridge {
  isReady(): boolean;
  version(): string | null;
  /** Подписка на «мост готов»; вернёт отписку. Если уже готов — вызовет сразу (асинхронно). */
  onReady(fn: () => void): () => void;
  /** Попросить скрипт ещё раз сказать «готов». */
  ping(): void;
  /** Взять главу через браузер человека. Таймаут по умолчанию — 60 с. */
  fetchChapter(url: string): Promise<BridgeFetchResult>;
  dispose(): void;
}

export interface BridgeOptions {
  timeoutMs?: number;
  idFactory?: () => string;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
}

let counter = 0;
function defaultId(): string {
  counter += 1;
  return `t${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}-${counter}`;
}

function isChapter(v: unknown): v is ExtractedChapter {
  if (!v || typeof v !== "object") return false;
  const c = v as Record<string, unknown>;
  return Array.isArray(c.paragraphs) && typeof c.chapterTitle === "string";
}

export function createBridge(host: BridgeHost, opts: BridgeOptions = {}): Bridge {
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const makeId = opts.idFactory ?? defaultId;
  const setTimer = opts.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearTimer = opts.clearTimer ?? ((t: unknown) => clearTimeout(t as ReturnType<typeof setTimeout>));
  const origin = host.location?.origin ?? null;
  const target = origin ?? "*";

  let ready = !!(host.__tolmachBridge && host.__tolmachBridge.ready);
  let ver: string | null = (host.__tolmachBridge && host.__tolmachBridge.version) || null;
  const readyListeners = new Set<() => void>();
  const pending = new Map<string, { resolve: (r: BridgeFetchResult) => void; timer: unknown }>();

  const onMessage = (ev: BridgeMessageEvent) => {
    // Сообщения только от своей же страницы (скрипт кнопки живёт на ней).
    if (origin && ev.origin && ev.origin !== origin) return;
    const d = ev.data;
    if (!d || typeof d !== "object") return;
    const msg = d as Record<string, unknown>;
    if (msg.type === "tolmach:bridge-ready") {
      const wasReady = ready;
      ready = true;
      ver = typeof msg.version === "string" ? msg.version : ver;
      host.__tolmachBridge = { ready: true, version: ver };
      if (!wasReady || readyListeners.size > 0) {
        readyListeners.forEach((fn) => fn());
      }
      return;
    }
    if (msg.type === "tolmach:fetched" && typeof msg.requestId === "string") {
      const p = pending.get(msg.requestId);
      if (!p) return;
      pending.delete(msg.requestId);
      clearTimer(p.timer);
      if (msg.ok === true && isChapter(msg.chapter)) {
        p.resolve({ ok: true, chapter: msg.chapter });
      } else {
        p.resolve({ ok: false, code: typeof msg.code === "string" && msg.code ? msg.code : "unknown" });
      }
    }
  };
  host.addEventListener("message", onMessage);

  return {
    isReady: () => ready,
    version: () => ver,
    onReady(fn) {
      readyListeners.add(fn);
      if (ready) Promise.resolve().then(() => readyListeners.has(fn) && fn());
      return () => {
        readyListeners.delete(fn);
      };
    },
    ping() {
      try {
        host.postMessage({ type: "tolmach:bridge-ping" }, target);
      } catch {
        // ничего: без моста просто не будет ответа
      }
    },
    fetchChapter(url: string) {
      if (!ready) return Promise.resolve({ ok: false, code: "no_bridge" } as BridgeFetchResult);
      const requestId = makeId();
      return new Promise<BridgeFetchResult>((resolve) => {
        const timer = setTimer(() => {
          if (!pending.has(requestId)) return;
          pending.delete(requestId);
          resolve({ ok: false, code: "timeout" });
        }, timeoutMs);
        pending.set(requestId, { resolve, timer });
        try {
          host.postMessage({ type: "tolmach:fetch", requestId, url }, target);
        } catch {
          pending.delete(requestId);
          clearTimer(timer);
          resolve({ ok: false, code: "no_bridge" });
        }
      });
    },
    dispose() {
      host.removeEventListener("message", onMessage);
      pending.forEach((p) => {
        clearTimer(p.timer);
        p.resolve({ ok: false, code: "disposed" });
      });
      pending.clear();
      readyListeners.clear();
    },
  };
}

let shared: Bridge | null = null;

/** Общий мост страницы (в браузере); на сервере — null. */
export function getBridge(): Bridge | null {
  if (typeof window === "undefined") return null;
  if (!shared) shared = createBridge(window as unknown as BridgeHost);
  return shared;
}
