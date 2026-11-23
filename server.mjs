#!/usr/bin/env node
// SolidCraft Remote: drive SolidCraft and a Claude Code agent from your phone over Tailscale.
// No dependencies: Node 22+ only. Run: node server.mjs (or `solidcraft-remote start` when installed)
import http from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { readFile, writeFile, mkdir, stat, unlink } from 'node:fs/promises';
import { existsSync, createWriteStream } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID, randomBytes } from 'node:crypto';
import { loadConfig, solidcraftArgs, recentDesigns, canBrowse, anyPath, allowedRoots, DATA_DIR, UPLOAD_DIR, OPENABLE } from './lib/files.mjs';

await loadConfig(); // ~/.config/solidcraft-remote/env, written by `solidcraft-remote files …`
const HERE = dirname(fileURLToPath(import.meta.url));
const VERSION = JSON.parse(await readFile(join(HERE, 'package.json'), 'utf8').catch(() => '{}')).version || 'dev';
const PORT = Number(process.env.PORT || 8790);
const CLAUDE_BIN = process.env.CLAUDE_BIN || [join(homedir(), '.local/bin/claude')].find(existsSync) || 'claude';
const SOLIDCRAFT_CLI = process.env.SOLIDCRAFT_CLI || 'solidcraft-cli';
const SOLIDCRAFT_APP = process.env.SOLIDCRAFT_APP || 'solidcraft';
const SOLIDCRAFT_PORT = process.env.SOLIDCRAFT_PORT || '27878';
const AGENT_DIR = join(DATA_DIR, 'agent-home'); // the agent's working folder (its chats are stored under this name)
const MAX_UPLOAD = 200 * 1024 * 1024;
const MAX_PDF_INLINE = 15 * 1024 * 1024; // PDFs up to this size are also shown to the agent directly
const MIME = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif', '.pdf': 'application/pdf' };

const MODELS = { 'claude-opus-5-5': 'Opus 5.5', 'claude-sonnet-5-5': 'Sonnet 5.5', 'claude-haiku-5-5': 'Haiku 5.5' };
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const DEFAULT_MODEL = MODELS[process.env.MODEL] ? process.env.MODEL : 'claude-opus-5-5';
const DEFAULT_EFFORT = EFFORTS.includes(process.env.EFFORT) ? process.env.EFFORT : 'high';

const SYSTEM_APPEND = `You are driving SolidCraft, a parametric CAD app, on the user's desktop computer. The user is away from the desk, on their phone, using a small remote-control page: it shows your replies and a live render of the model that refreshes after each of your tool calls, plus buttons for views, undo, redo and save.
- Keep replies short and plain for a phone screen: a sentence or two, or a few bullets. No long JSON, tables or code.
- The design open in the app is the user's real work. Don't close, replace, or open another design, and don't overwrite files, unless they ask. Save only when asked.
- If a request is ambiguous, make a sensible choice and say what you chose, rather than asking several questions.
- The user often sends photos (a part, a hand sketch, a drawing) and describes what they want. Read sizes and features from them; when a dimension isn't readable, pick a sensible value, say so, and make it a parameter.
- Files the user attaches are saved on this PC and their paths are given with the message; SolidCraft can open or import them from there.
- To open a design the user names ("open the tower crane"), find it with the files tools (recent_designs first, then find_files or list_folder), then use SolidCraft's open tool. Opening replaces the current design: if it has unsaved changes, ask before opening. If several files match, list the likely ones briefly and ask which.
- ${anyPath() ? 'SolidCraft may open, save and export files anywhere on this PC.' : `SolidCraft may open, save and export files in: ${allowedRoots().join(', ')}, and the folders of designs opened or saved in this session.`}`;

// ---------------------------------------------------------------- helpers
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
const textOf = r => (r?.content || []).filter(c => c.type === 'text').map(c => c.text).join('\n');
const imageOf = r => (r?.content || []).find(c => c.type === 'image');

function tailscaleIPs() {
  if (process.env.BIND) return process.env.BIND.split(',').map(s => s.trim()).filter(Boolean);
  try {
    return execFileSync('tailscale', ['ip', '-4'], { encoding: 'utf8', timeout: 5000 })
      .split('\n').map(s => s.trim()).filter(Boolean);
  } catch { return []; }
}

