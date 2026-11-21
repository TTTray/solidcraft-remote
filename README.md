# SolidCraft Remote

Control [SolidCraft](https://github.com/tangency-labs/solidcraft) from your phone. You chat with a Claude agent that edits the design open on your PC, watch a live render update as it works, and send it photos, sketches and files.

It runs on your Linux PC and is reachable only from your own devices over [Tailscale](https://tailscale.com). The agent is [Claude Code](https://claude.com/claude-code) running on your own Claude subscription, so there's no API key and no separate API bill.

> Unofficial. Not affiliated with SolidCraft / Tangency Labs or Anthropic.

## What you get

- **Chat with the agent.** Ask for changes in plain words. Each step it takes shows in the chat, and you can tap a step for details. **Stop** interrupts it.
- **Live view.** The model re-renders after every step. Use **Iso / Front / Top / Right / Fit** to turn the camera, and tap the view to refresh it.
- **Photos and files.** Take a photo of a part, a hand sketch or a drawing and describe what you want; the agent reads sizes and features from it. PDFs are read directly. CAD files (STEP, IGES, STL, 3MF and similar) are saved on the PC so SolidCraft can open or import them.
- **Model and effort pickers** (Opus, Sonnet, Haiku; low to max) next to the message box. Switching keeps the conversation.
- **Undo, Redo and Save** buttons, and **Start SolidCraft** when it isn't open (needs you logged in on the PC's desktop).
- **Installs like an app** on Android and iPhone over HTTPS, with an "is the PC on?" screen when it can't connect.

## Safety

- It only accepts connections from the PC itself and your Tailscale devices, and turns away requests from other websites.
- The agent can only use SolidCraft's tools: no shell, and no access to other files. Files are limited to SolidCraft's own folders and the uploads folder.
- It always uses your Claude subscription sign-in and never an API key from the environment.

## Requirements

- Linux with systemd (tested on Arch / CachyOS with KDE Plasma)
- [SolidCraft](https://github.com/tangency-labs/solidcraft) 0.43 or newer, which provides `solidcraft-cli`
- Node.js 22 or newer
- A Claude subscription that includes Claude Code
- Tailscale on the PC and on your phone

## Install

One line, no sudo. It installs into `~/.local`, sets up Claude Code if needed, and runs `setup`:

```bash
curl -fsSL https://raw.githubusercontent.com/TTTray/solidcraft-remote/main/install.sh | bash
```

Or step by step:

```bash
npm install -g --prefix ~/.local github:TTTray/solidcraft-remote
~/.local/bin/solidcraft-remote setup
```

`setup` checks everything, installs a background service that starts when you log in, and turns on Tailscale HTTPS. It then prints the address to open on your phone, something like `https://your-pc.your-tailnet.ts.net`.

On the phone, open that address and choose **Install app** (Android) or **Share → Add to Home Screen** (iPhone).

To update, run the same install line again, then `solidcraft-remote service restart`.

## Commands

```text
solidcraft-remote setup [--no-https]   check, install the background service, turn on HTTPS
solidcraft-remote start                run in this terminal instead (Ctrl-C stops it)
solidcraft-remote doctor               check what's installed and running
solidcraft-remote service <cmd>        install | uninstall | start | stop | restart | status | logs [-f]
solidcraft-remote https <on|off>       Tailscale HTTPS at https://<pc>.<tailnet>.ts.net
solidcraft-remote url                  print the addresses to open on your phone
```

Over SSH: `solidcraft-remote service start` (or `restart`). For it to run at boot without anyone logging in, run `loginctl enable-linger` once. SolidCraft itself still needs a desktop session.

## Settings

| Environment variable | Default | |
|---|---|---|
| `PORT` | `8790` | Local port; HTTPS is proxied to it by Tailscale |
| `MODEL` | `claude-opus-5-5` | Starting model; also `claude-sonnet-5-5`, `claude-haiku-5-5` |
| `EFFORT` | `high` | `low`, `medium`, `high`, `xhigh`, `max` |
| `CLAUDE_BIN` | `~/.local/bin/claude` or `claude` on PATH | |
| `SOLIDCRAFT_CLI` | `solidcraft-cli` | |
| `SOLIDCRAFT_REMOTE_DATA` | `~/.local/share/solidcraft-remote` | Uploads and the agent's chat history |

For the background service, set these with `systemctl --user edit solidcraft-remote`.

## How it works

`server.mjs` has no dependencies. It runs headless Claude Code (`claude -p` with stream-json) and allows only SolidCraft's MCP tools (`solidcraft-cli mcp`, bridged to the running app). It streams the agent's replies and steps to the page over Server-Sent Events. A second `solidcraft-cli mcp` connection renders the live view and handles the buttons. Changing the model or effort restarts the agent with `--resume`, so the conversation carries on.

## License

MIT
