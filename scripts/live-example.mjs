import { writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchChrome } from '../src/chrome-tab.mjs';
import { loadBridge } from '../src/server.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const shotPath = join(root, 'live-example.png');
const startUrl = 'https://example.com/';
const allowedOrigins = ['https://example.com', 'https://www.iana.org'];
const chrome = await launchChrome({ headless: process.env.JEV_CHROME_HEADLESS !== '0' });

try {
  await chrome.page.goto(startUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
  const state = await chrome.tab.getAXState();
  if (!state.includes('Learn more')) throw new Error('Learn more was not in the accessibility snapshot');
  const bridge = await loadBridge();
  const config = await bridge.loadConfig();
  const session = bridge.createSession(chrome.tab, {
    ...config,
    allowedOrigins,
    maxSteps: 2,
    minConfidence: 0.55
  });
  const outcome = await session.run({
    goal: 'Click the Learn more link.',
    controls: [{ op: 'click', name: 'Learn more' }],
    policy: { click: true, scrollDirections: ['down', 'up'] }
  });
  await writeFile(shotPath, await chrome.page.screenshot({ type: 'png' }));
  const finalUrl = chrome.page.url();
  const report = {
    status: outcome.status,
    url: finalUrl,
    handoff: outcome.handoff ?? null,
    actions: (outcome.history ?? []).map(item => item.action)
  };
  console.log(JSON.stringify(report, null, 2));
  if (!allowedOrigins.includes(new URL(finalUrl).origin)) throw new Error('Browser left the example origins');
} catch (error) {
  try { await writeFile(shotPath, await chrome.page.screenshot({ type: 'png' })); } catch { /* page may already be closed */ }
  console.error(error instanceof Error ? error.message : 'Live example failed');
  process.exitCode = 1;
} finally {
  await chrome.browser.close();
}
