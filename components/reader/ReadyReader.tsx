"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { api, errorText } from "@/lib/client/api";
import { num, plural } from "@/lib/client/format";
import { DEFAULT_READER_PREFS, LINE_HEIGHTS, loadReaderPrefs, type ReaderPrefs } from "@/lib/client/prefs";
import type { ReadyView } from "@/lib/types";
import { Icon } from "../Icon";
import { ErrorNote, Loading } from "../bits";
import { useWakeLock } from "./hooks";

/**
 * Глава готового перевода: русский текст как есть, вид — как в читалке
 * (кегль, интерлиньяж, шрифт), «Назад»/«Дальше» — к своим главам и к
 * готовым. Оригинала и подсветки терминов тут нет: это чужой перевод.
 */
export default function ReadyReader({ bookId, number }: { bookId: string; number: number }) {
  const [view, setView] = useState<ReadyView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [prefs, setPrefs] = useState<ReaderPrefs>(DEFAULT_READER_PREFS);
  useWakeLock(prefs.keepAwake);

  useEffect(() => {
    setPrefs(loadReaderPrefs());
  }, []);

  useEffect(() => {
    let alive = true;
    setError(null);
    api
      .ready(bookId, number)
      .then((v) => {
        if (!alive) return;
        setView(v);
        window.scrollTo(0, 0);
      })
      .catch((e) => alive && setError(errorText(e)));
    return () => {
      alive = false;
    };
  }, [bookId, number, reload]);

  const back = `/book/${encodeURIComponent(bookId)}`;
  if (error) {
    return (
      <main className="page page-narrow">
        <ErrorNote text={error} onRetry={() => setReload((n) => n + 1)} />
        <p className="center">
          <Link href={back}>К оглавлению</Link>
        </p>
      </main>
    );
  }
  if (!view) {
    return (
      <main className="page page-narrow">
        <Loading text="Открываю главу…" />
      </main>
    );
  }

  const { chapter, book, prev, next, own } = view;
  const style = {
    "--read-size": `${prefs.fontSize}px`,
    "--read-lh": String(LINE_HEIGHTS[prefs.lineHeight] ?? 1.75),
  } as React.CSSProperties;
  const nextLabel = !next ? null : next.kind === "source" ? `Глава ${next.number} · перевести →` : "Дальше →";

  return (
    <div className="reader" data-font={prefs.font} style={style}>
      <header className="reader-bar" data-hidden="false">
        <Link href={back} className="icon-btn" aria-label="К оглавлению книги">
          <Icon name="back" />
        </Link>
        <div className="reader-bar-title">
          <span className="t1">{book.title}</span>
          <span className="t2">Глава {chapter.number} · готовый перевод</span>
        </div>
      </header>

      <main className="reader-body">
        <div className="chapter-head">
          <div className="label">Глава {chapter.number}</div>
          <h1>{chapter.title || `Глава ${chapter.number}`}</h1>
          <div className="facts">
            <span>готовый перевод</span>
            <span>
              {num(chapter.words)} {plural(chapter.words, "слово", "слова", "слов")}
            </span>
          </div>
        </div>

        <div className="reading">
          {chapter.paragraphs.map((p, i) => (
            <p key={i} className="para">
              {p}
            </p>
          ))}
        </div>

        <nav className="chapter-end" aria-label="Соседние главы">
          {next && nextLabel ? (
            <Link className="btn btn-primary btn-big btn-block" href={next.href}>
              {nextLabel}
            </Link>
          ) : (
            <p className="center muted" style={{ margin: "8px 0" }}>
              Дальше глав пока нет. Следующую возьмите кнопкой «Т» на сайте с оригиналом.
            </p>
          )}
          <div className="row-between">
            {prev ? (
              <Link className="btn btn-quiet" href={prev.href}>
                ← Назад
              </Link>
            ) : (
              <span />
            )}
            <Link className="btn btn-quiet" href={back}>
              Оглавление
            </Link>
          </div>
          {own && (
            <p className="center small" style={{ marginTop: 12 }}>
              <Link href={own.href}>{own.translated ? "Свой перевод этой главы" : "Своя глава (оригинал) · перевести самому"}</Link>
            </p>
          )}
          {chapter.url && (
            <p className="center small muted" style={{ marginTop: own ? 4 : 12 }}>
              <a href={chapter.url} target="_blank" rel="noopener noreferrer">
                Открыть на сайте перевода
              </a>
            </p>
          )}
        </nav>
      </main>
    </div>
  );
}
