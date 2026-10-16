/**
 * Человеческие слова для остановленной задачи перевода и для отказов
 * открыть страницу. Никогда не обещаем «денег не потратили» — часть
 * главы могла быть уже переведена и оплачена.
 */

import type { ErrorCode, Job } from "../types";

export type ProblemKind = "budget" | "credit" | "console" | "auth" | "refused" | "temporary" | "too_large" | "other";

export interface ProblemText {
  kind: ProblemKind;
  title: string;
  text: string;
  /** Показать «Повторить» (заново поставить перевод). */
  retry: boolean;
  /** Показать «Продолжить» (снять блокировку бюджета/баланса). */
  resume: boolean;
}

export function describeJobProblem(job: Pick<Job, "state" | "errorCode" | "errorMessage">): ProblemText {
  const code: ErrorCode | null = job.errorCode;
  if (job.state === "blocked_budget" || code === "budget_limit") {
    return {
      kind: "budget",
      title: "Месячный лимит исчерпан",
      text: "Поднимите лимит в настройках и нажмите «Продолжить».",
      retry: false,
      resume: true,
    };
  }
  if (job.state === "blocked_credit" || code === "credit_low") {
    return {
      kind: "credit",
      title: "На счёте Anthropic закончились деньги",
      text: "Пополните баланс: platform.claude.com → Billing. Уже переведённое читается как обычно.",
      retry: false,
      resume: true,
    };
  }
  switch (code) {
    case "console_limit":
      return {
        kind: "console",
        title: "Сработал лимит трат в Anthropic",
        text: "В Anthropic Console стоит месячный лимит трат, и он исчерпан. Поднимите его: platform.claude.com → Settings → Limits, потом нажмите «Повторить».",
        retry: true,
        resume: false,
      };
    case "auth":
      return {
        kind: "auth",
        title: "Ключ Anthropic не подходит",
        text: "Проверьте ANTHROPIC_API_KEY в настройках Vercel: проект → Settings → Environment Variables. После правки перевыложите проект.",
        retry: true,
        resume: false,
      };
    case "refused":
      return {
        kind: "refused",
        title: "Модель отказалась переводить часть главы",
        text: "Повторы другой моделью не помогли. Переведённое — ниже; на месте пропусков показан оригинал.",
        retry: true,
        resume: false,
      };
    case "network":
    case "overloaded":
    case "rate_limit":
      return {
        kind: "temporary",
        title: "Не получилось связаться с Anthropic",
        text: "Так бывает: сервис перегружен или связь оборвалась. Попробую ещё раз — нажмите «Повторить».",
        retry: true,
        resume: false,
      };
    case "too_large":
      return {
        kind: "too_large",
        title: "Глава слишком большая",
        text: "Такой объём за раз не переводится. Если это несколько глав подряд — добавьте их по одной.",
        retry: false,
        resume: false,
      };
    default:
      return {
        kind: "other",
        title: "Перевод остановился",
        text: job.errorMessage
          ? `Что случилось: ${job.errorMessage}. Можно попробовать ещё раз; если повторится — нажмите «Что-то не так».`
          : "Можно попробовать ещё раз; если повторится — нажмите «Что-то не так».",
        retry: true,
        resume: false,
      };
  }
}

/** Как объяснить ответ «сайт не пускает» — общие слова для «Ссылки» и «Поделиться». */
export const SITE_BLOCKED_HELP =
  "Откройте главу на сайте в этом браузере и нажмите кнопку «Т» в углу страницы — она возьмёт текст прямо из браузера. " +
  "Или выделите весь текст главы и нажмите «Поделиться» → «Толмач», или вставьте его на вкладке «Текст».";
