# Notion Automation Setup Guide

This guide configures Notion automation:

`status change → local bridge picks ticket → intake writes handoff markdown → attach @notion-handoff.md in Cursor`

**For AI agents:** start with `AGENTS.md` (runbook with user checkpoints). This file is the detailed reference.

---

## Overview: what you configure vs what is automated

| You configure once | Toolkit automates after that |
|--------------------|------------------------------|
| `.notion.local` in your target repo | Poll Notion for matching tickets |
| Notion integration + database sharing | Fetch title, body, comments, attachments |
| Agent rules file (one copy) | Prepare git branch / worktree |
| (Optional) GitLab token for done-flow | Write `notion-handoff.md` handoff files |

There is no `.env` file. Configuration lives in **`.notion.local`** at the root of each target git workspace.

---

## Prerequisites

| Requirement | Notes |
|-------------|-------|
| **Node.js 18+** | `node --version` — no `npm install` needed in toolkit |
| **git** | Target workspace must be a git repository |
| **npm** | Used once to `npm link` the CLI |
| **Notion internal integration** | Token + database shared with integration |
| **cursor-agent** (optional) | Only for auto-dispatch or `notion-mcp-handoff.sh` |
| **fzf** (optional) | Arrow-key picker for `notion-auto tickets --checkout` |
| **GitLab token** (optional) | Only for `notion-auto done` (push + MR + auto-merge) |

---

## 1) Install toolkit CLI

One-time per machine:

```bash
cd /path/to/notion-automation-toolkit
npm config set prefix "$HOME/.local" --location=user
npm link
```

If `notion-auto` is not found:

```bash
grep -q 'HOME/.local/bin' ~/.bashrc || echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.bashrc
source ~/.bashrc
```

Verify:

```bash
notion-auto --help
```

---

## 2) Initialize target workspace

```bash
notion-auto init --workspace /path/to/your/repo
```

This creates `.notion/` directories and appends local-only ignores to `.git/info/exclude`:

- `.notion/`
- `.notion.local`
- `notion-handoff.md`

Handoff and config files never get committed to the product repo.

---

## 3) Configure Notion side (required)

### 3.1 Create integration token

In Notion:

1. **Settings → Connections → Develop or manage integrations**
2. Create an **internal** integration
3. Copy the token — format is `ntn_...` (current) or legacy `secret_...`

Store the token in `.notion.local` as `NOTION_API_TOKEN`. Never commit it.

### 3.2 Share the ticket database with integration

Open your ticket database → **Share** → add your integration by name.

Without this step, API calls return `404` or `403` even with a valid token.

### 3.3 Confirm database properties

Open the database and note exact property **names** and **option text**:

| Concept | Config key | Typical value | Must match |
|---------|------------|---------------|------------|
| Status column | `NOTION_STATUS_PROPERTY` | `Status` | Exact property name |
| Trigger value | `NOTION_TRIGGER_STATUS` | `In progress` | Exact option text (case-sensitive) |
| Assignee column | `NOTION_ASSIGNEE_PROPERTY` | `Assignee` or `Assigned To` | Exact property name, type **People** |
| Ticket type (optional) | `NOTION_AGENT_SECTION_PROPERTY` | `Type` | Used for branch prefix rules |

**Important:** `"In progress"`, `"In Progress"`, and `"AI work in progress"` are different values. Copy the exact label from Notion.

### 3.4 Get assignee user IDs

`NOTION_ASSIGNEE_IDS` restricts which assignees trigger automation. Use one of:

**Option A — Notion MCP in Cursor (easiest)**

1. Ensure Notion MCP is connected in Cursor.
2. Run tool `notion-get-users`.
3. Copy the `id` field (UUID) for each allowed user.

**Option B — Notion API**

```bash
curl -s https://api.notion.com/v1/users \
  -H "Authorization: Bearer $NOTION_API_TOKEN" \
  -H "Notion-Version: 2022-06-28" | jq '.results[] | {id, name: .name}'
```

**Option C — From a known page**

If you have a ticket page ID, fetch it and read the people property:

```bash
curl -s "https://api.notion.com/v1/pages/<page-id>" \
  -H "Authorization: Bearer $NOTION_API_TOKEN" \
  -H "Notion-Version: 2022-06-28" | jq '.properties["Assigned To"]'
```

