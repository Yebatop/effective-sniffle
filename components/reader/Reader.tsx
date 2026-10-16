"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, errorText, getSettingsCached, type SpendView } from "@/lib/client/api";
import { estimateRub, modelLabel, num, plural, rub } from "@/lib/client/format";
import { compileTerms } from "@/lib/client/highlight";
import {
  DEFAULT_READER_PREFS,
  LINE_HEIGHTS,
  applyTheme,
  currentTheme,
  loadReaderPrefs,
  saveReaderPrefs,
  type ReaderPrefs,
  type ThemeName,
} from "@/lib/client/prefs";
import { describeJobProblem, type ProblemText } from "@/lib/client/problems";
import {
  isLiveJobState,
  isStoppedJobState,
  maxSeq,
  mergeTranslated,
  minutesLeft,
  orderedParagraphs,
} from "@/lib/client/reading";
import type { ChapterView, ErrorCode, Job, ReportRequest, Settings, Term, TranslatedParagraph } from "@/lib/types";
import { Icon } from "../Icon";
import ReportSheet from "../ReportSheet";
import Sheet from "../Sheet";
import { ErrorNote, Loading } from "../bits";
import ChapterText from "./ChapterText";
import NeighborNav from "./NeighborNav";
import ReaderSettingsSheet from "./ReaderSettingsSheet";
import TermCard from "./TermCard";
import { useHideOnScroll, useWakeLock } from "./hooks";

const POLL_MS = 1500;
const POSITION_DEBOUNCE_MS = 2000;
const BAR_OFFSET = 64;

type SheetName = null | "aa" | "menu" | "report";

/**
 * Читалка. Клиентский компонент: глава рисуется из JSON /api/chapters/:id —
 * тем же кодом позже будет рисоваться из IndexedDB без сети (ARCH.md).
 *
 * Компонент монтируется заново на каждую главу (key={id} в странице), так
 * что от прошлой главы ничего не остаётся.
 */
