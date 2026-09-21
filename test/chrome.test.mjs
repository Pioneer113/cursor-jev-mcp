import assert from 'node:assert/strict';
import { test } from 'node:test';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createChromeTab } from '../src/chrome-tab.mjs';
import { closeChromeSession, contentWithImage, runChromeTask, typeInChrome, waitForChromeState } from '../src/server.mjs';

function axTree() {
  return {
    nodes: [
      { role: { value: 'link' }, name: { value: 'Learn more' }, backendDOMNodeId: 7 }
    ]
  };
}

test('chrome tab formats the page and clicks the accessibility node', async () => {
  const calls = [];
  const page = {
    url: () => 'https://example.com/',
    mouse: {
      async click(x, y) { calls.push(['click', x, y]); },
      async move(x, y) { calls.push(['move', x, y]); },
      async wheel(x, y) { calls.push(['wheel', x, y]); }
    },
    keyboard: { async press(key) { calls.push(['press', key]); } },
    async reload() { calls.push(['reload']); }
  };
  const cdp = {
    async send(method, params) {
      calls.push([method, params]);
      if (method === 'Accessibility.getFullAXTree') return axTree();
      if (method === 'DOM.getBoxModel') return { model: { content: [0, 0, 20, 0, 20, 10, 0, 10] } };
      throw new Error(method);
    }
  };
  const tab = createChromeTab(page, cdp);
  const state = await tab.getAXState();
  assert.match(state, /URL: "https:\/\/example\.com\/"\./);
  assert.match(state, /0 link Description: Learn more/);
  await tab.click(0);
  assert.deepEqual(calls.at(-1), ['click', 10, 5]);
  await tab.pressKey('PageDown');
  assert.deepEqual(calls.at(-1), ['press', 'PageDown']);
  await tab.pressKey('Enter');
  assert.deepEqual(calls.at(-1), ['press', 'Enter']);
  await assert.rejects(() => tab.pressKey('a'), /host handback/);
  await tab.scroll(0, 'down', 1);
  assert.deepEqual(calls.at(-2), ['move', 10, 5]);
  assert.deepEqual(calls.at(-1), ['wheel', 0, 600]);
  await tab.scroll([40, 80], 'up', 1);
  assert.deepEqual(calls.at(-2), ['move', 40, 80]);
  assert.deepEqual(calls.at(-1), ['wheel', 0, -600]);
  await assert.rejects(() => tab.scroll(1, 'down', 1), /stale/);
  await tab.reload();
  assert.equal(calls.at(-1)[0], 'reload');
});

test('chrome run keeps the same session and uses twelve steps', async () => {
  const opened = [];
  const chunks = [];
  let closed = false;
  let runs = 0;
  const sessions = { current: null, queue: Promise.resolve() };
  const options = {
    sessions,
    config: { provider: 'typesafe', model: 'jev-latest' },
    env: { JEV_BROWSER_ACTOR: 'cursor' },
    createSession: () => ({
      async run(task) {
        chunks.push(task.maxSteps);
        runs += 1;
        return { status: runs === 1 ? 'step_limit' : 'needs_verification', history: [] };
      }
    }),
    launchChrome: async () => ({
      browser: { async close() { closed = true; } },
      page: {
        async goto(url) { opened.push(url); },
        url: () => 'https://example.com/',
        async screenshot() { return Buffer.from('png-bytes'); }
      },
      tab: {}
    })
  };
  const first = await runChromeTask({
    url: 'https://example.com/',
    goal: 'Look at the page',
    allowed_origins: ['https://example.com']
  }, options);
  const second = await runChromeTask({
    session_id: first.session_id,
    goal: 'Look at the page'
  }, options);
  assert.deepEqual(opened, ['https://example.com/']);
  assert.deepEqual(chunks, [12, 12]);
  assert.equal(first.resume, 'continue_same_session');
  assert.equal(second.resume, 'verify_then_stop');
  assert.equal(second.session_id, first.session_id);
  assert.equal(closed, false);
  await closeChromeSession(sessions);
  assert.equal(closed, true);
  const message = contentWithImage(first);
  assert.equal(message.content[1].mimeType, 'image/png');
  assert.equal(message.content[0].text.includes('png-bytes'), false);
});

function chromeHarness() {
  const opened = [];
  const closed = [];
  let next = 0;
  let runs = 0;
  const sessions = { current: null, queue: Promise.resolve() };
  return {
    opened,
    closed,
    sessions,
    runs: () => runs,
    options: {
      sessions,
      config: { provider: 'typesafe', model: 'jev-latest' },
      env: { JEV_BROWSER_ACTOR: 'cursor' },
      createSession: () => ({
        async run() {
          runs += 1;
          return { status: 'step_limit', history: [] };
        }
      }),
      launchChrome: async () => {
        const id = ++next;
        return {
          browser: { async close() { closed.push(id); } },
          page: {
            async goto(url) { opened.push(url); },
            url: () => opened.at(-1),
            async screenshot() { return Buffer.from('png-bytes'); }
          },
          tab: { id }
        };
      }
    }
  };
}

