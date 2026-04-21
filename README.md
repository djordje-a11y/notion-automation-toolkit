# Notion Automation Toolkit (Standalone)

Reusable Notion -> local agent automation for any git workspace.

This toolkit is intentionally **outside product repos** and writes local runtime files under each workspace's `.notion/` folder.

## What You Get

- One CLI for all operations: `notion-auto`
- Workspace-scoped execution (`--workspace /path/to/repo`)
- Stable easy-attach handoff alias for Cursor `@`:
  - `notion-handoff.md`
- Branch-specific handoff file:
  - `.notion/handoffs/<branch-flat>.agent-handoff.md`
- Safe retrigger behavior:
  - existing ticket branch is reused (not reset from base)
  - handoff is rewritten with latest Notion comment only
- Poll-based trigger flow (no tunnel/webhook setup needed)
- Local-only files ignored through `.git/info/exclude` (no product repo pollution)

## Quick Start

1. Install CLI once (recommended):

```bash
cd /path/to/notion-automation-toolkit
npm config set prefix "$HOME/.local" --location=user
npm link
```

If `notion-auto` is not found, ensure `~/.local/bin` is on `PATH`:

```bash
grep -q 'HOME/.local/bin' ~/.bashrc || echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.bashrc
source ~/.bashrc
```

2. Initialize a target workspace:

```bash
notion-auto init --workspace /path/to/repo
```

This ensures local ignore entries for `.notion/`, `.notion.local`, and `notion-handoff.md`.

3. Create workspace config:

```bash
cp /path/to/notion-automation-toolkit/.notion.local.example /path/to/repo/.notion.local
```

4. Validate config:

```bash
notion-auto check --workspace /path/to/repo
```

5. Start automation:

```bash
notion-auto start --workspace /path/to/repo
```

6. Stop automation:

```bash
notion-auto stop --workspace /path/to/repo
```

## Commands

```bash
notion-auto init         --workspace /path/to/repo
notion-auto check        --workspace /path/to/repo
notion-auto start        --workspace /path/to/repo
notion-auto stop         --workspace /path/to/repo
notion-auto bridge       --workspace /path/to/repo
notion-auto intake       --workspace /path/to/repo --page-id <notion-page-id> --dispatch
notion-auto reply-latest --workspace /path/to/repo --page-id <notion-page-id> --body "Fix is implemented."
```

Always run/start/stop via `notion-auto` when validating toolkit behavior.

## Generated Files

Per workspace, the toolkit writes:

- `.notion/intake/<page>-<slug>-<timestamp>.prompt.md`
- `.notion/intake/<page>-<slug>-<timestamp>.context.json`
- `.notion/handoffs/<branch-flat>.agent-handoff.md`
- `notion-handoff.md` (stable alias that always points to the latest handoff)
- `.notion/runtime.json`
- `.notion/bridge-state.json`

In Cursor Agent chat, attach the stable alias:

```text
@notion-handoff.md
```

## Notes About Notion Triggering

- This project uses **database polling** (`NOTION_DATABASE_ID`) instead of Monday-style webhook + tunnel orchestration.
- Polling only evaluates pages with matching `NOTION_TRIGGER_STATUS`.
- Optional filters are supported via assignee IDs and routing key properties.
