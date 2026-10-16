/**
 * Глоссарий в промпте: только термины, которые встречаются в переводимом
 * тексте (по en и aliases, без учёта регистра, по границам слов), плюс
 * обращения «ты/вы» между персонажами, которые есть в тексте.
 * Порядок детерминирован (по en), чтобы одинаковый вход давал одинаковый текст.
 */

import type { Address, Term } from "../types";

export function termsInText(terms: Term[], text: string): Term[] {
  throw new Error("not implemented");
}

/** Обращения, где оба персонажа есть среди `present`; учитывает fromChapter ≤ chapterNumber. */
export function addressesFor(addresses: Address[], present: Term[], chapterNumber: number | null): Address[] {
  throw new Error("not implemented");
}

/** Блок для промпта: термины («en → ru (вид, род) — пометка»), затем «КТО К КОМУ». Предложенные помечены. */
export function renderGlossaryBlock(terms: Term[], addresses: Address[], allTerms: Term[]): string {
  throw new Error("not implemented");
}
