import { formatSnapshot, parseAxTree } from './tab-adapter.mjs';

const SAFE_KEYS = new Set(['Enter', 'Escape', 'Tab', 'Shift+Tab', 'PageUp', 'PageDown', 'Home', 'End']);
const TEXT_ROLES = new Set(['text field', 'text area', 'combo box', 'searchbox']);

function center(quad) {
  return {
    x: (quad[0] + quad[2] + quad[4] + quad[6]) / 4,
    y: (quad[1] + quad[3] + quad[5] + quad[7]) / 4
  };
}

async function boxCenter(cdp, nodeId) {
  const { model } = await cdp.send('DOM.getBoxModel', { backendNodeId: nodeId });
  const quad = model?.content;
  if (!Array.isArray(quad) || quad.length < 8) throw new Error('Browser target is stale');
  return center(quad);
}

export function createChromeTab(page, cdp) {
  if (!page || !cdp || typeof cdp.send !== 'function') throw new Error('Chrome tab requires page and cdp');
  let nodeIds = [];
  let nodes = [];
  return Object.freeze({
    async getAXState() {
      const tree = await cdp.send('Accessibility.getFullAXTree');
      const formatted = formatSnapshot(page.url(), parseAxTree(JSON.stringify(tree)));
      nodes = formatted.nodes;
      nodeIds = nodes.map(node => String(node.backendId));
      return formatted.state;
    },
    async click(index) {
      const nodeId = Number(nodeIds[index]);
      if (!Number.isInteger(nodeId)) throw new Error('Browser target is stale');
      const point = await boxCenter(cdp, nodeId);
      await page.mouse.click(point.x, point.y);
    },
    async scroll(target, direction, amount = 1) {
      const delta = direction === 'down' ? 600 : -600;
      if (target === undefined) {
        for (let i = 0; i < amount; i++) await page.keyboard.press(direction === 'down' ? 'PageDown' : 'PageUp');
        return;
      }
      let point;
      if (Array.isArray(target)) point = { x: target[0], y: target[1] };
      else {
        const nodeId = Number(nodeIds[target]);
        if (!Number.isInteger(nodeId)) throw new Error('Browser target is stale');
        point = await boxCenter(cdp, nodeId);
      }
      if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) throw new Error('Browser target is stale');
      await page.mouse.move(point.x, point.y);
      for (let i = 0; i < amount; i++) await page.mouse.wheel(0, delta);
    },
    async pressKey(key) {
      if (!SAFE_KEYS.has(key)) throw new Error('Browser key requires host handback');
      await page.keyboard.press(key);
    },
    async typeText(text, fieldName) {
      if (typeof text !== 'string' || !text || text.length > 2000) throw new Error('Invalid text');
      if (fieldName) {
        await this.getAXState();
        const matches = nodes.filter(node => TEXT_ROLES.has(node.role) && (node.name === fieldName || node.name.startsWith(`${fieldName}, Value:`)));
        if (matches.length !== 1) throw new Error(matches.length ? 'Text field is ambiguous' : 'Text field was not found');
        const point = await boxCenter(cdp, matches[0].backendId);
        await page.mouse.click(point.x, point.y);
      }
      try {
        await page.keyboard.insertText(text);
      } catch {
        throw new Error('Text entry failed');
      }
    },
    reload() {
      return page.reload({ waitUntil: 'domcontentloaded' });
    }
  });
}

export async function launchChrome({ headless = true } = {}) {
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ channel: 'chrome', headless });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  return { browser, page, cdp, tab: createChromeTab(page, cdp) };
}
