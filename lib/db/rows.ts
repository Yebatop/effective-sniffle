/**
 * Строки базы → типы приложения. pg отдаёт numeric и bigint строками, а
 * timestamptz — объектами Date; здесь всё приводится к тому, что обещает
 * lib/types.ts.
 */

import type { Address, Book, Chapter, ChapterSource, Effort, ErrorCode, Gender, Job, JobState, ModelId, Register, Term, TermKind, TermStatus, Translation, TranslationStatus } from "../types";

type Row = Record<string, unknown>;

export function iso(v: unknown): string {
  if (v instanceof Date) return v.toISOString();
  if (typeof v === "string") return new Date(v).toISOString();
  return new Date(0).toISOString();
}

export function isoOrNull(v: unknown): string | null {
  return v == null ? null : iso(v);
}

export function num(v: unknown): number {
  if (typeof v === "number") return v;
  if (typeof v === "string" || typeof v === "bigint") return Number(v);
  return 0;
}

export function numOrNull(v: unknown): number | null {
  return v == null ? null : num(v);
}

function str(v: unknown): string {
  return v == null ? "" : String(v);
}

function strOrNull(v: unknown): string | null {
  return v == null ? null : String(v);
}

export function toBook(r: Row): Book {
  return {
    id: str(r.id),
    bookKey: strOrNull(r.book_key),
    title: str(r.title),
    sourceLang: str(r.source_lang) || "en",
    site: strOrNull(r.site),
    register: (str(r.register) || "plain") as Register,
    narratorPerson: (numOrNull(r.narrator_person) as 1 | 3 | null) ?? null,
    narratorGender: (strOrNull(r.narrator_gender) as Gender | null) ?? null,
    honorifics: strOrNull(r.honorifics),
    glossaryVersion: num(r.glossary_version),
    coverUrl: strOrNull(r.cover_url),
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
  };
}

export function toChapter(r: Row): Chapter {
  return {
    id: str(r.id),
    bookId: str(r.book_id),
    number: numOrNull(r.number),
    titleSrc: str(r.title_src),
    url: strOrNull(r.url),
    nextUrl: strOrNull(r.next_url),
    prevUrl: strOrNull(r.prev_url),
    contentSha256: str(r.content_sha256),
    words: num(r.words),
    source: str(r.source) as ChapterSource,
    currentTranslationId: strOrNull(r.current_translation_id),
    createdAt: iso(r.created_at),
  };
}

export function toTranslation(r: Row): Translation {
  return {
    id: str(r.id),
    chapterId: str(r.chapter_id),
    model: str(r.model) as ModelId,
    mode: (str(r.mode) || "sync") as "sync" | "batch",
    glossaryVersion: num(r.glossary_version),
    status: str(r.status) as TranslationStatus,
    costUsd: num(r.cost_usd),
    createdAt: iso(r.created_at),
  };
}

export function toTerm(r: Row): Term {
  return {
    id: str(r.id),
    bookId: str(r.book_id),
    en: str(r.en),
    ru: str(r.ru),
    kind: str(r.kind) as TermKind,
    gender: (strOrNull(r.gender) as Gender | null) ?? null,
    aliases: Array.isArray(r.aliases) ? (r.aliases as unknown[]).map(String) : [],
    note: strOrNull(r.note),
    status: str(r.status) as TermStatus,
    firstChapterId: strOrNull(r.first_chapter_id),
  };
}

export function toAddress(r: Row): Address {
  return {
    id: str(r.id),
    bookId: str(r.book_id),
    fromTermId: str(r.from_term_id),
    toTermId: str(r.to_term_id),
    form: str(r.form) as "ty" | "vy",
    fromChapter: numOrNull(r.from_chapter),
    status: str(r.status) as TermStatus,
  };
}

export function toJob(r: Row): Job {
  return {
    id: str(r.id),
    kind: "translate",
    chapterId: str(r.chapter_id),
    translationId: strOrNull(r.translation_id),
    state: str(r.state) as JobState,
    model: str(r.model) as ModelId,
    effort: (str(r.effort) || "medium") as Effort,
    nextChunk: num(r.next_chunk),
    chunksTotal: numOrNull(r.chunks_total),
    termsExtracted: Boolean(r.terms_extracted),
    leaseUntil: isoOrNull(r.lease_until),
    attempt: num(r.attempt),
    errorCode: (strOrNull(r.error_code) as ErrorCode | null) ?? null,
    errorMessage: strOrNull(r.error_message),
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
  };
}
