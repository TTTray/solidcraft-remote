# SolidCraft Remote

Control [SolidCraft](https://github.com/tangency-labs/solidcraft) from your phone. You chat with a Claude agent that edits the design open on your PC, watch a live render update as it works, and send it photos, sketches and files.

It runs on your Linux PC and is reachable only from your own devices over [Tailscale](https://tailscale.com). The agent is [Claude Code](https://claude.com/claude-code) running on your own Claude subscription, so there's no API key and no separate API bill.

> Unofficial. Not affiliated with SolidCraft / Tangency Labs or Anthropic.

## What you get

- **Chat with the agent.** Ask for changes in plain words. Each step it takes shows in the chat, and you can tap a step for details. **Stop** interrupts it.
- **Live view.** The model re-renders after every step. Use **Iso / Front / Top / Right / Fit** to turn the camera, and tap the view to refresh it.
- **Photos and files.** Take a photo of a part, a hand sketch or a drawing and describe what you want; the agent reads sizes and features from it. PDFs are read directly. CAD files (STEP, IGES, STL, 3MF and similar) are saved on the PC so SolidCraft can open or import them.
- **Model and effort pickers** (Opus, Sonnet, Haiku; low to max) next to the message box. Switching keeps the conversation.
- **Open designs.** The **Open** button lists SolidCraft's recent designs. Or ask the agent ("open the tower crane"): it searches your folders by name. It asks first if the open design has unsaved changes.
- **Undo, Redo and Save** buttons, and **Start SolidCraft** when it isn't open (needs you logged in on the PC's desktop).
- **Installs like an app** on Android and iPhone over HTTPS, with an "is the PC on?" screen when it can't connect.

## Safety

- It only accepts connections from the PC itself and your Tailscale devices, and turns away requests from other websites.
- The agent can only use SolidCraft's tools and a read-only file finder that returns file names. It has no shell and can't read other files.
- By default SolidCraft may open, save and export files only in SolidCraft's data folder (`~/.local/share/solidcraft`), the uploads folder, and the folders of designs it opens or saves. You can widen this; see [File access](#file-access).
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
npm install -g --prefix ~/.local --allow-git=root github:TTTray/solidcraft-remote
~/.local/bin/solidcraft-remote setup
```

`--allow-git=root` lets npm 12 and newer fetch this one package from GitHub, and nothing it would pull in (it has no dependencies anyway). Older npm versions ignore the flag.

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

## File access

Control where SolidCraft may open, save and export files when you're working from the phone:

```bash
solidcraft-remote files                    # show the current access
solidcraft-remote files allow ~/Designs    # add a folder
solidcraft-remote files anywhere           # allow any folder on the PC
solidcraft-remote files limit              # back to the listed folders only
solidcraft-remote files reset              # back to the defaults
```

Changes are saved in `~/.config/solidcraft-remote/env` and restart the background service. With `anywhere`, the agent can also save or export over any file your user can write, so use it only if that's what you want.

## Settings

| Environment variable | Default | |
|---|---|---|
| `PORT` | `8790` | Local port; HTTPS is proxied to it by Tailscale |
| `MODEL` | `claude-opus-5-5` | Starting model; also `claude-sonnet-5-5`, `claude-haiku-5-5` |
| `EFFORT` | `high` | `low`, `medium`, `high`, `xhigh`, `max` |
| `CLAUDE_BIN` | `~/.local/bin/claude` or `claude` on PATH | |
| `SOLIDCRAFT_CLI` | `solidcraft-cli` | |
| `SOLIDCRAFT_REMOTE_DATA` | `~/.local/share/solidcraft-remote` | Uploads and the agent's chat history |
| `SOLIDCRAFT_ALLOW_PATHS` | (none) | Extra folders, `:`-separated (set by `files allow`) |
| `SOLIDCRAFT_ALLOW_ANY_PATH` | off | `1` lets SolidCraft use any folder (set by `files anywhere`) |

For the background service, set these with `systemctl --user edit solidcraft-remote`.

## How it works

`server.mjs` has no dependencies. It runs headless Claude Code (`claude -p` with stream-json) and allows only SolidCraft's MCP tools (`solidcraft-cli mcp`, bridged to the running app) plus `lib/files-mcp.mjs`, a small read-only file finder that uses SolidCraft's recent-designs list and searches by name. It streams the agent's replies and steps to the page over Server-Sent Events. A second `solidcraft-cli mcp` connection renders the live view and handles the buttons. Changing the model or effort restarts the agent with `--resume`, so the conversation carries on.

## License

MIT
