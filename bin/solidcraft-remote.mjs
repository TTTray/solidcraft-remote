#!/usr/bin/env node
// solidcraft-remote: start the server, check the setup, run it as a background service, turn on HTTPS.
import { spawnSync } from 'node:child_process';
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';

const SELF = fileURLToPath(import.meta.url);
const ROOT = join(dirname(SELF), '..');
const pkg = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'));
const PORT = Number(process.env.PORT || 8790);
const SOLIDCRAFT_PORT = Number(process.env.SOLIDCRAFT_PORT || 27878);
const UNIT = 'solidcraft-remote.service';
const UNIT_PATH = join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'systemd/user', UNIT);
const CLAUDE = process.env.CLAUDE_BIN || [join(homedir(), '.local/bin/claude')].find(existsSync) || 'claude';

const run = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: 'utf8', ...opts });
const pass = (cmd, args) => run(cmd, args, { stdio: 'inherit' }).status ?? 1;
const good = m => console.log(`  ✓ ${m}`);
const bad = m => console.log(`  ✗ ${m}`);
const note = m => console.log(`    ${m}`);

function portOpen(port, host = '127.0.0.1') {
  return new Promise(resolve => {
    const s = net.connect({ port, host });
    const done = v => { s.destroy(); resolve(v); };
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
    s.setTimeout(1000, () => done(false));
  });
}

function httpsUrl() {
  const r = run('tailscale', ['serve', 'status', '--json']);
  if (r.error || r.status) return null;
  try {
    const web = JSON.parse(r.stdout || '{}').Web || {};
    for (const [hostPort, cfg] of Object.entries(web)) {
      const proxy = cfg?.Handlers?.['/']?.Proxy || '';
      if (proxy.endsWith(`:${PORT}`)) return `https://${hostPort.replace(/:443$/, '')}`;
    }
  } catch {}
  return null;
}

function tailscaleIP() {
  const r = run('tailscale', ['ip', '-4']);
  return r.error || r.status ? null : r.stdout.trim().split('\n')[0] || null;
}

async function doctor() {
  let ok = true;
  const fail = (m, ...hints) => { ok = false; bad(m); hints.forEach(note); };

  const major = Number(process.versions.node.split('.')[0]);
  major >= 22 ? good(`Node.js ${process.versions.node}`) : fail(`Node.js ${process.versions.node}: needs 22 or newer`);

  const c = run(CLAUDE, ['auth', 'status']);
  if (c.error) {
    fail('Claude Code is not installed',
      'Install it: npm install -g --prefix ~/.local --allow-scripts=@anthropic-ai/claude-code @anthropic-ai/claude-code');
  } else {
    let s = {};
    try { s = JSON.parse(c.stdout); } catch {}
    s.loggedIn ? good(`Claude Code signed in (${s.authMethod || 'Claude account'})`)
      : fail('Claude Code is not signed in', `Sign in with your Claude subscription: ${CLAUDE} auth login`);
  }

  run('solidcraft-cli', ['--help']).error
    ? fail('solidcraft-cli not found (it comes with SolidCraft)', 'Install SolidCraft, or set SOLIDCRAFT_CLI to its path')
    : good('solidcraft-cli found');

  (await portOpen(SOLIDCRAFT_PORT)) ? good(`SolidCraft is running (control port ${SOLIDCRAFT_PORT})`)
    : note(`SolidCraft isn't running now. That's fine: the page has a button to start it.`);

  const ip = tailscaleIP();
  ip ? good(`Tailscale is up (${ip})`) : bad('Tailscale is not up: only this computer can connect');

  const url = httpsUrl();
  url ? good(`HTTPS on: ${url}`) : note('HTTPS is off. Turn it on with: solidcraft-remote https on');

  const active = run('systemctl', ['--user', 'is-active', UNIT]).stdout?.trim();
  active === 'active' ? good('Background service is running')
    : note(existsSync(UNIT_PATH) ? `Background service is ${active || 'stopped'}` : 'Background service is not installed (solidcraft-remote service install)');

  (await portOpen(PORT)) ? good(`Server is answering on port ${PORT}`) : note(`Nothing is answering on port ${PORT} yet`);
  return ok;
}

async function serviceInstall() {
  const path = [dirname(process.execPath), join(homedir(), '.local/bin'), '/usr/local/bin', '/usr/bin', '/bin'].join(':');
  const unit = `[Unit]
Description=SolidCraft Remote (control SolidCraft from your phone)
After=network-online.target graphical-session.target

[Service]
Type=simple
ExecStart="${process.execPath}" "${SELF}" start
Restart=on-failure
RestartSec=5
Environment=PORT=${PORT}
Environment=PATH=${path}

[Install]
WantedBy=default.target
`;
  await mkdir(dirname(UNIT_PATH), { recursive: true });
  await writeFile(UNIT_PATH, unit);
  pass('systemctl', ['--user', 'daemon-reload']);
  const code = pass('systemctl', ['--user', 'enable', '--now', UNIT]);
  if (code) return code;
  pass('systemctl', ['--user', 'restart', UNIT]);
  good(`Background service installed and started (starts when you log in): ${UNIT_PATH}`);
  return 0;
}

