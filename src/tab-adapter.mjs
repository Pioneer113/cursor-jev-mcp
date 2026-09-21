const MAX_SNAPSHOT = 24000;
const PAGE_KEYS = new Set(['PageUp', 'PageDown']);

function textFrom(result) {
  if (typeof result === 'string') return result;
  if (result?.isError) throw new Error('Browser transport failed');
  const value = result?.content?.filter(item => item?.type === 'text').map(item => item.text).join('\n');
  if (typeof value !== 'string' || !value) throw new Error('Browser transport returned no text');
  return value;
}

function extractUrl(value) {
  const match = value.match(/https?:\/\/[^\s"']+/);
  if (!match) throw new Error('Browser transport returned no URL');
  return match[0];
}

export function parseAxTree(raw) {
  let tree;
  try { tree = JSON.parse(raw); } catch { throw new Error('Browser transport returned invalid AX state'); }
  if (!Array.isArray(tree?.nodes)) throw new Error('Browser transport returned invalid AX state');
  return tree.nodes.flatMap(node => {
    const role = node?.role?.value;
    const name = node?.name?.value;
    const backendId = node?.backendDOMNodeId;
    return typeof role === 'string' && typeof name === 'string' && Number.isInteger(backendId)
      ? [{ role: role.replace(/\s+/g, ' ').trim(), name: name.replace(/\s+/g, ' ').trim(), backendId }]
      : [];
  }).filter(node => node.role && node.name);
}

export function formatSnapshot(url, nodes) {
  const header = `Browser tab: Codex bridge URL: "${url}".`;
  if (header.length > MAX_SNAPSHOT) throw new Error('Snapshot too large; narrow the task');
  const lines = [header];
  const kept = [];
  for (const node of nodes) {
    const line = `${kept.length} ${node.role} Description: ${node.name}`;
    if (`${lines.join('\n')}\n${line}`.length > MAX_SNAPSHOT) break;
    lines.push(line);
    kept.push(node);
  }
  return { state: lines.join('\n'), nodes: kept };
}

// Matches the installed jev-browser-use bridge: pressKey(key) takes one argument.
// The Claude PR adapter uses pressKey(target, key) and does not fit this install.
export function createBridgeTab({ tabId, callTool }) {
  if (typeof tabId !== 'string' || !tabId || typeof callTool !== 'function') throw new Error('Browser transport requires tabId and callTool');
  let nodeIds = [];
  const call = async (name, args = {}) => textFrom(await callTool(name, { tab_id: tabId, ...args }));
  const pageScroll = direction => call('codex_cua_scroll', {
    x: 500,
    y: 500,
    scroll_x: 0,
    scroll_y: direction === 'down' ? 600 : -600
  });
  return Object.freeze({
    async getAXState() {
      const [urlText, raw] = await Promise.all([call('codex_get_url'), call('codex_dom_snapshot')]);
      const formatted = formatSnapshot(extractUrl(urlText), parseAxTree(raw));
      nodeIds = formatted.nodes.map(node => String(node.backendId));
      return formatted.state;
    },
    async click(index) {
      const nodeId = nodeIds[index];
      if (!nodeId) throw new Error('Browser target is stale');
      await call('codex_dom_click', { node_id: nodeId });
    },
    async scroll(target, direction, amount = 1) {
      if (target !== undefined) throw new Error('Targeted scroll requires host handback');
      for (let i = 0; i < amount; i++) await pageScroll(direction);
    },
    async pressKey(key) {
      if (!PAGE_KEYS.has(key)) throw new Error('Browser key requires host handback');
      await pageScroll(key === 'PageDown' ? 'down' : 'up');
    },
    reload: () => call('codex_reload')
  });
}