Use comma-separated IDs for multiple users: `uuid1,uuid2`.

---

## Finding Notion IDs

### Database ID

From a Notion database URL:

```text
https://www.notion.so/workspace/3179b38927048025b4a1e1f8679add98?v=...
                              └──────── 32-char hex ────────┘
```

Use with hyphens: `3179b389-2704-8025-8b4a-e1f8679add98`.

From API (lists databases the integration can access):

```bash
curl -s https://api.notion.com/v1/search \
  -H "Authorization: Bearer $NOTION_API_TOKEN" \
  -H "Notion-Version: 2022-06-28" \
  -d '{"query": "your database name", "filter": {"value": "database", "property": "object"}}' \
  | jq '.results[] | {id, title: .title[0].plain_text}'
```

### Data source ID (multi-source databases only)

Newer Notion databases can contain multiple data sources. If bridge logs:

```text
multiple data sources are not supported
```

Add to `.notion.local`:

```bash
NOTION_DATA_SOURCE_ID="e519..."    # UUID only, no collection:// prefix
NOTION_API_VERSION="2025-09-03"
```

Find it via Notion MCP `notion-fetch` on the database URL — look for `data-source-url` or collection ID in the response. Or ask your Notion admin.

### Page ID (for manual intake testing)

From ticket URL:

```text
https://www.notion.so/workspace/Ticket-Title-abc123def4567890abcdef12345678
                                              └────── 32-char page id ──────┘
```

Format with hyphens: `abc123de-f456-7890-abcd-ef1234567890`.

---

## 4) Create workspace config (`.notion.local`)

```bash
cp /path/to/notion-automation-toolkit/.notion.local.example /path/to/your/repo/.notion.local
```

Edit `/path/to/your/repo/.notion.local`.

### Required keys

| Key | Description |
|-----|-------------|
| `NOTION_API_TOKEN` | Integration token (`ntn_...` or `secret_...`) |
| `NOTION_DATABASE_ID` | Ticket database UUID |
| `NOTION_TRIGGER_STATUS` | Exact status option that triggers intake |
| `NOTION_STATUS_PROPERTY` | Status property name (default `Status`) |
| `NOTION_ASSIGNEE_PROPERTY` | People property name |
| `NOTION_ASSIGNEE_IDS` | Comma-separated Notion user UUIDs |

### Commonly customized keys

| Key | Default | When to change |
|-----|---------|----------------|
| `NOTION_AGENT_GIT_BASE_BRANCH` | `dev` | Your repo uses `acceptance`, `main`, etc. |
| `NOTION_AGENT_BRANCH_PREFIX` | `fix` | Branch naming preference |
| `NOTION_AGENT_GIT_REQUIRE_CLEAN_WORKTREE` | `true` | Set `false` only if you accept intake on dirty trees |
| `NOTION_SINGLE_TICKET_MODE` | `true` | Set `false` for parallel ticket intake |
| `NOTION_AGENT_WORKTREE_MODE` | `false` | Set `true` for one git worktree per ticket |
| `NOTION_AGENT_MODEL` | `composer-2.5` | Cheap model for script-driven `cursor-agent` calls (see § Model selection below) |

### Multi-data-source keys (when needed)

| Key | Value |
|-----|-------|
| `NOTION_DATA_SOURCE_ID` | Data source UUID |
| `NOTION_API_VERSION` | `"2025-09-03"` |

### Optional GitLab done-flow keys

| Key | Description |
|-----|-------------|
| `GITLAB_TOKEN` | PAT (`glpat-...`) or OAuth token from `glab auth login` |
| `GITLAB_TARGET_BRANCH` | MR target (default `dev`) |
| `GITLAB_PROJECT_ID` | Auto-inferred from git remote if omitted |
| `GITLAB_AUTO_MERGE` | Default `true` |

See `.notion.local.example` for all options with inline comments.

### Model selection (token cost)

Use two tiers:

| Context | Model | How it is set |
|---------|-------|----------------|
| **IDE Agent chat** (implementation, debugging) | Your chosen model in Cursor UI | You pick in chat — scripts do not override |
| **Script-driven `cursor-agent`** (intake dispatch, MCP handoff) | Cheap model (default `composer-2.5`) | `NOTION_AGENT_MODEL` in `.notion.local` |

