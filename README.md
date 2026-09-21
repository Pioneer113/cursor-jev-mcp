# cursor-jev-mcp

Stdio MCP для Cursor Desktop. Один вызов крутит цикл кликов Jev. Cursor после этого печатает текст и проверяет результат.

Скилл `jev-browser-use` не форкается и не копируется. Сервер импортирует установленный `bridge.mjs`.

## Подключение

Проектный конфиг уже лежит в `.cursor/mcp.json`. Откройте эту папку в Cursor и включите сервер `cursor-jev`.

Глобальный `~/.cursor/mcp.json` не меняется.

Инструменты: `jev_user_tabs`, `jev_claim_tab`, `jev_browser_run`.

## Живые клики

`jev_browser_run` с полем `url` сам открывает установленный Google Chrome в фоне, без личного профиля. Один заход — 12 шагов и не больше 45 секунд, как в инструкции Codex. Окно не закрывается. Если статус `step_limit` или `budget`, Cursor смотрит скриншот и при живой задаче вызывает инструмент ещё раз с тем же `session_id`, без `url`. Если статус `needs_verification`, это не успех: Cursor проверяет скриншот и останавливается. Окно показывается, если задать `JEV_CHROME_HEADLESS=0`.

Проверка на публичной странице:

```sh
node scripts/live-example.mjs
```

Путь через `codex-browser-bridge` остаётся для уже открытой вкладки (`tab_id`). На этом Mac той программы нет, поэтому рабочий путь — Chrome.

Своя команда:

```sh
CODEX_BROWSER_BRIDGE_COMMAND=/path/to/codex-browser-bridge node src/server.mjs
```

Другой путь к циклу:

```sh
JEV_BRIDGE_PATH=/path/to/bridge.mjs
```

По умолчанию берётся `~/.agents/skills/jev-browser-use/bridge.mjs`.

Если в `~/.config/jev-browser-use/config.json` заданы `browser.allowedOrigins` или `browser.allowedActors`, сервер их соблюдает. Актор читается из `JEV_BROWSER_ACTOR`.

## Границы

Jev не печатает. Текст вводит Cursor через `jev_host_type`: ответ содержит длину, не сам текст. `jev_wait` ждёт строку на уже открытом сеансе и не запускает новое решение. Клавиши: Enter, Escape, Tab, Shift+Tab, PageUp, PageDown, Home, End. Прокрутка блока идёт по индексу снимка или по точке, которую дал Cursor. Чужие вкладки обычного Chrome, кадры, перетаскивание и загрузки не поддерживаются. Имена вроде send, delete, pay и password отсекаются. Статус цикла — не подтверждение успеха: итог проверяет Cursor.

## Проверка

```sh
node --test
```