// Only loopback and Tailscale addresses may connect.
function allowedPeer(addr = '') {
  const a = addr.replace(/^::ffff:/, '').toLowerCase();
  if (a === '127.0.0.1' || a === '::1') return true;
  const m = a.match(/^(\d+)\.(\d+)\.\d+\.\d+$/);
  if (m && +m[1] === 100 && +m[2] >= 64 && +m[2] <= 127) return true; // 100.64.0.0/10
  return a.startsWith('fd7a:115c:a1e0:'); // Tailscale IPv6
}

// Refuse requests whose Host header names some other site (DNS-rebinding guard).
function allowedHost(hostHeader = '', bound) {
  const h = hostHeader.replace(/:\d+$/, '').replace(/^\[|\]$/g, '').toLowerCase();
  const host = hostname().toLowerCase();
  return h === 'localhost' || bound.includes(h) || h === host || h.startsWith(host + '.') || h.endsWith('.ts.net');
}

// ---------------------------------------------------------------- SolidCraft MCP client
// A tiny MCP (JSON-RPC over stdio) client for `solidcraft-cli mcp`, used for the live render and the buttons.
class McpClient {
  constructor(cmd, args) { Object.assign(this, { cmd, args, proc: null, ready: null, nextId: 0, pending: new Map(), buf: '', lastErr: '' }); }

  start() {
    if (this.ready) return this.ready;
    const proc = spawn(this.cmd, this.args, { stdio: ['pipe', 'pipe', 'pipe'] });
    this.proc = proc;
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', d => this.onData(d));
    proc.stderr.on('data', d => { this.lastErr = String(d).trim().slice(-400); });
    proc.stdin.on('error', () => {});
    const fail = err => {
      if (this.proc !== proc) return;
      this.proc = null; this.ready = null;
      for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(err); }
      this.pending.clear();
    };
    proc.on('error', e => fail(new Error(`Can't start ${this.cmd}: ${e.message}`)));
    proc.on('exit', code => fail(new Error(`${this.cmd} exited (${code}). ${this.lastErr}`)));
    this.ready = (async () => {
      await this.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'solidcraft-remote', version: '1.0' } }, 30000);
      this.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    })();
    this.ready.catch(() => { if (this.proc === proc) { proc.kill(); } });
    return this.ready;
  }

  send(msg) { this.proc?.stdin.write(JSON.stringify(msg) + '\n'); }

  onData(d) {
    this.buf += d;
    let i;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i).trim();
      this.buf = this.buf.slice(i + 1);
      if (!line) continue;
      let m; try { m = JSON.parse(line); } catch { continue; }
      if (m.method && m.id != null) { // a request from the server (ping, roots/list)
        if (m.method === 'ping') this.send({ jsonrpc: '2.0', id: m.id, result: {} });
        else if (m.method === 'roots/list') this.send({ jsonrpc: '2.0', id: m.id, result: { roots: [] } });
        else this.send({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'Not supported' } });
        continue;
      }
      const p = m.id != null && this.pending.get(m.id);
      if (!p) continue;
      this.pending.delete(m.id);
      clearTimeout(p.timer);
      m.error ? p.reject(new Error(m.error.message || 'MCP error')) : p.resolve(m.result);
    }
  }

  rpc(method, params, timeoutMs = 120000) {
    return new Promise((resolve, reject) => {
      if (!this.proc) return reject(new Error(`${this.cmd} is not running`));
      const id = ++this.nextId;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`SolidCraft took too long (${method})`)); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ jsonrpc: '2.0', id, method, params });
    });
  }

  async call(name, args = {}, timeoutMs) {
    await this.start();
    return this.rpc('tools/call', { name, arguments: args }, timeoutMs);
  }
}

const sc = new McpClient(SOLIDCRAFT_CLI, solidcraftArgs());

