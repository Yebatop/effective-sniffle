/**
 * Соседи главы в книге, где есть и свои главы (английские, переведённые
 * или нет), и главы готового перевода. Для номера рядом выбирается лучшее:
 * свой перевод → своя глава с начатым переводом (оплаченные абзацы,
 * «Продолжить») → готовый перевод → своя глава без перевода (с картой
 * «Перевести»).
 */

export interface OwnHead {
  id: string;
  number: number;
  translated: boolean;
  /** Перевод хоть раз запускали. */
  started?: boolean;
}

export interface NeighborLink {
  number: number;
  href: string;
  kind: "own" | "ready" | "source";
}

export function readyHref(bookId: string, number: number): string {
  return `/book/${encodeURIComponent(bookId)}/ready/${number}`;
}

/** Своя глава номера: переведённая, иначе с начатым переводом, иначе первая. */
export function ownAt(number: number, own: OwnHead[]): OwnHead | null {
  const mine = own.filter((c) => c.number === number);
  return mine.find((c) => c.translated) ?? mine.find((c) => c.started) ?? mine[0] ?? null;
}

export function pickAt(bookId: string, number: number, own: OwnHead[], ready: Set<number>): NeighborLink | null {
  const mine = ownAt(number, own);
  const href = mine ? `/read/${encodeURIComponent(mine.id)}` : "";
  if (mine?.translated) return { number, href, kind: "own" };
  if (mine?.started) return { number, href, kind: "source" };
  if (ready.has(number)) return { number, href: readyHref(bookId, number), kind: "ready" };
  if (mine) return { number, href, kind: "source" };
  return null;
}

/** Ближайший номер до (dir = -1) или после (dir = 1) этого, у которого есть хоть что-то. */
export function pickNeighbor(bookId: string, number: number, dir: -1 | 1, own: OwnHead[], ready: Set<number>): NeighborLink | null {
  let best: number | null = null;
  const consider = (n: number) => {
    if (dir < 0 ? n >= number : n <= number) return;
    if (best === null || (dir < 0 ? n > best : n < best)) best = n;
  };
  for (const c of own) consider(c.number);
  ready.forEach(consider);
  return best === null ? null : pickAt(bookId, best, own, ready);
}
