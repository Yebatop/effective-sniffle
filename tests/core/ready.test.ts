import { describe, expect, it } from "vitest";
import { pickAt, pickNeighbor } from "@/lib/core/ready";
import { tocRows } from "@/lib/client/toc";
import type { Chapter } from "@/lib/types";

const own = [
  { id: "en-135", number: 135, translated: false },
  { id: "en-136", number: 136, translated: false },
  { id: "en-137", number: 137, translated: true },
  { id: "en-138", number: 138, translated: false },
];
const ready = new Set([1, 2, 3, 135, 136]);

describe("соседи главы готового перевода", () => {
  it("свой перевод главнее готового, готовый главнее главы без перевода", () => {
    expect(pickAt("b", 137, own, ready)).toEqual({ number: 137, href: "/read/en-137", kind: "own" });
    expect(pickAt("b", 136, own, ready)).toEqual({ number: 136, href: "/book/b/ready/136", kind: "ready" });
    expect(pickAt("b", 138, own, ready)).toEqual({ number: 138, href: "/read/en-138", kind: "source" });
    expect(pickAt("b", 50, own, ready)).toBeNull();
  });
  it("«Дальше» с последней готовой ведёт в свою переведённую главу, «Назад» — в готовую", () => {
    expect(pickNeighbor("b", 136, 1, own, ready)?.href).toBe("/read/en-137");
    expect(pickNeighbor("b", 136, -1, own, ready)?.href).toBe("/book/b/ready/135");
    // Пропуск в номерах: с 3 «Дальше» — на 135.
    expect(pickNeighbor("b", 3, 1, own, ready)?.number).toBe(135);
    expect(pickNeighbor("b", 1, -1, own, ready)).toBeNull();
  });
  it("начатый перевод (оплаченные абзацы) готовый не заслоняет; пролог — номер 0", () => {
    const withStarted = [...own, { id: "en-3", number: 3, translated: false, started: true }];
    expect(pickAt("b", 3, withStarted, ready)).toEqual({ number: 3, href: "/read/en-3", kind: "source" });
    expect(pickNeighbor("b", 1, -1, own, new Set([0, 1]))?.href).toBe("/book/b/ready/0");
  });
});

describe("оглавление с готовым переводом", () => {
  const chapter = (id: string, number: number | null, translated: boolean): Chapter & { translated: boolean } =>
    ({ id, number, titleSrc: `Chapter ${number}`, createdAt: "2026-10-01T00:00:00.000Z", translated }) as unknown as Chapter & { translated: boolean };
  it("по номеру одна строка: свой перевод, иначе готовый, иначе без перевода", () => {
    const rows = tocRows(
      "b",
      [chapter("en-136", 136, false), chapter("en-137", 137, true), chapter("en-138", 138, false), chapter("x", null, false)],
      [
        { number: 1, title: "Глава 1. Начало", words: 100 },
        { number: 136, title: "Глава 136", words: 100 },
        { number: 137, title: "Глава 137 (чужая)", words: 100 },
      ],
    );
    expect(rows.map((r) => [r.number, r.kind, r.href])).toEqual([
      [1, "ready", "/book/b/ready/1"],
      [136, "ready", "/book/b/ready/136"],
      [137, "own", "/read/en-137"],
      [138, "source", "/read/en-138"],
      [null, "source", "/read/x"],
    ]);
  });
  it("своя глава добавлена дважды и одна переведена — готовой строки нет, в любом порядке", () => {
    const heads = [{ number: 11, title: "Глава 11", words: 100 }];
    for (const order of [
      [chapter("a", 11, false), chapter("b", 11, true)],
      [chapter("b", 11, true), chapter("a", 11, false)],
    ]) {
      expect(tocRows("b", order, heads).map((r) => [r.kind, r.href]).sort()).toEqual([
        ["own", "/read/b"],
        ["source", "/read/a"],
      ]);
    }
  });
  it("перевод начат (упал или остановлен) — строка своей главы, не готовой", () => {
    const started = { ...chapter("en-5", 5, false), started: true };
    expect(tocRows("b", [started], [{ number: 5, title: "Глава 5", words: 100 }]).map((r) => [r.kind, r.href])).toEqual([["source", "/read/en-5"]]);
  });
});
