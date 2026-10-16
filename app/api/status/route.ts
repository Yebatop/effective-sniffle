import { db, databaseUrl } from "@/lib/db/client";
import { getSettings } from "@/lib/db/misc";
import { budgetState } from "@/lib/db/money";
import { staleJobs } from "@/lib/db/jobs";
import { checkKey } from "@/lib/server/anthropic";
import { appPassword } from "@/lib/server/auth";
import { json } from "@/lib/server/http";
import type { StatusView } from "@/lib/types";

export async function GET() {
  const checks: StatusView["checks"] = [];
  let budget: StatusView["budget"] = { month: "", limitUsd: 0, spentUsd: 0, reservedUsd: 0 };

  checks.push({ key: "password", ok: Boolean(appPassword()), label: "Пароль для входа задан" });

  if (!databaseUrl()) {
    checks.push({ key: "db", ok: false, label: "База подключена", detail: "Нет строки подключения: в Vercel → Storage подключите Neon и перевыложите." });
  } else {
    try {
      const d = await db();
      await d.query("select 1");
      checks.push({ key: "db", ok: true, label: "База подключена" });
      const settings = await getSettings(d);
      budget = await budgetState(d, settings.monthlyLimitRub / settings.usdRub);
      checks.push({
        key: "model",
        ok: Boolean(settings.translateModel),
        label: "Модель перевода выбрана",
        detail: settings.translateModel ? undefined : "Выберите в настройках.",
      });
      const left = budget.limitUsd - budget.spentUsd - budget.reservedUsd;
      checks.push({
        key: "budget",
        ok: left > 0,
        label: "Месячный лимит не исчерпан",
        detail: `Осталось ≈ ${Math.max(0, left * settings.usdRub).toFixed(0)} ₽ из ${settings.monthlyLimitRub} ₽.`,
      });
      const stale = await staleJobs(d);
      checks.push({
        key: "jobs",
        ok: stale.length === 0,
        label: "Нет зависших переводов",
        detail: stale.length ? `Ждут продолжения: ${stale.length}. Откройте главу — перевод продолжится.` : undefined,
      });
    } catch (e) {
      checks.push({ key: "db", ok: false, label: "База подключена", detail: e instanceof Error ? e.message : String(e) });
    }
  }

  const key = await checkKey();
  checks.push({ key: "anthropic", ok: key.ok, label: "Ключ Anthropic работает", detail: key.message });

  const view: StatusView = {
    version: process.env.NEXT_PUBLIC_APP_VERSION ?? "0.0.0",
    commit: process.env.NEXT_PUBLIC_COMMIT ?? null,
    checks,
    budget,
  };
  return json(view);
}
