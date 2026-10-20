"use client";

import { useEffect, useState } from "react";
import { api, errorText } from "@/lib/client/api";
import { getBridge } from "@/lib/client/bridge";
import { BackLink, CopyField, ErrorNote } from "../bits";

const CHECK_WAIT_MS = 3000;

/**
 * «Кнопка для сайтов»: что это, выпуск личного ключа, ссылка «Установить»,
 * пошаговые инструкции для разных браузеров и самопроверка.
 */
export default function ButtonScreen() {
  const [installUrl, setInstallUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [check, setCheck] = useState<"wait" | "ok" | "missing">("wait");

  // Самопроверка: кнопка, установленная в этом браузере, работает и на
  // страницах Толмача и говорит «мост готов».
  useEffect(() => {
    const bridge = getBridge();
    if (!bridge) return;
    let done = false;
    const off = bridge.onReady(() => {
      done = true;
      setCheck("ok");
    });
    bridge.ping();
    const t = setTimeout(() => {
      if (!done) setCheck("missing");
    }, CHECK_WAIT_MS);
    return () => {
      off();
      clearTimeout(t);
    };
  }, []);

  async function issue() {
    // Ключ один на все устройства: новый ключ ломает кнопку, поставленную раньше
    // (например, на телефоне, если сейчас ставим на компьютер).
    let exists = Boolean(installUrl) || check === "ok";
    if (!exists) exists = await api.buttonTokenStatus().then((r) => r.exists).catch(() => false);
    if (
      exists &&
      !window.confirm(
        "Кнопка уже установлена хотя бы в одном браузере. Новый ключ отключит её везде — её придётся поставить заново на каждом устройстве. Продолжить?",
      )
    )
      return;
    setBusy(true);
    setError(null);
    try {
      const r = await api.buttonToken();
      if (!r || !r.installUrl) throw new Error("Сервер не прислал ссылку. Попробуйте ещё раз.");
      setInstallUrl(r.installUrl);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="page">
      <BackLink href="/settings">Настройки</BackLink>
      <div className="page-head">
        <h1 className="display">Кнопка «Т» для сайтов</h1>
        <p className="p">
          Это маленькая кнопка, которая появляется в углу страницы с главой на любом сайте. Нажали — глава
          оказалась в Толмаче, и он открыл её для перевода. Текст берётся прямо из вашего браузера, поэтому
          работает и там, где сайт не пускает чужие серверы («вы не робот?»). Кнопка умеет взять сразу и несколько
          следующих глав.
        </p>
        <p className="p">
          Показывает её бесплатное дополнение к браузеру — Violentmonkey или Tampermonkey. Один раз ставите
          дополнение, потом кнопку — это 5–10 минут. На телефоне надёжнее всего — Firefox.
        </p>
      </div>

      <div className="stack-lg">
        <SelfCheck state={check} />

        <section className="card stack" aria-label="Установка">
          {!installUrl ? (
            <>
              <p className="p">
                Сначала Толмач выпустит личный ключ — он вшивается в кнопку, чтобы ей не нужен был пароль.
              </p>
              <button type="button" className="btn btn-primary btn-big btn-block" onClick={() => void issue()} disabled={busy}>
                {busy ? "Выпускаю ключ…" : "Выпустить ключ и установить"}
              </button>
            </>
          ) : (
            <>
              <p className="p">
                Ключ готов. Если дополнение уже стоит — нажмите «Установить кнопку», откроется окно дополнения,
                в нём нажмите «Установить» (Install).
              </p>
              <a className="btn btn-primary btn-big btn-block install-link" href={installUrl}>
                Установить кнопку
              </a>
              <CopyField
                value={installUrl}
                label="Ссылка на кнопку — если удобнее открыть её в другом браузере"
              />
              <button type="button" className="btn btn-quiet" onClick={() => void issue()} disabled={busy}>
                Выпустить новый ключ
              </button>
            </>
          )}
          {error && <ErrorNote text={error} />}
          <p className="hint">
            Выпуск нового ключа отключает старую кнопку — на всех устройствах. Так можно «отозвать» кнопку, если
            ссылка попала не туда.
          </p>
        </section>

        <section aria-label="Как установить">
          <h2 className="label" style={{ marginBottom: 6 }}>
            Пошагово для вашего браузера
          </h2>

          <details className="fold" open>
            <summary>Firefox на телефоне — самый надёжный</summary>
            <div className="fold-body">
              <ol className="steps">
                <li>Поставьте Firefox из Google Play.</li>
                <li>
                  Меню Firefox (три точки) → «Расширения» → найдите <b>Violentmonkey</b> → «+» → «Добавить».
                </li>
                <li>Откройте этот адрес Толмача в Firefox и войдите паролем.</li>
                <li>«Выпустить ключ и установить» → «Установить кнопку» → «Установить» в окне Violentmonkey.</li>
                <li>Обновите эту страницу: сверху должно появиться «Кнопка установлена и работает ✓».</li>
              </ol>
              <p className="hint" style={{ marginTop: 10 }}>
                Сайты с главами и сам Толмач лучше открывать в Firefox: тогда «Дальше» в читалке подтягивает
                следующую главу через кнопку. Значок Толмача на главный экран — меню Firefox → «Добавить на
                главный экран».
              </p>
            </div>
          </details>

          <details className="fold">
            <summary>Microsoft Edge на телефоне</summary>
            <div className="fold-body">
              <ol className="steps">
                <li>Меню Edge (три полоски внизу справа) → «Расширения».</li>
                <li>
                  Найдите в списке <b>Tampermonkey</b> или <b>Violentmonkey</b> и нажмите «Получить» → «Добавить».
                </li>
                <li>
                  Разрешите дополнению запускать скрипты: меню → «Расширения» → «Управление расширениями» →
                  шестерёнка вверху справа → включите «Режим разработчика». Если у дополнения есть переключатель
                  «Разрешить пользовательские скрипты» — включите и его. Без этого шага кнопка не появится.
                </li>
                <li>Откройте эту страницу Толмача в Edge и войдите.</li>
                <li>«Выпустить ключ и установить» → «Установить кнопку» → «Установить» в окне дополнения.</li>
              </ol>
            </div>
          </details>

          <details className="fold">
            <summary>Kiwi на телефоне — скорее всего, не заработает</summary>
            <div className="fold-body">
              <p className="p">
                Kiwi больше не обновляется. А Violentmonkey и Tampermonkey в магазине Chrome теперь есть только в
                новой версии, которую Kiwi не умеет запускать, — это признают их разработчики. Дополнение
                ставится, но кнопка не появляется. Поставьте кнопку в Firefox — инструкция выше.
              </p>
              <p className="p">Если всё же хотите попробовать в Kiwi:</p>
              <ol className="steps">
                <li>Меню Kiwi (три точки) → «Расширения» → включите «Режим разработчика» вверху страницы.</li>
                <li>Закройте Kiwi совсем (смахните из недавних приложений) и откройте снова.</li>
                <li>Вернитесь сюда и обновите страницу. Нет «работает ✓» — значит, Kiwi не справился, нужен Firefox.</li>
              </ol>
            </div>
          </details>

          <details className="fold">
            <summary>Chrome на компьютере</summary>
            <div className="fold-body">
              <ol className="steps">
                <li>
                  Поставьте <b>Violentmonkey</b> или <b>Tampermonkey</b> из Chrome Web Store («Установить»).
                </li>
                <li>
                  Включите для дополнения пользовательские скрипты: откройте адрес <b>chrome://extensions</b>, у
                  дополнения нажмите «Сведения» и включите «Разрешить пользовательские скрипты» (Allow User
                  Scripts). Без этого шага кнопка не появится.
                </li>
                <li>Вернитесь сюда: «Выпустить ключ и установить» → «Установить кнопку» → «Установить».</li>
              </ol>
            </div>
          </details>

          <details className="fold">
            <summary>Firefox на компьютере</summary>
            <div className="fold-body">
              <ol className="steps">
                <li>
                  Поставьте <b>Violentmonkey</b> с addons.mozilla.org («Добавить в Firefox»).
                </li>
                <li>Вернитесь сюда: «Выпустить ключ и установить» → «Установить кнопку» → «Установить».</li>
              </ol>
            </div>
          </details>

          <details className="fold">
            <summary>Обычный Chrome на телефоне</summary>
            <div className="fold-body">
              <p className="p">
                Мобильный Chrome не умеет ставить дополнения, поэтому кнопки в нём не будет. Там пользуйтесь
                «Поделиться» → «Толмач» или вставкой текста на странице «Добавить главу».
              </p>
            </div>
          </details>
        </section>

        <p className="hint">
          Удобнее всего открывать сайт с главами и Толмач в одном и том же браузере: тогда «Дальше» в конце главы
          сам подтянет следующую через кнопку, даже если сайт не пускает сервер Толмача.
        </p>
      </div>
    </main>
  );
}

function SelfCheck({ state }: { state: "wait" | "ok" | "missing" }) {
  if (state === "ok") {
    return (
      <div className="notice" role="status">
        <p className="big-check" style={{ color: "var(--ok)" }}>
          Кнопка установлена и работает ✓
        </p>
      </div>
    );
  }
  if (state === "missing") {
    return (
      <div className="notice notice-warn" role="status">
        <p>
          <strong>Кнопка пока не видна в этом браузере.</strong>
        </p>
        <p>
          Если вы её только что поставили — обновите страницу. Если нет — проверьте, что дополнение включено, а в
          Chrome на компьютере — что включено «Разрешить пользовательские скрипты».
        </p>
        <p>
          В Kiwi кнопка, скорее всего, не заработает: новые версии дополнений в нём не запускаются. На телефоне
          ставьте её в Firefox — инструкция ниже.
        </p>
      </div>
    );
  }
  return (
    <div className="notice" role="status">
      <p className="big-check">
        <span className="spinner" aria-hidden="true" /> Проверяю, есть ли кнопка в этом браузере…
      </p>
    </div>
  );
}
