import { describe, expect, it } from "vitest";
import { userscriptVersion } from "@/lib/server/userscript-version";

/** Сравнение версий как у менеджеров скриптов: по числам через точку. */
function newer(a: string, b: string): boolean {
  const x = a.split(".").map(Number);
  const y = b.split(".").map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const p = x[i] ?? 0;
    const q = y[i] ?? 0;
    if (p !== q) return p > q;
  }
  return false;
}

describe("версия кнопки для сайтов", () => {
  it("больше любой прежней версии из хеша", () => {
    const v = userscriptVersion(Date.UTC(2026, 9, 22, 10, 30, 5));
    expect(v).toBe("2.20261022.103005");
    expect(newer(v, "1.0.268435455")).toBe(true);
    expect(newer(v, "1.0.105024195")).toBe(true);
  });
  it("каждая следующая сборка — новее прошлой, в том числе через полночь и в начале часа", () => {
    const times = [
      Date.UTC(2026, 9, 22, 9, 59, 59),
      Date.UTC(2026, 9, 22, 10, 0, 1),
      Date.UTC(2026, 9, 22, 23, 59, 59),
      Date.UTC(2026, 9, 23, 0, 0, 0),
      Date.UTC(2026, 11, 31, 23, 59, 59),
      Date.UTC(2027, 0, 1, 0, 0, 1),
    ];
    for (let i = 1; i < times.length; i++) {
      expect(newer(userscriptVersion(times[i]), userscriptVersion(times[i - 1]))).toBe(true);
    }
  });
});
