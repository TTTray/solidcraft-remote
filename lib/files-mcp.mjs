#!/usr/bin/env node
// A small read-only MCP server (stdio) that lets the agent find design files to open in SolidCraft.
// It lists names only: it never reads, writes or opens files itself.
import { loadConfig, recentDesigns, listFolder, findFiles, anyPath, allowedRoots } from './files.mjs';

await loadConfig();

const TOOLS = [
  {
    name: 'recent_designs',
    description: "SolidCraft's recent designs, newest first: path, folder, last opened (unix time) and whether the file still exists. Start here when the user names a design.",
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    run: async () => ({ designs: await recentDesigns() }),
  },
  {
    name: 'find_files',
    description: 'Find design files (.sc, STEP, STL, 3MF, OBJ, glTF, IGES, DXF, SVG, images, PDF) whose path contains every word given, case-insensitive. Searches the folders around recent designs and the usual folders unless `folder` is given. Returns paths only.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Words from the file or folder name, e.g. "tower crane jib"' },
        folder: { type: 'string', description: 'Search only this folder (optional)' },
      },
      required: ['query'],
      additionalProperties: false,
    },
    run: a => findFiles(a.query, a.folder),
  },
  {
    name: 'list_folder',
    description: 'List the subfolders and design files in a folder (names only).',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false },
    run: a => listFolder(a.path),
  },
];

const send = msg => process.stdout.write(JSON.stringify(msg) + '\n');

async function handle(m) {
  if (m.id == null) return; // notifications
  switch (m.method) {
    case 'initialize':
      return send({ jsonrpc: '2.0', id: m.id, result: {
        protocolVersion: m.params?.protocolVersion || '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'files', version: '1.0' },
        instructions: `Find design files to open with SolidCraft's open tool. Access: ${anyPath() ? 'any folder' : allowedRoots().join(', ') + ' and folders of recent designs'}.`,
      } });
    case 'ping':
      return send({ jsonrpc: '2.0', id: m.id, result: {} });
    case 'tools/list':
      return send({ jsonrpc: '2.0', id: m.id, result: { tools: TOOLS.map(({ run, ...t }) => t) } });
    case 'tools/call': {
      const tool = TOOLS.find(t => t.name === m.params?.name);
      if (!tool) return send({ jsonrpc: '2.0', id: m.id, error: { code: -32602, message: `Unknown tool ${m.params?.name}` } });
      try {
        const out = await tool.run(m.params?.arguments || {});
        return send({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: JSON.stringify(out) }] } });
      } catch (e) {
        return send({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: e.message }], isError: true } });
      }
    }
    default:
      return send({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: `Not supported: ${m.method}` } });
  }
}

let buf = '';
const inFlight = new Set();
process.stdin.setEncoding('utf8');
process.stdin.on('data', d => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let m; try { m = JSON.parse(line); } catch { continue; }
    const p = handle(m).finally(() => inFlight.delete(p));
    inFlight.add(p);
  }
});
process.stdin.on('end', async () => { await Promise.allSettled([...inFlight]); process.exit(0); });
