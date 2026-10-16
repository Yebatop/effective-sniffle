"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { api, errorText, getSettingsCached, type SpendView } from "@/lib/client/api";
import { budgetShares, monthName } from "@/lib/client/budget";
import { dateTime, modelLabel, rub, rubBare } from "@/lib/client/format";
import type { BudgetState } from "@/lib/types";
import { BackLink, ErrorNote, Loading } from "../bits";

/** Расходы: месяц и лимит, по книгам, последние обращения к Anthropic. */
export default function SpendScreen() {
  const [data, setData] = useState<SpendView | null>(null);
  const [usdRub, setUsdRub] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let alive = true;
    setError(null);
    Promise.all([api.spend(), getSettingsCached()])
      .then(([d, s]) => {
        if (!alive) return;
        setUsdRub(s.usdRub);
        setData({ budget: d.budget, byBook: d.byBook ?? [], recent: d.recent ?? [] });
      })
      .catch((e) => alive && setError(errorText(e)));
    return () => {
      alive = false;
    };
  }, [reload]);

  return (
    <main className="page">
      <BackLink href="/settings">Настройки</BackLink>
      <div className="page-head">
        <h1 className="display">Расходы</h1>
      </div>
      {error && <ErrorNote text={error} onRetry={() => setReload((n) => n + 1)} />}
      {!data && !error && <Loading />}
      {data && usdRub !== null && (
        <div className="stack-lg">
          <BudgetCard budget={data.budget} usdRub={usdRub} />

          <section className="stack-sm" aria-labelledby="by-book">
            <h2 id="by-book" className="label">
              По книгам за месяц
            </h2>
            {data.byBook.length === 0 ? (
              <p className="p">В этом месяце ещё ничего не переводилось.</p>
            ) : (
              <ByBook items={data.byBook} usdRub={usdRub} />
            )}
          </section>

          <section className="stack-sm" aria-labelledby="recent">
            <h2 id="recent" className="label">
              Последние обращения к Anthropic
            </h2>
            {data.recent.length === 0 ? (
              <p className="p">Пока ничего.</p>
            ) : (
              <ul className="table-list">
                {data.recent.map((c, i) => (
                  <li key={`${c.createdAt}-${i}`}>
                    <span className="grow stack-sm" style={{ gap: 2 }}>
                      <span style={{ overflowWrap: "anywhere" }}>
                        {c.chapterId ? (
                          <Link href={`/read/${encodeURIComponent(c.chapterId)}`}>{c.chapterTitle || "Глава"}</Link>
                        ) : (
                          c.chapterTitle || purposeLabel(c.purpose)
                        )}
                      </span>
                      <span className="tiny dim">
                        {dateTime(c.createdAt)} · {modelLabel(c.model)}
                        {c.purpose ? ` · ${purposeLabel(c.purpose)}` : ""}
                        {c.batch ? " · со скидкой" : ""}
                      </span>
                    </span>
                    <span className="nums nowrap">{rubBare(c.usd, usdRub)}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <p className="hint">
            Рубли — примерный пересчёт по курсу из настроек ({usdRub} ₽ за доллар). Точная сумма в долларах — в
            Anthropic Console → Cost (platform.claude.com).
          </p>
        </div>
      )}
    </main>
  );
}

export function BudgetCard({ budget, usdRub }: { budget: BudgetState; usdRub: number }) {
  const sh = budgetShares(budget);
  const left = Math.max(0, budget.limitUsd - budget.spentUsd - budget.reservedUsd);
  return (
    <section className="card stack-sm" aria-label="Лимит месяца">
      <div className="row-between">
        <span className="label">{monthName(budget.month)}</span>
        <span className="small muted">лимит {rubBare(budget.limitUsd, usdRub)}</span>
      </div>
      <div className="row" style={{ alignItems: "baseline", gap: 8 }}>
        <span className="display" style={{ fontSize: 30 }}>
          {rub(budget.spentUsd, usdRub)}
        </span>
        <span className="muted">потрачено</span>
      </div>
      <div
        className="meter"
        role="meter"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round((sh.spent + sh.reserved) * 100)}
        aria-label="Доля месячного лимита"
      >
        <span className="spent" style={{ width: `${sh.spent * 100}%` }} />
        <span className="reserved" style={{ left: `${sh.spent * 100}%`, width: `${sh.reserved * 100}%` }} />
      </div>
      <div className="facts">
        {budget.reservedUsd > 0 && <span>ещё {rubBare(budget.reservedUsd, usdRub)} — под идущие переводы</span>}
        <span>
          осталось <strong>{rubBare(left, usdRub)}</strong>
        </span>
      </div>
      {sh.over && (
        <p className="small" style={{ margin: 0, color: "var(--danger-ink)" }}>
          Лимит исчерпан — новые переводы ждут. Поднять его можно в <Link href="/settings">настройках</Link>.
        </p>
      )}
    </section>
  );
}

function ByBook({ items, usdRub }: { items: SpendView["byBook"]; usdRub: number }) {
  const max = items.reduce((m, b) => Math.max(m, b.usd || 0), 0) || 1;
  return (
    <div className="stack">
      {items.map((b, i) => (
        <div className="bar-row" key={b.bookId ?? `none-${i}`}>
          <span style={{ overflowWrap: "anywhere" }}>
            {b.bookId ? (
              <Link href={`/book/${encodeURIComponent(b.bookId)}`}>{b.title || "Книга"}</Link>
            ) : (
              b.title || "Без книги"
            )}
          </span>
          <span className="nums nowrap">{rubBare(b.usd, usdRub)}</span>
          <div className="meter" aria-hidden="true">
            <span className="spent" style={{ width: `${Math.max(2, ((b.usd || 0) / max) * 100)}%` }} />
          </div>
        </div>
      ))}
    </div>
  );
}

function purposeLabel(p: string | undefined): string {
  if (!p) return "Обращение";
  if (/translat/i.test(p)) return "перевод";
  if (/extract|term/i.test(p)) return "поиск имён";
  if (/polish|check|review/i.test(p)) return "проверка";
  return p;
}
