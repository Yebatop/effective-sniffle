import { describe, expect, it } from "vitest";
import { createLabelParser, labelParagraphs, missingIdx } from "@/lib/core/labels";

type P = { idx: number; text: string };

/** Прогнать поток кусками и собрать всё, что выдал парсер. */
function run(deltas: string[], expected = { from: 0, to: 20 }) {
  const parser = createLabelParser(expected);
  const out: P[] = [];
  const steps: P[][] = [];
  for (const d of deltas) {
    const got = parser.push(d);
    steps.push(got);
    out.push(...got);
  }
  out.push(...parser.finish());
  return { out, steps, parser };
}

/** Разрезать строку на куски по n символов. */
function slices(s: string, n: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < s.length; i += n) out.push(s.slice(i, i + n));
  return out;
}

describe("labelParagraphs", () => {
  it("метки перед абзацами, пустая строка между ними", () => {
    expect(
      labelParagraphs([
        { idx: 0, text: "Chapter 1" },
        { idx: 1, text: "  The bridge was quiet.  " },
      ]),
    ).toBe("⟦0⟧ Chapter 1\n\n⟦1⟧ The bridge was quiet.");
  });

  it("скобки меток внутри текста не притворяются метками", () => {
    expect(labelParagraphs([{ idx: 3, text: "He wrote ⟦4⟧ on the wall." }])).toBe("⟦3⟧ He wrote [4] on the wall.");
  });
});

describe("createLabelParser", () => {
  const stream = "Вот перевод:\n⟦1⟧ Рынок открылся.\n\n⟦2⟧ — Ты опять опоздал.\n— Паром шёл медленно.\n\n⟦3⟧ Он не спорил.";

  it("разбирает целый ответ: вступление отброшено, строки под меткой сохранены", () => {
    const { out } = run([stream]);
    expect(out).toEqual([
      { idx: 1, text: "Рынок открылся." },
      { idx: 2, text: "— Ты опять опоздал.\n— Паром шёл медленно." },
      { idx: 3, text: "Он не спорил." },
    ]);
  });

  it("абзац выдаётся, когда пришла следующая метка, последний — в finish()", () => {
    const parser = createLabelParser({ from: 1, to: 3 });
    expect(parser.push("⟦1⟧ Раз.")).toEqual([]);
    expect(parser.push(" Ещё раз.\n\n⟦2⟧ Два.")).toEqual([{ idx: 1, text: "Раз. Ещё раз." }]);
    expect(parser.push("\n\n")).toEqual([]);
    expect(parser.finish()).toEqual([{ idx: 2, text: "Два." }]);
    expect(parser.finish()).toEqual([]);
  });

  it("одинаковый результат при любом разрезании потока, включая метки пополам", () => {
    const whole = run([stream]).out;
    for (const n of [1, 2, 3, 5, 7, 13]) {
      expect(run(slices(stream, n)).out).toEqual(whole);
    }
    expect(run(["⟦1", "2⟧ Двенадцать.", "\n\n⟦", "13⟧ Тринадцать."]).out).toEqual([
      { idx: 12, text: "Двенадцать." },
      { idx: 13, text: "Тринадцать." },
    ]);
  });

  it("терпит пробелы внутри скобок", () => {
    expect(run(["⟦ 4 ⟧ Четыре. ⟦5 ⟧ Пять."]).out).toEqual([
      { idx: 4, text: "Четыре." },
      { idx: 5, text: "Пять." },
    ]);
  });

  it("метка вне диапазона — обычный текст текущего абзаца", () => {
    const { out } = run(["⟦1⟧ Один ⟦99⟧ и дальше.\n\n⟦2⟧ Два."], { from: 1, to: 2 });
    expect(out).toEqual([
      { idx: 1, text: "Один ⟦99⟧ и дальше." },
      { idx: 2, text: "Два." },
    ]);
    // До первой настоящей метки — отбрасывается вместе со вступлением.
    expect(run(["⟦7⟧ чужое ⟦1⟧ своё"], { from: 1, to: 2 }).out).toEqual([{ idx: 1, text: "своё" }]);
  });

  it("«⟦» без числа — обычный текст, недописанная метка в конце потока отбрасывается", () => {
    expect(run(["⟦1⟧ Скобка ⟦ — просто знак."]).out).toEqual([{ idx: 1, text: "Скобка ⟦ — просто знак." }]);
    expect(run(["⟦1⟧ Хвост.\n\n⟦1"]).out).toEqual([{ idx: 1, text: "Хвост." }]);
  });

  it("[[12]] не считается меткой", () => {
    expect(run(["⟦1⟧ Один [[2]] два"]).out).toEqual([{ idx: 1, text: "Один [[2]] два" }]);
  });

  it("повтор метки выдаёт абзац ещё раз (замена) и попадает в duplicates()", () => {
    const { out, parser } = run(["⟦1⟧ Первый вариант. ⟦2⟧ Два. ⟦1⟧ Второй вариант."]);
    expect(out).toEqual([
      { idx: 1, text: "Первый вариант." },
      { idx: 2, text: "Два." },
      { idx: 1, text: "Второй вариант." },
    ]);
    expect(parser.duplicates()).toEqual([1]);
    // Потребитель пишет по idx — остаётся последний вариант.
    const byIdx = new Map(out.map((p) => [p.idx, p.text]));
    expect(byIdx.get(1)).toBe("Второй вариант.");
  });

  it("пустой абзац не выдаётся — такой idx остаётся пропущенным", () => {
    const { out } = run(["⟦1⟧ ⟦2⟧ Два."]);
    expect(out).toEqual([{ idx: 2, text: "Два." }]);
    expect(missingIdx({ from: 1, to: 2 }, out.map((p) => p.idx))).toEqual([1]);
  });

  it("ответ без меток не даёт ничего", () => {
    expect(run(["Просто текст без меток."]).out).toEqual([]);
  });
});

describe("missingIdx", () => {
  it("называет отсутствующие idx по порядку", () => {
    expect(missingIdx({ from: 3, to: 8 }, [3, 5, 8, 8, 42])).toEqual([4, 6, 7]);
    expect(missingIdx({ from: 0, to: 2 }, new Set([0, 1, 2]))).toEqual([]);
    expect(missingIdx({ from: 1, to: 1 }, [])).toEqual([1]);
  });
});