let shotChain = Promise.resolve();
function screenshot({ w = 900, h = 900, view } = {}) {
  const clamp = v => Math.max(200, Math.min(1600, Math.round(Number(v) || 900)));
  const args = { source: 'model', width: clamp(w), height: clamp(h) };
  if (view) args.view = String(view);
  const run = async () => {
    const r = await sc.call('screenshot', args, 90000);
    if (r?.isError) throw new Error(textOf(r) || 'SolidCraft could not render the view');
    const img = imageOf(r);
    if (!img) throw new Error('SolidCraft returned no picture');
    return Buffer.from(img.data, 'base64');
  };
  const p = shotChain.then(run, run); // one render at a time
  shotChain = p.catch(() => {});
  return p;
}

// ---------------------------------------------------------------- uploads
const safeName = s => (String(s).split(/[\\/]/).pop() || 'file').replace(/[^\w.\- ()]+/g, '_').replace(/^\.+/, '').slice(-80) || 'file';
const stamp = () => new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-') + '-' + randomBytes(2).toString('hex');

async function saveUpload(req) {
  const name = safeName(decodeURIComponent(req.headers['x-filename'] || 'file'));
  const id = `${stamp()}-${name}`;
  const path = join(UPLOAD_DIR, id);
  let size = 0;
  try {
    await new Promise((resolve, reject) => {
      const out = createWriteStream(path);
      req.on('data', chunk => {
        size += chunk.length;
        if (size > MAX_UPLOAD) { req.unpipe(out); out.destroy(); req.destroy(); reject(new Error('That file is over 200 MB')); }
      });
      req.on('error', reject);
      out.on('error', reject);
      out.on('finish', resolve);
      req.pipe(out);
    });
  } catch (e) {
    await unlink(path).catch(() => {});
    throw e;
  }
  log(`received ${name} (${Math.round(size / 1024)} KB)`);
  return { id, name, size };
}

