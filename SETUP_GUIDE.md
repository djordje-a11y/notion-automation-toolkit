# Notion Automation Setup Guide

This guide configures Notion automation to behave as close as possible to `monday-automation-toolkit`:

`status change -> local bridge picks ticket -> intake writes handoff markdown -> attach @notion-handoff.md`

## 1) Install toolkit CLI

```bash
cd /path/to/notion-automation-toolkit
npm config set prefix "$HOME/.local" --location=user
npm link
```

If needed:

```bash
grep -q 'HOME/.local/bin' ~/.bashrc || echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.bashrc
source ~/.bashrc
```

## 2) Initialize target workspace

```bash
notion-auto init --workspace /path/to/your/repo
```

This creates local directories and appends local-only ignores to `.git/info/exclude`:

- `.notion/`
- `.notion.local`
- `notion-handoff.md`

So handoff files do not get committed.

## 3) Configure Notion side (required)

### 3.1 Create integration token

In Notion:

1. Settings -> Connections -> Develop or manage integrations
2. Create internal integration
3. Copy token (`secret_...`)

### 3.2 Share the ticket database with integration

Open target database -> Share -> add your integration.

### 3.3 Confirm database properties used by automation

- Status property name (default expected: `Status`)
- Assignee property name (default expected: `Assignee`, type: People)
- Trigger status option text (example: `AI work in progress`)

### 3.4 Get assignee user IDs

Use Cursor with Notion MCP `notion-get-users` and copy the `id` of allowed users.

## 4) Create workspace config

```bash
cp /path/to/notion-automation-toolkit/.notion.local.example /path/to/your/repo/.notion.local
```

Update values in `/path/to/your/repo/.notion.local`:

- `NOTION_API_TOKEN`
- `NOTION_DATABASE_ID`
- `NOTION_DATA_SOURCE_ID` (required when the selected Notion database contains multiple data sources)
- `NOTION_API_VERSION="2025-09-03"` (required when using `NOTION_DATA_SOURCE_ID`)
- `NOTION_TRIGGER_STATUS`
- `NOTION_STATUS_PROPERTY`
- `NOTION_ASSIGNEE_PROPERTY`
- `NOTION_ASSIGNEE_IDS`

`NOTION_ASSIGNEE_IDS` is the key guard that makes bridge pick only predefined user(s).

Optional multi-ticket isolation:

- `NOTION_AGENT_WORKTREE_MODE="true"` enables one git worktree per ticket branch.
- Active worktrees are tracked in `.notion/worktree-map.json`.
- A quick index is written to `.notion/active-tickets.md`.
- `NOTION_AGENT_IDE="webstorm"` (or `jetbrains`) places new worktrees outside the repo (`../{repo}-worktrees/`) so WebStorm's Git Worktrees UI works. Cursor users can omit this or set `NOTION_AGENT_IDE="cursor"` to keep `.notion/worktrees/`.

## 5) Seed rules (Monday-like instruction set)

```bash
mkdir -p /path/to/your/repo/.notion
cp /path/to/notion-automation-toolkit/scripts/notion-ticket-agent-rules.md /path/to/your/repo/.notion/agent-rules.md
```

The example env already points to:

```bash
NOTION_AGENT_RULES_FILE=".notion/agent-rules.md"
```

So the generated handoff includes your stable rules.

## 6) Validate and start

```bash
notion-auto check --workspace /path/to/your/repo
notion-auto start --workspace /path/to/your/repo
```

Keep `start` running in a terminal.

## 7) Trigger flow

When a page in `NOTION_DATABASE_ID` changes to `NOTION_TRIGGER_STATUS` and matches assignee filter:

1. bridge picks it
2. intake runs
3. writes:
   - `.notion/handoffs/<branch-flat>.agent-handoff.md`
   - `notion-handoff.md` (stable alias)
4. in Cursor chat attach:
   - `@notion-handoff.md`

## 8) Monday-style closeout

When implementation is done and staged, run the done-flow to push, create MR, and enable auto-merge:

```bash
notion-auto done
```

If your status property is not named `Status`, add:

```bash
--status-property "<your-status-property-name>"
```

## 9) Webhook vs polling

- Default and recommended here: polling bridge (no Notion webhook required).
- Notion-side webhook is optional and not required for parity with Monday flow.
- Polling avoids tunnel/exposed local webhook complexity and works reliably for local dev workflows.
