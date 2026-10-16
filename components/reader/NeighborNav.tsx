"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { api, errorText, importOne } from "@/lib/client/api";
import { getBridge } from "@/lib/client/bridge";
import { estimateRub, rub } from "@/lib/client/format";
import type { NeighborView, Settings } from "@/lib/types";

/** Что сказать, если глава через браузер не пришла. */
export function bridgeFailureText(code: string): string {
  switch (code) {
    case "timeout":
      return "Кнопка «Т» не ответила за минуту. Откройте следующую главу на сайте и нажмите кнопку «Т».";
    case "site_blocked":
      return "Сайт попросил пройти проверку «вы не робот?». Откройте следующую главу на сайте, пройдите проверку и нажмите кнопку «Т».";
    case "not_chapter":
      return "По ссылке «дальше» нашлась не глава. Откройте её на сайте и нажмите кнопку «Т».";
    default:
      return "Не получилось взять главу через браузер. Откройте её на сайте и нажмите кнопку «Т».";
  }
}

export const SERVER_BLOCKED_TEXT = "Сайт не пускает наш сервер. Откройте следующую главу на сайте и нажмите кнопку «Т».";

/**
 * «Дальше» и «← Назад» в конце главы.
 * Глава уже в библиотеке → переход; есть только адрес на сайте → сервер
 * пробует открыть, не пускает → через кнопку «Т» в этом браузере (мост),
 * нет кнопки → объясняем, что нажать.
 */
export default function NeighborNav({
  next,
  prev,
  bookId,
  settings,
}: {
  next: NeighborView;
  prev: NeighborView;
  bookId: string;
  settings: Settings | null;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<null | "next" | "prev">(null);
  const [status, setStatus] = useState<string | null>(null);
  const [problem, setProblem] = useState<{ text: string; url: string | null } | null>(null);
  const [nextPrice, setNextPrice] = useState<string | null>(null);
  const priceAsked = useRef(false);

  // Цена следующей главы: её длина известна только серверу — спросим один раз.
  useEffect(() => {
    if (priceAsked.current || !next.chapterId || next.translated || !settings) return;
    priceAsked.current = true;
    api
      .chapter(next.chapterId)
      .then((v) => {
        if (v.estimate) setNextPrice(rub(v.estimate.usd, settings.usdRub));
        else setNextPrice(estimateRub(settings.translateModel, v.chapter.words, settings.usdRub, settings.translateEffort, settings.extractModel));
      })
      .catch(() => undefined);
  }, [next.chapterId, next.translated, settings]);

  async function take(which: "next" | "prev", url: string) {
    setBusy(which);
    setProblem(null);
    setStatus("Беру главу с сайта…");
    try {
      const r = await api.fetchUrl(url);
      if (r.ok) {
        const item = await importOne(r.chapter, "server", bookId);
        router.push(`/read/${encodeURIComponent(item.chapterId)}`);
        return;
      }
      if (r.code === "site_blocked") {
        const bridge = getBridge();
        if (bridge && bridge.isReady()) {
          setStatus("Сайт не пускает сервер — беру главу через ваш браузер…");
          const b = await bridge.fetchChapter(url);
          if (b.ok) {
            const item = await importOne(b.chapter, "bridge", bookId);
            router.push(`/read/${encodeURIComponent(item.chapterId)}`);
            return;
          }
          setProblem({ text: bridgeFailureText(b.code), url });
        } else {
          setProblem({
            text: which === "next" ? SERVER_BLOCKED_TEXT : SERVER_BLOCKED_TEXT.replace("следующую", "предыдущую"),
            url,
          });
        }
      } else {
        setProblem({ text: r.message, url });
      }
    } catch (e) {
      setProblem({ text: errorText(e), url });
    } finally {
      setBusy(null);
      setStatus(null);
    }
  }

  const nextHref = next.chapterId ? `/read/${encodeURIComponent(next.chapterId)}` : null;
  const prevHref = prev.chapterId ? `/read/${encodeURIComponent(prev.chapterId)}` : null;

  return (
    <nav className="chapter-end" aria-label="Соседние главы">
      {nextHref ? (
        <Link className="btn btn-primary btn-big btn-block" href={nextHref}>
          {next.translated ? "Дальше →" : nextPrice ? `Дальше · перевести ${nextPrice}` : "Дальше · перевести"}
        </Link>
      ) : next.url ? (
        <button
          type="button"
          className="btn btn-primary btn-big btn-block"
          disabled={!!busy}
          onClick={() => take("next", next.url as string)}
        >
          {busy === "next" ? "Беру главу…" : "Взять следующую с сайта"}
        </button>
      ) : (
        <p className="center muted" style={{ margin: "8px 0" }}>
          Это последняя взятая глава.
        </p>
      )}

      {status && (
        <p className="status-line" role="status" style={{ margin: 0 }}>
          <span className="spinner" aria-hidden="true" />
          {status}
        </p>
      )}
      {problem && (
        <div className="notice notice-error" role="alert">
          <p>{problem.text}</p>
          {problem.url && (
            <p>
              <a href={problem.url} target="_blank" rel="noopener noreferrer">
                Открыть главу на сайте
              </a>{" "}
              · <Link href="/button">про кнопку «Т»</Link>
            </p>
          )}
        </div>
      )}

      <div className="row-between">
        {prevHref ? (
          <Link className="btn btn-quiet" href={prevHref}>
            ← Назад
          </Link>
        ) : prev.url ? (
          <button type="button" className="btn btn-quiet" disabled={!!busy} onClick={() => take("prev", prev.url as string)}>
            {busy === "prev" ? "Беру главу…" : "← Взять предыдущую"}
          </button>
        ) : (
          <span />
        )}
        <Link className="btn btn-quiet" href={`/book/${encodeURIComponent(bookId)}`}>
          Оглавление
        </Link>
      </div>
    </nav>
  );
}
