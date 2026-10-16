"use client";

import { useEffect, useState } from "react";

/**
 * «Не гасить экран». Wake Lock есть в Chrome Android 84+, Firefox 126+.
 * Браузер сам отпускает блокировку, когда вкладка скрыта, — при возврате
 * берём её снова. Вернёт false, если браузер так не умеет (тогда
 * переключатель не показываем).
 */
export function useWakeLock(enabled: boolean): boolean {
  const [supported, setSupported] = useState(false);

  useEffect(() => {
    setSupported(typeof navigator !== "undefined" && "wakeLock" in navigator && !!navigator.wakeLock);
  }, []);

  useEffect(() => {
    if (!enabled || !supported) return;
    let sentinel: WakeLockSentinel | null = null;
    let cancelled = false;
    const acquire = async () => {
      if (document.visibilityState !== "visible") return;
      try {
        const s = await navigator.wakeLock.request("screen");
        if (cancelled) {
          s.release().catch(() => undefined);
          return;
        }
        sentinel = s;
      } catch {
        // отказано (энергосбережение и т. п.) — молча
      }
    };
    void acquire();
    const onVisibility = () => {
      if (document.visibilityState === "visible" && (!sentinel || sentinel.released)) void acquire();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisibility);
      if (sentinel && !sentinel.released) sentinel.release().catch(() => undefined);
    };
  }, [enabled, supported]);

  return supported;
}

/** Верхняя панель прячется, когда листают вниз, и возвращается при движении вверх. */
export function useHideOnScroll(locked: boolean): boolean {
  const [hidden, setHidden] = useState(false);
  useEffect(() => {
    if (locked) {
      setHidden(false);
      return;
    }
    let last = window.scrollY;
    let frame = 0;
    const onScroll = () => {
      if (frame) return;
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        const y = window.scrollY;
        if (y < 80) setHidden(false);
        else if (y > last + 8) setHidden(true);
        else if (y < last - 8) setHidden(false);
        if (Math.abs(y - last) > 8) last = y;
      });
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", onScroll);
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, [locked]);
  return hidden;
}
