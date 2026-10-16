/**
 * Настройки, которые живут только в этом браузере: тема и вид читалки.
 *
 * Хранилище браузера может быть недоступно (приватное окно, запрет данных
 * сайта) — тогда всё работает со значениями по умолчанию, просто не
 * запоминается. Поэтому каждое обращение — в try/catch.
 */

export type ThemeName = "night" | "sepia" | "day";
export const THEMES: readonly ThemeName[] = ["night", "sepia", "day"];
export const THEME_LABELS: Record<ThemeName, string> = {
  night: "Ночная",
  sepia: "Сепия",
  day: "Дневная",
};
/** Цвет страницы каждой темы — для образцов в переключателе и theme-color. */
export const THEME_BG: Record<ThemeName, string> = {
  night: "#14120f",
  sepia: "#f0e4cf",
  day: "#f8f6f1",
};

export const THEME_KEY = "tolmach-theme";
export const READER_KEY = "tolmach-reader";

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export type LineHeightStep = 0 | 1 | 2;
export const LINE_HEIGHTS: readonly number[] = [1.55, 1.75, 1.95];
export const LINE_HEIGHT_LABELS: readonly string[] = ["Плотно", "Обычно", "Свободно"];

export const FONT_MIN = 14;
export const FONT_MAX = 26;

export interface ReaderPrefs {
  /** Кегль текста главы, px. */
  fontSize: number;
  lineHeight: LineHeightStep;
  /** serif — Literata, sans — Golos Text. */
  font: "serif" | "sans";
  /** «Не гасить экран». */
  keepAwake: boolean;
}

export const DEFAULT_READER_PREFS: ReaderPrefs = {
  fontSize: 19,
  lineHeight: 1,
  font: "serif",
  keepAwake: false,
};

export function isTheme(v: unknown): v is ThemeName {
  return v === "night" || v === "sepia" || v === "day";
}

export function clampFontSize(n: unknown): number {
  const v = typeof n === "number" && Number.isFinite(n) ? Math.round(n) : DEFAULT_READER_PREFS.fontSize;
  return Math.min(FONT_MAX, Math.max(FONT_MIN, v));
}

/** Разобрать сохранённое; всё непонятное заменяется значением по умолчанию. */
export function parseReaderPrefs(raw: string | null | undefined): ReaderPrefs {
  if (!raw) return { ...DEFAULT_READER_PREFS };
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return { ...DEFAULT_READER_PREFS };
  }
  if (!data || typeof data !== "object") return { ...DEFAULT_READER_PREFS };
  const d = data as Record<string, unknown>;
  const lh = d.lineHeight;
  return {
    fontSize: d.fontSize === undefined ? DEFAULT_READER_PREFS.fontSize : clampFontSize(d.fontSize),
    lineHeight: lh === 0 || lh === 1 || lh === 2 ? lh : DEFAULT_READER_PREFS.lineHeight,
    font: d.font === "sans" ? "sans" : "serif",
    keepAwake: d.keepAwake === true,
  };
}

export function serializeReaderPrefs(p: ReaderPrefs): string {
  return JSON.stringify({
    fontSize: clampFontSize(p.fontSize),
    lineHeight: p.lineHeight,
    font: p.font,
    keepAwake: p.keepAwake,
  });
}

function defaultStorage(): StorageLike | null {
  try {
    return typeof window !== "undefined" ? window.localStorage : null;
  } catch {
    return null;
  }
}

export function loadReaderPrefs(storage: StorageLike | null = defaultStorage()): ReaderPrefs {
  if (!storage) return { ...DEFAULT_READER_PREFS };
  try {
    return parseReaderPrefs(storage.getItem(READER_KEY));
  } catch {
    return { ...DEFAULT_READER_PREFS };
  }
}

export function saveReaderPrefs(p: ReaderPrefs, storage: StorageLike | null = defaultStorage()): boolean {
  if (!storage) return false;
  try {
    storage.setItem(READER_KEY, serializeReaderPrefs(p));
    return true;
  } catch {
    return false;
  }
}

export function loadTheme(storage: StorageLike | null = defaultStorage()): ThemeName | null {
  if (!storage) return null;
  try {
    const v = storage.getItem(THEME_KEY);
    return isTheme(v) ? v : null;
  } catch {
    return null;
  }
}

export function saveTheme(theme: ThemeName, storage: StorageLike | null = defaultStorage()): boolean {
  if (!storage) return false;
  try {
    storage.setItem(THEME_KEY, theme);
    return true;
  } catch {
    return false;
  }
}

/** Тема, которая стоит на странице сейчас (её ставит скрипт в <head>). */
export function currentTheme(): ThemeName {
  if (typeof document === "undefined") return "night";
  const v = document.documentElement.getAttribute("data-theme");
  return isTheme(v) ? v : "night";
}

/** Сменить тему на всех экранах сразу и запомнить. */
export function applyTheme(theme: ThemeName): void {
  if (typeof document === "undefined") return;
  document.documentElement.setAttribute("data-theme", theme);
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", THEME_BG[theme]);
  saveTheme(theme);
  try {
    window.dispatchEvent(new CustomEvent("tolmach:theme", { detail: theme }));
  } catch {
    // старые браузеры без CustomEvent-конструктора — не страшно
  }
}

/**
 * Скрипт в <head>: ставит тему до первой отрисовки (без вспышки) и заранее
 * ловит сигнал кнопки «Т» «мост готов» — он может прийти раньше, чем
 * загрузится код страницы.
 */
export const BOOT_SCRIPT = `(function(){var d=document.documentElement;try{var t=localStorage.getItem(${JSON.stringify(
  THEME_KEY,
)});if(t!=="night"&&t!=="sepia"&&t!=="day"){t=window.matchMedia&&window.matchMedia("(prefers-color-scheme: light)").matches?"day":"night"}d.setAttribute("data-theme",t);var m=document.querySelector('meta[name="theme-color"]');var c={night:"#14120f",sepia:"#f0e4cf",day:"#f8f6f1"};if(m)m.setAttribute("content",c[t])}catch(e){}try{window.addEventListener("message",function(e){var x=e&&e.data;if(x&&x.type==="tolmach:bridge-ready"){window.__tolmachBridge={ready:true,version:x.version||null}}})}catch(e){}})();`;
