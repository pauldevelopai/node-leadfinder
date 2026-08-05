# Agent guide (Codex, Claude Code, any coding agent)

This is a **GROUNDED Node** — a small newsroom AI app by Develop AI that runs
entirely on this machine (local data, the newsroom's own AI key).

**To set it up and run it** (also whenever the user types `/grounded` or asks
to "run this"): follow the playbook in `.claude/commands/grounded.md` — plain
markdown that works in any agent. Short version: `npm install` → `npm start` →
open the printed `http://localhost:<port>` URL and verify it responds. The
user enters their AI key in the app's own browser setup screen — never in
chat, never by hand-editing `.env`.

Node-specifics (what this Node does, ports, extra setup): `NODE.md`,
`CLAUDE.md`, `README.md`.

Hard rule from the platform: **no fake data, ever** — never seed sample or
placeholder content; real data or honest empty states only.
