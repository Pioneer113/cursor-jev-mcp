#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import { launchChrome } from './chrome-tab.mjs';
import { createBridgeTab } from './tab-adapter.mjs';

const SAFE_COMMAND = /^[\w .:\\/@-]+(?:\.cmd|\.exe)?$/i;
const SAFE_PIPE = /^codex-browser-use(?:\\|-)[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const CONSEQUENTIAL = /\b(publish|send|like|follow|subscribe|purchase|buy|pay|delete|remove|logout|log out|sign out|save|submit|confirm|create|update|edit|password|account)\b/i;
const WRAPPER_KEYS = new Set(['Enter', 'Escape', 'Tab', 'Shift+Tab', 'PageUp', 'PageDown', 'Home', 'End']);
const MISSING_BRIDGE = 'codex-browser-bridge was not found in PATH. Install it or set CODEX_BROWSER_BRIDGE_COMMAND. Live clicks are unavailable until then.';
const DEFAULT_MAX_STEPS = 12;

function toolAnnotations({ readOnly, idempotent }) {
  return {
    readOnlyHint: readOnly,
    destructiveHint: false,
    idempotentHint: idempotent,
    openWorldHint: true
  };
}

export const tools = [
  { name: 'jev_user_tabs', description: 'List existing browser tabs available to claim.', annotations: toolAnnotations({ readOnly: true, idempotent: true }), inputSchema: { type: 'object', properties: {} } },
  { name: 'jev_claim_tab', description: 'Claim one existing browser tab for bounded Jev operation.', annotations: toolAnnotations({ readOnly: false, idempotent: false }), inputSchema: { type: 'object', properties: { tab_id: { type: 'string' } }, required: ['tab_id'] } },
  { name: 'jev_browser_run', description: 'Run one Jev chunk in background Google Chrome. Default 12 steps, maximum 30, and 45 seconds. Pass url to open a page. Chrome stays open and the same Jev history is kept. Safe keys are Enter, Escape, Tab, Shift+Tab, PageUp, PageDown, Home, and End. If status is step_limit or budget, inspect the screenshot and call again with the same session_id and goal, without url, only when the task is still valid. If status is needs_verification, stop and verify the screenshot yourself. That status is not a pass. Jev does not type.', annotations: toolAnnotations({ readOnly: false, idempotent: false }), inputSchema: { type: 'object', properties: { url: { type: 'string' }, session_id: { type: 'string' }, tab_id: { type: 'string' }, goal: { type: 'string' }, allowed_origins: { type: 'array', items: { type: 'string' } }, controls: { type: 'array' }, policy: { type: 'object' }, max_steps: { type: 'integer', minimum: 1, maximum: 30 }, min_confidence: { type: 'number', minimum: 0.55, maximum: 1 } }, required: ['goal'] } },
  { name: 'jev_wait', description: 'Wait until the open Chrome session accessibility text includes every string in includes and none in excludes. Does not start a Jev decision. Requires session_id.', annotations: toolAnnotations({ readOnly: true, idempotent: true }), inputSchema: { type: 'object', properties: { session_id: { type: 'string' }, includes: { type: 'array', items: { type: 'string' } }, excludes: { type: 'array', items: { type: 'string' } }, timeout_ms: { type: 'integer', minimum: 1, maximum: 60000 }, poll_ms: { type: 'integer', minimum: 100, maximum: 5000 } }, required: ['session_id'] } },
  { name: 'jev_host_type', description: 'Type text supplied by the host into the open Chrome session. Jev never chooses this text. Pass field to click that text field first. The typed text is not returned. Then resume with jev_browser_run and the same session_id.', annotations: toolAnnotations({ readOnly: false, idempotent: false }), inputSchema: { type: 'object', properties: { session_id: { type: 'string' }, text: { type: 'string' }, field: { type: 'string' } }, required: ['session_id', 'text'] } }
];

export function resolveBridgeCommand(env = process.env) {
  const command = env.CODEX_BROWSER_BRIDGE_COMMAND || 'codex-browser-bridge';
  if (!SAFE_COMMAND.test(command)) throw new Error('Invalid CODEX_BROWSER_BRIDGE_COMMAND');
  if (command.includes('/') || command.includes('\\')) {
    try { accessSync(command, constants.X_OK); } catch { throw new Error(MISSING_BRIDGE); }
    return command;
  }
  const found = (env.PATH || '').split(delimiter).filter(Boolean).some(dir => {
    try { accessSync(join(dir, command), constants.X_OK); return true; } catch { return false; }
  });
  if (!found) throw new Error(MISSING_BRIDGE);
  return command;
}

export function browserBridgeArgs(command, runDoctor = spawnSync) {
  const args = ['--mode', 'mcp', '--profile', 'basic'];
  try {
    const doctor = runDoctor(command, ['--mode', 'doctor'], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 15000,
      shell: process.platform === 'win32' && /\.cmd$/i.test(command)
    });
    if (doctor.status !== 0) return args;
    const report = JSON.parse(doctor.stdout);
    const pipe = report?.pipes
      ?.filter(candidate => candidate?.connected === true && SAFE_PIPE.test(candidate.name ?? ''))
      .sort((a, b) => (a.latency_ms ?? Number.MAX_SAFE_INTEGER) - (b.latency_ms ?? Number.MAX_SAFE_INTEGER))[0]?.name;
    if (pipe) args.push('--pipe', pipe);
  } catch { /* doctor is optional; the default pipe selection still starts */ }
  return args;
}

