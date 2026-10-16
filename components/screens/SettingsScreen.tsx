"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { api, errorText, getSettingsCached, saveSettings } from "@/lib/client/api";
import { estimateRub, rub } from "@/lib/client/format";
import { estimateExtractionUsd } from "@/lib/core/cost";
import { THEMES, THEME_BG, THEME_LABELS, applyTheme, currentTheme, type ThemeName } from "@/lib/client/prefs";
import { MODELS, MODEL_IDS } from "@/lib/core/models";
import type { Effort, ModelId, Settings } from "@/lib/types";
import { ErrorNote, Loading, Switch } from "../bits";

/** Сколько слов в «типичной главе» для цены на карточке модели. */
const TYPICAL_WORDS = 1740;

const EFFORTS: Array<{ id: Effort; label: string; hint: string }> = [
  { id: "low", label: "быстрая", hint: "Быстрее и чуть дешевле, но небрежнее." },
  { id: "medium", label: "обычная", hint: "Хороший баланс — подходит почти всегда." },
  { id: "high", label: "повышенная", hint: "Модель дольше думает над фразами. Дороже и медленнее." },
];

type SaveState = { key: string; state: "busy" | "ok" | "error"; text?: string } | null;

/**
 * Настройки. Каждое изменение сохраняется сразу. При первом запуске
 * (/settings?first=1) сверху приветствие и обязательный выбор модели —
 * заранее ничего не выбрано.
 */
