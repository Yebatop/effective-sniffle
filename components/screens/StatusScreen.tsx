"use client";

import { useEffect, useState } from "react";
import { api, errorText, getSettingsCached } from "@/lib/client/api";
import type { StatusView } from "@/lib/types";
import { BackLink, ErrorNote, Loading } from "../bits";
import { BudgetCard } from "./SpendScreen";

/** «Проверка»: всё ли на месте — база, ключ Anthropic, лимит, задачи, версия. */
export default function StatusScreen() {
  const [data, setData] = useState<StatusView | null>(null);
  const [usdRub, setUsdRub] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let alive = true;
    setError(null);
    setBusy(true);
    api
      .status()
      .then((d) => alive && setData(d))
      .catch((e) => alive && setError(errorText(e)))
      .finally(() => alive && setBusy(false));
    getSettingsCached()
      .then((s) => alive && setUsdRub(s.usdRub))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [reload]);

  const mine = process.env.NEXT_PUBLIC_COMMIT || null;
  const allOk = data ? data.checks.every((c) => c.ok) : false;

  return (
    <main className="page">
      <BackLink href="/settings">Настройки</BackLink>
      <div className="page-head">
        <h1 className="display">Проверка</h1>
        <p className="p">Всё ли на месте. Здесь ничего не тратится.</p>
      </div>
      {error && <ErrorNote text={error} onRetry={() => setReload((n) => n + 1)} />}
      {!data && !error && <Loading text="Проверяю…" />}
      {data && (
        <div className="stack-lg">
          <div className={allOk ? "notice" : "notice notice-warn"} role="status">
            <p>{allOk ? "Всё в порядке ✓" : "Есть что поправить — смотрите строки с ✕."}</p>
          </div>
          <section aria-label="Проверки">
            {data.checks.map((c) => (
              <div className="check" key={c.key}>
                <span className={`check-mark ${c.ok ? "check-ok" : "check-bad"}`} aria-hidden="true">
                  {c.ok ? "✓" : "✕"}
                </span>
                <div className="grow stack-sm" style={{ gap: 2 }}>
                  <span>
                    <span className="sr-only">{c.ok ? "В порядке: " : "Проблема: "}</span>
                    {c.label}
                  </span>
                  {c.detail && (
                    <span className="small muted" style={{ overflowWrap: "anywhere" }}>
                      {c.detail}
                    </span>
                  )}
                </div>
              </div>
            ))}
          </section>

          {data.budget && usdRub !== null && <BudgetCard budget={data.budget} usdRub={usdRub} />}

          <section className="stack-sm" aria-label="Версия">
            <h2 className="label">Версия</h2>
            <ul className="table-list">
              <li>
                <span>Версия</span>
                <span className="nums">{data.version}</span>
              </li>
              <li>
                <span>Сборка на сервере</span>
                <span className="nums">{data.commit ? data.commit.slice(0, 7) : "—"}</span>
              </li>
              <li>
                <span>Сборка в этой вкладке</span>
                <span className="nums">{mine ? mine.slice(0, 7) : "—"}</span>
              </li>
            </ul>
            {mine && data.commit && mine !== data.commit && (
              <div className="notice notice-warn">
                <p>
                  Эта вкладка открыта на старой версии.{" "}
                  <button type="button" className="btn btn-small" onClick={() => window.location.reload()}>
                    Обновить
                  </button>
                </p>
              </div>
            )}
          </section>

          <button type="button" className="btn" onClick={() => setReload((n) => n + 1)} disabled={busy}>
            {busy ? "Проверяю…" : "Проверить ещё раз"}
          </button>
        </div>
      )}
    </main>
  );
}