// Turn what the page sent into saved files and the blocks the agent sees.
async function prepareAttachments(body) {
  const images = [], docs = [], files = [];
  for (const img of (Array.isArray(body.images) ? body.images : []).slice(0, 8)) {
    const mime = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(img.mime) ? img.mime : 'image/jpeg';
    const data = String(img.data || '');
    if (!data) continue;
    const ext = { 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif' }[mime] || '.jpg';
    const id = `${stamp()}-${safeName(img.name || 'photo').replace(/\.\w+$/, '')}${ext}`;
    await writeFile(join(UPLOAD_DIR, id), Buffer.from(data, 'base64'));
    images.push({ name: img.name || 'photo', url: `/uploads/${encodeURIComponent(id)}`, path: join(UPLOAD_DIR, id), mime, data });
  }
  for (const raw of (Array.isArray(body.files) ? body.files : []).slice(0, 10)) {
    const id = safeName(raw);
    const path = join(UPLOAD_DIR, id);
    const st = await stat(path).catch(() => null);
    if (!st?.isFile()) continue;
    const name = id.replace(/^\d{4}(-\d\d){5}-[0-9a-f]{4}-/, '');
    if (extname(id).toLowerCase() === '.pdf' && st.size <= MAX_PDF_INLINE) docs.push({ name, path, data: (await readFile(path)).toString('base64') });
    else files.push({ name, path, size: st.size });
  }
  return { images, docs, files };
}

// ---------------------------------------------------------------- starting SolidCraft from the phone
const GUI_VARS = ['WAYLAND_DISPLAY', 'DISPLAY', 'XAUTHORITY', 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS', 'XDG_SESSION_TYPE',
  'XDG_CURRENT_DESKTOP', 'XDG_SESSION_DESKTOP', 'KDE_FULL_SESSION', 'KDE_SESSION_VERSION', 'QT_QPA_PLATFORMTHEME'];
let starting = false;

async function startSolidCraft() {
  if ((await designStatus()).connected) return { ok: true, text: 'SolidCraft is already running' };
  if (starting) return { ok: true, text: 'Already starting' };
  // A server started over SSH has no screen to open windows on: borrow the desktop session's.
  const env = { ...process.env };
  try {
    const out = execFileSync('systemctl', ['--user', 'show-environment'], { encoding: 'utf8', timeout: 5000 });
    for (const line of out.split('\n')) {
      const i = line.indexOf('=');
      if (i < 1) continue;
      const key = line.slice(0, i);
      let value = line.slice(i + 1);
      if (value.startsWith("$'") && value.endsWith("'")) value = value.slice(2, -1);
      if (GUI_VARS.includes(key) && !env[key]) env[key] = value;
    }
  } catch {}
  if (!env.WAYLAND_DISPLAY && !env.DISPLAY) {
    throw new Error('No desktop session is running on the PC, so SolidCraft has no screen to open on. Log in on the PC first.');
  }
  for (const key of Object.keys(env)) if (key.startsWith('CLAUDE') || key.startsWith('ANTHROPIC_')) delete env[key];
  const proc = spawn(SOLIDCRAFT_APP, ['--control', SOLIDCRAFT_PORT], { env, cwd: homedir(), detached: true, stdio: 'ignore' });
  proc.on('error', e => log(`can't start SolidCraft: ${e.message}`));
  proc.unref();
  log('starting SolidCraft');
  starting = true;
  (async () => {
    for (let i = 0; i < 30; i++) {
      await new Promise(r => setTimeout(r, 2000));
      const s = await designStatus();
      if (s.connected) { agent.broadcast({ t: 'status', ...s }); agent.broadcast({ t: 'shot' }); break; }
    }
    starting = false;
  })();
  return { ok: true, text: 'Starting SolidCraft…' };
}

async function designStatus() {
  try {
    const r = await sc.call('inspect_design', { measure: false, sketches: false, timeline: false, bodies: false, joints: false }, 30000);
    if (r?.isError) return { connected: false, error: clip(textOf(r), 300) };
    const d = JSON.parse(textOf(r));
    return { connected: true, name: d.name || 'Untitled', dirty: !!d.dirty, path: d.path || null, units: d.units || null };
  } catch (e) {
    return { connected: false, error: clip(e.message, 300) };
  }
}

// ---------------------------------------------------------------- the agent (headless Claude Code)
function shortTool(name = '') { return name.replace(/^mcp__[a-z0-9_-]+?__/i, ''); }

function summarizeInput(name, input = {}) {
  if (name === 'batch' && Array.isArray(input.commands)) {
    const names = input.commands.map(s => s?.command || '').filter(Boolean);
    return `${input.commands.length} step${input.commands.length === 1 ? '' : 's'}${names.length ? ': ' + clip(names.join(', '), 140) : ''}`;
  }
  if (input.command) return clip(String(input.command) + (input.params ? ' ' + JSON.stringify(input.params) : ''), 160);
  const s = JSON.stringify(input);
  return s === '{}' ? '' : clip(s, 160);
}

function summarizeResult(content) {
  const text = typeof content === 'string' ? content
    : Array.isArray(content) ? content.filter(c => c.type === 'text').map(c => c.text).join('\n') : '';
  return clip(text.replace(/\s+/g, ' ').trim(), 200);
}

class Agent {
  constructor() {
    Object.assign(this, {
      proc: null, items: [], clients: new Set(), pending: 0, interrupted: false, restartAfter: false, notes: [],
      model: DEFAULT_MODEL, effort: DEFAULT_EFFORT, sessionId: null, usage: null,
      k: 0, textQueue: [], blockKeys: new Map(), curMsg: null, stderr: '',
    });
  }

  get busy() { return this.pending > 0; }

  broadcast(ev) { const data = `data: ${JSON.stringify(ev)}\n\n`; for (const c of this.clients) c.write(data); }
  emit(ev) { this.items.push(ev); if (this.items.length > 600) this.items.splice(0, this.items.length - 600); this.broadcast(ev); }

  snapshot() {
    return { t: 'snapshot', items: this.items, busy: this.busy, model: this.model, effort: this.effort, models: MODELS, efforts: EFFORTS, session: this.sessionId, usage: this.usage };
  }

  spawn() {
    const mcp = { mcpServers: {
      solidcraft: { type: 'stdio', command: SOLIDCRAFT_CLI, args: solidcraftArgs() },
      files: { type: 'stdio', command: process.execPath, args: [join(HERE, 'lib/files-mcp.mjs')] }, // read-only file finder
    } };
    const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
      '--mcp-config', JSON.stringify(mcp), '--strict-mcp-config',
      '--tools', '', '--allowedTools', 'mcp__solidcraft,mcp__files', '--permission-mode', 'dontAsk',
      '--setting-sources', '', '--model', this.model, '--effort', this.effort,
      '--append-system-prompt', SYSTEM_APPEND];
    if (this.sessionId) args.push('--resume', this.sessionId);

    // Use the subscription you signed in with (`claude auth login`), never an API key or a parent session's settings.
    const env = { ...process.env };
    for (const key of Object.keys(env)) {
      if ((key.startsWith('CLAUDE') && key !== 'CLAUDE_CONFIG_DIR') || key.startsWith('ANTHROPIC_')) delete env[key];
    }

    const proc = spawn(CLAUDE_BIN, args, { cwd: AGENT_DIR, env, stdio: ['pipe', 'pipe', 'pipe'] });
    this.proc = proc;
    this.stderr = '';
    log(`agent started (${MODELS[this.model]}, ${this.effort}${this.sessionId ? ', resuming ' + this.sessionId : ''})`);
    let buf = '';
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', d => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        let m; try { m = JSON.parse(line); } catch { continue; }
        if (this.proc === proc) this.handle(m);
      }
    });
    proc.stderr.on('data', d => { this.stderr = (this.stderr + d).slice(-1500); });
    proc.stdin.on('error', () => {});
    const ended = msg => {
      if (this.proc !== proc) return;
      this.proc = null;
      const wasBusy = this.busy;
      this.pending = 0; this.interrupted = false;
      this.closeText();
      if (wasBusy || msg) this.emit({ t: 'error', text: msg || 'The agent stopped. Your next message starts it again where it left off.' });
      this.broadcast({ t: 'busy', busy: false });
      log('agent ended', msg || '', clip(this.stderr.trim(), 300));
    };
    proc.on('error', e => ended(`Can't start Claude Code (${CLAUDE_BIN}): ${e.message}`));
    proc.on('exit', (code, sig) => ended(code && !sig ? `Claude Code exited with code ${code}. ${clip(this.stderr.trim(), 300)}`.trim() : ''));
  }

  closeText() { this.textQueue = []; this.blockKeys.clear(); }

  handle(m) {
    switch (m.type) {
      case 'system':
        if (m.subtype === 'init') {
          this.sessionId = m.session_id || this.sessionId;
          this.broadcast({ t: 'session', session: this.sessionId });
          log(`agent ready: ${m.model}, Claude Code ${m.claude_code_version}, API key: ${m.apiKeySource || 'none'} (none = your subscription)`);
        }
        break;
      case 'stream_event': {
        const e = m.event || {};
        if (e.type === 'message_start') this.curMsg = e.message?.id;
        else if (e.type === 'content_block_start' && e.content_block?.type === 'text') {
          const k = ++this.k;
          this.blockKeys.set(`${this.curMsg}:${e.index}`, k);
          this.textQueue.push(k);
        } else if (e.type === 'content_block_delta' && e.delta?.type === 'text_delta') {
          const k = this.blockKeys.get(`${this.curMsg}:${e.index}`);
          if (k) this.broadcast({ t: 'delta', k, text: e.delta.text });
        }
        break;
      }
      case 'assistant':
        for (const b of m.message?.content || []) {
          if (b.type === 'text' && b.text?.trim()) this.emit({ t: 'text', k: this.textQueue.shift() ?? ++this.k, text: b.text });
          else if (b.type === 'tool_use') { const name = shortTool(b.name); this.emit({ t: 'tool', id: b.id, name, summary: summarizeInput(name, b.input) }); }
        }
        break;
      case 'user': {
        const content = m.message?.content;
        if (!Array.isArray(content)) break;
        for (const b of content) {
          if (b.type !== 'tool_result') continue;
          this.emit({ t: 'result', id: b.tool_use_id, ok: !b.is_error, summary: summarizeResult(b.content) });
          this.broadcast({ t: 'shot' });
        }
        break;
      }
      case 'rate_limit_event': {
        const info = m.rate_limit_info || {};
        const w = info.unifiedWindows || {};
        this.usage = { fiveHour: w.five_hour?.utilization ?? null, week: w.seven_day?.utilization ?? null, status: info.status, resetsAt: info.resetsAt ?? null };
        this.broadcast({ t: 'usage', usage: this.usage });
        if (info.status && info.status !== 'allowed' && info.status !== 'allowed_warning') {
          const when = info.resetsAt ? new Date(info.resetsAt * 1000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : 'later';
          this.emit({ t: 'error', text: `You've hit your Claude usage limit. It resets at ${when}.` });
        }
        break;
      }
      case 'result': {
        this.closeText();
        const stopped = this.interrupted;
        this.pending = stopped ? 0 : Math.max(0, this.pending - 1);
        this.interrupted = false;
        if (stopped) this.emit({ t: 'note', text: 'Stopped.' });
        else if (m.is_error) this.emit({ t: 'error', text: clip((typeof m.result === 'string' && m.result) || `The agent hit an error (${m.subtype}).`, 400) });
        this.emit({ t: 'done', ok: !m.is_error, ms: m.duration_ms || 0 });
        this.broadcast({ t: 'busy', busy: this.busy });
        this.broadcast({ t: 'shot' });
        pushStatus();
        if (this.restartAfter && !this.busy) this.restart();
        break;
      }
    }
  }

  send(text, { images = [], docs = [], files = [] } = {}) {
    if (!this.proc) this.spawn();
    this.pending++;
    this.emit({ t: 'user', text, images: images.map(i => i.url), files: [...docs, ...files].map(f => f.name) });
    this.broadcast({ t: 'busy', busy: true });
    const saved = [...images, ...docs, ...files];
    let full = text || (images.length ? 'See the attached photo.' : 'See the attached file.');
    if (saved.length) full += `\n\n(Attachments are saved on this PC: ${saved.map(f => f.path).join(', ')})`;
    if (this.notes.length) { full = `(${this.notes.join(' ')})\n\n${full}`; this.notes = []; }
    const content = saved.length ? [
      ...images.map(i => ({ type: 'image', source: { type: 'base64', media_type: i.mime, data: i.data } })),
      ...docs.map(d => ({ type: 'document', title: d.name, source: { type: 'base64', media_type: 'application/pdf', data: d.data } })),
      { type: 'text', text: full },
    ] : full;
    this.proc.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content } }) + '\n');
  }

  // Change model or effort for the current chat: the agent restarts and resumes the same conversation.
  configure(model, effort) {
    const m = MODELS[model] ? model : this.model;
    const e = EFFORTS.includes(effort) ? effort : this.effort;
    if (m === this.model && e === this.effort) return;
    this.model = m;
    this.effort = e;
    this.emit({ t: 'note', text: `Now using ${MODELS[m]} · ${e} effort` });
    this.broadcast({ t: 'config', model: m, effort: e });
    if (this.proc) { if (this.busy) this.restartAfter = true; else this.restart(); }
  }

  restart() {
    const old = this.proc;
    this.proc = null;
    this.restartAfter = false;
    this.closeText();
    old?.kill('SIGTERM');
    log(`agent will restart with ${MODELS[this.model]}, ${this.effort}`);
  }

  stop() {
    const proc = this.proc;
    if (!proc || !this.busy) return;
    this.interrupted = true;
    proc.stdin.write(JSON.stringify({ type: 'control_request', request_id: randomUUID(), request: { subtype: 'interrupt' } }) + '\n');
    setTimeout(() => { if (this.proc === proc && this.interrupted) proc.kill('SIGTERM'); }, 8000); // fallback
  }

  reset(model, effort) {
    if (MODELS[model]) this.model = model;
    if (EFFORTS.includes(effort)) this.effort = effort;
    const old = this.proc;
    this.proc = null; this.pending = 0; this.interrupted = false; this.restartAfter = false; this.sessionId = null; this.items = [];
    this.closeText();
    old?.kill('SIGTERM');
    this.broadcast(this.snapshot());
    log(`new chat (${MODELS[this.model]}, ${this.effort})`);
  }
}