export function bridgePath(env = process.env) {
  return env.JEV_BRIDGE_PATH || join(homedir(), '.agents', 'skills', 'jev-browser-use', 'bridge.mjs');
}

export async function loadBridge(env = process.env) {
  return import(pathToFileURL(bridgePath(env)).href);
}

class BrowserMcpClient {
  constructor(command, args) {
    this.child = spawn(command, args, {
      stdio: ['pipe', 'pipe', 'inherit'],
      shell: process.platform === 'win32' && /\.cmd$/i.test(command),
      windowsHide: true
    });
    this.pending = new Map();
    this.nextId = 1;
    this.child.on('error', error => {
      this.failAll(error?.code === 'ENOENT' ? MISSING_BRIDGE : 'Browser bridge failed to start');
    });
    createInterface({ input: this.child.stdout }).on('line', line => {
      let message;
      try { message = JSON.parse(line); } catch { return; }
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      message.error ? pending.reject(new Error('Browser MCP request failed')) : pending.resolve(message.result);
    });
    this.child.on('exit', () => this.failAll('Browser MCP exited'));
  }
  failAll(message) {
    for (const pending of this.pending.values()) pending.reject(new Error(message));
    this.pending.clear();
  }
  request(method, params) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }
  notify(method, params) {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  }
  async initialize() {
    await this.request('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'jev-chrome-mcp', version: '0.1.0' } });
    this.notify('notifications/initialized', {});
  }
  callTool(name, args) {
    return this.request('tools/call', { name, arguments: args });
  }
  close() {
    this.child.kill();
  }
}

function assertString(value, name) {
  if (typeof value !== 'string' || !value) throw new Error(`Invalid ${name}`);
  return value;
}

function parseOrigin(value) {
  if (typeof value !== 'string') throw new Error('Invalid browser origin');
  const url = new URL(value);
  if (url.origin !== value || !['https:', 'http:'].includes(url.protocol)) throw new Error('Invalid browser origin');
  return value;
}

function configuredOrigins(config) {
  const origins = config?.browser?.allowedOrigins;
  if (origins === undefined) return null;
  if (!Array.isArray(origins) || !origins.length) throw new Error('Invalid configured browser origins');
  return origins.map(parseOrigin);
}

function enforceActor(config, env) {
  const allowed = config?.browser?.allowedActors;
  if (allowed === undefined) return env.JEV_BROWSER_ACTOR || 'unspecified';
  if (!Array.isArray(allowed) || !allowed.length || allowed.some(value => typeof value !== 'string' || !value)) throw new Error('Invalid configured browser actors');
  const actor = env.JEV_BROWSER_ACTOR;
  if (!actor || !allowed.includes(actor)) throw new Error('Browser actor is not authorized');
  return actor;
}

function enforceOrigins(requested, config) {
  if (!Array.isArray(requested) || !requested.length) throw new Error('Invalid allowed_origins');
  const origins = requested.map(parseOrigin);
  const configured = configuredOrigins(config);
  if (configured && origins.some(origin => !configured.includes(origin))) throw new Error('Browser origin is not authorized by host');
  return origins;
}

function toolText(result) {
  if (typeof result === 'string') return result;
  const value = result?.content?.filter(item => item?.type === 'text').map(item => item.text).join('\n');
  if (result?.isError || typeof value !== 'string' || !value) throw new Error('Browser transport returned no text');
  return value;
}