async function serviceUninstall() {
  run('systemctl', ['--user', 'disable', '--now', UNIT], { stdio: 'inherit' });
  await rm(UNIT_PATH, { force: true });
  pass('systemctl', ['--user', 'daemon-reload']);
  good('Background service removed');
  return 0;
}

function httpsOn() {
  const r = run('tailscale', ['serve', '--bg', '--yes', '--https=443', `http://127.0.0.1:${PORT}`], { stdio: 'inherit' });
  if (r.error || r.status) {
    bad('Tailscale could not turn on HTTPS');
    note('If it says access denied: sudo tailscale set --operator=$USER  (then run this again)');
    note('If it mentions HTTPS certificates: turn on HTTPS in the Tailscale admin console (DNS page)');
    return 1;
  }
  const url = httpsUrl();
  good(`HTTPS on${url ? `: ${url}` : ''} (only your tailnet can reach it)`);
  return 0;
}

function httpsOff() {
  const code = pass('tailscale', ['serve', '--yes', '--https=443', 'off']);
  if (!code) good('HTTPS off');
  return code;
}

function where() {
  const url = httpsUrl();
  const ip = tailscaleIP();
  console.log('\nOpen on your phone (with Tailscale on):');
  if (url) console.log(`  ${url}   ← install it from the browser menu ("Install app" / "Add to Home Screen")`);
  if (ip) console.log(`  http://${ip}:${PORT}`);
  if (!url && !ip) console.log(`  (Tailscale is not up; on this computer: http://127.0.0.1:${PORT})`);
}

const HELP = `solidcraft-remote ${pkg.version}: control SolidCraft and a Claude agent from your phone

Usage:
  solidcraft-remote setup [--no-https]   check everything, install the background service, turn on HTTPS
  solidcraft-remote start                run the server in this terminal (Ctrl-C stops it)
  solidcraft-remote doctor               check what's installed and running
  solidcraft-remote service <cmd>        install | uninstall | start | stop | restart | status | logs [-f]
  solidcraft-remote https <on|off>       serve it at https://<this-pc>.<tailnet>.ts.net (needed to install it as a phone app)
  solidcraft-remote url                  print the addresses to open on your phone
  solidcraft-remote --version

Settings (environment): PORT (8790), MODEL, EFFORT, CLAUDE_BIN, SOLIDCRAFT_CLI, SOLIDCRAFT_REMOTE_DATA`;

const [cmd = 'start', sub, ...rest] = process.argv.slice(2);
let code = 0;
switch (cmd) {
  case 'start':
    await import(join(ROOT, 'server.mjs'));
    break;
  case 'setup': {
    console.log(`SolidCraft Remote ${pkg.version}: checking…`);
    if (!(await doctor())) { console.log('\nFix the ✗ items above, then run: solidcraft-remote setup'); code = 1; break; }
    console.log('\nInstalling the background service…');
    if ((code = await serviceInstall())) break;
    if (![sub, ...rest].includes('--no-https') && tailscaleIP()) { console.log('\nTurning on HTTPS…'); httpsOn(); }
    where();
    break;
  }
  case 'doctor': code = (await doctor()) ? 0 : 1; break;
  case 'url': where(); break;
  case 'service':
    switch (sub) {
      case 'install': code = await serviceInstall(); break;
      case 'uninstall': code = await serviceUninstall(); break;
      case 'start': case 'stop': case 'restart': case 'status':
        code = pass('systemctl', ['--user', sub, ...(sub === 'status' ? ['--no-pager'] : []), UNIT]); break;
      case 'logs': code = pass('journalctl', ['--user', '-u', UNIT, '-n', '200', '--no-pager', ...(rest.includes('-f') ? ['-f'] : [])]); break;
      default: console.log(HELP); code = 1;
    }
    break;
  case 'https':
    code = sub === 'on' ? httpsOn() : sub === 'off' ? httpsOff() : (console.log(httpsUrl() || 'HTTPS is off'), 0);
    break;
  case '-v': case '--version': case 'version': console.log(pkg.version); break;
  case '-h': case '--help': case 'help': console.log(HELP); break;
  default: console.log(HELP); code = 1;
}
if (cmd !== 'start') process.exit(code);
