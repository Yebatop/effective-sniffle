/**
 * Бесплатные проверки готового перевода — подсветка, не автозамена.
 */

import type { Term, TermKind } from "../types";
import { wordsIn } from "./words";

export type CheckKind = "missing" | "latin" | "length" | "term_spelling" | "refused";

export interface CheckIssue {
  idx: number;
  kind: CheckKind;
  /** Коротко по-русски, для подсказки. */
  message: string;
}

const KIND_ORDER: CheckKind[] = ["refused", "missing", "length", "latin", "term_spelling"];

/** Длина перевода к длине оригинала (в символах) вне этих границ — подозрительно. */
export const LENGTH_RATIO_MIN = 0.5;
export const LENGTH_RATIO_MAX = 2.5;
export const LENGTH_MIN_WORDS = 8;

/**
 * - missing: абзац оригинала без перевода;
 * - latin: латинские слова в русском тексте (кроме белого списка: термины
 *   глоссария с латиницей в ru, аббревиатуры вроде HP, LV, ID);
 * - length: отношение длины перевода к оригиналу вне 0,5–2,5 (для абзацев от 8 слов);
 * - term_spelling: слово, похожее на русское имя термина, но написанное иначе
 *   (основа отличается на 1–2 буквы), например «Лин Вэй» при «Линь Вэй»;
 * - refused: абзац, который модель отказалась переводить.
 *
 * Длина меряется в символах (без лишних пробелов): русский текст длиннее
 * английского на 10–30%, а число слов по-русски, наоборот, меньше — символы
 * устойчивее. Смешение алфавитов в одном слове («мaна» с латинской «a»)
 * тоже считается латиницей: такие слова не находятся поиском и выглядят
 * нормально, пока не начнёшь искать.
 */
export function checkTranslation(
  source: Array<{ idx: number; text: string }>,
  translated: Array<{ idx: number; text: string; refused?: boolean }>,
  terms: Term[],
): CheckIssue[] {
  const byIdx = new Map<number, { idx: number; text: string; refused?: boolean }>();
  for (const t of translated) byIdx.set(t.idx, t);

  const latinWhitelist = buildLatinWhitelist(terms);
  const spelling = buildSpellingIndex(terms);
  // Строчные основы всего перевода — чтобы не принимать обычное слово в начале
  // предложения («Мира не будет») за искажённое имя («Кира»).
  const lowerStems = new Set<string>();
  for (const t of translated) {
    if (t.refused) continue;
    for (const w of t.text.match(CYRILLIC_WORD) ?? []) {
      if (w[0] === w[0].toLowerCase()) lowerStems.add(ruStem(w));
    }
  }

  const issues: CheckIssue[] = [];
  const sorted = [...source].sort((a, b) => a.idx - b.idx);

  for (const src of sorted) {
    if (!src.text.trim()) continue;
    const tr = byIdx.get(src.idx);

    if (tr?.refused) {
      issues.push({ idx: src.idx, kind: "refused", message: "Модель отказалась переводить этот абзац" });
      continue;
    }
    if (!tr || !tr.text.trim()) {
      issues.push({ idx: src.idx, kind: "missing", message: "Абзац не переведён" });
      continue;
    }

    const lengthIssue = checkLength(src.text, tr.text);
    if (lengthIssue) issues.push({ idx: src.idx, kind: "length", message: lengthIssue });

    const latin = findLatin(tr.text, latinWhitelist);
    if (latin) issues.push({ idx: src.idx, kind: "latin", message: latin });

    for (const message of findMisspelledTerms(tr.text, spelling, lowerStems)) {
      issues.push({ idx: src.idx, kind: "term_spelling", message });
    }
  }

  // Внутри абзаца — по виду проверки, иначе порядок как найдено.
  return issues
    .map((issue, order) => ({ issue, order }))
    .sort((a, b) => a.issue.idx - b.issue.idx || KIND_ORDER.indexOf(a.issue.kind) - KIND_ORDER.indexOf(b.issue.kind) || a.order - b.order)
    .map((x) => x.issue);
}

// ── Длина ──────────────────────────────────────────────────────────────

function visibleLength(text: string): number {
  return text.replace(/\s+/g, " ").trim().length;
}

function checkLength(source: string, translation: string): string | null {
  if (wordsIn(source) < LENGTH_MIN_WORDS) return null;
  const ratio = visibleLength(translation) / Math.max(1, visibleLength(source));
  if (ratio < LENGTH_RATIO_MIN) return "Перевод заметно короче оригинала — возможно, что-то пропущено";
  if (ratio > LENGTH_RATIO_MAX) return "Перевод заметно длиннее оригинала — возможно, добавлено лишнее";
  return null;
}

// ── Латиница ───────────────────────────────────────────────────────────

const LETTER_RUN = /\p{L}+/gu;
const HAS_LATIN = /\p{Script=Latin}/u;
const HAS_CYRILLIC = /\p{Script=Cyrillic}/u;
/** Аббревиатуры игровых систем и римские цифры: HP, LV, ID, EXP, XIV. */
const ABBREVIATION = /^\p{Lu}{2,6}$/u;

function buildLatinWhitelist(terms: Term[]): Set<string> {
  const allowed = new Set<string>();
  for (const t of terms) {
    for (const w of t.ru.match(LETTER_RUN) ?? []) {
      if (HAS_LATIN.test(w)) allowed.add(w.toLowerCase());
    }
  }
  return allowed;
}

