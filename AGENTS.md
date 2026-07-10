# AI Agent Setup Runbook

Use this document when setting up Notion automation for a user. The goal is:

**user fills `.notion.local` → agent runs the rest → user verifies one test ticket.**

Detailed reference: `SETUP_GUIDE.md`. Command reference: `README.md`.

---

## What the user must provide

These values cannot be inferred reliably. Ask the user (or read from an existing config they paste):

| Value | Why user input is required |
|-------|---------------------------|
| `NOTION_API_TOKEN` | Secret; usually from Notion admin or user's integration |
| `NOTION_DATABASE_ID` | Workspace-specific ticket database |
| `NOTION_DATA_SOURCE_ID` | Only when database has multiple data sources |
| `NOTION_TRIGGER_STATUS` | Must match **exact** status option text in Notion |
| `NOTION_STATUS_PROPERTY` | Property name in their database (often `Status`) |
| `NOTION_ASSIGNEE_PROPERTY` | Property name in their database (often `Assignee` or `Assigned To`) |
| `NOTION_ASSIGNEE_IDS` | Notion user UUID(s) allowed to trigger automation |
| `NOTION_AGENT_GIT_BASE_BRANCH` | Their repo's base branch (`dev`, `acceptance`, etc.) |

Optional (only if using done-flow):

| Value | Why |
|-------|-----|
| `GITLAB_TOKEN` | GitLab PAT or OAuth token for MR creation |
| `GITLAB_TARGET_BRANCH` | MR target branch (default `dev`) |

Notion-side actions the user (or admin) must confirm:

1. Internal integration exists and token is copied.
2. Ticket database is **shared with the integration** (Share → add integration).
3. Trigger status option exists in the Status property.
4. Assignee property is type **People**.

How to find IDs: see **"Finding Notion IDs"** in `SETUP_GUIDE.md`.

---

## What the agent automates

After `.notion.local` exists, run these without asking unless a step fails:

```bash
# 1) Install CLI (once per machine)
cd /path/to/notion-automation-toolkit
npm config set prefix "$HOME/.local" --location=user
npm link

# 2) Bootstrap target workspace
notion-auto init --workspace /path/to/target-repo

# 3) Create config (if not already present)
cp /path/to/notion-automation-toolkit/.notion.local.example /path/to/target-repo/.notion.local
# Then fill values from user input — see SETUP_GUIDE.md "Configuration reference"

# 4) Seed agent rules
mkdir -p /path/to/target-repo/.notion
cp /path/to/notion-automation-toolkit/scripts/notion-ticket-agent-rules.md /path/to/target-repo/.notion/agent-rules.md

# 5) Validate
notion-auto check --workspace /path/to/target-repo

# 6) Start bridge (keep running)
notion-auto start --workspace /path/to/target-repo
```

Do **not** commit `.notion.local`, `.notion/`, or `notion-handoff.md` to git. `notion-auto init` adds local-only ignores.

---

## Setup workflow (step by step)

### Phase 0 — Confirm prerequisites

Verify or install:

- **Node.js 18+** (`node --version`)
- **git** repo at target workspace
- **npm** (no `npm install` needed in toolkit — zero runtime dependencies)
- **notion-auto** on PATH after `npm link`

Optional later:

- `cursor-agent` — only if using auto-dispatch or MCP handoff script
- `fzf` — nicer worktree picker (`notion-auto tickets --checkout`)
- `glab` / GitLab token — only for `notion-auto done`

### Phase 1 — Collect config from user

Use this prompt template:

```text
Please provide or confirm these values for .notion.local:

1. Notion API token (ntn_... or secret_...)
2. Ticket database URL or database ID
3. Status property name (e.g. "Status")
4. Exact trigger status option text (e.g. "In progress")
5. Assignee property name (e.g. "Assigned To")
6. Your Notion user ID(s) for NOTION_ASSIGNEE_IDS
7. Git base branch for new ticket branches (e.g. "acceptance" or "dev")

Also confirm:
- The integration is shared with the ticket database
- You have permission to change ticket status for testing
```

If the database has multiple data sources, also collect `NOTION_DATA_SOURCE_ID` and set `NOTION_API_VERSION="2025-09-03"`.

### Phase 2 — Write `.notion.local`

Copy from `.notion.local.example` into the **target repo root** (not the toolkit repo):

```bash
cp /path/to/notion-automation-toolkit/.notion.local.example /path/to/target-repo/.notion.local
```

Fill required keys. Minimum working set:

```bash
NOTION_API_TOKEN="..."
NOTION_DATABASE_ID="..."
NOTION_TRIGGER_STATUS="..."          # exact match, case-sensitive
NOTION_STATUS_PROPERTY="Status"
NOTION_ASSIGNEE_PROPERTY="Assigned To"
NOTION_ASSIGNEE_IDS="uuid-here"
NOTION_AGENT_GIT_BASE_BRANCH="acceptance"   # or dev — match their repo
NOTION_AGENT_CREATE_CHAT="false"
NOTION_AGENT_MODEL="composer-2.5"             # script-driven agent only; IDE chat = user's model
```

