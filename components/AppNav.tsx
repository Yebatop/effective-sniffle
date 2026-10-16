"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Icon } from "./Icon";

/**
 * Навигация: на телефоне — снизу под большой палец (Библиотека · Добавить ·
 * Настройки), на компьютере — полоса сверху. В читалке и на входе её нет:
 * у читалки своя верхняя панель.
 *
 * Стоит в разметке после содержимого: нижней полосе нужен отступ под собой,
 * а верхняя поднимается наверх через CSS order.
 */
export default function AppNav() {
  const path = usePathname() || "/";
  if (path.startsWith("/read/") || path.startsWith("/login")) return null;

  const isLibrary = path === "/" || path.startsWith("/book");
  const isAdd = path.startsWith("/add") || path.startsWith("/share");
  const isSettings =
    path.startsWith("/settings") || path.startsWith("/spend") || path.startsWith("/status") || path.startsWith("/button");

  const cur = (on: boolean) => (on ? ("page" as const) : undefined);

  return (
    <>
      <nav className="nav-top" aria-label="Разделы">
        <Link href="/" className="nav-brand">
          <Icon name="logo" size={22} />
          <span className="display">Толмач</span>
        </Link>
        <Link href="/" className="nav-link" aria-current={cur(isLibrary)}>
          Библиотека
        </Link>
        <Link href="/add" className="nav-link" aria-current={cur(isAdd)}>
          Добавить главу
        </Link>
        <Link href="/settings" className="nav-link" aria-current={cur(isSettings)}>
          Настройки
        </Link>
      </nav>
      <div className="nav-spacer" aria-hidden="true" />
      <nav className="nav-bottom" aria-label="Разделы">
        <Link href="/" aria-current={cur(isLibrary)}>
          <Icon name="books" size={22} />
          Библиотека
        </Link>
        <Link href="/add" aria-current={cur(isAdd)}>
          <Icon name="plus" size={22} />
          Добавить
        </Link>
        <Link href="/settings" aria-current={cur(isSettings)}>
          <Icon name="gear" size={22} />
          Настройки
        </Link>
      </nav>
    </>
  );
}
