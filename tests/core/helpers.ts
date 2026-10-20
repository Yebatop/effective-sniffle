/** Общие заготовки для тестов ядра. Все тексты и имена выдуманы. */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Address, Book, Paragraph, Term } from "@/lib/types";

export function makeTerm(p: Partial<Term> & { en: string; ru: string }): Term {
  return {
    id: p.id ?? `t-${p.en.toLowerCase().replace(/\W+/g, "-")}`,
    bookId: "b1",
    kind: "name",
    gender: null,
    aliases: [],
    note: null,
    status: "checked",
    firstChapterId: null,
    source: "auto",
    ...p,
  };
}

export function makeAddress(p: Partial<Address> & { fromTermId: string; toTermId: string; form: "ty" | "vy" }): Address {
  return {
    id: p.id ?? `a-${p.fromTermId}-${p.toTermId}-${p.fromChapter ?? "0"}`,
    bookId: "b1",
    fromChapter: null,
    status: "checked",
    ...p,
  };
}

export function makeBook(p: Partial<Book> = {}): Book {
  return {
    id: "b1",
    bookKey: "example.com/lantern",
    title: "The Lantern Bridge",
    sourceLang: "en",
    site: "example.com",
    register: "plain",
    narratorPerson: 3,
    narratorGender: null,
    honorifics: null,
    glossaryVersion: 1,
    coverUrl: null,
    createdAt: "2026-10-01T00:00:00Z",
    updatedAt: "2026-10-01T00:00:00Z",
    ...p,
  };
}

/** Выдуманная глава из tests/fixtures/core: idx 0 — название, дальше текст. */
export function loadChapter(): Paragraph[] {
  const path = fileURLToPath(new URL("../fixtures/core/chapter-en.json", import.meta.url));
  const data = JSON.parse(readFileSync(path, "utf8")) as { title: string; paragraphs: string[] };
  return [{ idx: 0, text: data.title }, ...data.paragraphs.map((text, i) => ({ idx: i + 1, text }))];
}

/** Абзацы из n слов «word». */
export function wordsParagraph(idx: number, n: number): Paragraph {
  return { idx, text: Array.from({ length: n }, (_, i) => `word${i}`).join(" ") };
}
