/** Глоссарий — строки, не документ: правки и слияние идут по строкам. */

import type { Db } from "./client";
import type { Address, Gender, Term, TermKind, TermStatus } from "../types";

export async function listTerms(d: Db, bookId: string): Promise<Term[]> {
  throw new Error("not implemented");
}
export async function listAddresses(d: Db, bookId: string): Promise<Address[]> {
  throw new Error("not implemented");
}

export interface ProposedTerm {
  en: string;
  ru: string;
  kind: TermKind;
  gender?: Gender | null;
  aliases?: string[];
  note?: string | null;
}
export interface ProposedAddress {
  fromEn: string;
  toEn: string;
  form: "ty" | "vy";
  fromChapter?: number | null;
}

/**
 * Слить предложения модели: новый термин добавляется, только если его en
 * (без учёта регистра) нет ни среди en, ни среди aliases книги; к
 * существующему термину добавляются новые aliases, пустой gender
 * заполняется; status=checked модель не меняет никогда. Обращения: по en
 * (или alias) находятся term id; неизвестные имена пропускаются; пара уже
 * есть — не трогать. Если что-то добавлено — glossary_version книги +1.
 */
export async function mergeProposals(
  d: Db,
  bookId: string,
  chapterId: string,
  terms: ProposedTerm[],
  addresses: ProposedAddress[],
): Promise<{ addedTerms: number; addedAddresses: number; glossaryVersion: number }> {
  throw new Error("not implemented");
}

/** Правка человеком: ставит status=checked, glossary_version +1. */
export async function updateTerm(
  d: Db,
  id: string,
  patch: Partial<{ ru: string; kind: TermKind; gender: Gender | null; aliases: string[]; note: string | null; status: TermStatus }>,
): Promise<Term> {
  throw new Error("not implemented");
}
export async function deleteTerm(d: Db, id: string): Promise<void> {
  throw new Error("not implemented");
}
export async function setAddressForm(d: Db, id: string, form: "ty" | "vy"): Promise<void> {
  throw new Error("not implemented");
}
