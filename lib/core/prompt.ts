/**
 * Сборка запроса на перевод части главы.
 *
 * Порядок — от неизменного к меняющемуся: правила → стиль книги (это
 * system, с одной меткой кэша после) → глоссарий части, рассказчик →
 * концовка предыдущего текста → абзацы с метками. Поток и пакет собирают
 * запрос одной этой функцией: расхождение даже в пробел ломает кэш и слог.
 *
 * Рассказчик и обращения — настройки книги, они не меняются от части к
 * части, поэтому живут в стиле книги (в кэшируемом system), а не в
 * сообщении части.
 */

import type { Address, Book, Effort, ModelId, Paragraph, Register, Term } from "../types";
import { countWords, estimateTokens, RU_TOKENS_PER_EN_WORD } from "./cost";
import { addressesFor, renderGlossaryBlock, termsInText } from "./glossary";
import { labelParagraphs, stripLabelChars } from "./labels";
import { MODELS } from "./models";

export interface TranslatePromptInput {
  book: Book;
  chapterNumber: number | null;
  /** Абзацы этой части (idx 0 — название, если входит в часть). */
  paragraphs: Paragraph[];
  /** Все термины книги и обращения — отбор по тексту делается внутри. */
  terms: Term[];
  addresses: Address[];
  /** Последние 2–3 переведённых абзаца перед этой частью (из этой или прошлой главы). */
  previousTail: string[];
  /** Короткое «что было раньше», если есть. */
  summary?: string | null;
}

export interface BuiltRequest {
  system: Array<{ type: "text"; text: string; cache_control?: { type: "ephemeral" } }>;
  messages: Array<{ role: "user"; content: string }>;
  /** Оценка входных токенов — для резерва бюджета. */
  inputTokensEstimate: number;
  /** max_tokens для этой части: ожидаемый вывод × 1,5 + запас на обдумывание. */
  maxTokens: number;
}

/** Правила перевода (из «Толмача», дополненные метками, названием, рассказчиком). */
export const RULES: string = `Ты переводишь отрывок англоязычной веб-новеллы на русский язык.

МЕТКИ АБЗАЦЕВ. Каждый абзац оригинала начинается с метки вида ⟦12⟧. Перевод
абзаца начинай с той же метки: «⟦12⟧ текст перевода». Под одной меткой может
быть несколько строк — например, реплики, каждая с новой строки. Каждую метку
повтори ровно один раз и в том же порядке: не пропускай, не объединяй два
абзаца под одной меткой, не придумывай новых. Кроме перевода с метками не пиши
ничего: ни вступления, ни заметок, ни пояснений, ни «Прим. переводчика».

НАЗВАНИЕ ГЛАВЫ. Абзац ⟦0⟧, если он есть, — название главы. Переведи его как
заголовок: коротко, без точки в конце; «Chapter 12» — «Глава 12».

ГЛОССАРИЙ ОБЯЗАТЕЛЕН. Если термин есть в глоссарии, пиши его ровно так, как там
указано: склоняй по правилам русского языка, но не меняй написание и не
подбирай синонимов. Это главное правило: читатель бросает перевод, когда герой
на каждой главе зовётся по-новому. Термины с пометкой [предложено] ещё не
проверены человеком — это сильная подсказка: держись их, если они не
противоречат смыслу текста.

РОД ПЕРСОНАЖЕЙ. У имён в глоссарии указан род: м — мужской, ж — женский.
Согласуй с ним глаголы прошедшего времени, прилагательные и местоимения, даже
если по английскому тексту пол не виден.

ОБРАЩЕНИЯ. В английском одно «you», в русском выбор между «ты» и «вы» говорит,
кто перед кем стоит. Соблюдай таблицу «кто к кому обращается» из глоссария.
Для пар, которых в ней нет, выбери форму по отношениям персонажей и держи её
до конца главы.

ВЕЖЛИВЫЕ ОБРАЩЕНИЯ И ТИТУЛЫ вроде shixiong, senpai, young master передавай
так, как сказано в стиле книги; если там ничего не сказано — одинаково по всей
главе.

ИМЕНА ВНЕ ГЛОССАРИЯ. Передавай практической транскрипцией и держи одинаково
внутри главы. Не переводи говорящие имена, если только автор сам не играет на
их значении.

РАССКАЗЧИК. Лицо и род рассказчика указаны в стиле книги — держи их. При
повествовании от первого лица согласуй слова рассказчика с его родом: «я
пришёл» или «я пришла». Не меняй лицо повествования.

ПО-РУССКИ, А НЕ ПО-АНГЛИЙСКИ. Переводи смысл, а не конструкцию. Падеж и предлог
выбираются по тому, что сказано, а не копируются из оригинала. На вопрос
«куда» отвечает «в библиотеку», а не «библиотека». «Where are we going?» — это
«Куда мы едем?», а не «Где мы едем?»: в английском одно слово и на место, и на
направление, в русском — разные. Если русская фраза звучит так, будто под ней
просвечивает английская, перепиши её.

РЕПЛИКИ. Каждая реплика начинается с тире на новой строке — все, включая
первую в сцене и самые короткие. Кавычки для прямой речи не используются.
Мысли героя — не реплика: без тире, в кавычках-ёлочках или просто текстом.

ЗНАКИ. Многоточие по-русски — три точки, сколько бы их ни стояло в оригинале.
Ряды точек, восклицательных и вопросительных знаков приводи к русской норме.
Кавычки — «ёлочки», внутри них — „лапки“. Тире — длинное (—) с пробелами по
краям; дефис — только внутри слов.

ЧТО ОТДАВАТЬ. Только текст перевода, без разметки: ни звёздочек, ни решёток, ни
курсива. Разбиение на абзацы — как в оригинале. Ничего не сокращай, не
пересказывай и не дополняй: сколько сцен в оригинале, столько и в переводе.

ЧЕГО НЕ ДЕЛАТЬ. Не смягчай и не вырезай сцены — это художественный текст для
взрослого читателя, и он должен дойти таким, каким его написали. Не вставляй
пометок о том, что ты переводчик или что что-то опущено.

ПОДСКАЗКИ — НЕ ТЕКСТ. Краткое содержание прошлых глав и конец предыдущего текста
даны для связности: их не переводи и не повторяй.`;

