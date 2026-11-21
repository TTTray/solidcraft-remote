// Makes SolidCraft Remote installable as a phone app. Everything is live, so nothing is cached:
// the only job here is a friendly page when the PC can't be reached.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));

const OFFLINE = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>SolidCraft Remote</title>
<style>
  :root { --bg: #f5f5f4; --text: #1c1b1a; --muted: #6b6864; --accent: #2563eb; --accent-text: #fff; }
  @media (prefers-color-scheme: dark) { :root { --bg: #131314; --text: #ececec; --muted: #9a9aa0; --accent: #5b93ff; --accent-text: #0b1220; } }
  body { margin: 0; min-height: 100dvh; display: grid; place-items: center; background: var(--bg); color: var(--text);
    font: 15px/1.5 system-ui, -apple-system, sans-serif; text-align: center; padding: 24px; box-sizing: border-box; }
  h1 { font-size: 19px; margin: 0 0 6px; } p { color: var(--muted); margin: 0 auto 18px; max-width: 32ch; }
  button { font: inherit; font-weight: 600; border: 0; border-radius: 12px; padding: 11px 22px; background: var(--accent); color: var(--accent-text); }
</style></head><body><main>
<h1>Can't reach your PC</h1>
<p>Check that the PC is on, Tailscale is connected on this phone, and SolidCraft Remote is running.</p>
<button onclick="location.reload()">Try again</button>
</main></body></html>`;

self.addEventListener('fetch', event => {
  if (event.request.mode !== 'navigate') return;
  event.respondWith(fetch(event.request).catch(() => new Response(OFFLINE, { headers: { 'Content-Type': 'text/html; charset=utf-8' } })));
});