test('a foreign session id does not continue the open browser', async () => {
  const harness = chromeHarness();
  const first = await runChromeTask({
    url: 'https://example.com/',
    goal: 'Look at the page',
    allowed_origins: ['https://example.com']
  }, harness.options);
  await assert.rejects(() => runChromeTask({
    session_id: '00000000-0000-4000-8000-000000000000',
    goal: 'Look at the page'
  }, harness.options), /same session_id/);
  assert.equal(harness.runs(), 1);
  assert.equal(harness.sessions.current.id, first.session_id);
  await closeChromeSession(harness.sessions);
});

test('a new url closes the previous Chrome and opens another', async () => {
  const harness = chromeHarness();
  const first = await runChromeTask({
    url: 'https://example.com/',
    goal: 'Look at the page',
    allowed_origins: ['https://example.com']
  }, harness.options);
  const second = await runChromeTask({
    url: 'https://www.iana.org/help/example-domains',
    goal: 'Read the page',
    allowed_origins: ['https://www.iana.org']
  }, harness.options);
  assert.deepEqual(harness.opened, ['https://example.com/', 'https://www.iana.org/help/example-domains']);
  assert.deepEqual(harness.closed, [1]);
  assert.notEqual(second.session_id, first.session_id);
  assert.equal(harness.sessions.current.tab.id, 2);
  await closeChromeSession(harness.sessions);
  assert.deepEqual(harness.closed, [1, 2]);
});

test('one call does not start a second chunk', async () => {
  const harness = chromeHarness();
  const outcome = await runChromeTask({
    url: 'https://example.com/',
    goal: 'Look at the page',
    allowed_origins: ['https://example.com']
  }, harness.options);
  assert.equal(outcome.status, 'step_limit');
  assert.equal(outcome.resume, 'continue_same_session');
  assert.equal(harness.runs(), 1);
  await closeChromeSession(harness.sessions);
});

test('wait matches open-session text without a Jev decision', async () => {
  const bridge = await import(pathToFileURL(join(homedir(), '.agents/skills/jev-browser-use/bridge.mjs')).href);
  const sessions = {
    current: {
      id: 'session-1',
      allowedOrigins: ['https://example.com'],
      tab: {
        async getAXState() {
          return 'Browser tab: Codex bridge URL: "https://example.com/".\n0 button Description: Ready now';
        }
      }
    },
    queue: Promise.resolve()
  };
  const matched = await waitForChromeState({
    session_id: 'session-1',
    includes: ['Ready'],
    excludes: ['Missing'],
    timeout_ms: 1000,
    poll_ms: 100
  }, { sessions, bridge });
  assert.equal(matched.status, 'matched');
  assert.equal(matched.session_id, 'session-1');
  assert.equal('state' in matched, false);
  const missed = await waitForChromeState({
    session_id: 'session-1',
    includes: ['Absent'],
    timeout_ms: 200,
    poll_ms: 100
  }, { sessions, bridge });
  assert.equal(missed.status, 'timeout');
});

test('host type clicks a named field and does not echo the text', async () => {
  const calls = [];
  const page = {
    url: () => 'https://example.com/',
    mouse: { async click(x, y) { calls.push(['click', x, y]); } },
    keyboard: { async insertText(text) { calls.push(['type', text]); } }
  };
  const cdp = {
    async send(method) {
      if (method === 'Accessibility.getFullAXTree') return {
        nodes: [{ role: { value: 'text field' }, name: { value: 'Search' }, backendDOMNodeId: 3 }]
      };
      if (method === 'DOM.getBoxModel') return { model: { content: [0, 0, 10, 0, 10, 10, 0, 10] } };
      throw new Error(method);
    }
  };
  const sessions = {
    current: { id: 'session-1', tab: createChromeTab(page, cdp) },
    queue: Promise.resolve()
  };
  const result = await typeInChrome({ session_id: 'session-1', text: 'secret-query', field: 'Search' }, { sessions });
  assert.deepEqual(result, { session_id: 'session-1', characters: 12 });
  assert.equal(JSON.stringify(result).includes('secret-query'), false);
  assert.deepEqual(calls, [['click', 5, 5], ['type', 'secret-query']]);
  await assert.rejects(() => typeInChrome({ session_id: 'session-1', text: '   ' }, { sessions }), /Invalid text/);
  await assert.rejects(() => typeInChrome({ session_id: 'missing', text: 'a' }, { sessions }), /session_id/);
});

test('host type clicks a searchbox and does not echo the text', async () => {
  const calls = [];
  const page = {
    url: () => 'https://www.wikipedia.org/',
    mouse: { async click(x, y) { calls.push(['click', x, y]); } },
    keyboard: { async insertText(text) { calls.push(['type', text]); } }
  };
  const cdp = {
    async send(method) {
      if (method === 'Accessibility.getFullAXTree') return {
        nodes: [{ role: { value: 'searchbox' }, name: { value: 'Search Wikipedia' }, backendDOMNodeId: 9 }]
      };
      if (method === 'DOM.getBoxModel') return { model: { content: [10, 20, 30, 20, 30, 40, 10, 40] } };
      throw new Error(method);
    }
  };
  const sessions = {
    current: { id: 'session-1', tab: createChromeTab(page, cdp) },
    queue: Promise.resolve()
  };
  const result = await typeInChrome({ session_id: 'session-1', text: 'Example', field: 'Search Wikipedia' }, { sessions });
  assert.deepEqual(result, { session_id: 'session-1', characters: 7 });
  assert.equal(JSON.stringify(result).includes('Example'), false);
  assert.deepEqual(calls, [['click', 20, 30], ['type', 'Example']]);
});
