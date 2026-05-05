# Notion Automation Toolkit (Standalone)

Reusable Notion -> local agent automation for any git workspace.

This toolkit is intentionally **outside product repos** and writes local runtime files under each workspace's `.notion/` folder.

For full first-time setup, see `SETUP_GUIDE.md`.

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

4. Seed workspace-local agent rules (ignored from git):

```bash
mkdir -p /path/to/repo/.notion
cp /path/to/notion-automation-toolkit/scripts/notion-ticket-agent-rules.md /path/to/repo/.notion/agent-rules.md
```

5. Validate config:

```bash
notion-auto check --workspace /path/to/repo
```

6. Start automation:

```bash
notion-auto start --workspace /path/to/repo
```

7. Stop automation:

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
notion-auto reply-latest --workspace /path/to/repo --page-id <notion-page-id> --body-file ./reply.md --set-status "AI fix ready"
```

Always run/start/stop via `notion-auto` when validating toolkit behavior.

## Generated Files

Per workspace, the toolkit writes:

- `.notion/intake/<page>-<slug>-<timestamp>.prompt.md`
- `.notion/intake/<page>-<slug>-<timestamp>.context.json`
- `.notion/intake/assets/<page-id>/*` (downloaded ticket attachments when enabled)
- `.notion/handoffs/<branch-flat>.agent-handoff.md`
- `notion-handoff.md` (stable alias that always points to the latest handoff)
- `.notion/runtime.json`
- `.notion/bridge-state.json`

When `NOTION_CLEANUP_ON_STATUS=true`, bridge automatically removes a ticket's intake files/assets when status becomes `NOTION_CLEANUP_STATUS` (default: `Pushed to dev`).

In Cursor Agent chat, attach the stable alias:

```text
@notion-handoff.md
```

## Manual MCP Handoff (One-Step Trigger)

If you prefer manual triggering (instead of polling) but want the same easy `@notion-handoff.md` flow, use:

```bash
scripts/notion-mcp-handoff.sh \
  --workspace /path/to/repo \
  --ticket "https://www.notion.so/...or-page-id..."
```

This uses Cursor Agent with your installed Notion MCP server to fetch ticket content + discussions and writes a single handoff file. Default output is:

```text
/path/to/repo/notion-handoff.md
```

Optional flags:

```bash
scripts/notion-mcp-handoff.sh --ticket "<url-or-id>" --output ".notion/handoffs/notion-handoff.md"
scripts/notion-mcp-handoff.sh --ticket "<url-or-id>" --agent-bin "$HOME/.local/bin/cursor-agent"
```

Minimum requirements for this mode:

- `cursor-agent` CLI installed and available on PATH (or pass `--agent-bin`).
- Notion MCP server installed in Cursor and authenticated.
- A Notion page URL or page ID.
- Write access to the target workspace for `notion-handoff.md`.

## Notes About Notion Triggering

- This project uses **database polling** (`NOTION_DATABASE_ID`) instead of Monday-style webhook + tunnel orchestration.
- For Notion databases with multiple data sources, set `NOTION_DATA_SOURCE_ID` and `NOTION_API_VERSION="2025-09-03"` in `.notion.local`.
- Polling only evaluates pages with matching `NOTION_TRIGGER_STATUS`.
- Optional filters are supported via assignee IDs and routing key properties.
- No Notion-side webhook is required for the default flow.