See full key reference in `SETUP_GUIDE.md` (including § Model selection).

### Phase 3 — Bootstrap workspace

```bash
notion-auto init --workspace /path/to/target-repo
mkdir -p /path/to/target-repo/.notion
cp /path/to/notion-automation-toolkit/scripts/notion-ticket-agent-rules.md /path/to/target-repo/.notion/agent-rules.md
```

### Phase 4 — Validate

```bash
notion-auto check --workspace /path/to/target-repo
```

Expected: all `[OK]` for local config, then extended check with no `[FAIL]`:

- `NOTION_API_AUTH`, `NOTION_DATABASE_ACCESS` (or `NOTION_DATA_SOURCE_ACCESS`)
- `NOTION_STATUS_PROPERTY`, `NOTION_TRIGGER_STATUS`, `NOTION_ASSIGNEE_PROPERTY`

Warnings (`[WARN]`) for missing agent rules, cursor-agent, or GitLab token are OK if not using those features.

Skip live Notion API validation when needed:

```bash
notion-auto check --workspace /path/to/target-repo --skip-live-check
```

### Phase 5 — Start and test

```bash
notion-auto start --workspace /path/to/target-repo
```

Ask user to:

1. Open a ticket assigned to them in the configured database.
2. Change status to `NOTION_TRIGGER_STATUS` (exact text).
3. Wait ~15 seconds (default poll interval).

Success criteria:

- Bridge logs show ticket matched and intake ran.
- Files appear:
  - `notion-handoff.md` in repo root
  - `.notion/handoffs/<branch>.agent-handoff.md`
- User can attach `@notion-handoff.md` in Cursor chat.

Manual intake test (bypasses polling — useful for debugging):

```bash
notion-auto intake --workspace /path/to/target-repo --page-id <notion-page-id> --dispatch
```

### Phase 6 — Optional GitLab done-flow

If user wants push + MR + auto-merge, add to `.notion.local`:

```bash
GITLAB_TOKEN="glpat-..."
GITLAB_TARGET_BRANCH="dev"
```

Then after implementation: `notion-auto done` from the ticket worktree.

---

## Mode selection

| Mode | When to use | User config burden |
|------|-------------|-------------------|
| **Full polling** (default) | Daily ticket flow | `.notion.local` + keep bridge running |
| **Manual MCP handoff** | Ad-hoc / no always-on bridge | Notion MCP in Cursor + ticket URL only |

Manual fallback:

```bash
/path/to/notion-automation-toolkit/scripts/notion-mcp-handoff.sh \
  --workspace /path/to/target-repo \
  --ticket "https://www.notion.so/..."
```

---

## Troubleshooting (agent quick reference)

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| `notion-auto: command not found` | PATH | Add `~/.local/bin` to PATH; re-run `npm link` |
| Bridge never picks ticket | Status text mismatch | `NOTION_TRIGGER_STATUS` must match Notion option **exactly** |
| Bridge never picks ticket | Assignee filter | Confirm page assignee is in `NOTION_ASSIGNEE_IDS` |
| Bridge never picks ticket | Wrong property names | Fix `NOTION_STATUS_PROPERTY` / `NOTION_ASSIGNEE_PROPERTY` |
| `401` / `403` from Notion | Token or sharing | Re-copy token; share database with integration |
| `multiple data sources are not supported` | Multi-source DB | Set `NOTION_DATA_SOURCE_ID` + `NOTION_API_VERSION="2025-09-03"` |
| Check passes, intake fails | Git state | Ensure clean worktree if `NOTION_AGENT_GIT_REQUIRE_CLEAN_WORKTREE=true` |
| Handoff empty / no attachments | Page permissions | Integration needs read access to page content and files |
| `GITLAB_TOKEN is required` | Done-flow not configured | Add token or use `--push-only true` |

Full troubleshooting: `SETUP_GUIDE.md` § Troubleshooting.

---

## Verification checklist

Before telling the user setup is complete, confirm:

- [ ] `notion-auto check` exits 0 (no extended `[FAIL]` items)
- [ ] `.notion.local` is in target repo root and git-ignored
- [ ] `NOTION_AGENT_MODEL` set (default `composer-2.5` for script-driven agent; IDE chat unchanged)
- [ ] `.notion/agent-rules.md` exists
- [ ] Bridge process is running (`notion-auto start`)
- [ ] Test ticket triggered intake OR manual `notion-auto intake --page-id ...` succeeded
- [ ] `notion-handoff.md` exists and contains ticket title/body
- [ ] User knows to attach `@notion-handoff.md` in Cursor

---

## Security reminders for agents

- Never commit, paste into PRs, or log full `NOTION_API_TOKEN` / `GITLAB_TOKEN`.
- Keep secrets in target repo `.notion.local` only (local, ignored).
- Do not copy production tokens into the toolkit repo itself.
