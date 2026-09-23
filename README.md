# jev-chrome-mcp

[Русская версия](README.ru.md)

MCP server for any client that can start a local process. It runs the [jev-browser-use](https://github.com/wy-coliney/jev-browser-use) click loop in Google Chrome. The client supplies the task, types text, and checks the result. Jev chooses the next click. Tested with Cursor and Codex CLI.

This repository does not copy or fork that skill. The server imports an installed `bridge.mjs`. The skill is MIT-licensed. This project is a separate adapter, not an official part of the skill.

## Setup

Install [jev-browser-use](https://github.com/wy-coliney/jev-browser-use) and Google Chrome. Then add this server in the project `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "cursor-jev": {
      "command": "node",
      "args": ["/absolute/path/to/cursor-jev-mcp/src/server.mjs"]
    }
  }
}
```

Open the folder in Cursor and enable `cursor-jev`.

By default the server loads `~/.agents/skills/jev-browser-use/bridge.mjs`. Override it with `JEV_BRIDGE_PATH`.

## Tools

- `jev_browser_run` opens Chrome and runs one Jev chunk.
- `jev_host_type` types text supplied by Cursor. The reply contains the length and `session_id`, not the text.
- `jev_wait` waits until the open page contains the requested strings. It does not ask Jev for a new decision.
- `jev_user_tabs` and `jev_claim_tab` claim an already open tab through `codex-browser-bridge`. That program is Windows-only. On other systems, pass `url` to `jev_browser_run` instead.

## What one call does

`jev_browser_run` with `url` launches the installed Google Chrome in the background. It does not use the personal Chrome profile. One chunk is 12 steps and at most 45 seconds. Chrome stays open.

If the status is `step_limit` or `budget`, Cursor looks at the screenshot and, when the task is still valid, calls the tool again with the same `session_id` and no `url`. `needs_verification` is not a pass. Cursor checks the screenshot and stops.

Set `JEV_CHROME_HEADLESS=0` to show the window. If `~/.config/jev-browser-use/config.json` sets `browser.allowedOrigins` or `browser.allowedActors`, the server honors them. The actor comes from `JEV_BROWSER_ACTOR`.

## Limits

Jev does not type. Safe keys are Enter, Escape, Tab, Shift+Tab, PageUp, PageDown, Home, and End. A targeted scroll uses a snapshot index or a point supplied by Cursor. Names such as send, delete, pay, and password are rejected. Existing tabs of normal Chrome, frames, drag-and-drop, and uploads are not supported.

## License

This adapter is [MIT](LICENSE), copyright Pioneer113. The click loop belongs to [jev-browser-use](https://github.com/wy-coliney/jev-browser-use), which has its own MIT license. This repository is not endorsed by that project.

## Check

```sh
npm test
node scripts/live-example.mjs
```