/** Как передавать текст — перенос из «Толмача» (exttran:src/config.ts, REGISTERS). */
export const REGISTER_DESCRIPTIONS: Record<Register, string> = {
  live:
    "Живой. Короткие фразы, разговорные обороты в диалогах, минимум причастных " +
    "оборотов. Так переводят литРПГ и городское фэнтези.",
  plain: "Ровный. Нейтральная литературная норма без стилизации в обе стороны. Подходит почти всему.",
  elevated:
    "Возвышенный. Чуть архаичный строй фразы, полные формы обращений, " +
    "уважительные конструкции там, где они уместны по отношениям персонажей. " +
    "Так переводят сянься и уся.",
};

function narratorLine(book: Book): string {
  const g = book.narratorGender;
  if (book.narratorPerson === 1) {
    if (g === "m") return "от первого лица, мужчина: «я пришёл», «я устал».";
    if (g === "f") return "от первого лица, женщина: «я пришла», «я устала».";
    if (g === "n") return "от первого лица, средний род: «я пришло», «я устало».";
    return "от первого лица; род не указан — пойми его из текста и держи одинаково.";
  }
  if (book.narratorPerson === 3) {
    if (g === "m") return "от третьего лица; главный герой — мужчина.";
    if (g === "f") return "от третьего лица; главная героиня — женщина.";
    return "от третьего лица.";
  }
  if (g === "m") return "лицо не указано — держи, как в оригинале; рассказчик — мужчина.";
  if (g === "f") return "лицо не указано — держи, как в оригинале; рассказчик — женщина.";
  return "не указан — держи лицо и род, как в оригинале.";
}