function originFromUrlText(value) {
  const match = value.match(/https?:\/\/[^\s"']+/);
  if (!match) throw new Error('Browser transport returned no URL');
  return new URL(match[0]).origin;
}

function filterUserTabs(result, config) {
  const configured = configuredOrigins(config);
  if (!configured) return result;
  let tabs;
  try { tabs = JSON.parse(toolText(result)); } catch { throw new Error('Browser transport returned invalid tab list'); }
  if (!Array.isArray(tabs)) throw new Error('Browser transport returned invalid tab list');
  return tabs.filter(tab => {
    try { return typeof tab?.url === 'string' && configured.includes(new URL(tab.url).origin); } catch { return false; }
  });
}

function taskPolicy(args) {
  const requestedPolicy = args?.policy ?? { click: true, scrollDirections: ['down', 'up'] };
  return {
    ...requestedPolicy,
    keys: (requestedPolicy.keys ?? []).filter(key => WRAPPER_KEYS.has(key)),
    requireCodexNames: [...(requestedPolicy.requireCodexNames ?? []), CONSEQUENTIAL]
  };
}

function assertSafeControls(controls) {
  if (!Array.isArray(controls) || controls.some(control =>
    !control || !['click', 'scroll', 'reload', 'press'].includes(control.op) ||
    (control.op === 'click' && CONSEQUENTIAL.test(control.name ?? '')) ||
    (control.op === 'press' && !WRAPPER_KEYS.has(control.key)))) throw new Error('Unsafe browser control');
}

const chromeSessions = { current: null, queue: Promise.resolve() };

function enqueue(sessions, job) {
  const run = sessions.queue.then(job, job);
  sessions.queue = run.then(() => {}, () => {});
  return run;
}

export async function closeChromeSession(sessions = chromeSessions) {
  const current = sessions.current;
  sessions.current = null;
  if (current) await current.browser.close();
}

function resumeHint(status) {
  if (status === 'step_limit' || status === 'budget') return 'continue_same_session';
  if (status === 'needs_verification') return 'verify_then_stop';
  return null;
}

function requireHeld(sessions, sessionId) {
  const held = sessions.current;
  if (!held || typeof sessionId !== 'string' || sessionId !== held.id) throw new Error('Pass the same session_id to continue');
  return held;
}

export async function runChromeTask(args, options = {}) {
  const sessions = options.sessions ?? chromeSessions;
  return enqueue(sessions, () => runChromeTaskNow(args, options, sessions));
}

export async function waitForChromeState(args, options = {}) {
  const sessions = options.sessions ?? chromeSessions;
  return enqueue(sessions, async () => {
    const held = requireHeld(sessions, args?.session_id);
    const env = options.env ?? process.env;
    const bridge = options.bridge ?? await loadBridge(env);
    const result = await bridge.waitForState(held.tab, {
      allowedOrigins: held.allowedOrigins,
      includes: args?.includes ?? [],
      excludes: args?.excludes ?? [],
      timeoutMs: args?.timeout_ms,
      pollMs: args?.poll_ms
    });
    return { status: result.status, elapsedMs: result.elapsedMs, session_id: held.id };
  });
}

export async function typeInChrome(args, options = {}) {
  const sessions = options.sessions ?? chromeSessions;
  return enqueue(sessions, async () => {
    const held = requireHeld(sessions, args?.session_id);
    const text = args?.text;
    if (typeof text !== 'string' || !text.trim()) throw new Error('Invalid text');
    await held.tab.typeText(text, args?.field);
    return { session_id: held.id, characters: text.length };
  });
}

async function runChromeTaskNow(args, options, sessions) {
  const env = options.env ?? process.env;
  const bridge = options.bridge ?? (options.createSession && options.config ? null : await loadBridge(env));
  const config = options.config ?? await bridge.loadConfig();
  const actor = enforceActor(config, env);
  const goal = assertString(args?.goal, 'goal');
  const controls = args?.controls ?? [];
  assertSafeControls(controls);
  const policy = taskPolicy(args);
  const maxSteps = args?.max_steps ?? DEFAULT_MAX_STEPS;
  const minConfidence = args?.min_confidence ?? 0.55;
  const opening = typeof args?.url === 'string' && args.url;
  if (opening) {
    const parsed = new URL(args.url);
    if (!['https:', 'http:'].includes(parsed.protocol)) throw new Error('Invalid url');
    const allowedOrigins = enforceOrigins(args?.allowed_origins, config);
    if (!allowedOrigins.includes(parsed.origin)) throw new Error('Browser origin is not authorized by host');
    await closeChromeSession(sessions);
    const launch = options.launchChrome ?? launchChrome;
    const opened = await launch({ headless: env.JEV_CHROME_HEADLESS !== '0' });
    try {
      await opened.page.goto(args.url, { waitUntil: 'domcontentloaded', timeout: 20000 });
    } catch (error) {
      await opened.browser.close();
      throw error;
    }
    const createSession = options.createSession ?? bridge.createSession;
    sessions.current = {
      id: randomUUID(),
      ...opened,
      jev: createSession(opened.tab, { ...config, allowedOrigins, maxSteps, minConfidence }),
      allowedOrigins,
      actor
    };
  } else if (!sessions.current || (args?.session_id && args.session_id !== sessions.current.id)) {
    throw new Error('Pass url to open Chrome, or the same session_id to continue');
  } else if (args?.allowed_origins) {
    sessions.current.allowedOrigins = enforceOrigins(args.allowed_origins, config);
  }
  const held = sessions.current;
  const outcome = await held.jev.run({
    goal,
    controls,
    policy,
    allowedOrigins: held.allowedOrigins,
    maxSteps,
    minConfidence
  });
  const screenshot = await held.page.screenshot({ type: 'png' });
  return { ...outcome, actor: held.actor, session_id: held.id, url: held.page.url(), resume: resumeHint(outcome.status), screenshot };
}

export async function handleJevTool(name, args, callTool, options = {}) {
  const env = options.env ?? process.env;
  const needsInstalledBridge = options.config === undefined || (name === 'jev_browser_run' && !options.createSession);
  const bridge = options.bridge ?? (needsInstalledBridge ? await loadBridge(env) : null);
  const config = options.config ?? await bridge.loadConfig();
  const actor = enforceActor(config, env);
  if (name === 'jev_user_tabs') return filterUserTabs(await callTool('codex_user_tabs', {}), config);
  if (name === 'jev_claim_tab') {
    const tabId = assertString(args?.tab_id, 'tab_id');
    const claimed = await callTool('codex_claim_tab', { tab_id: tabId });
    const configured = configuredOrigins(config);
    if (configured) {
      const actual = originFromUrlText(toolText(await callTool('codex_get_url', { tab_id: tabId })));
      if (!configured.includes(actual)) throw new Error('Claimed tab origin is not authorized by host');
    }
    return claimed;
  }
  if (name !== 'jev_browser_run') throw new Error('Unknown Jev browser tool');
  if ((typeof args?.url === 'string' && args.url) || args?.session_id) return runChromeTask(args, { ...options, env, bridge, config });
  const tabId = assertString(args?.tab_id, 'tab_id');
  const goal = assertString(args?.goal, 'goal');
  const allowedOrigins = enforceOrigins(args?.allowed_origins, config);
  const controls = args?.controls ?? [];
  assertSafeControls(controls);
  const policy = taskPolicy(args);
  const createSession = options.createSession ?? bridge.createSession;
  const session = createSession(createBridgeTab({ tabId, callTool }), {
    ...config,
    allowedOrigins,
    maxSteps: args?.max_steps ?? DEFAULT_MAX_STEPS,
    minConfidence: args?.min_confidence ?? 0.55
  });
  try {
    return { ...await session.run({ goal, controls, policy }), actor };
  } finally {
    try { await callTool('codex_finalize', {}); } catch { /* the run result still returns if finalize is already closed */ }
  }
}

function content(value) {
  return { content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }] };
}

