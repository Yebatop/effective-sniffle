"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { api, errorText } from "@/lib/client/api";
import { chapterFromBytes } from "@/lib/client/extract";
import { SITE_BLOCKED_HELP } from "@/lib/client/problems";
import { clearPendingShare, readPendingShare, type PendingShare } from "@/lib/client/share";
import { chapterFromPastedText, sharedUrl } from "@/lib/extract/text";
import type { ChapterSource, ExtractedChapter } from "@/lib/types";
import ChapterPreview from "../ChapterPreview";
import { Loading } from "../bits";

type Stage =
  | { kind: "loading"; text: string }
  | { kind: "preview"; chapter: ExtractedChapter; source: ChapterSource }
  | { kind: "blocked"; message: string; url: string }
  | { kind: "error"; message: string }
  | { kind: "empty" };

/**
 * «Поделиться → Толмач». Данные приходят либо из service worker (POST с
 * файлом или текстом → IndexedDB → сюда с ?pending=1), либо в адресе
 * (?text=&url=&title=) — запасной путь для GET.
 */
export default function ShareScreen({
  pending,
  failed = false,
  text,
  url,
  title,
}: {
  pending: boolean;
  failed?: boolean;
  text: string | null;
  url: string | null;
  title: string | null;
}) {
  const [stage, setStage] = useState<Stage>({ kind: "loading", text: "Смотрю, чем поделились…" });
  const started = useRef(false);

  useEffect(() => {
    // Один разбор на открытие: строгий режим React вызывает эффект дважды,
    // а запись в IndexedDB после первого чтения уже удалена.
    if (started.current) return;
    started.current = true;
    void (async () => {
      let data: PendingShare | null = null;
      if (pending) {
        data = await readPendingShare();
        if (data) await clearPendingShare();
      }
      if (!data && (text || url || title)) data = { text, url, title };
      if (!data) {
        setStage({ kind: "empty" });
        return;
      }
      setStage(await handle(data));
    })();
  }, [pending, text, url, title]);

  return (
    <main className="page">
      <div className="page-head">
        <h1 className="display">Поделились с Толмачом</h1>
      </div>
      {stage.kind === "loading" && <Loading text={stage.text} />}
      {stage.kind === "preview" && <ChapterPreview chapter={stage.chapter} source={stage.source} />}
      {stage.kind === "blocked" && (
        <div className="notice notice-error stack-sm" role="alert">
          <p>{stage.message}</p>
          <p>{SITE_BLOCKED_HELP}</p>
          <p>
            <a href={stage.url} target="_blank" rel="noopener noreferrer">
              Открыть главу на сайте
            </a>{" "}
            · <Link href="/add">вставить текст</Link>
          </p>
        </div>
      )}
      {stage.kind === "error" && (
        <div className="notice notice-error" role="alert">
          <p>{stage.message}</p>
          <p>
            <Link href="/add">Добавить главу другим способом</Link>
          </p>
        </div>
      )}
      {stage.kind === "empty" && (
        <div className="notice stack-sm">
          <p>
            {failed
              ? "Не получилось принять то, чем поделились: браузер не дал сохранить это на телефоне."
              : "Нечего добавлять: Толмач не получил ни ссылки, ни текста, ни файла."}
          </p>
          <p>
            Поделитесь ещё раз страницей главы или выделенным текстом — или <Link href="/add">добавьте главу здесь</Link>.
          </p>
        </div>
      )}
    </main>
  );
}

async function handle(data: PendingShare): Promise<Stage> {
  try {
    if (data.file && data.file.data) {
      const bytes = new Uint8Array(data.file.data);
      const chapter = chapterFromBytes(bytes, data.file.name || "", data.file.type || "");
      if (!chapter.paragraphs.length) return { kind: "error", message: "В файле не нашлось текста главы." };
      return { kind: "preview", chapter, source: "share" };
    }
    const text = (data.text || "").trim();
    let link: string | null = data.url && /^https?:\/\//i.test(data.url) ? data.url : null;
    if (!link && text) {
      try {
        link = sharedUrl(text);
      } catch {
        link = null;
      }
    }
    // Длинный текст (выделили главу) — это сама глава, ссылка при нём лишь подсказка.
    const textIsChapter = text.length > 400 && (!link || text.replace(link, "").trim().length > 400);
    if (link && !textIsChapter) {
      const r = await api.fetchUrl(link);
      if (r.ok) return { kind: "preview", chapter: r.chapter, source: "server" };
      if (r.code === "site_blocked") return { kind: "blocked", message: r.message, url: link };
      return { kind: "error", message: r.message };
    }
    if (text) {
      const chapter = chapterFromPastedText(text, { url: link });
      if (!chapter.paragraphs.length) return { kind: "error", message: "Текста главы не нашлось." };
      return { kind: "preview", chapter, source: "share" };
    }
    return { kind: "empty" };
  } catch (e) {
    return { kind: "error", message: errorText(e) };
  }
}
