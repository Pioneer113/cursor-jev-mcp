import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createBridgeTab } from '../src/tab-adapter.mjs';
import { browserBridgeArgs, handleJevTool, loadBridge, resolveBridgeCommand } from '../src/server.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const missingBridge = /codex-browser-bridge was not found/;

function axResult(nodes, url = 'https://example.com/settings') {
  return async name => {
    if (name === 'codex_get_url') return { content: [{ type: 'text', text: url }] };
    if (name === 'codex_dom_snapshot') return { content: [{ type: 'text', text: JSON.stringify({ nodes }) }] };
    return { content: [{ type: 'text', text: name }] };
  };
}

test('formats AX for the installed bridge and clicks by kept index', async () => {
  const calls = [];
  const tab = createBridgeTab({
    tabId: 'tab-1',
    callTool: async (name, args) => {
      calls.push([name, args]);
      return axResult([{ role: { value: 'button' }, name: { value: 'Settings' }, backendDOMNodeId: 42 }])(name);
    }
  });
  const bridge = await loadBridge();
  const state = await tab.getAXState({ emit: false, disableDiffing: true });
  assert.match(state, /^Browser tab:.* URL: "https:\/\/example\.com\/settings"\./);
  assert.equal(bridge.availableActions(state, [{ op: 'click', name: 'Settings' }])[0].index, 0);
  assert.equal(tab.pressKey.length, 1);
  await tab.click(0);
  assert.deepEqual(calls.at(-1), ['codex_dom_click', { tab_id: 'tab-1', node_id: '42' }]);
});

test('page keys scroll and other keys or targeted scroll return to the host', async () => {
  const calls = [];
  const tab = createBridgeTab({
    tabId: 'tab-1',
    callTool: async (name, args) => {
      calls.push([name, args]);
      return { content: [{ type: 'text', text: 'ok' }] };
    }
  });
  await tab.pressKey('PageDown');
  assert.equal(calls[0][0], 'codex_cua_scroll');
  assert.equal(calls[0][1].scroll_y, 600);
  await assert.rejects(() => tab.pressKey('Enter'), /host handback/);
  await assert.rejects(() => tab.scroll(3, 'down', 1), /host handback/);
});

test('keeps the snapshot inside the installed bridge limit', async () => {
  const nodes = Array.from({ length: 400 }, (_, index) => ({
    role: { value: 'button' },
    name: { value: `Control ${index} ${'x'.repeat(80)}` },
    backendDOMNodeId: index + 1
  }));
  const calls = [];
  const tab = createBridgeTab({
    tabId: 'tab-1',
    callTool: async (name, args) => {
      calls.push([name, args]);
      return axResult(nodes)(name);
    }
  });
  const state = await tab.getAXState();
  assert.ok(state.length <= 24000);
  const lastIndex = Number(state.trim().split('\n').at(-1).split(' ')[0]);
  await tab.click(lastIndex);
  assert.equal(calls.at(-1)[1].node_id, String(lastIndex + 1));
  await assert.rejects(() => tab.click(lastIndex + 1), /stale/);
});

test('rejects consequential controls, foreign origins, and unauthorized actors', async () => {
  const config = { browser: { allowedOrigins: ['https://example.com'], allowedActors: ['cursor'] } };
  await assert.rejects(() => handleJevTool('jev_browser_run', {
    tab_id: 'tab-1',
    goal: 'Delete the item',
    allowed_origins: ['https://example.com'],
    controls: [{ op: 'click', name: 'Delete item' }]
  }, async () => { throw new Error('bridge should not be called'); }, { config, env: { JEV_BROWSER_ACTOR: 'cursor' }, createSession() { throw new Error('session should not start'); } }), /Unsafe browser control/);
  await assert.rejects(() => handleJevTool('jev_browser_run', {
    tab_id: 'tab-1',
    goal: 'Open settings',
    allowed_origins: ['https://evil.test']
  }, async () => { throw new Error('bridge should not be called'); }, { config, env: { JEV_BROWSER_ACTOR: 'cursor' }, createSession() { throw new Error('session should not start'); } }), /not authorized by host/);
  await assert.rejects(() => handleJevTool('jev_user_tabs', {}, async () => ({ content: [{ type: 'text', text: '[]' }] }), {
    config,
    env: {}
  }), /not authorized/);
});

