"use client";

import { useEffect, useRef, useState } from "react";
import { api } from "@/lib/client/api";

const CHECK_EVERY_MS = 10 * 60 * 1000;

/**
 * Плашка «Есть новая версия — обновить».
 *
 * Проверяем, когда человек возвращается во вкладку, не чаще раза в 10 минут
 * и никогда — при первой загрузке (только что загруженная страница и есть
 * свежая). База при этом не трогается: /api/version отвечает из сборки.
 */
export default function UpdateBanner() {
  const [stale, setStale] = useState(false);
  const lastCheck = useRef(0);
  const busy = useRef(false);

  useEffect(() => {
    lastCheck.current = Date.now();
    const mine = process.env.NEXT_PUBLIC_COMMIT || null;

    const check = () => {
      if (busy.current || Date.now() - lastCheck.current < CHECK_EVERY_MS) return;
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      busy.current = true;
      lastCheck.current = Date.now();
      api
        .version()
        .then((v) => {
          if (v && v.commit && mine && v.commit !== mine) setStale(true);
        })
        .catch(() => {
          // нет связи или вход истёк — проверим в следующий раз
        })
        .finally(() => {
          busy.current = false;
        });
    };

    const onVisibility = () => {
      if (document.visibilityState === "visible") check();
    };
    window.addEventListener("focus", check);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("focus", check);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  if (!stale) return null;
  return (
    <div className="update-banner" role="status">
      <button type="button" onClick={() => window.location.reload()}>
        Есть новая версия — <strong>обновить</strong>
      </button>
    </div>
  );
}