Most toolkit commands (`notion-auto done`, `reply-latest`, polling, intake fetch) call Notion/GitLab APIs directly and **do not use LLM tokens**.

Add to `.notion.local`:

```bash
NOTION_AGENT_MODEL="composer-2.5"
# alternatives: "auto"  |  "inherit" (skip injection, use cursor-agent default)
# optional override for scripts/notion-mcp-handoff.sh only:
# NOTION_MCP_HANDOFF_MODEL="auto"
```

Intake injects `--model` into `NOTION_AGENT_COMMAND` unless the command already includes `--model` or `NOTION_AGENT_MODEL=inherit`.

For in-chat auxiliary work (Notion MCP reads, GitLab status checks), copy `scripts/notion-ticket-agent-rules.md` to `.notion/agent-rules.md`. Those rules ask the agent to delegate repetitive Notion/GitLab fetches to a cheap subagent while keeping your premium model for code changes. That guidance is not enforced by scripts.

---

## 5) Seed agent rules

```bash
mkdir -p /path/to/your/repo/.notion
cp /path/to/notion-automation-toolkit/scripts/notion-ticket-agent-rules.md /path/to/your/repo/.notion/agent-rules.md
```

Default path is already set in example config:

```bash
NOTION_AGENT_RULES_FILE=".notion/agent-rules.md"
```

If this file is missing, intake falls back to built-in default rules (less team-specific).

---

## 6) Validate and start

```bash
notion-auto check --workspace /path/to/your/repo
notion-auto start --workspace /path/to/your/repo
```

`check` validates:

**Local config (always):**

- `NOTION_API_TOKEN` is set
- `NOTION_DATABASE_ID` is set
- `NOTION_ON_MATCH_COMMAND` is set
- Local git ignores cover `.notion/`, `.notion.local`, `notion-handoff.md`

**Extended check (when `--check`, unless `--skip-live-check`):**

- Notion API token authenticates (`/users/me`)
- Database or data source is accessible with the integration
- `NOTION_STATUS_PROPERTY` exists with type `status` or `select`
- `NOTION_TRIGGER_STATUS` matches an option in the database schema (exact text)
- `NOTION_ASSIGNEE_PROPERTY` exists with type `people`
- `NOTION_ASSIGNEE_IDS` recognized by workspace (when set)
- Agent rules file exists at `NOTION_AGENT_RULES_FILE` (warns if missing)
- Git base branch exists (warns if missing)
- `cursor-agent` on PATH (warns if missing)
- `GITLAB_TOKEN` configured (warns if missing)

Skip live API calls when offline or token not yet shared:

```bash
notion-auto check --workspace /path/to/your/repo --skip-live-check
```

Extended `[FAIL]` items block `check` from completing. `[WARN]` items are advisory.

Keep `start` running in a terminal (or run bridge in tmux/systemd).

Stop:

```bash
notion-auto stop --workspace /path/to/your/repo
```

---

## 7) Trigger flow and verification

When a page in `NOTION_DATABASE_ID`:

1. Has status = `NOTION_TRIGGER_STATUS` (exact match)
2. Assignee is in `NOTION_ASSIGNEE_IDS`
3. (Optional) Matches routing key if configured

Then:

1. Bridge picks the ticket
2. Intake runs
3. Writes:
   - `.notion/handoffs/<branch-flat>.agent-handoff.md`
   - `notion-handoff.md` (stable alias)
4. In Cursor chat attach: `@notion-handoff.md`

### Manual intake test (recommended during setup)

Skip polling — test intake directly:

```bash
notion-auto intake --workspace /path/to/your/repo --page-id <notion-page-id> --dispatch
```

Success: `notion-handoff.md` appears with ticket title, body, and comments.

---

## 8) Closeout (GitLab MR + Notion status)

When implementation is done:

```bash
notion-auto done
```

From inside the ticket branch/worktree. This:

1. Verifies clean working tree
2. Pushes branch
3. Creates or reuses GitLab MR
4. Enables auto-merge (default)

Requires `GITLAB_TOKEN` in `.notion.local`. See `README.md` § Task Done Flow for token setup.

If status property is not `Status`:

```bash
notion-auto done --status-property "<your-status-property-name>"
```

