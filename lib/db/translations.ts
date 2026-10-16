/** Переводы: версии не перезаписываются, текущая — указатель в главе. */

import type { Db } from "./client";
import { num, toTranslation } from "./rows";
import type { ModelId, Translation, TranslatedParagraph } from "../types";

export async function createTranslation(d: Db, input: { chapterId: string; model: ModelId; mode: "sync" | "batch"; glossaryVersion: number }): Promise<Translation> {
  const r = await d.query(
    "insert into translations (chapter_id, model, mode, glossary_version) values ($1, $2, $3, $4) returning *",
    [input.chapterId, input.model, input.mode, input.glossaryVersion],
  );
  return toTranslation(r.rows[0]);
}

/** Записать/заменить абзац перевода; seq берётся новый — опрос увидит обновление. */
export async function upsertParagraph(d: Db, translationId: string, p: { idx: number; text: string; refused?: boolean }): Promise<number> {
  const r = await d.query<{ seq: string }>(
    `insert into translation_paragraphs (translation_id, idx, text, refused)
     values ($1, $2, $3, $4)
     on conflict (translation_id, idx) do update
       set text = excluded.text, refused = excluded.refused, seq = nextval('translation_paragraph_seq')
     returning seq`,
    [translationId, p.idx, p.text, Boolean(p.refused)],
  );
  return num(r.rows[0]?.seq);
}

/** Удалить абзацы диапазона (недописанная часть перед повтором). */
export async function deleteParagraphRange(d: Db, translationId: string, from: number, to: number): Promise<void> {
  await d.query("delete from translation_paragraphs where translation_id = $1 and idx between $2 and $3", [translationId, from, to]);
}

export async function getTranslation(d: Db, id: string): Promise<Translation | null> {
  const r = await d.query("select * from translations where id = $1", [id]);
  return r.rows[0] ? toTranslation(r.rows[0]) : null;
}

/** Абзацы с seq > since, по idx. */
export async function getParagraphsSince(d: Db, translationId: string, since: number): Promise<TranslatedParagraph[]> {
  const r = await d.query(
    "select idx, text, refused, seq from translation_paragraphs where translation_id = $1 and seq > $2 order by idx",
    [translationId, since],
  );
  return r.rows.map((row) => ({
    idx: num(row.idx),
    text: String(row.text),
    refused: Boolean(row.refused) || undefined,
    seq: num(row.seq),
  }));
}

export async function addTranslationCost(d: Db, translationId: string, usd: number): Promise<void> {
  await d.query("update translations set cost_usd = cost_usd + $2 where id = $1", [translationId, usd]);
}

/** Завершить: статус done и указатель главы на эту версию. */
export async function finishTranslation(d: Db, translationId: string): Promise<void> {
  await d.query(
    `with t as (update translations set status = 'done' where id = $1 returning chapter_id)
     update chapters set current_translation_id = $1 from t where chapters.id = t.chapter_id`,
    [translationId],
  );
}

/** Продолжаем прерванную версию — она снова «в работе». */
export async function reviveTranslation(d: Db, translationId: string): Promise<void> {
  await d.query("update translations set status = 'in_progress' where id = $1 and status = 'failed'", [translationId]);
}

/** Какие абзацы этой версии уже готовы в диапазоне — их при продолжении не переводим. */
export async function doneIdx(d: Db, translationId: string, from: number, to: number): Promise<Set<number>> {
  const r = await d.query("select idx from translation_paragraphs where translation_id = $1 and idx between $2 and $3", [translationId, from, to]);
  return new Set(r.rows.map((row) => Number(row.idx)));
}

export async function failTranslation(d: Db, translationId: string): Promise<void> {
  await d.query("update translations set status = 'failed' where id = $1", [translationId]);
}

/** Последние n абзацев текущего перевода предыдущей главы — контекст для следующей. */
export async function tailOfChapter(d: Db, chapterId: string, n: number): Promise<string[]> {
  const r = await d.query(
    `select tp.text from chapters c
     join translation_paragraphs tp on tp.translation_id = c.current_translation_id
     where c.id = $1 and tp.idx >= 1 and not tp.refused
     order by tp.idx desc limit $2`,
    [chapterId, n],
  );
  return r.rows.map((row) => String(row.text)).reverse();
}

/** Последние n готовых абзацев этой версии перед idx — контекст между частями одной главы. */
export async function tailBefore(d: Db, translationId: string, beforeIdx: number, n: number): Promise<string[]> {
  const r = await d.query(
    `select text from translation_paragraphs
     where translation_id = $1 and idx >= 1 and idx < $2 and not refused
     order by idx desc limit $3`,
    [translationId, beforeIdx, n],
  );
  return r.rows.map((row) => String(row.text)).reverse();
}