export function contentWithImage(value) {
  const screenshot = value?.screenshot;
  const text = { ...value };
  delete text.screenshot;
  const parts = [{ type: 'text', text: JSON.stringify(text) }];
  if (screenshot) parts.push({ type: 'image', data: Buffer.from(screenshot).toString('base64'), mimeType: 'image/png' });
  return { content: parts };
}

function publicError(error) {
  const message = error instanceof Error ? error.message : 'Jev browser request failed';
  if (/bearer|api[_-]?key|sk-|secret/i.test(message)) return 'Jev browser request failed';
  return message;
}

async function main() {
  let browser;
  const getBrowser = async () => {
    if (!browser) {
      const command = resolveBridgeCommand();
      const client = new BrowserMcpClient(command, browserBridgeArgs(command));
      try {
        await client.initialize();
      } catch (error) {
        client.close();
        throw error;
      }
      browser = client;
    }
    return browser;
  };
  const input = createInterface({ input: process.stdin });
  input.on('line', async line => {
    let request;
    try { request = JSON.parse(line); } catch { return; }
    if (request.id === undefined) return;
    try {
      let result;
      if (request.method === 'initialize') result = { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'jev-chrome-mcp', version: '0.1.0' } };
      else if (request.method === 'tools/list') result = { tools };
      else if (request.method === 'tools/call') {
        const name = request.params?.name;
        const args = request.params?.arguments ?? {};
        if (name === 'jev_browser_run' && !args.tab_id) result = contentWithImage(await runChromeTask(args));
        else if (name === 'jev_wait') result = content(await waitForChromeState(args));
        else if (name === 'jev_host_type') result = content(await typeInChrome(args));
        else {
          const client = await getBrowser();
          result = content(await handleJevTool(name, args, (toolName, toolArgs) => client.callTool(toolName, toolArgs)));
        }
      } else throw new Error('Method not found');
      process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result })}\n`);
    } catch (error) {
      process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { content: [{ type: 'text', text: publicError(error) }], isError: true } })}\n`);
    }
  });
  input.on('close', () => {
    browser?.close();
    closeChromeSession();
  });
  process.on('exit', () => browser?.close());
}

const entry = process.argv[1] ? pathToFileURL(process.argv[1]).href : '';
if (import.meta.url === entry) main();
