# jev-chrome-mcp

[English](README.md)

MCP-сервер для любой программы, которая умеет запускать локальный процесс. Он запускает цикл кликов [jev-browser-use](https://github.com/wy-coliney/jev-browser-use) в Google Chrome. Клиент ставит задачу, вводит текст и проверяет результат. Jev выбирает следующий клик. Проверен в Cursor и в Codex CLI.

Этот репозиторий не копирует скилл и не является его форком. Сервер импортирует установленный `bridge.mjs`. Скилл под лицензией MIT. Этот проект — отдельный адаптер, а не официальная часть скилла.

## Подключение

Установите [jev-browser-use](https://github.com/wy-coliney/jev-browser-use) и Google Chrome. Затем добавьте сервер в проектный `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "cursor-jev": {
      "command": "node",
      "args": ["/absolute/path/to/jev-chrome-mcp/src/server.mjs"]
    }
  }
}
```

Откройте папку в Cursor и включите `cursor-jev`.

По умолчанию сервер берёт `~/.agents/skills/jev-browser-use/bridge.mjs`. Другой путь задаётся через `JEV_BRIDGE_PATH`.

## Инструменты

- `jev_browser_run` открывает Chrome и делает один заход Jev.
- `jev_host_type` вводит текст, который передал Cursor. В ответе длина и `session_id`, не сам текст.
- `jev_wait` ждёт, пока на открытой странице появятся заданные строки. Новое решение Jev для этого не запрашивается.
- `jev_user_tabs` и `jev_claim_tab` берут уже открытую вкладку через `codex-browser-bridge`. Эта программа только для Windows. На других системах передавайте `url` в `jev_browser_run`.

## Что делает один вызов

`jev_browser_run` с `url` сам запускает установленный Google Chrome в фоне и не использует личный профиль. Один заход — 12 шагов и не больше 45 секунд. Окно не закрывается.

Если статус `step_limit` или `budget`, Cursor смотрит скриншот и при живой задаче вызывает инструмент ещё раз с тем же `session_id`, без `url`. `needs_verification` — не успех: Cursor проверяет скриншот и останавливается.

Окно показывается, если задать `JEV_CHROME_HEADLESS=0`. Если в `~/.config/jev-browser-use/config.json` заданы `browser.allowedOrigins` или `browser.allowedActors`, сервер их соблюдает. Актор читается из `JEV_BROWSER_ACTOR`.

## Границы

Jev не печатает. Клавиши: Enter, Escape, Tab, Shift+Tab, PageUp, PageDown, Home, End. Прокрутка блока идёт по индексу снимка или по точке, которую дал Cursor. Имена вроде send, delete, pay и password отсекаются. Чужие вкладки обычного Chrome, кадры, перетаскивание и загрузки не поддерживаются.

## Лицензия

Этот адаптер под [MIT](LICENSE), правообладатель Pioneer113. Цикл кликов принадлежит [jev-browser-use](https://github.com/wy-coliney/jev-browser-use) и распространяется по его собственной лицензии MIT. Автор скилла этот репозиторий не одобрял.

## Проверка

```sh
npm test
node scripts/live-example.mjs
```