const agent = new Agent();

let statusTimer = null;
function pushStatus() {
  clearTimeout(statusTimer);
  statusTimer = setTimeout(async () => {
    if (!agent.clients.size) return;
    agent.broadcast({ t: 'status', ...(await designStatus()) });
  }, 300);
}
setInterval(() => { if (agent.clients.size && !agent.busy) pushStatus(); }, 20000);

// ---------------------------------------------------------------- HTTP
const STATIC = {
  '/': ['public/index.html', 'text/html; charset=utf-8'],
  '/index.html': ['public/index.html', 'text/html; charset=utf-8'],
  '/manifest.webmanifest': ['public/manifest.webmanifest', 'application/manifest+json'],
  '/sw.js': ['public/sw.js', 'text/javascript; charset=utf-8'],
  '/icon.svg': ['public/icon.svg', 'image/svg+xml'],
  '/icon-192.png': ['public/icon-192.png', 'image/png'],
  '/icon-512.png': ['public/icon-512.png', 'image/png'],
  '/icon-maskable-512.png': ['public/icon-maskable-512.png', 'image/png'],
  '/apple-touch-icon.png': ['public/apple-touch-icon.png', 'image/png'],
};

const json = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); };
const png = (res, buf) => { res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store', 'Content-Length': buf.length }); res.end(buf); };

function readJson(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', d => { body += d; if (body.length > limit) { reject(new Error('Too much at once: send fewer or smaller photos')); req.destroy(); } });
    req.on('end', () => { try { resolve(body ? JSON.parse(body) : {}); } catch { reject(new Error('Bad JSON')); } });
    req.on('error', reject);
  });
}