export default function SettingsScreen({ first }: { first: boolean }) {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [save, setSave] = useState<SaveState>(null);
  const [limit, setLimit] = useState("");
  const [rate, setRate] = useState("");
  const [theme, setTheme] = useState<ThemeName>("night");
  const [loggingOut, setLoggingOut] = useState(false);

  useEffect(() => {
    setTheme(currentTheme());
  }, []);

  useEffect(() => {
    let alive = true;
    setError(null);
    getSettingsCached()
      .then((s) => {
        if (!alive) return;
        setSettings(s);
        setLimit(String(s.monthlyLimitRub));
        setRate(String(s.usdRub));
      })
      .catch((e) => alive && setError(errorText(e)));
    return () => {
      alive = false;
    };
  }, [reload]);

  async function patch(key: string, p: Partial<Settings>) {
    if (!settings) return;
    const before = settings;
    setSettings({ ...settings, ...p });
    setSave({ key, state: "busy" });
    try {
      const s = await saveSettings(p);
      setSettings(s && typeof s === "object" && "usdRub" in s ? s : { ...before, ...p });
      setSave({ key, state: "ok" });
    } catch (e) {
      setSettings(before);
      setSave({ key, state: "error", text: errorText(e) });
    }
  }

  function saveNumber(key: "monthlyLimitRub" | "usdRub", raw: string, min: number, max: number) {
    if (!settings) return;
    const v = Number(raw.replace(",", ".").replace(/\s+/g, ""));
    if (!Number.isFinite(v) || v < min || v > max) {
      setSave({ key, state: "error", text: `Введите число от ${min} до ${max}.` });
      if (key === "monthlyLimitRub") setLimit(String(settings.monthlyLimitRub));
      else setRate(String(settings.usdRub));
      return;
    }
    const value = key === "monthlyLimitRub" ? Math.round(v) : Math.round(v * 100) / 100;
    if (value === settings[key]) return;
    void patch(key, { [key]: value } as Partial<Settings>);
  }

  async function logout() {
    setLoggingOut(true);
    try {
      await api.logout();
    } catch {
      // всё равно уходим на вход
    }
    window.location.href = "/login";
  }

  const mark = (key: string) =>
    save && save.key === key ? (
      <span
        className="tiny"
        role="status"
        style={{ color: save.state === "error" ? "var(--danger-ink)" : save.state === "ok" ? "var(--ok)" : "var(--muted)" }}
      >
        {save.state === "busy" ? "Сохраняю…" : save.state === "ok" ? "Сохранено ✓" : save.text}
      </span>
    ) : null;

  return (
    <main className="page">
      <div className="page-head">
        {first ? (
          <>
            <div className="label">Первый запуск</div>
            <h1 className="display">Выберите модель для перевода</h1>
            <p className="p">
              Модель — это то, кто переводит. Они отличаются качеством и ценой; платите вы сами, на счёт Anthropic.
              Выбор можно поменять в любой момент здесь же, в настройках.
            </p>
          </>
        ) : (
          <h1 className="display">Настройки</h1>
        )}
      </div>

      {error && <ErrorNote text={error} onRetry={() => setReload((n) => n + 1)} />}
      {!settings && !error && <Loading />}

      {settings && (
        <div className="stack-lg">
          <section className="stack-sm" aria-labelledby="model-head">
            <div className="row-between">
              <h2 id="model-head" className="label">
                Модель для перевода
              </h2>
              {mark("translateModel")}
            </div>
            <div className="stack-sm" role="radiogroup" aria-labelledby="model-head">
              {MODEL_IDS.map((id) => (
                <ModelCard
                  key={id}
                  id={id}
                  selected={settings.translateModel === id}
                  usdRub={settings.usdRub}
                  effort={settings.translateEffort}
                  extractModel={settings.extractModel}
                  onPick={() => void patch("translateModel", { translateModel: id })}
                />
              ))}
            </div>
            <p className="hint">Цена — примерная, за главу около {TYPICAL_WORDS.toLocaleString("ru-RU")} слов.</p>
            {first && settings.translateModel && (
              <Link className="btn btn-primary btn-big btn-block" href="/">
                Готово — в библиотеку
              </Link>
            )}
          </section>

          <section className="stack" aria-label="Тонкости перевода">
            <label className="field">
              <span className="row-between">
                <span>Модель для поиска имён и терминов</span>
                {mark("extractModel")}
              </span>
              <select
                className="select"
                value={settings.extractModel}
                onChange={(e) => void patch("extractModel", { extractModel: e.currentTarget.value as ModelId })}
              >
                {MODEL_IDS.map((id) => (
                  <option key={id} value={id}>
                    {MODELS[id].label}
                  </option>
                ))}
              </select>
              <span className="hint">
                Перед переводом Толмач находит в главе имена и названия, чтобы переводить их везде одинаково. Это
                добавляет к главе {extractRub(settings.extractModel, settings.usdRub) ?? "немного"} — цены моделей
                выше уже с этим.
              </span>
            </label>

            <div className="field">
              <span className="row-between">
                <span id="effort-label">Тщательность перевода</span>
                {mark("translateEffort")}
              </span>
              <div className="segments" role="group" aria-labelledby="effort-label">
                {EFFORTS.map((e) => (
                  <button
                    key={e.id}
                    type="button"
                    aria-pressed={settings.translateEffort === e.id}
                    onClick={() => void patch("translateEffort", { translateEffort: e.id })}
                  >
                    {e.label}
                  </button>
                ))}
              </div>
              <span className="hint">{EFFORTS.find((e) => e.id === settings.translateEffort)?.hint}</span>
            </div>

            <div>
              <Switch
                checked={settings.autostart}
                onChange={(v) => void patch("autostart", { autostart: v })}
                label="Переводить сразу, без карточки с ценой"
                hint="Открыли непереведённую главу — перевод начинается сам. Лимит месяца всё равно действует."
              />
              {mark("autostart")}
            </div>
          </section>

          <section className="stack" aria-label="Деньги">
            <h2 className="label">Деньги</h2>
            <label className="field">
              <span className="row-between">
                <span>Месячный лимит, ₽</span>
                {mark("monthlyLimitRub")}
              </span>
              <input
                className="input"
                inputMode="numeric"
                value={limit}
                onChange={(e) => setLimit(e.currentTarget.value)}
                onBlur={() => saveNumber("monthlyLimitRub", limit, 0, 1_000_000)}
                onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
              />
              <span className="hint">
                Больше этого Толмач за месяц не потратит: перевод остановится и спросит вас.
              </span>
            </label>
            <label className="field">
              <span className="row-between">
                <span>Курс доллара, ₽</span>
                {mark("usdRub")}
              </span>
              <input
                className="input"
                inputMode="decimal"
                value={rate}
                onChange={(e) => setRate(e.currentTarget.value)}
                onBlur={() => saveNumber("usdRub", rate, 1, 10_000)}
                onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
              />
              <span className="hint">Anthropic берёт оплату в долларах; рубли в Толмаче — пересчёт по этому курсу.</span>
            </label>
            <Link href="/spend" className="btn">
              Расходы за месяц
            </Link>
          </section>

          <section className="stack-sm" aria-labelledby="theme-head">
            <h2 id="theme-head" className="label">
              Оформление
            </h2>
            <div className="swatches" role="group" aria-labelledby="theme-head">
              {THEMES.map((t) => (
                <button
                  key={t}
                  type="button"
                  className="swatch"
                  aria-pressed={theme === t}
                  onClick={() => {
                    applyTheme(t);
                    setTheme(t);
                  }}
                >
                  <i style={{ background: THEME_BG[t] }} aria-hidden="true" />
                  {THEME_LABELS[t]}
                </button>
              ))}
            </div>
            <p className="hint">Запоминается в этом браузере.</p>
          </section>

          <section aria-label="Ещё">
            <ul className="menu-list">
              <li>
                <Link href="/button">Кнопка «Т» для сайтов</Link>
              </li>
              <li>
                <Link href="/spend">Расходы</Link>
              </li>
              <li>
                <Link href="/status">Проверка: всё ли работает</Link>
              </li>
              <li>
                <button type="button" onClick={() => void logout()} disabled={loggingOut}>
                  {loggingOut ? "Выхожу…" : "Выйти"}
                </button>
              </li>
            </ul>
          </section>
        </div>
      )}
    </main>
  );
}

function ModelCard({
  id,
  selected,
  usdRub,
  effort,
  extractModel,
  onPick,
}: {
  id: ModelId;
  selected: boolean;
  usdRub: number;
  effort: Effort;
  extractModel: ModelId;
  onPick: () => void;
}) {
  const spec = MODELS[id];
  // Цена — вместе с поиском имён: именно столько спишется за главу.
  const price = estimateRub(id, TYPICAL_WORDS, usdRub, effort, extractModel);
  return (
    <button type="button" role="radio" aria-checked={selected} className="choice" onClick={onPick}>
      <span className="choice-title">
        <span>{spec.label}</span>
        {price && <span className="small muted nums" style={{ fontWeight: 500 }}>глава {price}</span>}
      </span>
      <span className="choice-sub">{spec.blurb}</span>
    </button>
  );
}

/** Сколько добавляет к главе поиск имён выбранной моделью. */
function extractRub(model: ModelId, usdRub: number): string | null {
  try {
    return rub(estimateExtractionUsd(model, TYPICAL_WORDS), usdRub);
  } catch {
    return null;
  }
}