/** Стиль книги — вторая половина system. Только настройки книги: ничего, что меняется от части к части. */
export function renderStyleBlock(book: Book): string {
  const lines = ["СТИЛЬ ЭТОЙ КНИГИ"];
  const title = book.title.replace(/\s+/g, " ").trim();
  if (title) lines.push(`Книга: ${stripLabelChars(title)}`);
  lines.push(`Стиль: ${REGISTER_DESCRIPTIONS[book.register] ?? REGISTER_DESCRIPTIONS.plain}`);
  lines.push(`Рассказчик: ${narratorLine(book)}`);
  const honorifics = book.honorifics?.replace(/\s+/g, " ").trim();
  if (honorifics) lines.push(`Вежливые обращения и титулы: ${stripLabelChars(honorifics)}`);
  return lines.join("\n");
}

/** Запас max_tokens на обдумывание; Opus 5.5 думает всегда — ему больше. */
export const THINKING_ALLOWANCE: Record<Effort, number> = { low: 4000, medium: 8000, high: 16000 };
export const ALWAYS_THINKS_EXTRA_ALLOWANCE = 4000;
export const MAX_TOKENS_CAP = 64000;
/** Метка с переносом строки в выводе — с запасом. */
export const LABEL_OUTPUT_TOKENS = 20;
/** Редкие символы ⟦⟧ в токенизаторе стоят дороже обычных букв — добавка к оценке входа на метку. */
const LABEL_INPUT_TOKENS = 4;

/** Ожидаемый вывод части без обдумывания: ~2,9 токена на английское слово + метки. */
export function expectedOutputTokens(paragraphs: Paragraph[]): number {
  return RU_TOKENS_PER_EN_WORD * countWords(paragraphs.map((p) => p.text)) + LABEL_OUTPUT_TOKENS * paragraphs.length;
}

export function maxTokensFor(paragraphs: Paragraph[], model: ModelId, effort: Effort): number {
  const thinking = THINKING_ALLOWANCE[effort] + (MODELS[model].alwaysThinks ? ALWAYS_THINKS_EXTRA_ALLOWANCE : 0);
  return Math.min(MAX_TOKENS_CAP, Math.ceil(expectedOutputTokens(paragraphs) * 1.5) + thinking);
}

const SEPARATOR = "\n\n---\n\n";

export function buildTranslateRequest(input: TranslatePromptInput, model: ModelId, effort: Effort): BuiltRequest {
  const paragraphs = [...input.paragraphs].sort((a, b) => a.idx - b.idx);
  if (paragraphs.length === 0) throw new Error("buildTranslateRequest: в части нет абзацев");

  const systemText = `${RULES}\n\n${renderStyleBlock(input.book)}`;

  // Глоссарий — только по английскому тексту этой части.
  const present = termsInText(input.terms, paragraphs.map((p) => p.text).join("\n"));
  const addresses = addressesFor(input.addresses, present, input.chapterNumber);
  const glossary = renderGlossaryBlock(present, addresses, input.terms);

  const parts: string[] = [];
  if (glossary) parts.push(`ГЛОССАРИЙ ДЛЯ ЭТОГО ОТРЫВКА\n\n${glossary}`);

  const summary = input.summary ? stripLabelChars(input.summary).trim() : "";
  if (summary) parts.push(`ЧТО БЫЛО РАНЬШЕ (для связности, не переводить)\n\n${summary}`);

  // Концовка — сразу перед текстом: она связывает его с прошлой частью.
  const tail = input.previousTail.map((t) => stripLabelChars(t).trim()).filter(Boolean);
  if (tail.length > 0) parts.push(`КОНЕЦ ПРЕДЫДУЩЕГО ТЕКСТА (для связности, не переводить)\n\n${tail.join("\n\n")}`);

  const from = paragraphs[0].idx;
  const to = paragraphs[paragraphs.length - 1].idx;
  // Диапазон — без скобок меток: в ответ модели должны попасть только метки абзацев.
  const range = from === to ? `абзац ${from}` : `абзацы ${from}–${to}, ${paragraphs.length} шт.`;
  parts.push(`ПЕРЕВЕДИ: ${range}\n\n${labelParagraphs(paragraphs)}`);

  const userText = parts.join(SEPARATOR);

  return {
    system: [{ type: "text", text: systemText, cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: userText }],
    inputTokensEstimate: estimateTokens(systemText) + estimateTokens(userText) + LABEL_INPUT_TOKENS * paragraphs.length,
    maxTokens: maxTokensFor(paragraphs, model, effort),
  };
}
