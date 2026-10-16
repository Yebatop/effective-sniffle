# Толмач

Личный переводчик англоязычных веб-новелл на русский с помощью Claude.
Продолжение прошлого проекта (Yebatop/ExtTran), но для себя, а не на продажу.

- [Установка](docs/SETUP.md) — по шагам, в браузере, без терминала.
- [План](docs/PLAN.md) — что строим, сколько стоит, этапы.
- [Устройство](docs/ARCH.md) и [договор адресов и экранов](docs/CONTRACTS.md) — для сессий Claude Code.

## Для разработки

```bash
npm install
npm test          # нужен Postgres: TEST_DATABASE_URL или postgres://postgres:postgres@localhost:5432/tolmach_test
npm run build
```

Сквозная проверка в браузере без трат — `tests/e2e/smoke.mjs` против
поддельного сервера модели (`tests/e2e/mock-server.ts`).