function findLatin(text: string, whitelist: Set<string>): string | null {
  const latin = new Set<string>();
  const mixed = new Set<string>();
  for (const w of text.match(LETTER_RUN) ?? []) {
    if (!HAS_LATIN.test(w)) continue;
    if (HAS_CYRILLIC.test(w)) {
      mixed.add(w);
      continue;
    }
    // Одиночная буква — чаще всего «S-ранг» или «x2», это не непереведённое слово.
    if (w.length < 2 || ABBREVIATION.test(w) || whitelist.has(w.toLowerCase())) continue;
    latin.add(w);
  }
  if (mixed.size > 0) return `Латиница внутри русского слова: ${listSome([...mixed])}`;
  if (latin.size > 0) return `Латиница в переводе: ${listSome([...latin])}`;
  return null;
}

function listSome(words: string[]): string {
  return words.length > 3 ? `${words.slice(0, 3).join(", ")}…` : words.join(", ");
}

// ── Написание терминов ─────────────────────────────────────────────────

/**
 * Окончания для простого стеммера, от длинных к коротким: существительные
 * и прилагательные во всех падежах. Это не Snowball, а его бедный родственник:
 * для имён собственных его хватает, а словарь на Vercel не нужен.
 */
const ENDINGS = [
  "ями", "ами", "ого", "его", "ому", "ему", "ыми", "ими",
  "ах", "ях", "ам", "ям", "ом", "ем", "ой", "ей", "ую", "юю",
  "ая", "яя", "ое", "ее", "ые", "ие", "ых", "их", "ым", "им",
  "ов", "ев", "ья", "ье", "ью",
  "а", "я", "ы", "и", "у", "ю", "е", "о", "ь", "й",
];

/** Основа слова: нижний регистр, ё → е, срезано окончание (основа не короче 2 букв). */
export function ruStem(word: string): string {
  const w = word.toLowerCase().replace(/ё/g, "е");
  for (const e of ENDINGS) {
    if (w.length - e.length >= 2 && w.endsWith(e)) return w.slice(0, -e.length);
  }
  return w;
}

/** Все формы слова, которые даёт его основа с окончаниями из списка, и само слово. */
function formsOf(word: string): string[] {
  const w = word.toLowerCase().replace(/ё/g, "е");
  const stem = ruStem(w);
  return [w, ...ENDINGS.map((e) => stem + e)];
}

export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i += 1) {
    const cur = [i];
    for (let j = 1; j <= b.length; j += 1) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

/**
 * Проверяются только имена собственные — персонажи, места, организации — и
 * только слова с заглавной буквы: нарицательные термины («мана», «ци»)
 * дают слишком много ложных срабатываний.
 */
const PROPER_KINDS = new Set<TermKind>(["name", "place", "org"]);
const CYRILLIC_WORD = /[А-ЯЁа-яё]+/g;
const CAPITALIZED = /^[А-ЯЁ][а-яё]+$/;

interface SpellingIndex {
  /** Все допустимые формы всех русских слов глоссария — точное совпадение не ошибка. */
  allowed: Set<string>;
  words: Array<{ word: string; stem: string; term: Term }>;
}

function buildSpellingIndex(terms: Term[]): SpellingIndex {
  const allowed = new Set<string>();
  const words: SpellingIndex["words"] = [];
  const seen = new Set<string>();
  for (const term of terms) {
    for (const raw of term.ru.match(CYRILLIC_WORD) ?? []) {
      const forms = formsOf(raw);
      for (const f of forms) allowed.add(f);
      if (!PROPER_KINDS.has(term.kind) || raw.length < 4) continue;
      const word = raw.toLowerCase().replace(/ё/g, "е");
      if (seen.has(word)) continue;
      seen.add(word);
      words.push({ word, stem: ruStem(word), term });
    }
  }
  return { allowed, words };
}

/** Слово стоит в начале предложения или реплики. */
function atSentenceStart(text: string, index: number): boolean {
  const before = text.slice(0, index).replace(/[\s«"„(—–-]+$/u, "");
  return before === "" || /[.!?…:\n]$/.test(before);
}

function findMisspelledTerms(text: string, index: SpellingIndex, lowerStems: Set<string>): string[] {
  if (index.words.length === 0) return [];
  const out: string[] = [];
  const reported = new Set<string>();

  for (const m of text.matchAll(CYRILLIC_WORD)) {
    const raw = m[0];
    if (raw.length < 3 || !CAPITALIZED.test(raw)) continue;
    const lower = raw.toLowerCase().replace(/ё/g, "е");
    if (index.allowed.has(lower) || reported.has(lower)) continue;
    const stem = ruStem(lower);
    if (atSentenceStart(text, m.index) && lowerStems.has(stem)) continue;

    let best: { distance: number; word: string; term: Term } | null = null;
    for (const w of index.words) {
      let distance: number | null = null;
      if (stem === w.stem) {
        // Та же основа, но форма не из склонения термина: «Лин» при «Линь».
        if (w.stem.length >= 3) distance = 0.5;
      } else if (stem.length >= 4 && w.stem.length >= 4) {
        const d = levenshtein(stem, w.stem);
        // На коротких основах одна буква — уже другое слово; две — только от 6 букв.
        if (d <= (w.stem.length >= 6 ? 2 : 1)) distance = d;
      }
      if (distance !== null && (!best || distance < best.distance)) best = { distance, word: w.word, term: w.term };
    }
    if (!best) continue;
    reported.add(lower);
    const expected = best.word[0].toUpperCase() + best.word.slice(1);
    out.push(`Похоже на искажённое имя: «${raw}» вместо «${expected}» (${best.term.en})`);
  }
  return out;
}
