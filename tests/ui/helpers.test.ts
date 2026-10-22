import { describe, expect, it } from "vitest";
import { budgetShares, monthName } from "@/lib/client/budget";
import { chapterLabel, estimateRub, fallbackRub, modelLabel, plural, truncate } from "@/lib/client/format";
import { formatAliases, groupTerms, parseAliases } from "@/lib/client/glossary";
import { latestRead, sortBooks } from "@/lib/client/library";
import { NO_PASSWORD_TEXT, loginProblemText } from "@/lib/client/login";
import { describeJobProblem } from "@/lib/client/problems";
import type { BookListItem, Term } from "@/lib/types";

function item(id: string, lastAt: string | null, updatedAt = "2026-10-01T00:00:00Z"): BookListItem {
  return {
    book: {
      id,
      bookKey: null,
      title: `Книга ${id}`,
      sourceLang: "en",
      site: null,
      register: "live",
      narratorPerson: null,
      narratorGender: null,
      honorifics: null,
      glossaryVersion: 1,
      coverUrl: null,
      createdAt: updatedAt,
      updatedAt,
    },
    chapters: 3,
    translated: 1,
    lastRead: lastAt ? { chapterId: `c-${id}`, chapterTitle: "Глава", number: 2, at: lastAt } : null,
    nextReady: false,
    spentUsd: 0,
  };
}

describe("библиотека", () => {
  it("«Продолжить» — самая свежая глава", () => {
    const list = [item("a", "2026-10-10T10:00:00Z"), item("b", "2026-10-12T10:00:00Z"), item("c", null)];
    expect(latestRead(list)?.chapterId).toBe("c-b");
    expect(latestRead([item("c", null)])).toBeNull();
  });

  it("сначала читанные недавно", () => {
    const list = [
      item("old", null, "2026-09-01T00:00:00Z"),
      item("read", "2026-10-12T10:00:00Z"),
      item("new", null, "2026-10-15T00:00:00Z"),
    ];
    expect(sortBooks(list).map((b) => b.book.id)).toEqual(["read", "new", "old"]);
  });
});

describe("подписи", () => {
  it("склонение", () => {
    expect([1, 2, 5, 11, 21, 22, 25, 112].map((n) => plural(n, "глава", "главы", "глав"))).toEqual([
      "глава", "главы", "глав", "глав", "глава", "главы", "глав", "глав",
    ]);
  });

  it("глава с номером и без", () => {
    expect(chapterLabel(12, "Возвращение")).toBe("Глава 12 · Возвращение");
    expect(chapterLabel(12, "Chapter 12: Return")).toBe("Chapter 12: Return");
    expect(chapterLabel(null, "")).toBe("Глава без названия");
    expect(chapterLabel(3, "")).toBe("Глава 3");
  });

  it("цена: без модели — нет цены, а не выдумка", () => {
    expect(estimateRub(null, 1740, 92)).toBeNull();
    expect(estimateRub("claude-sonnet-5-5", 0, 92)).toBeNull();
    const p = estimateRub("claude-sonnet-5-5", 1740, 92);
    expect(p).toMatch(/^≈ .+ ₽$/);
    expect(fallbackRub(0.05, 92)).toBe("≈ 4,6 ₽");
  });

  it("имя модели, в том числе с датой в конце", () => {
    expect(modelLabel("claude-opus-5-5")).toBe("Opus 5.5");
    expect(modelLabel("claude-haiku-5-5-20261001")).toBe("Haiku 5.5");
    expect(modelLabel("something-else")).toBe("something-else");
  });

  it("обрезка по слову", () => {
    expect(truncate("короткий", 50)).toBe("короткий");
    expect(truncate("один два три четыре пять", 14)).toBe("один два три…");
  });
});

describe("глоссарий", () => {
  it("другие имена через запятую", () => {
    expect(parseAliases(" Gu,  Master   Gu ,, gu; Old Gu\n")).toEqual(["Gu", "Master Gu", "Old Gu"]);
    expect(formatAliases(["Gu", "Master Gu"])).toBe("Gu, Master Gu");
    expect(formatAliases(null)).toBe("");
  });

  it("разделы в постоянном порядке", () => {
    const term = (id: string, kind: Term["kind"], en: string): Term => ({
      id, bookId: "b", en, ru: en, kind, gender: null, aliases: [], note: null, status: "proposed", firstChapterId: null, source: "auto",
    });
    const g = groupTerms([term("1", "place", "Zed"), term("2", "name", "bob"), term("3", "name", "Alice"), term("4", "item", "Sword")]);
    expect(g.map((x) => x.label)).toEqual(["Имена", "Места", "Предметы"]);
    expect(g[0].terms.map((t) => t.en)).toEqual(["Alice", "bob"]);
  });
});

describe("бюджет", () => {
  it("доли потраченного и занятого", () => {
    expect(budgetShares({ limitUsd: 10, spentUsd: 2.5, reservedUsd: 1 })).toEqual({ spent: 0.25, reserved: 0.1, over: false });
    const full = budgetShares({ limitUsd: 10, spentUsd: 9, reservedUsd: 5 });
    expect(full.spent).toBeCloseTo(0.9);
    expect(full.reserved).toBeCloseTo(0.1);
    expect(full.over).toBe(true);
    expect(budgetShares({ limitUsd: 0, spentUsd: 0, reservedUsd: 0 }).over).toBe(false);
    expect(monthName("2026-10")).toBe("октябрь 2026");
  });
});

describe("человеческие слова об ошибках", () => {
  it("лимит, баланс, ключ, временные сбои", () => {
    expect(describeJobProblem({ state: "blocked_budget", errorCode: null, errorMessage: null })).toMatchObject({ kind: "budget", resume: true });
    expect(describeJobProblem({ state: "blocked_credit", errorCode: null, errorMessage: null }).text).toMatch(/platform\.claude\.com → Billing/);
    expect(describeJobProblem({ state: "failed", errorCode: "auth", errorMessage: null }).text).toMatch(/ANTHROPIC_API_KEY/);
    for (const code of ["network", "overloaded", "rate_limit"] as const) {
      const p = describeJobProblem({ state: "failed", errorCode: code, errorMessage: null });
      expect(p.title).toBe("Не получилось связаться с Anthropic");
      expect(p.retry).toBe(true);
    }
  });

  it("никогда не обещает, что деньги не потрачены", () => {
    const codes = ["budget_limit", "credit_low", "console_limit", "auth", "rate_limit", "overloaded", "refused", "network", "too_large", "unknown"] as const;
    for (const code of codes) {
      const p = describeJobProblem({ state: "failed", errorCode: code, errorMessage: null });
      expect(`${p.title} ${p.text}`).not.toMatch(/не потратил|денег не|бесплатно/i);
    }
  });

  it("вход: пароль не задан и слишком много попыток", () => {
    expect(loginProblemText("no_password", "whatever")).toBe(NO_PASSWORD_TEXT);
    expect(loginProblemText("too_many", "Подождите 12 минут")).toBe("Подождите 12 минут");
    expect(loginProblemText("too_many", undefined)).toMatch(/Слишком много попыток/);
    expect(loginProblemText("wrong_password", undefined)).toMatch(/не подошёл/);
  });
});
