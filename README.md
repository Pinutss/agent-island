# Agent Island — for Claude Code

A Dynamic Island for every Claude Code session on your machine. A small pill sits at the top of your screen, always on top. Hover it and it unfolds to show what each session is doing, its subagents, your usage limits and the dev servers you have running. When Claude needs you, it opens by itself: approve a permission with its diff, answer a question, or read a plan, without hunting for the right window.

> Community project, not affiliated with or endorsed by Anthropic. "Claude" and "Claude Code" are trademarks of Anthropic.

## What it does

- **Permissions in one click.** Each request shows its diff or command. **Allow** (`Ctrl+Y`), **Deny** (`Ctrl+N`), **Always** (the same rule Claude's own dialog would save), or **Answer in Claude** to fall back to the usual dialog.
- **Questions.** When Claude asks you something (`AskUserQuestion`), pick an option, tick several on a multiple-choice question, or type your own answer. It goes straight back to Claude.
- **Plans.** A plan waiting for approval is shown in full in the island, while you approve it in Claude (only Claude's own dialog can approve a plan).
- **Sessions at work.** Every session that is thinking, running a tool, waiting for you or running subagents, with its current action and model.
- **Usage limits.** Your 5-hour and 7-day windows, with when they reset.
- **Dev servers.** Ports held by node, python, bun and the like, named after what runs them (vite, next, uvicorn…). Click one to open it.
- **A companion.** A pixel-art critter in ten outfits that hops when a session needs you.
- **Dark and light themes.** Anthracite dark by default, light, or follow Windows.

The island only steps in where Claude would have asked you anyway: your permission rules and mode (auto mode included) decide first. With the island closed, Claude Code behaves exactly as before.

## How it works

Two parts:

- `bridge/` is a Claude Code plugin (`island-bridge`) loaded in every session. It sends the session's state to the island and, when Claude is about to ask you for something, asks the island first.
- `app/` is the desktop app (Electron). It draws the island and runs a small hub on `127.0.0.1:47823`, guarded by a random token written to `~/.claude/island/island.json` at each launch. Requests from a web browser are refused.

Unanswered requests go back to Claude's own dialog after 90 seconds.

## Install

Requirements: Windows 10/11 (macOS should work but is untested; the dev-server list is Windows-only for now), Node.js 20+, Claude Code.

1. Get the app and start it:

   ```
   git clone https://github.com/Pinutss/agent-island
   cd agent-island/app
   npm install
   npm start
   ```

   On Windows you can then double-click `Start Agent Island.cmd`.

2. Install the plugin for every Claude Code session:

   ```
   claude plugin install island-bridge --marketplace Pinutss/agent-island
   ```

   or, at the prompt of a terminal session, `/plugin install island-bridge --marketplace Pinutss/agent-island` (answer `y` to add the marketplace, then pick the user scope). Sessions already open pick it up after `/reload-plugins`.

Right-click the tray icon for the theme, the companion, notifications, the island style (attached or floating) and **Start with Windows**.

The interface is in French for now; translations are welcome.

## Develop

- Hub tests: `cd app && npm test`
- Plugin tests: `claude plugin test bridge`
- `app/renderer/mascot.js` is generated from the mascot module of the Agent Flow plugin; regenerate it rather than editing it.

## License

MIT
