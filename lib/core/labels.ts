/**
 * Метки абзацев. В запросе перед каждым абзацем оригинала стоит ⟦idx⟧,
 * модель обязана повторить ту же метку перед переводом этого абзаца.
 * Под одной меткой может быть несколько строк (реплики с новой строки).
 */

export const LABEL_OPEN = "⟦";
export const LABEL_CLOSE = "⟧";

/** Скобки меток внутри самого текста подменяются обычными — иначе текст притворится меткой. */
export function stripLabelChars(text: string): string {
  return text.replace(/⟦/g, "[").replace(/⟧/g, "]");
}

/** Текст абзацев с метками для запроса: "⟦1⟧ текст\n\n⟦2⟧ текст". */
export function labelParagraphs(items: Array<{ idx: number; text: string }>): string {
  return items.map((p) => `${LABEL_OPEN}${p.idx}${LABEL_CLOSE} ${stripLabelChars(p.text).trim()}`).join("\n\n");
}

/**
 * Разбор потока по мере прихода. push(delta) возвращает абзацы, которые
 * стали завершёнными (пришла следующая метка); finish() — последний абзац.
 * Текст до первой метки отбрасывается. Метки вне ожидаемого диапазона
 * игнорируются; повтор метки — повторный абзац заменяет предыдущий.
 */
export interface LabelStreamParser {
  push(delta: string): Array<{ idx: number; text: string }>;
  finish(): Array<{ idx: number; text: string }>;
}

/** Парсер с подсказкой для проверки: какие метки пришли больше одного раза. */
export interface LabelStreamParserWithStats extends LabelStreamParser {
  /** idx, абзац которых пришёл повторно (потребитель уже получил замену). */
  duplicates(): number[];
}

// Допускаем пробелы внутри скобок («⟦ 12 ⟧») — модели иногда так пишут.
// Запасной формат «[[12]]» не разбираем: настоящие метки модель видит во
// входе и повторяет надёжно, а «[[…]]» встречается и в обычном тексте —
// ложное срабатывание порвало бы абзац посередине.
const LABEL_RE = /^⟦[ \t]{0,3}(\d{1,6})[ \t]{0,3}⟧/;
// Начало, которое ещё может дорасти до метки, — его держим до следующего куска.
const PARTIAL_RE = /^⟦[ \t]{0,3}\d{0,6}[ \t]{0,3}$/;

/**
 * Решения разбора:
 * - метка может прийти разрезанной между кусками («⟦1» + «2⟧») — начало
 *   метки придерживается в буфере, пока не станет ясно, метка это или нет;
 * - метка вне диапазона {from..to} считается обычным текстом текущего абзаца
 *   (до первой метки — отбрасывается вместе с прочим вступлением);
 * - «⟦» без числа и закрывающей скобки — обычный текст;
 * - недописанное начало метки в самом конце потока отбрасывается;
 * - абзац с пустым текстом не выдаётся — такой idx считается пропущенным;
 * - повтор метки: абзац выдаётся ещё раз, потребитель заменяет прежний
 *   (запись по idx), а duplicates() называет такие idx для проверки.
 */
export function createLabelParser(expected: { from: number; to: number }): LabelStreamParserWithStats {
  let buffer = "";
  let current: { idx: number; text: string } | null = null;
  let finished = false;
  const seen = new Set<number>();
  const repeated = new Set<number>();

  const appendText = (text: string) => {
    if (current) current.text += text;
  };

  const closeCurrent = (out: Array<{ idx: number; text: string }>) => {
    if (!current) return;
    const text = current.text.trim();
    if (text) {
      if (seen.has(current.idx)) repeated.add(current.idx);
      seen.add(current.idx);
      out.push({ idx: current.idx, text });
    }
    current = null;
  };

  const drain = (out: Array<{ idx: number; text: string }>, final: boolean) => {
    while (buffer.length > 0) {
      const at = buffer.indexOf(LABEL_OPEN);
      if (at < 0) {
        appendText(buffer);
        buffer = "";
        return;
      }
      if (at > 0) {
        appendText(buffer.slice(0, at));
        buffer = buffer.slice(at);
      }
      const m = LABEL_RE.exec(buffer);
      if (m) {
        const idx = Number(m[1]);
        if (idx >= expected.from && idx <= expected.to) {
          closeCurrent(out);
          current = { idx, text: "" };
        } else {
          appendText(m[0]);
        }
        buffer = buffer.slice(m[0].length);
        continue;
      }
      if (PARTIAL_RE.test(buffer)) {
        if (!final) return; // ждём продолжения
        buffer = "";
        return;
      }
      // «⟦» оказался не меткой.
      appendText(LABEL_OPEN);
      buffer = buffer.slice(LABEL_OPEN.length);
    }
  };

  return {
    push(delta: string) {
      const out: Array<{ idx: number; text: string }> = [];
      if (finished || !delta) return out;
      buffer += delta;
      drain(out, false);
      return out;
    },
    finish() {
      const out: Array<{ idx: number; text: string }> = [];
      if (finished) return out;
      finished = true;
      drain(out, true);
      closeCurrent(out);
      return out;
    },
    duplicates() {
      return [...repeated].sort((a, b) => a - b);
    },
  };
}

/** Какие idx из диапазона отсутствуют в результате. */
export function missingIdx(expected: { from: number; to: number }, got: Iterable<number>): number[] {
  const have = new Set(got);
  const missing: number[] = [];
  for (let idx = expected.from; idx <= expected.to; idx += 1) {
    if (!have.has(idx)) missing.push(idx);
  }
  return missing;
}
