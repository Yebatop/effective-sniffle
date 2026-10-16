# Договор этапа 1: адреса и экраны

Формы запросов и ответов — в `lib/types.ts`. Все адреса, кроме отмеченных
«открыт», требуют cookie входа (проверяет `proxy.ts`); ответ без входа —
401 JSON для `/api/*` и редирект на `/login` для страниц.

## API

| Метод и адрес | Тело → ответ | Заметки |
| --- | --- | --- |
| `POST /api/login` (открыт) | `{password}` → `{ok}` + cookie | Не больше 5 неудач за 15 минут |
| `POST /api/logout` | → `{ok}` | |
| `GET /api/books` | → `BookListItem[]` | |
| `GET /api/books/:id` | → `{book, chapters: (Chapter & {translated})[], spentUsd}` | |
| `PATCH /api/books/:id` | `{title?, register?, narratorPerson?, narratorGender?, honorifics?}` → `Book` | |
| `GET /api/books/:id/glossary` | → `{terms: Term[], addresses: Address[]}` | |
| `PATCH /api/terms/:id` | `{ru?, kind?, gender?, aliases?, note?, status?}` → `Term` | Правка человеком → `checked` |
| `DELETE /api/terms/:id` | → `{ok}` | |
| `PATCH /api/addresses/:id` | `{form}` → `{ok}` | |
| `POST /api/import` (открыт по Bearer) | `ImportRequest` → `ImportResponse` | Cookie **или** `Authorization: Bearer <ключ кнопки>`; до ~100 КБ |
| `POST /api/fetch` | `FetchRequest` → `FetchResponse` | Сервер сам открывает страницу |
| `GET /api/chapters/:id` | → `ChapterView` | |
| `DELETE /api/chapters/:id` | → `{ok}` | |
| `POST /api/chapters/:id/translate` | `TranslateRequest` → `TranslateResponse` | Создаёт или берёт живую задачу, запускает через `after()` |
| `GET /api/jobs/:id?since=N` | → `JobPoll` | Если аренда истекла — перезапуск через `after()` |
| `POST /api/jobs/run` (открыт по секрету) | `{jobId}` + `x-relay-secret` → 202 | Эстафета исполнителя |
| `POST /api/position` | `PositionRequest` → `{ok}` | |
| `POST /api/report` | `ReportRequest` → `ReportResponse` | |
| `GET /api/report/:token` (открыт по токену) | → JSON отчёта | Для сессии Claude Code |
| `GET /api/settings`, `PATCH /api/settings` | → `Settings` | |
| `POST /api/budget/unblock` | → `{unblocked}` | После поднятия лимита или пополнения |
| `GET /api/spend` | → `{budget: BudgetState, byBook, recent}` | |
| `GET /api/status` | → `StatusView` | Дорогих вызовов нет; ключ проверяется `models.retrieve` |
| `GET /api/version` | → `{version, commit}` | Дёшево; для плашки «Есть новая версия» |
| `POST /api/button-token` | → `{installUrl}` | Выпускает новый ключ кнопки, старый перестаёт работать |
| `GET /u/:token/tolmach.user.js` (открыт по ключу) | → JS | Скрипт с вшитыми адресом и ключом |
| `GET /api/cron` (открыт) | → `{resumed}` | Ежедневно: продолжить зависшие задачи; ничего не тратит сам по себе |
| `GET /manifest.webmanifest` (открыт) | | `app/manifest.ts`, `share_target` → `POST /share` |
| `GET /sw.js` (открыт) | | `public/sw.js`: принимает `POST /share` |

## Экраны

| Адрес | Что на нём |
| --- | --- |
| `/login` | Пароль. Если `APP_PASSWORD` не задан — подсказка, где его задать |
| `/` | Библиотека: «Продолжить» (последняя книга и глава), книги с обложками, «следующая готова», кнопка «Добавить главу». При первом запуске без выбранной модели — переход в `/settings?first=1` |
| `/add` | Три вкладки: «Вставить текст», «Файл» (.mht/.html — разбор в браузере), «Ссылка» (сервер пробует открыть). Предпросмотр: название, слов, начало и конец, цена, выбор книги → «Перевести» |
| `/share` | Принимает «Поделиться»: ссылка → попытка сервера; текст → предпросмотр как в `/add`; файл → разбор |
| `/read/[id]` | Читалка (клиентский компонент). Карточка старта для непереведённой главы; перевод по абзацам с опросом; темы, шрифт, интервал; нажатие на абзац — оригинал; подсветка терминов и карточка; «Дальше» с состоянием; «не гасить экран»; место чтения; «Что-то не так» |
| `/book/[id]` | Оглавление, настройки книги (стиль, рассказчик, обращения), расход по книге |
| `/book/[id]/glossary` | Термины по разделам, правка ru/рода/имён, «кто кому ты/вы» |
| `/settings` | Модель перевода (с ценами, при первом запуске — обязательный выбор), модель поиска имён, усердие, месячный лимит, курс, «переводить сразу без карточки» |
| `/spend` | Расходы: месяц, лимит, по книгам, последние вызовы |
| `/status` | Проверки: база, ключ Anthropic, лимит, зависшие задачи, версия |
| `/button` | «Кнопка для сайтов»: выпустить ключ, «Установить», инструкции для Kiwi/Edge/Firefox и Chrome на ПК, самопроверка |

## Кнопка на сайтах и мост

Скрипт (`userscript/main.ts`) получает при отдаче `APP_ORIGIN` и `IMPORT_TOKEN`.

- На страницах сайтов: плавающая кнопка «Толмач», если страница похожа на
  главу. Меню: «Перевести эту», «Взять эту и следующие 3 / 5 / 10». Отправка
  `POST {APP_ORIGIN}/api/import` с Bearer-ключом через `GM_xmlhttpRequest`,
  затем открыть `{APP_ORIGIN}/read/<chapterId>`.
- На страницах приложения (`location.origin === APP_ORIGIN`) — мост для
  «Дальше»: `window.postMessage({type:"tolmach:bridge-ready", version})` при
  загрузке; на `{type:"tolmach:fetch", requestId, url}` — `GM_xmlhttpRequest`
  GET страницы с куками пользователя → `DOMParser` → `markHiddenByStyles` →
  `extractFromDocument` → ответ `{type:"tolmach:fetched", requestId, ok, chapter?, code?}`.
  Импорт делает сама страница (у неё есть cookie).