function makeHandler(bound) {
  return async (req, res) => {
    if (!allowedPeer(req.socket.remoteAddress) || !allowedHost(req.headers.host, bound)) {
      res.writeHead(403, { 'Content-Type': 'text/plain' }).end('Forbidden');
      return;
    }
    const url = new URL(req.url, 'http://local');
    try {
      if (req.method === 'GET') {
        const file = STATIC[url.pathname];
        if (file) {
          const body = await readFile(join(HERE, file[0]));
          res.writeHead(200, { 'Content-Type': file[1], 'Cache-Control': 'no-cache' });
          return res.end(body);
        }
        if (url.pathname === '/api/events') {
          res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
          res.write(`retry: 2000\n\ndata: ${JSON.stringify(agent.snapshot())}\n\n`);
          agent.clients.add(res);
          const ping = setInterval(() => res.write(': ping\n\n'), 20000);
          req.on('close', () => { clearInterval(ping); agent.clients.delete(res); });
          designStatus().then(s => res.write(`data: ${JSON.stringify({ t: 'status', ...s })}\n\n`));
          return;
        }
        if (url.pathname === '/api/shot') return png(res, await screenshot({ w: url.searchParams.get('w'), h: url.searchParams.get('h') }));
        if (url.pathname === '/api/status') return json(res, 200, await designStatus());
        if (url.pathname === '/api/recent') {
          const designs = (await recentDesigns()).filter(d => d.exists && OPENABLE.includes(extname(d.path).toLowerCase()));
          return json(res, 200, { designs });
        }
        if (url.pathname.startsWith('/uploads/')) {
          const id = safeName(decodeURIComponent(url.pathname.slice(9)));
          const type = MIME[extname(id).toLowerCase()];
          if (!type) return json(res, 404, { error: 'Not found' });
          const body = await readFile(join(UPLOAD_DIR, id)).catch(() => null);
          if (!body) return json(res, 404, { error: 'Not found' });
          res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'private, max-age=86400', 'X-Content-Type-Options': 'nosniff' });
          return res.end(body);
        }
      } else if (req.method === 'POST') {
        // Browsers can't send cross-site JSON (or a custom header) without a CORS preflight, which this server never grants.
        const type = req.headers['content-type'] || '';
        const isUpload = url.pathname === '/api/upload';
        if (isUpload ? !(/^application\/octet-stream\b/i.test(type) && req.headers['x-filename']) : !/^application\/json\b/i.test(type)) {
          return json(res, 415, { error: 'Unsupported request' });
        }
        // Behind `tailscale serve` the Host header and the page's origin differ, so check the origin by name.
        if (req.headers.origin && !allowedHost(new URL(req.headers.origin).host, bound)) return json(res, 403, { error: 'Cross-site request refused' });
        if (isUpload) return json(res, 200, await saveUpload(req));
        const body = await readJson(req, url.pathname === '/api/send' ? 40 * 1024 * 1024 : 64 * 1024);
        switch (url.pathname) {
          case '/api/send': {
            const text = clip(String(body.text || '').trim(), 8000);
            const att = await prepareAttachments(body);
            if (!text && !att.images.length && !att.docs.length && !att.files.length) return json(res, 400, { error: 'Empty message' });
            agent.send(text, att);
            return json(res, 200, { ok: true });
          }
          case '/api/stop': agent.stop(); return json(res, 200, { ok: true });
          case '/api/new': agent.reset(body.model, body.effort); return json(res, 200, { ok: true });
          case '/api/config': agent.configure(body.model, body.effort); return json(res, 200, { ok: true });
          case '/api/start-solidcraft': return json(res, 200, await startSolidCraft());
          case '/api/open': {
            // Open a design from the page's Open menu: one of SolidCraft's recent designs, or a file in an allowed place.
            const path = String(body.path || '');
            const recent = (await recentDesigns()).some(d => d.path === path && d.exists);
            if (!OPENABLE.includes(extname(path).toLowerCase())) return json(res, 400, { error: 'SolidCraft can’t open that kind of file' });
            if (!recent && !(await canBrowse(path))) return json(res, 403, { error: 'That folder isn’t allowed (see solidcraft-remote files)' });
            const r = await sc.call('open', { path }, 180000);
            if (r?.isError) return json(res, 409, { error: clip(textOf(r) || 'SolidCraft could not open it', 300) });
            const name = path.split('/').pop();
            agent.emit({ t: 'note', text: `Opened ${name}` });
            agent.notes.push(`The user opened ${path} from the Open menu; it replaced the previous design.`);
            agent.broadcast({ t: 'shot' });
            pushStatus();
            log(`opened ${path}`);
            return json(res, 200, { ok: true, name });
          }
          case '/api/shot': return png(res, await screenshot({ w: body.w, h: body.h, view: body.view }));
          case '/api/action': {
            const name = body.name;
            if (!['undo', 'redo', 'save'].includes(name)) return json(res, 400, { error: 'Unknown action' });
            const r = await sc.call(name, {}, 60000);
            pushStatus();
            return json(res, r?.isError ? 409 : 200, { ok: !r?.isError, text: clip(textOf(r), 300) });
          }
        }
      }
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
    } catch (e) {
      if (!res.headersSent) json(res, 502, { error: e.message });
      else res.end();
    }
  };
}