test('filters tabs, checks a claimed origin, and finalizes a run', async () => {
  const config = { envFile: '/tmp/jev.env', provider: 'typesafe', model: 'jev-latest', browser: { allowedOrigins: ['https://example.com'] } };
  const calls = [];
  const callTool = async (name, args) => {
    calls.push([name, args]);
    if (name === 'codex_user_tabs') return { content: [{ type: 'text', text: JSON.stringify([{ id: 'keep', url: 'https://example.com/a' }, { id: 'drop', url: 'https://evil.test/' }]) }] };
    if (name === 'codex_get_url') return { content: [{ type: 'text', text: 'https://example.com/settings' }] };
    return { content: [{ type: 'text', text: 'claimed' }] };
  };
  const tabs = await handleJevTool('jev_user_tabs', {}, callTool, { config, env: { JEV_BROWSER_ACTOR: 'cursor' } });
  assert.deepEqual(tabs, [{ id: 'keep', url: 'https://example.com/a' }]);
  await handleJevTool('jev_claim_tab', { tab_id: 'keep' }, callTool, { config, env: { JEV_BROWSER_ACTOR: 'cursor' } });
  const outcome = await handleJevTool('jev_browser_run', {
    tab_id: 'keep',
    goal: 'Open settings',
    allowed_origins: ['https://example.com'],
    controls: [{ op: 'click', name: 'Settings' }]
  }, callTool, {
    config,
    env: { JEV_BROWSER_ACTOR: 'cursor' },
    createSession: () => ({ async run() { return { status: 'needs_verification', history: [] }; } })
  });
  assert.equal(outcome.status, 'needs_verification');
  assert.equal(outcome.actor, 'cursor');
  assert.equal(calls.at(-1)[0], 'codex_finalize');
});

test('finalizes a run that throws', async () => {
  const calls = [];
  await assert.rejects(() => handleJevTool('jev_browser_run', {
    tab_id: 'tab-1',
    goal: 'Open settings',
    allowed_origins: ['https://example.com']
  }, async name => {
    calls.push(name);
    return { content: [{ type: 'text', text: 'ok' }] };
  }, {
    config: { provider: 'typesafe', model: 'jev-latest' },
    env: {},
    createSession: () => ({ async run() { throw new Error('loop failed'); } })
  }), /loop failed/);
  assert.equal(calls.at(-1), 'codex_finalize');
});

test('selects a connected bridge pipe and ignores a bad doctor report', () => {
  const pipe = 'codex-browser-use-01234567-89ab-cdef-0123-456789abcdef';
  assert.deepEqual(browserBridgeArgs('codex-browser-bridge', () => ({
    status: 0,
    stdout: JSON.stringify({ pipes: [{ name: 'bad', connected: true, latency_ms: 1 }, { name: pipe, connected: true, latency_ms: 5 }] })
  })), ['--mode', 'mcp', '--profile', 'basic', '--pipe', pipe]);
  assert.deepEqual(browserBridgeArgs('codex-browser-bridge', () => { throw new Error('offline'); }), ['--mode', 'mcp', '--profile', 'basic']);
});

test('names a missing bridge command before starting it', () => {
  assert.throws(() => resolveBridgeCommand({ PATH: '/usr/bin:/bin' }), missingBridge);
  assert.throws(() => resolveBridgeCommand({ CODEX_BROWSER_BRIDGE_COMMAND: 'bridge;rm', PATH: '/usr/bin' }), /Invalid CODEX_BROWSER_BRIDGE_COMMAND/);
});

test('stdio server stays up and reports a missing bridge', async () => {
  const child = spawn(process.execPath, [join(root, 'src/server.mjs')], {
    cwd: root,
    env: { ...process.env, PATH: '/usr/bin:/bin', CODEX_BROWSER_BRIDGE_COMMAND: '' },
    stdio: ['pipe', 'pipe', 'pipe']
  });
  const lines = createInterface({ input: child.stdout });
  const messages = [];
  const waiters = [];
  lines.on('line', line => {
    const message = JSON.parse(line);
    const waiter = waiters.shift();
    if (waiter) waiter(message);
    else messages.push(message);
  });
  const next = () => {
    if (messages.length) return Promise.resolve(messages.shift());
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('stdio timeout')), 5000);
      waiters.push(message => {
        clearTimeout(timer);
        resolve(message);
      });
    });
  };
  const send = message => child.stdin.write(`${JSON.stringify(message)}\n`);
  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
  const started = await next();
  assert.equal(started.result.serverInfo.name, 'jev-chrome-mcp');
  send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'jev_user_tabs', arguments: {} } });
  const failed = await next();
  assert.equal(failed.result.isError, true);
  assert.match(failed.result.content[0].text, missingBridge);
  send({ jsonrpc: '2.0', id: 3, method: 'tools/list' });
  const listed = await next();
  assert.equal(listed.result.tools.length, 5);
  child.kill();
  await new Promise(resolve => child.on('exit', resolve));
});
