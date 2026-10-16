"use client";

import { useEffect } from "react";
import { THEME_BG, currentTheme } from "@/lib/client/prefs";

/**
 * Подключает service worker (public/sw.js) — он нужен, чтобы приложение
 * появилось в меню «Поделиться». На этапе 1 он ничего не кэширует.
 * Заодно выравнивает цвет полосы браузера под выбранную тему.
 */
export default function SwRegister() {
  useEffect(() => {
    try {
      const meta = document.querySelector('meta[name="theme-color"]');
      if (meta) meta.setAttribute("content", THEME_BG[currentTheme()]);
    } catch {
      // не важно
    }
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
    if (!window.isSecureContext) return;
    const register = () => {
      navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(() => {
        // Без service worker не будет только «Поделиться» — остальное работает.
      });
    };
    if (document.readyState === "complete") register();
    else {
      window.addEventListener("load", register, { once: true });
      return () => window.removeEventListener("load", register);
    }
  }, []);
  return null;
}
