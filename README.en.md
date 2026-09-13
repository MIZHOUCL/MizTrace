<p align="center"><img src="./web/logo.png" width="120" alt="MizTrace"></p>
<h1 align="center">MizTrace</h1>
<p align="center">What did you actually do today? It collects the traces and writes a diary where <b>every sentence links back to its evidence</b>.</p>
<p align="center"><a href="./README.md">中文</a></p>

---

By the end of a day your work is scattered everywhere: files you edited, commits you made, questions you asked an AI tool, pages you read, commands you typed. MizTrace gathers those traces on your machine, lays them out on a time board, lets you pop the ones you don't want, and hands the rest to a model you configure to write a proper diary.

Zero dependencies. No network by default. Works without an API key. macOS and Windows.

## Up and running in a minute

Needs Node 22.13+ (or 23.4+). No third-party packages, no `npm install`.

```bash
git clone https://github.com/MIZHOUCL/MizTrace.git
cd MizTrace
node bin/miztrace.js ui
```

A local page only you can reach opens in your browser. The first visit asks where to look and which sources to read; suggested folders, detected browsers and AI tools are pre-checked. Click "Start collecting".

To install it as a global command:

```bash
npm link
miztrace ui
```

Daily routine: open the page, glance at the board, pop what you don't want, click "Write with AI", save. Two minutes.

## Why it is worth using

**Other tools ask you to remember. This one lays the evidence out.** Writing a work log is hard because you forget, not because you can't write. MizTrace reads what really happened: git commits, changed files, what you asked your AI tools and what they finally answered, browser history with dwell time, shell commands. You only make choices.

**Every sentence links back to a source.** Each paragraph of the AI diary maps to concrete evidence; click it in the UI to see which prompt, file or page it came from. The model cannot invent things the evidence doesn't contain, and if it does, the line is flagged. The saved file is a clean diary with no footnotes.

**It knows AI tools, lots of them.** Claude Code, Codex, Gemini CLI, Cursor, Cline, opencode, Hermes Agent, Windsurf, Trae, CodeBuddy and twenty-plus more. The diary says "I had Codex change X and it replaced Y", not just "used AI".

**Your words win.** A "My notes" box sits above the board: write a few lines, paste a screenshot, and the model trusts it first. Every bubble also takes a note: the browser only knows you spent an hour on a site; tell it "watching Vue tutorials" and that is what gets written.

**Reads like a diary, not a log.** Two layers: a short "Overview" of what got done, then first-person "Notes" on where you got stuck and how you got out. Four built-in templates, all editable.

**Works for non-coders too.** A day of spreadsheets, documents and meetings still yields a diary from document outlines, browsing history and your notes.

**Privacy is the default, not an option.** Reads only the folders you pick, never file contents or diffs; browser and shell are off by default; data lives in a local SQLite; the only outbound request is the one you confirm, and you see every byte first. Managed machines can disable outbound traffic permanently. One-click Chinese / English UI.

## What it reads

| Source | What | Default |
|---|---|---|
| git | Today's commits, working-tree changes, repos cloned today | on |
| Files | Files changed or created today under your folders (path and time only); document outlines | on |
| AI sessions | Your prompts, commands / files the tool touched, first 300 chars of each final reply | on |
| Notes | What you write and paste yourself | on |
| Browser | Page titles, URLs without parameters, search terms, dwell time | off |
| Shell | Commands you type and their folder (via a small shell hook) | off |

`miztrace sources` lists what this machine can actually read.

## Commands

| Command | Does |
|---|---|
| `miztrace ui` | Web UI: board, notes, AI writing, settings |
| `miztrace today` | Today's rules-based diary in the terminal |
| `miztrace date 2026-09-03` | A specific day |
| `miztrace week` | Last 7 days |
| `miztrace write` | AI diary from the CLI; `--preview` shows the payload without sending |
| `miztrace sources` | What can be read on this machine |
| `miztrace shell-hook --install` | Install the shell hook |
| `miztrace where` | Data and config paths |
| `miztrace purge --yes` | Delete all local data |

Common options: `--root <dir>` (repeatable, the important one), `--out <dir>` (where diaries go, e.g. an Obsidian vault), `--author <name or email>`, `--tz Asia/Shanghai`, `--cutoff 4`.

## Model setup

Settings in the UI takes three fields: Base URL, API key, model name. DeepSeek, OpenRouter, Ollama and most others are OpenAI-compatible (end the URL at `/v1`); Anthropic is detected from the URL. Hit "Test connection". There is no other switch.

Tick "Model supports images" for multimodal models to send images from notes as originals.

Use the provider's stable model name (`deepseek-chat`, `deepseek-reasoner`, …). Time-limited names containing `expires` / `preview` often keep returning 200 with empty content after they are retired; MizTrace then reports "the model returned empty content" and suggests switching. Reasoning models (DeepSeek V4 flash / reasoner, o-series) spend "Max output" on thinking first; with a small budget nothing of the answer comes back. MizTrace detects this, retries once with more (at least 16000 for reasoning models, 8000 for plain truncation) and saves the working value to Settings. OpenAI-style `max_completion_tokens` / no-`temperature` quirks are adapted automatically from the 400 message.

## Privacy details

- Reads only folders under `--root` and each AI tool's own session directory. Skips dotfiles, `node_modules`, and files like `.env` / `*.pem` / `id_rsa` (not even the path is recorded).
- Files: path, time, size only. Documents: heading levels / sheet names / slide titles only.
- Sessions: no thinking, no tool output, no code blocks.
- Shell commands containing `password=`, `token=`, `export XXX_KEY=` never enter the local database.
- Before sending: home-directory, email / phone / IP redaction; suspected secrets abort the request.
- Outbound code lives only in `src/ai/`; the local server only in `src/server/`, bound to 127.0.0.1. CI greps both boundaries.
- `managedDevice: true` in `config.json` disables all outbound traffic permanently; the UI deliberately has no switch for it.

Data directory: macOS `~/Library/Application Support/miztrace`, Windows `%APPDATA%\miztrace`; override with `MIZTRACE_DATA_DIR`.

## Development

```bash
npm test
```

Tests run pinned to the Asia/Shanghai timezone (`scripts/pin-timezone.mjs`), so results match between UTC CI and a machine in any timezone.

`src/collect/` collectors, `src/modules.js` grouping, `src/ai/` writing (only outbound module), `src/server/` local server (only listening module), `web/` build-free Vue frontend.

Want another AI tool supported? Open an issue with a redacted sample session file.

## License

MIT. 