// ---------------------------------------------------------------- start
await mkdir(AGENT_DIR, { recursive: true });
await mkdir(UPLOAD_DIR, { recursive: true });
log(`SolidCraft Remote ${VERSION}, data in ${DATA_DIR}`);
const bound = [];
const handler = makeHandler(bound);

function listenOn(host) {
  if (bound.includes(host)) return;
  bound.push(host);
  const server = http.createServer(handler);
  server.on('error', e => { log(`can't listen on ${host}:${PORT}: ${e.message}`); bound.splice(bound.indexOf(host), 1); });
  server.listen(PORT, host, () => log(`listening on http://${host}:${PORT}`));
}

listenOn('127.0.0.1');
let announced = false;
function bindTailscale() {
  const ts = tailscaleIPs();
  ts.forEach(listenOn);
  if (ts.length && !announced) {
    announced = true;
    log(`open on your phone: http://${ts[0]}:${PORT}  (or the https address from \`solidcraft-remote https on\`)`);
  }
  return ts.length;
}
// Tailscale may come up after this server (at login): keep looking for its address.
if (!bindTailscale()) log('No Tailscale address yet: only this computer can connect until Tailscale is up.');
setInterval(bindTailscale, 30000).unref();
sc.start().catch(e => log('SolidCraft link:', e.message));

const quit = () => { agent.proc?.kill('SIGTERM'); sc.proc?.kill('SIGTERM'); process.exit(0); };
process.on('SIGINT', quit);
process.on('SIGTERM', quit);