When bridge is running, merged MRs can auto-update Notion status to `Fix Deployed Dev` (configurable).

---

## 9) Webhook vs polling

- **Default (recommended):** polling bridge — no Notion webhook, no tunnel.
- Bridge polls every `NOTION_POLL_INTERVAL_SECONDS` (default 15s).
- Notion webhooks are optional and not required.

---

## 10) Multi-ticket worktree mode

Enable in `.notion.local`:

```bash
NOTION_AGENT_WORKTREE_MODE="true"
```

Each ticket gets an isolated git worktree. Switch between tickets:

```bash
notion-auto tickets --checkout
```

For JetBrains IDEs (WebStorm, IntelliJ):

```bash
NOTION_AGENT_IDE="webstorm"
```

Worktrees are created outside the repo at `../{repo-name}-worktrees/`. Cursor users can keep the default nested layout.

See `README.md` § Multi-Ticket Worktree Switching for full options.

---

## Troubleshooting

### `notion-auto: command not found`

- Run `npm link` from toolkit directory
- Ensure `~/.local/bin` is on `PATH`

### Check passes but bridge never picks tickets

1. **Status text** — `NOTION_TRIGGER_STATUS` must match Notion option exactly (including spaces and capitalization).
2. **Assignee filter** — ticket assignee UUID must be in `NOTION_ASSIGNEE_IDS`.
3. **Property names** — `NOTION_STATUS_PROPERTY` and `NOTION_ASSIGNEE_PROPERTY` must match database column names exactly.
4. **Bridge running?** — `notion-auto start` must stay alive; check `.notion/runtime.json` and bridge logs.
5. **Dedupe** — same ticket won't retrigger within `NOTION_DEDUPE_SECONDS` (default 120s). Change status away and back, or wait.
6. **Single-ticket mode** — with `NOTION_SINGLE_TICKET_MODE=true`, only one ticket processes at a time.

### Notion API errors

| Error | Cause | Fix |
|-------|-------|-----|
| `401 Unauthorized` | Invalid or revoked token | Re-copy token from Notion integration settings |
| `404 Not Found` | Database not shared with integration | Share database with integration |
| `multiple data sources are not supported` | Multi-source database | Add `NOTION_DATA_SOURCE_ID` + `NOTION_API_VERSION="2025-09-03"` |
| Empty page body | Integration lacks content access | Ensure integration has read access; check page is in shared database |

### Git / branch errors during intake

| Error | Fix |
|-------|-----|
| `Refusing branch checkout because working tree has tracked changes` | Commit/stash changes, or set `NOTION_AGENT_GIT_REQUIRE_CLEAN_WORKTREE=false` |
| Wrong base branch | Set `NOTION_AGENT_GIT_BASE_BRANCH` to your repo's actual base |
| Branch already exists | Expected on retrigger — handoff is rewritten, branch is reused |

### GitLab done-flow errors

| Error | Fix |
|-------|-----|
| `GITLAB_TOKEN is required` | Add `GITLAB_TOKEN` to `.notion.local` or use `--push-only true` |
| Auto-merge failed | Non-fatal — MR still created; resolve conflicts manually |
| OAuth token expired | Re-run `glab auth login`, copy new token from `~/.config/glab-cli/config.yml` |

### Manual fallback (no polling)

If polling setup is blocked, generate a handoff from a ticket URL:

```bash
/path/to/notion-automation-toolkit/scripts/notion-mcp-handoff.sh \
  --workspace /path/to/your/repo \
  --ticket "https://www.notion.so/..."
```

Requires Cursor Notion MCP authenticated and `cursor-agent` installed.

---

## Setup checklist

- [ ] Node 18+ and git available
- [ ] `notion-auto` installed via `npm link`
- [ ] Target workspace initialized (`notion-auto init`)
- [ ] Notion integration created; database shared with integration
- [ ] `.notion.local` filled with token, database ID, status/assignee config
- [ ] `NOTION_AGENT_MODEL="composer-2.5"` set (or `inherit` if using cursor-agent default)
- [ ] `.notion/agent-rules.md` copied
- [ ] `notion-auto check` passes
- [ ] Test intake works (`notion-auto intake --page-id ...` or live status change)
- [ ] `@notion-handoff.md` attachable in Cursor
- [ ] (Optional) GitLab token configured for `notion-auto done`