export default function Reader({ chapterId }: { chapterId: string }) {
  const [view, setView] = useState<ChapterView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [settings, setSettings] = useState<Settings | null>(null);

  const [translated, setTranslated] = useState<Map<number, TranslatedParagraph>>(() => new Map());
  const [jobId, setJobId] = useState<string | null>(null);
  const [job, setJob] = useState<Job | null>(null);
  const [jobCost, setJobCost] = useState(0);
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<{ code: ErrorCode; message: string } | null>(null);
  const [pollTrouble, setPollTrouble] = useState(false);
  const [resumeNote, setResumeNote] = useState<string | null>(null);
  const [resuming, setResuming] = useState(false);
  const [spend, setSpend] = useState<SpendView | null>(null);

  const [open, setOpen] = useState<Set<number>>(() => new Set());
  const [term, setTerm] = useState<Term | null>(null);
  const [sheet, setSheet] = useState<SheetName>(null);
  const [reportKind, setReportKind] = useState<ReportRequest["kind"]>("other");
  const [prefs, setPrefs] = useState<ReaderPrefs>(DEFAULT_READER_PREFS);
  const [theme, setThemeState] = useState<ThemeName>("night");
  const [topIdx, setTopIdx] = useState(1);

  const seqRef = useRef(0);
  const startingRef = useRef(false);
  const autoStartedFor = useRef<string | null>(null);
  const doneHandledFor = useRef<string | null>(null);
  const progressRef = useRef<HTMLSpanElement>(null);
  const articleRef = useRef<HTMLDivElement>(null);
  const restoredRef = useRef(false);
  const lastPostedIdx = useRef<number | null>(null);

  const wakeSupported = useWakeLock(prefs.keepAwake);
  const barHidden = useHideOnScroll(sheet !== null || term !== null);

  // ── Вид: из браузера, уже после первой отрисовки (без расхождения с сервером).
  useEffect(() => {
    setPrefs(loadReaderPrefs());
    setThemeState(currentTheme());
    const onTheme = () => setThemeState(currentTheme());
    window.addEventListener("tolmach:theme", onTheme);
    return () => window.removeEventListener("tolmach:theme", onTheme);
  }, []);

  const changePrefs = useCallback((p: ReaderPrefs) => {
    setPrefs(p);
    saveReaderPrefs(p);
  }, []);
  const changeTheme = useCallback((t: ThemeName) => {
    applyTheme(t);
    setThemeState(t);
  }, []);

  // ── Загрузка главы.
  const applyView = useCallback((v: ChapterView) => {
    setView(v);
    const tr = v.translation;
    const liveOther =
      v.job && isLiveJobState(v.job.state) && v.job.translationId && tr && v.job.translationId !== tr.id;
    const paras = tr && !liveOther ? tr.paragraphs : [];
    setTranslated(mergeTranslated(new Map(), paras));
    seqRef.current = maxSeq(paras);
    if (v.job && (isLiveJobState(v.job.state) || isStoppedJobState(v.job.state))) {
      setJobId(v.job.id);
      setJob(v.job);
    } else {
      setJobId(null);
      setJob(v.job);
    }
  }, []);

  useEffect(() => {
    let alive = true;
    setLoadError(null);
    Promise.all([api.chapter(chapterId), getSettingsCached().catch(() => null)])
      .then(([v, s]) => {
        if (!alive) return;
        setSettings(s);
        applyView(v);
      })
      .catch((e) => alive && setLoadError(errorText(e)));
    return () => {
      alive = false;
    };
  }, [chapterId, reloadKey, applyView]);

  const hasBody = useMemo(() => {
    for (const k of translated.keys()) if (k >= 1) return true;
    return false;
  }, [translated]);

  const live = starting || (!!jobId && (job === null || isLiveJobState(job.state)));

  // ── Запуск перевода. Сторож — по главе целиком: двойной эффект строгого
  // режима и двойное нажатие не дают второго запроса (сервер тоже идемпотентен).
  const startTranslate = useCallback(async () => {
    if (startingRef.current) return;
    startingRef.current = true;
    setStarting(true);
    setStartError(null);
    setResumeNote(null);
    try {
      const s = settings ?? (await getSettingsCached().catch(() => null));
      const r = await api.translate(chapterId, s?.translateModel ? { model: s.translateModel } : {});
      if (r.ok) {
        seqRef.current = 0;
        doneHandledFor.current = null;
        setJob(null);
        setJobId(r.jobId);
      } else {
        setStartError({ code: r.code, message: r.message });
      }
    } catch (e) {
      setStartError({ code: "unknown", message: errorText(e) });
    } finally {
      startingRef.current = false;
      setStarting(false);
    }
  }, [chapterId, settings]);

  // Автостарт: только для главы, которую ещё ни разу не пробовали перевести.
  useEffect(() => {
    if (!view || !settings || !settings.autostart || !settings.translateModel) return;
    if (autoStartedFor.current === chapterId) return;
    if (view.translation || view.job) return;
    autoStartedFor.current = chapterId;
    void startTranslate();
  }, [view, settings, chapterId, startTranslate]);

  // ── Опрос задачи: раз в 1,5 с, только пока вкладка на экране.
  const polling = !!jobId && (job === null || isLiveJobState(job.state));
  useEffect(() => {
    if (!jobId || !polling) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let inflight = false;
    let failures = 0;
    const controller = typeof AbortController !== "undefined" ? new AbortController() : null;

    const schedule = () => {
      if (cancelled || timer !== null) return;
      const delay = failures === 0 ? POLL_MS : Math.min(15000, POLL_MS * Math.pow(2, failures));
      timer = setTimeout(() => {
        timer = null;
        void tick();
      }, delay);
    };

    const tick = async () => {
      if (cancelled || inflight) return;
      if (document.visibilityState !== "visible") return; // продолжим на visibilitychange
      inflight = true;
      let stop = false;
      try {
        const r = await api.job(jobId, seqRef.current, controller?.signal);
        if (cancelled) return;
        failures = 0;
        setPollTrouble(false);
        if (r.paragraphs && r.paragraphs.length) {
          setTranslated((m) => mergeTranslated(m, r.paragraphs));
        }
        seqRef.current = Math.max(seqRef.current, r.seq || 0, maxSeq(r.paragraphs || []));
        setJob(r.job);
        setJobCost(r.costUsd || 0);
        if (!isLiveJobState(r.job.state)) stop = true;
      } catch (e) {
        if (cancelled || (e && (e as { name?: string }).name === "AbortError")) return;
        failures += 1;
        if (failures >= 2) setPollTrouble(true);
      } finally {
        inflight = false;
      }
      if (!stop) schedule();
    };

    const onVisibility = () => {
      if (document.visibilityState === "visible" && timer === null && !inflight) void tick();
    };
    document.addEventListener("visibilitychange", onVisibility);
    void tick();
    return () => {
      cancelled = true;
      if (timer !== null) clearTimeout(timer);
      controller?.abort();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [jobId, polling]);

  // Перевод остановился (ошибка, лимит, деньги на счёте) — показать то, что
  // уже переведено и оплачено, и сколько это стоило. Иначе после перезагрузки
  // страницы готовые абзацы и потраченное не видны вовсе.
  const partialLoadedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!job || polling || !job.translationId || view?.translation) return;
    if (partialLoadedFor.current === job.id) return;
    partialLoadedFor.current = job.id;
    api
      .job(job.id, 0)
      .then((r) => {
        if (r.paragraphs?.length) setTranslated((m) => mergeTranslated(m, r.paragraphs));
        seqRef.current = Math.max(seqRef.current, r.seq || 0);
        setJobCost(r.costUsd || 0);
      })
      .catch(() => undefined);
  }, [job, polling, view]);

  // Готово — перечитать главу целиком (чистовой текст, термины, «Дальше»).
  useEffect(() => {
    if (!job || job.state !== "done" || doneHandledFor.current === job.id) return;
    doneHandledFor.current = job.id;
    api
      .chapter(chapterId)
      .then((v) => applyView(v))
      .catch(() => undefined);
  }, [job, chapterId, applyView]);

  // Бюджет для карточки «лимит исчерпан».
  const blockedBudget = job?.state === "blocked_budget" || startError?.code === "budget_limit";
  useEffect(() => {
    if (!blockedBudget) return;
    api
      .spend()
      .then(setSpend)
      .catch(() => undefined);
  }, [blockedBudget]);

  async function resume() {
    setResuming(true);
    setResumeNote(null);
    try {
      const r = await api.unblockBudget();
      const ok = typeof r.unblocked === "number" ? r.unblocked > 0 : !!r.unblocked;
      if (!ok) {
        setResumeNote("Пока не пускает: лимит всё ещё исчерпан или баланс не пополнен. Поднимите лимит в настройках или пополните счёт и нажмите ещё раз.");
        return;
      }
      if (jobId && job) {
        setJob({ ...job, state: "queued", errorCode: null, errorMessage: null });
      } else {
        setStartError(null);
        await startTranslate();
      }
    } catch (e) {
      setResumeNote(errorText(e));
    } finally {
      setResuming(false);
    }
  }

  // ── Место чтения: верхний видимый абзац; через 2 с тишины — на сервер.
  const shownCount = translated.size;
  useEffect(() => {
    const root = articleRef.current;
    if (!root || typeof IntersectionObserver === "undefined") return;
    const visible = new Set<number>();
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          const idx = Number((e.target as HTMLElement).dataset.idx);
          if (!Number.isFinite(idx)) continue;
          if (e.isIntersecting) visible.add(idx);
          else visible.delete(idx);
        }
        if (visible.size === 0) return;
        let min = Infinity;
        visible.forEach((i) => {
          if (i < min) min = i;
        });
        setTopIdx(min);
      },
      { rootMargin: `-${BAR_OFFSET}px 0px 0px 0px`, threshold: 0 },
    );
    root.querySelectorAll<HTMLElement>("[data-idx]").forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, [shownCount, view]);

  // Вернуться туда, где остановились (один раз, если человек ещё не листал).
  useEffect(() => {
    if (restoredRef.current || !view) return;
    const target = view.position?.paragraphIdx ?? 0;
    if (target <= 1) {
      if (hasBody || !live) restoredRef.current = true;
      return;
    }
    const el = articleRef.current?.querySelector<HTMLElement>(`[data-idx="${target}"]`);
    if (!el) return;
    restoredRef.current = true;
    if (window.scrollY > 120) return;
    const y = el.getBoundingClientRect().top + window.scrollY - BAR_OFFSET - 8;
    window.scrollTo(0, Math.max(0, y));
  }, [view, shownCount, hasBody, live]);

  useEffect(() => {
    if (!view || !restoredRef.current || !hasBody) return;
    if (lastPostedIdx.current === topIdx) return;
    const t = setTimeout(() => {
      lastPostedIdx.current = topIdx;
      api
        .position({ bookId: view.book.id, chapterId, paragraphIdx: topIdx, device: deviceLabel() })
        .catch(() => {
          lastPostedIdx.current = null;
        });
    }, POSITION_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [topIdx, view, chapterId, hasBody]);

  // ── Полоса прочитанного: без перерисовки React, прямо в DOM.
  useEffect(() => {
    let frame = 0;
    const measure = () => {
      frame = 0;
      const h = document.documentElement.scrollHeight - window.innerHeight;
      const f = h > 40 ? Math.min(1, Math.max(0, window.scrollY / h)) : 0;
      if (progressRef.current) progressRef.current.style.transform = `scaleX(${f})`;
    };
    const onScroll = () => {
      if (!frame) frame = window.requestAnimationFrame(measure);
    };
    measure();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, [shownCount]);

  // ── Подсветка терминов: регулярка собирается один раз на список.
  const compiled = useMemo(() => compileTerms(view?.terms ?? []), [view?.terms]);
  const toggle = useCallback((idx: number) => {
    setOpen((s) => {
      const n = new Set(s);
      if (n.has(idx)) n.delete(idx);
      else n.add(idx);
      return n;
    });
  }, []);
  const pickTerm = useCallback((t: Term) => setTerm(t), []);

  const originals = useMemo(
    () => (view ? view.paragraphs.filter((p) => p.idx >= 1).sort((a, b) => a.idx - b.idx) : []),
    [view],
  );
  const orderedTr = useMemo(() => orderedParagraphs(translated), [translated]);

  const snapshot = useCallback(
    () => ({
      chapterId,
      url: view?.chapter.url ?? null,
      bookId: view?.book.id ?? null,
      paragraphs: view?.paragraphs.length ?? 0,
      translatedCount: translated.size,
      translationId: view?.translation?.id ?? null,
      jobId,
      jobState: job?.state ?? null,
      errorCode: job?.errorCode ?? startError?.code ?? null,
      errorMessage: job?.errorMessage ?? startError?.message ?? null,
      userAgent: typeof navigator !== "undefined" ? navigator.userAgent : null,
      appVersion: process.env.NEXT_PUBLIC_APP_VERSION ?? null,
      commit: process.env.NEXT_PUBLIC_COMMIT ?? null,
      page: typeof location !== "undefined" ? location.pathname : null,
    }),
    [chapterId, view, translated, jobId, job, startError],
  );

  function openReport(kind: ReportRequest["kind"]) {
    setReportKind(kind);
    setSheet("report");
  }

  // ── Отрисовка.
  if (loadError) {
    return (
      <main className="page page-narrow">
        <div className="stack">
          <h1 className="display">Глава не открылась</h1>
          <ErrorNote text={loadError} onRetry={() => setReloadKey((k) => k + 1)} />
          <Link href="/" className="btn">
            В библиотеку
          </Link>
        </div>
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

  const { chapter, book } = view;
  const titleTr = translated.get(0);
  const heading = titleTr && !titleTr.refused ? titleTr.text : chapter.titleSrc;
  const usdRub = settings?.usdRub ?? 92;
  const doneTranslation = !live && view.translation?.status === "done";
  const showMissing = doneTranslation && !(job && isStoppedJobState(job.state));
  const minutes = hasBody ? minutesLeft(orderedTr, topIdx) : 0;
  const totalMinutes = hasBody ? minutesLeft(orderedTr, 1) : 0;
  const stopped = job && isStoppedJobState(job.state) ? job : null;
  const problem: ProblemText | null = stopped
    ? describeJobProblem(stopped)
    : startError
      ? describeJobProblem({ state: "failed", errorCode: startError.code, errorMessage: startError.message })
      : null;
  const showStart = !hasBody && !live && !stopped && !startError;

  const estimateText = view.estimate
    ? rub(view.estimate.usd, usdRub)
    : estimateRub(settings?.translateModel, chapter.words, usdRub, settings?.translateEffort, settings?.extractModel);
  const estimateModel = view.estimate?.model ?? settings?.translateModel ?? null;

  const style = {
    "--read-size": `${prefs.fontSize}px`,
    "--read-lh": String(LINE_HEIGHTS[prefs.lineHeight] ?? 1.75),
  } as React.CSSProperties;

  return (
    <div className="reader" data-font={prefs.font} style={style}>
      <div className="reader-progress" aria-hidden="true">
        <span ref={progressRef} style={{ transform: "scaleX(0)" }} />
      </div>

      <header className="reader-bar" data-hidden={barHidden ? "true" : "false"}>
        <Link href={`/book/${encodeURIComponent(book.id)}`} className="icon-btn" aria-label="К оглавлению книги">
          <Icon name="back" />
        </Link>
        <div className="reader-bar-title">
          <span className="t1">{book.title}</span>
          <span className="t2">
            {chapter.number !== null ? `Глава ${chapter.number}` : ""}
            {minutes > 0 ? `${chapter.number !== null ? " · " : ""}до конца главы ≈ ${minutes} мин` : ""}
          </span>
        </div>
        <button type="button" className="icon-btn reader-aa" aria-label="Вид текста" onClick={() => setSheet("aa")}>
          Aa
        </button>
        <button type="button" className="icon-btn" aria-label="Меню главы" onClick={() => setSheet("menu")}>
          <Icon name="more" />
        </button>
      </header>

      <main className="reader-body">
        <div className="chapter-head">
          {chapter.number !== null && <div className="label">Глава {chapter.number}</div>}
          <h1>{heading}</h1>
          <div className="facts">
            {doneTranslation && (
              <span className="row" style={{ gap: 7 }}>
                <span className="dot" aria-hidden="true" /> переведено
              </span>
            )}
            <span>
              {num(chapter.words)} {plural(chapter.words, "слово", "слова", "слов")} в оригинале
            </span>
            {totalMinutes > 0 && <span>≈ {totalMinutes} мин чтения</span>}
          </div>
        </div>

        {showStart && (
          <section className="card start-card" aria-label="Перевод главы">
            <p className="p">Эта глава ещё не переведена.</p>
            {estimateText && (
              <div>
                <div className="start-price">{estimateText}</div>
                <div className="small muted">
                  примерная цена{estimateModel ? ` · ${modelLabel(estimateModel)}` : ""}
                </div>
              </div>
            )}
            {settings && !settings.translateModel ? (
              <Link className="btn btn-primary btn-big btn-block" href="/settings?first=1">
                Сначала выбрать модель
              </Link>
            ) : (
              <button
                type="button"
                className="btn btn-primary btn-big btn-block"
                onClick={() => void startTranslate()}
                disabled={starting}
              >
                Перевести
              </button>
            )}
            <div className="row">
              <button type="button" className="btn grow" onClick={() => openReport("wrong_text")}>
                Не та глава / что-то не так
              </button>
              {chapter.url && (
                <a className="btn grow" href={chapter.url} target="_blank" rel="noopener noreferrer">
                  Открыть на сайте
                </a>
              )}
            </div>
          </section>
        )}

        {live && (
          <p className="status-line" role="status" aria-live="polite">
            <span className="spinner" aria-hidden="true" />
            {statusText(job, starting)}
            {pollTrouble && <span className="dim"> · нет связи, пробую снова…</span>}
          </p>
        )}

        <div className="reading" ref={articleRef}>
          <ChapterText
            originals={originals}
            translated={translated}
            showMissing={showMissing}
            compiled={compiled}
            open={open}
            onToggle={toggle}
            onTerm={pickTerm}
          />
          {live && hasBody && <span className="cursor-blink" aria-hidden="true" />}
        </div>

        {problem && (
          <ProblemCard
            problem={problem}
            serverMessage={startError?.message ?? null}
            costUsd={jobCost}
            usdRub={usdRub}
            spend={spend}
            limitRub={settings?.monthlyLimitRub ?? null}
            busy={resuming || starting}
            note={resumeNote}
            onRetry={() => void startTranslate()}
            onResume={() => void resume()}
            onReport={() => openReport("error")}
          />
        )}

        {hasBody && !live && <NeighborNav next={view.next} prev={view.prev} bookId={book.id} settings={settings} />}

        {hasBody && (
          <p className="center" style={{ marginTop: 20 }}>
            <button type="button" className="btn btn-quiet" onClick={() => openReport("bad_translation")}>
              Что-то не так
            </button>
          </p>
        )}
      </main>

      <ReaderSettingsSheet
        open={sheet === "aa"}
        onClose={() => setSheet(null)}
        prefs={prefs}
        onPrefs={changePrefs}
        theme={theme}
        onTheme={changeTheme}
        wakeLockSupported={wakeSupported}
      />

      <Sheet open={sheet === "menu"} title="Глава" onClose={() => setSheet(null)}>
        <ul className="menu-list">
          <li>
            <Link href={`/book/${encodeURIComponent(book.id)}`}>Оглавление книги</Link>
          </li>
          <li>
            <Link href={`/book/${encodeURIComponent(book.id)}/glossary`}>Глоссарий: имена и термины</Link>
          </li>
          {chapter.url && (
            <li>
              <a href={chapter.url} target="_blank" rel="noopener noreferrer">
                Открыть на сайте
              </a>
            </li>
          )}
          <li>
            <button type="button" onClick={() => openReport("other")}>
              Что-то не так
            </button>
          </li>
          <li>
            <Link href="/">Библиотека</Link>
          </li>
        </ul>
      </Sheet>

      <ReportSheet
        open={sheet === "report"}
        onClose={() => setSheet(null)}
        chapterId={chapterId}
        initialKind={reportKind}
        snapshot={snapshot}
      />

      <TermCard term={term} onClose={() => setTerm(null)} />
    </div>
  );
}

function statusText(job: Job | null, starting: boolean): string {
  if (starting || !job) return "Запускаю перевод…";
  if (!job.termsExtracted) return "Ищу имена и термины…";
  const total = job.chunksTotal;
  if (total && total > 0) {
    const n = Math.min(total, Math.max(1, job.nextChunk + 1));
    return `Перевожу: часть ${n} из ${total}`;
  }
  return "Перевожу…";
}

function deviceLabel(): string {
  if (typeof navigator === "undefined") return "browser";
  return /Android|iPhone|iPad|Mobile/i.test(navigator.userAgent) ? "phone" : "desktop";
}

function ProblemCard({
  problem,
  serverMessage,
  costUsd,
  usdRub,
  spend,
  limitRub,
  busy,
  note,
  onRetry,
  onResume,
  onReport,
}: {
  problem: ProblemText;
  serverMessage: string | null;
  costUsd: number;
  usdRub: number;
  spend: SpendView | null;
  limitRub: number | null;
  busy: boolean;
  note: string | null;
  onRetry: () => void;
  onResume: () => void;
  onReport: () => void;
}) {
  let title = problem.title;
  if (problem.kind === "budget" && spend) {
    const spent = Math.round((spend.budget.spentUsd + spend.budget.reservedUsd) * usdRub);
    const limit = limitRub ?? Math.round(spend.budget.limitUsd * usdRub);
    title = `Месячный лимит исчерпан: потрачено ${num(spent)} из ${num(limit)} ₽`;
  }
  const extra =
    serverMessage && problem.kind === "other" && !problem.text.includes(serverMessage) ? serverMessage : null;
  return (
    <section className="problem-card" role="alert">
      <h2>{title}</h2>
      <p>{problem.text}</p>
      {extra && <p>{extra}</p>}
      {costUsd > 0 && <p className="small">На эту главу уже потрачено {rub(costUsd, usdRub)}.</p>}
      {note && <p className="small">{note}</p>}
      <div className="row">
        {problem.resume && (
          <button type="button" className="btn btn-primary" onClick={onResume} disabled={busy}>
            {busy ? "Проверяю…" : "Продолжить"}
          </button>
        )}
        {problem.kind === "budget" && (
          <Link className="btn" href="/settings">
            Настройки
          </Link>
        )}
        {problem.retry && (
          <button type="button" className="btn btn-primary" onClick={onRetry} disabled={busy}>
            {busy ? "Запускаю…" : "Повторить"}
          </button>
        )}
        <button type="button" className="btn btn-quiet" onClick={onReport}>
          Что-то не так
        </button>
      </div>
    </section>
  );
}
