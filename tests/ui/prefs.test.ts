import { describe, expect, it } from "vitest";
import {
  BOOT_SCRIPT,
  DEFAULT_READER_PREFS,
  FONT_MAX,
  FONT_MIN,
  READER_KEY,
  THEME_KEY,
  clampFontSize,
  loadReaderPrefs,
  loadTheme,
  parseReaderPrefs,
  saveReaderPrefs,
  saveTheme,
  serializeReaderPrefs,
  type StorageLike,
} from "@/lib/client/prefs";

function memory(): StorageLike & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k) => (data.has(k) ? (data.get(k) as string) : null),
    setItem: (k, v) => void data.set(k, v),
  };
}

const broken: StorageLike = {
  getItem: () => {
    throw new Error("SecurityError");
  },
  setItem: () => {
    throw new Error("QuotaExceededError");
  },
};

describe("настройки читалки в браузере", () => {
  it("сохраняет и читает обратно", () => {
    const s = memory();
    const p = { fontSize: 22, lineHeight: 2 as const, font: "sans" as const, keepAwake: true };
    expect(saveReaderPrefs(p, s)).toBe(true);
    expect(loadReaderPrefs(s)).toEqual(p);
    expect(s.data.has(READER_KEY)).toBe(true);
  });

  it("мусор и чужие значения → значения по умолчанию", () => {
    expect(parseReaderPrefs(null)).toEqual(DEFAULT_READER_PREFS);
    expect(parseReaderPrefs("{oops")).toEqual(DEFAULT_READER_PREFS);
    expect(parseReaderPrefs("42")).toEqual(DEFAULT_READER_PREFS);
    expect(parseReaderPrefs(JSON.stringify({ fontSize: 99, lineHeight: 7, font: "comic", keepAwake: "yes" }))).toEqual({
      fontSize: FONT_MAX,
      lineHeight: DEFAULT_READER_PREFS.lineHeight,
      font: "serif",
      keepAwake: false,
    });
  });

  it("кегль от 14 до 26", () => {
    expect(clampFontSize(5)).toBe(FONT_MIN);
    expect(clampFontSize(100)).toBe(FONT_MAX);
    expect(clampFontSize(18.6)).toBe(19);
    expect(clampFontSize(Number.NaN)).toBe(DEFAULT_READER_PREFS.fontSize);
    expect(JSON.parse(serializeReaderPrefs({ ...DEFAULT_READER_PREFS, fontSize: 40 })).fontSize).toBe(FONT_MAX);
  });

  it("недоступное хранилище не ломает страницу", () => {
    expect(loadReaderPrefs(broken)).toEqual(DEFAULT_READER_PREFS);
    expect(saveReaderPrefs(DEFAULT_READER_PREFS, broken)).toBe(false);
    expect(loadTheme(broken)).toBeNull();
    expect(saveTheme("sepia", broken)).toBe(false);
    expect(loadReaderPrefs(null)).toEqual(DEFAULT_READER_PREFS);
  });

  it("тема: только известные значения", () => {
    const s = memory();
    expect(loadTheme(s)).toBeNull();
    saveTheme("sepia", s);
    expect(loadTheme(s)).toBe("sepia");
    s.setItem(THEME_KEY, "neon");
    expect(loadTheme(s)).toBeNull();
  });

  it("скрипт в <head> — валидный JS и знает ключ темы", () => {
    expect(() => new Function(BOOT_SCRIPT)).not.toThrow();
    expect(BOOT_SCRIPT).toContain(THEME_KEY);
  });
});
