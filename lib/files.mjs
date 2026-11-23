// Where design files may be opened from, and finding them: shared by the server (Open menu, SolidCraft flags)
// and the agent's read-only `files` tools.
import { readFile, readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname, basename, extname, resolve, sep } from 'node:path';

export const HOME = homedir();
const XDG_DATA = process.env.XDG_DATA_HOME || join(HOME, '.local/share');
export const DATA_DIR = process.env.SOLIDCRAFT_REMOTE_DATA || join(XDG_DATA, 'solidcraft-remote');
export const UPLOAD_DIR = join(DATA_DIR, 'uploads');
export const SOLIDCRAFT_DATA = join(XDG_DATA, 'solidcraft');
export const CONFIG_FILE = join(process.env.XDG_CONFIG_HOME || join(HOME, '.config'), 'solidcraft-remote', 'env');

export const OPENABLE = ['.sc', '.solidcraft', '.step', '.stp', '.3mf', '.stl', '.obj', '.glb', '.gltf'];
const DESIGN_FILES = [...OPENABLE, '.iges', '.igs', '.dxf', '.svg', '.png', '.jpg', '.jpeg', '.pdf'];

const expand = p => resolve(String(p).trim().replace(/^~(?=\/|$)/, HOME));
const within = (promise, ms, fallback) => Promise.race([promise, new Promise(r => setTimeout(() => r(fallback), ms))]);

// Settings saved by `solidcraft-remote files …` (KEY=value lines). Real environment variables win.
export async function loadConfig() {
  const text = await readFile(CONFIG_FILE, 'utf8').catch(() => '');
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, '$1');
  }
}

export const anyPath = () => /^(1|true|yes|on)$/i.test(process.env.SOLIDCRAFT_ALLOW_ANY_PATH || '');
export const extraPaths = () => (process.env.SOLIDCRAFT_ALLOW_PATHS || '').split(':').map(s => s.trim()).filter(Boolean).map(expand);
export const allowedRoots = () => [...new Set([UPLOAD_DIR, SOLIDCRAFT_DATA, ...extraPaths()])];

// Flags for `solidcraft-cli mcp`, so SolidCraft opens, saves and exports in the same places.
export function solidcraftArgs() {
  const args = ['mcp'];
  for (const p of allowedRoots()) if (existsSync(p)) args.push('--allow-path', p);
  if (anyPath()) args.push('--allow-any-path');
  return args;
}

export function isInside(path, root) {
  const p = resolve(path), r = resolve(root);
  return p === r || p.startsWith(r.endsWith(sep) ? r : r + sep);
}

// SolidCraft's own recent-designs list (from its saved app state), newest first.
export async function recentDesigns() {
  const text = await readFile(join(SOLIDCRAFT_DATA, 'app.ron'), 'utf8').catch(() => '');
  const m = text.match(/"solidcraft\.prefs":\s*"((?:[^"\\]|\\.)*)"/);
  if (!m) return [];
  let prefs;
  try { prefs = JSON.parse(JSON.parse(`"${m[1]}"`)); } catch { return []; }
  const openedAt = prefs.recent_opened_at || {};
  const paths = (Array.isArray(prefs.recent) ? prefs.recent : []).filter(p => typeof p === 'string').slice(0, 40);
  return Promise.all(paths.map(async path => ({
    path, name: basename(path), folder: dirname(path), openedAt: openedAt[path] || null,
    exists: await within(stat(path).then(s => s.isFile(), () => false), 1500, false),
  })));
}

async function browseRoots() {
  const recent = (await recentDesigns()).filter(d => d.exists).map(d => d.folder);
  return [...allowedRoots(), ...recent];
}

export async function canBrowse(path) {
  if (anyPath()) return true;
  return (await browseRoots()).some(r => isInside(path, r));
}

const notAllowed = dir => new Error(
  `Not allowed to look in ${dir}. Allowed: ${allowedRoots().join(', ')} and the folders of recent designs. ` +
  'The user can widen this on the PC with: solidcraft-remote files allow <folder>  (or: files anywhere)');

export async function listFolder(path) {
  const dir = expand(path);
  if (!(await canBrowse(dir))) throw notAllowed(dir);
  const entries = await within(readdir(dir, { withFileTypes: true }).catch(e => { throw new Error(`Can't read ${dir}: ${e.code || e.message}`); }), 5000, null);
  if (!entries) throw new Error(`Reading ${dir} took too long`);
  const out = [];
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const folder = e.isDirectory();
    if (!folder && !DESIGN_FILES.includes(extname(e.name).toLowerCase())) continue;
    out.push({ name: e.name, type: folder ? 'folder' : 'file' });
  }
  out.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'folder' ? -1 : 1));
  return { folder: dir, entries: out.slice(0, 400), truncated: out.length > 400 };
}

// Where to look when no folder is given: around recent designs (one level up when any folder is allowed),
// the usual home folders, and the allowed folders.
async function searchRoots() {
  const any = anyPath();
  const recent = (await recentDesigns()).filter(d => d.exists && !d.path.startsWith('/tmp/')).map(d => (any ? dirname(d.folder) : d.folder));
  const usual = any ? ['Documents', 'Desktop', 'Downloads'].map(d => join(HOME, d)) : [];
  const all = [...new Set([...recent, ...usual, ...allowedRoots()])].filter(existsSync);
  return all.filter(r => !all.some(o => o !== r && isInside(r, o)));
}

// SolidCraft designs first, then STEP/IGES, meshes, and the rest; files named after the query before folder matches.
const RANK = ['.sc', '.solidcraft', '.step', '.stp', '.iges', '.igs', '.3mf', '.stl', '.obj', '.glb', '.gltf', '.dxf', '.svg', '.pdf', '.png', '.jpg', '.jpeg'];
const score = (p, words) => RANK.indexOf(extname(p).toLowerCase()) * 2 + (words.every(w => basename(p).toLowerCase().includes(w)) ? 0 : 1);

// Design files whose path contains every word of `query` (case-insensitive). Bounded in depth, count and time.
export async function findFiles(query, folder) {
  const words = String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) throw new Error('Give a word or two from the file or folder name');
  let roots;
  if (folder) {
    roots = [expand(folder)];
    if (!(await canBrowse(roots[0]))) throw notAllowed(roots[0]);
  } else {
    roots = [];
    for (const r of await searchRoots()) if (await canBrowse(r)) roots.push(r);
  }
  const results = [];
  const deadline = Date.now() + 6000;
  const MAX = 300; // collect plenty, then return the best 40
  async function walk(dir, depth) {
    if (results.length >= MAX || Date.now() > deadline || depth > 7) return;
    const entries = await within(readdir(dir, { withFileTypes: true }).catch(() => []), 3000, []);
    for (const e of entries) {
      if (results.length >= MAX || Date.now() > deadline) return;
      if (e.name.startsWith('.') || e.name === 'node_modules') continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) { await walk(p, depth + 1); continue; }
      if (!DESIGN_FILES.includes(extname(e.name).toLowerCase())) continue;
      const hay = p.toLowerCase();
      if (words.every(w => hay.includes(w))) results.push(p);
    }
  }
  for (const r of roots) await walk(r, 0);
  const complete = results.length < MAX && Date.now() <= deadline;
  results.sort((a, b) => score(a, words) - score(b, words) || a.localeCompare(b));
  return { query, searched: roots, results: results.slice(0, 40), more: results.length > 40, complete };
}
