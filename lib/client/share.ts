/**
 * «Поделиться → Толмач»: то, что service worker (public/sw.js) положил в
 * IndexedDB. База и хранилище — те же, что у idb-keyval по умолчанию
 * ("keyval-store" / "keyval"), ключ "tolmach-share".
 */

import { del, get } from "idb-keyval";

export const SHARE_KEY = "tolmach-share";

export interface PendingShare {
  title?: string | null;
  text?: string | null;
  url?: string | null;
  file?: { name: string; type: string; data: ArrayBuffer } | null;
  at?: number;
}

export async function readPendingShare(): Promise<PendingShare | null> {
  try {
    const v = (await get(SHARE_KEY)) as PendingShare | undefined;
    return v && typeof v === "object" ? v : null;
  } catch {
    return null;
  }
}

export async function clearPendingShare(): Promise<void> {
  try {
    await del(SHARE_KEY);
  } catch {
    // ничего страшного: при следующем «Поделиться» запись перезапишется
  }
}
