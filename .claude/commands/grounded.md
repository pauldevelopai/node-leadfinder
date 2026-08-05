---
description: Set up and run a GROUNDED Node locally — clone it (if given a git URL), install, launch, verify, and hand the user plain run instructions
argument-hint: "[git URL, pauldevelopai/node-<slug>, or a bare node-<slug> — omit if already inside a Node folder]"
---

You are setting up a **GROUNDED Node** — a small newsroom AI app by Develop AI
that runs entirely on this machine (local data, the newsroom's own AI key). Your
job: get it running with zero fiddling, then hand the user plain instructions.
This playbook is deliberately agent-agnostic markdown: Claude Code runs it as
`/grounded`; any other coding agent (Codex etc.) can just follow it top to bottom.

**Hard rules (from the platform, non-negotiable):**
- **No fake data, ever.** Never seed sample/placeholder content. Real data or
  honest empty states only.
- **Never ask for, accept, or write an API key.** Keys are entered in the app's
  own browser screen, which live-validates and saves them (`.env` is written by
  the app, not by you or the user). If the user pastes a key into chat anyway,
  tell them to use the in-app screen instead.
- Don't touch the user's `.env` or `data/` — they survive updates by design.
- Don't commit or push anything unless the user asks.

## 1. Find (or fetch) the Node

- **Given an argument** (`$ARGUMENTS` below): normalise it to a git URL —
  `node-verifier` → `https://github.com/pauldevelopai/node-verifier`,
  `owner/repo` → `https://github.com/owner/repo`, full URLs as-is. Then
  `git clone <url>` into the current directory and `cd` into it. If the folder
  already exists, don't re-clone — `cd` in and continue (this playbook is safe
  to re-run).
- **No argument:** you should already be inside a Node checkout — confirm
  `package.json` depends on `@developai/grounded-node-runtime` (check the cwd,
  then immediate subfolders). If you can't find one, ask the user for the
  Node's git URL and stop.

All later steps run from the Node's folder.

## 2. Prerequisites

`node -v` must be ≥ 20 (and npm present). If Node is missing or too old, don't
improvise a system install — tell the user the two easy paths and stop:
install Node LTS from nodejs.org, **or** use the Node's own no-terminal-skills
installer (`install.sh` / `install.ps1`, also served as a one-liner from
`https://grounded.developai.co.za/nodes/<slug>/{mac,windows}`), which downloads
a private app-only copy of Node automatically.

## 3. Install

```bash
npm install --no-audit --no-fund
```

If it fails on `@developai/grounded-node-runtime` (a github-pinned dep npm
caches too eagerly), force it once: `rm -rf node_modules/@developai && npm install`.

## 4. Read the Node's own docs

Skim `NODE.md`, `CLAUDE.md`, `README.md` in the repo — **they win on
specifics** (port, extra env, node-specific setup steps). Most Nodes need
nothing beyond install → start.

## 5. Launch and verify

Start it in the background with `npm start` and read its output — the runtime
prints the real URL (`✓ <Name> is running … http://localhost:<port>`, default
port 3000; `PORT=<n> npm start` overrides if 3000 is taken). Then **verify,
don't assume**: curl the URL and confirm HTTP 200. Open it in the user's
browser (`open <url>` on macOS / `start` on Windows). If startup fails, read
the error and fix the real cause (usually port in use or the dep-cache gotcha
above) — don't hand the user a broken "done".

## 6. Hand over (your final message — keep it plain, non-technical)

Tell the user:
- **It's running** at `http://localhost:<port>` — already opened in the browser.
- **First run:** the dashboard will ask for their AI key (Anthropic or OpenAI)
  on a setup screen — entered there, checked live, saved locally. Their key and
  data never leave this machine. (Some features work with no key at all.)
- **Stop:** press Ctrl+C in the terminal running it (or close that window).
- **Start again another day:** double-click `Start.command` (Mac) /
  `Start.bat` (Windows) in the app folder, or run `npm start` — or re-run
  `/grounded` here.
- **Update to the latest version:** `npm run update` (or the `Update.command` /
  `Update.bat` launcher). Their key (`.env`) and data (`data/`) are always
  preserved.
- Anything node-specific you learned in step 4 (what the Node actually does,
  where to begin).

## 7. Optional — MCP (only if the repo has `mcp-server.js`)

This Node can also plug its tools straight into Claude Desktop (data stays
local). Offer it; if the user wants it, follow the repo's `MCP.md` — but ask
before editing their `claude_desktop_config.json`, and never put keys in it.

---
The Node to set up (may be empty — see step 1):
$ARGUMENTS
