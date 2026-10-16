import { describe, expect, it } from "vitest";
import { DEFAULT_CHUNK_WORDS, halveRange, splitIntoChunks } from "@/lib/core/chunk";
import type { Paragraph } from "@/lib/types";
import { loadChapter, wordsParagraph } from "./helpers";

function covers(chunks: ReturnType<typeof splitIntoChunks>, paragraphs: Paragraph[]) {
  const idxs = paragraphs.map((p) => p.idx).sort((a, b) => a - b);
  const fromChunks: number[] = [];
  for (const c of chunks) for (const p of idxs) if (p >= c.from && p <= c.to) fromChunks.push(p);
  expect(fromChunks).toEqual(idxs);
}

describe("splitIntoChunks", () => {
  it("короткая глава — одна часть с названием", () => {
    const chapter = loadChapter();
    const chunks = splitIntoChunks(chapter);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject({ index: 0, from: 0, to: chapter.length - 1 });
    expect(chunks[0].words).toBeGreaterThan(150);
  });

  it("пустая глава — ни одной части", () => {
    expect(splitIntoChunks([])).toEqual([]);
  });

  it("части непрерывны, не больше maxWords, покрывают все абзацы", () => {
    const paragraphs = [{ idx: 0, text: "Chapter 3: Rain" }, ...Array.from({ length: 80 }, (_, i) => wordsParagraph(i + 1, 30 + (i % 7) * 10))];
    const chunks = splitIntoChunks(paragraphs, 1400);
    expect(chunks.length).toBeGreaterThan(1);
    covers(chunks, paragraphs);
    for (const [i, c] of chunks.entries()) {
      expect(c.index).toBe(i);
      expect(c.words).toBeLessThanOrEqual(1400);
      if (i > 0) expect(c.from).toBe(chunks[i - 1].to + 1);
    }
    expect(chunks[0].from).toBe(0);
  });

  it("выравнивает части: 1 500 слов — две примерно равные, а не 1 400 + 100", () => {
    const paragraphs = Array.from({ length: 30 }, (_, i) => wordsParagraph(i + 1, 50));
    const chunks = splitIntoChunks(paragraphs, 1400);
    expect(chunks.map((c) => c.words)).toEqual([750, 750]);
  });

  it("абзац длиннее maxWords — отдельная часть", () => {
    const paragraphs = [wordsParagraph(1, 100), wordsParagraph(2, 2000), wordsParagraph(3, 100)];
    const chunks = splitIntoChunks(paragraphs, 1400);
    expect(chunks.map((c) => [c.from, c.to, c.words])).toEqual([
      [1, 1, 100],
      [2, 2, 2000],
      [3, 3, 100],
    ]);
  });

  it("название не остаётся частью само по себе, даже перед огромным абзацем", () => {
    const paragraphs = [{ idx: 0, text: "Chapter 9" }, wordsParagraph(1, 3000), wordsParagraph(2, 50)];
    const chunks = splitIntoChunks(paragraphs, 1400);
    expect(chunks[0]).toMatchObject({ from: 0, to: 1, words: 3002 });
    expect(chunks[1]).toMatchObject({ from: 2, to: 2 });
  });

  it("детерминировано и не зависит от порядка во входе", () => {
    const paragraphs = Array.from({ length: 60 }, (_, i) => wordsParagraph(i, 20 + ((i * 37) % 90)));
    const a = splitIntoChunks(paragraphs);
    const b = splitIntoChunks([...paragraphs].reverse());
    expect(b).toEqual(a);
    expect(splitIntoChunks(paragraphs)).toEqual(a);
  });

  it("по умолчанию предел — 1 400 слов", () => {
    expect(DEFAULT_CHUNK_WORDS).toBe(1400);
    const paragraphs = Array.from({ length: 10 }, (_, i) => wordsParagraph(i + 1, 300));
    const chunks = splitIntoChunks(paragraphs);
    for (const c of chunks) expect(c.words).toBeLessThanOrEqual(1400);
    expect(chunks).toHaveLength(3);
  });
});

describe("halveRange", () => {
  it("делит пополам", () => {
    expect(halveRange(1, 10)).toEqual([
      [1, 5],
      [6, 10],
    ]);
    expect(halveRange(4, 5)).toEqual([
      [4, 4],
      [5, 5],
    ]);
    expect(halveRange(0, 2)).toEqual([
      [0, 1],
      [2, 2],
    ]);
  });

  it("один абзац делить нечего", () => {
    expect(halveRange(7, 7)).toBeNull();
    expect(halveRange(8, 7)).toBeNull();
  });
});
