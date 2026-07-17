# Notion Automation Toolkit (Standalone)

Reusable Notion -> local agent automation for any git workspace.

This toolkit is intentionally **outside product repos** and writes local runtime files under each workspace's `.notion/` folder.

For full first-time setup, see `SETUP_GUIDE.md`.

For AI agent setup (user fills `.notion.local`, agent runs the rest), see `AGENTS.md`.

Planned next-step automation ideas are tracked in `TODO.md`.

## Setup in brief

1. User (or admin) provides Notion integration token, database ID, and property names → written to **`.notion.local`** in the target repo.
2. Agent or developer runs `notion-auto init`, copies agent rules, `notion-auto check`, `notion-auto start`.
3. User changes a ticket status to the trigger value → `@notion-handoff.md` is ready in Cursor.

There is no separate `.env` file. All workspace config lives in `.notion.local` (git-ignored).

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

3. Create workspace config (`.notion.local` — not `.env`):

```bash
cp /path/to/notion-automation-toolkit/.notion.local.example /path/to/repo/.notion.local
```

Fill required values — see `SETUP_GUIDE.md` (Finding Notion IDs + §4 Required keys). Minimum: `NOTION_API_TOKEN`, `NOTION_DATABASE_ID`, `NOTION_TRIGGER_STATUS`, `NOTION_ASSIGNEE_PROPERTY`, `NOTION_ASSIGNEE_IDS`.

Keep auto chat creation disabled (recommended default):

```bash
# in /path/to/repo/.notion.local
NOTION_AGENT_CREATE_CHAT="false"
NOTION_AGENT_MODEL="composer-2.5"   # script-driven agent only; IDE chat keeps your chosen model
```

4. Seed workspace-local agent rules (ignored from git):

```bash
mkdir -p /path/to/repo/.notion
cp /path/to/notion-automation-toolkit/scripts/notion-ticket-agent-rules.md /path/to/repo/.notion/agent-rules.md
```

5. Validate config (local + live Notion API when online):

```bash
notion-auto check --workspace /path/to/repo
```

`check` verifies config, authenticates the Notion token, confirms database access, and validates status/assignee property names. Use `--skip-live-check` to validate config files only.

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
notion-auto reply-latest --workspace /path/to/repo --page-id <notion-page-id> --body-file ./reply.md --set-status "Fix Deployed Dev"
notion-auto tickets      --workspace /path/to/repo
notion-auto tickets      --checkout
notion-auto tickets      --paths true
notion-auto done
notion-auto push         --message "Implement ticket changes"
```

Always run/start/stop via `notion-auto` when validating toolkit behavior.

## Multi-Ticket Worktree Switching

When worktree mode is enabled (`NOTION_AGENT_WORKTREE_MODE=true`), switch active task worktrees with:

```bash
notion-auto tickets --checkout
```

Notes:

- `--workspace` is optional for `tickets`; when omitted, current repo/root workspace is auto-detected.
- `--checkout` opens an interactive selector and drops you into the selected worktree shell.
- `--checkout --run` same as above but also runs `NOTION_TICKETS_AFTER_CHECKOUT_COMMAND` (e.g. `npm run dev`).
- `--paths true` prints copy/paste `cd` commands for all active worktrees.
- `--prune` removes stale entries from `.notion/worktree-map.json` when the worktree folder no longer exists (also cleans related handoff aliases and runs `git worktree prune`).

If you manually deleted worktrees to free disk/memory, run:

```bash
notion-auto tickets --prune
```

Optional (recommended) for arrow-key selector UX:

```bash
sudo apt update
sudo apt install fzf
```

Without `fzf`, `--checkout` falls back to numeric selection.

### IDE-specific worktree directories

By default, worktrees are created inside the repo at `.notion/worktrees/` (works well with Cursor).

JetBrains IDEs (WebStorm, IntelliJ, etc.) do not reliably discover nested worktrees. Set your IDE in `.notion.local`:

```bash
NOTION_AGENT_IDE="webstorm"
```

With `NOTION_AGENT_IDE=webstorm`, new worktrees go to a sibling folder outside the repo: `../{repo-name}-worktrees/`. Cursor behavior is unchanged unless you set `NOTION_AGENT_IDE="cursor"` or an explicit override.

Optional per-IDE overrides:

```bash
NOTION_AGENT_WORKTREE_DIR_BY_IDE="cursor=.notion/worktrees,webstorm=../{repo}-worktrees"
```

`NOTION_AGENT_WORKTREE_DIR` still wins over both when you need a single explicit path.

Optional: run a command immediately after selecting a worktree (instead of opening a shell):

```bash
notion-auto tickets --checkout --after-checkout-command "npm run dev"
```

or configure once via env:

```bash
export NOTION_TICKETS_AFTER_CHECKOUT_COMMAND="npm run dev"
notion-auto tickets --checkout
```

Important:

- `NOTION_TICKETS_AFTER_CHECKOUT_COMMAND` is read from your shell environment (not from `.notion.local`).

Persist across sessions (bash):

```bash
echo 'export NOTION_TICKETS_AFTER_CHECKOUT_COMMAND="npm run dev"' >> ~/.bashrc
source ~/.bashrc
```

## Task Done Flow

When a ticket is finished, run from inside the worktree:

```bash
notion-auto done
```

This performs the full end-of-task handoff in one command:

1. verifies clean working tree (fails if uncommitted changes)
2. pushes current branch (`git push -u origin HEAD` when remote branch does not exist)
3. creates (or reuses) GitLab MR targeting `dev`
4. enables GitLab auto-merge (merge when pipeline succeeds)

Auto-merge is **enabled by default**. If auto-merge fails (e.g. merge conflicts with `dev`), it warns but does not block — push and MR creation still succeed.

Dry-run first:

```bash
notion-auto done --dry-run true
```

Required env (add to project `.notion.local`):

- `GITLAB_TOKEN` — GitLab PAT (`glpat-...`) or OAuth2 token (from `glab auth login`); both are supported
- optional: `GITLAB_TARGET_BRANCH` (default: `dev`)
- optional: `GITLAB_REMOTE` (default: `origin`)
- optional: `GITLAB_AUTO_MERGE` (default: `true`)
- optional: `GITLAB_PROJECT_ID` (auto-inferred from git remote if omitted)
- optional: `GITLAB_API_URL` (auto-inferred from git remote, fallback `https://gitlab.com/api/v4`)

Disable auto-merge:

```bash
notion-auto done --auto-merge false
```

Token notes:

- PAT tokens (`glpat-...`) do not expire frequently; create at [gitlab.com/-/user_settings/personal_access_tokens](https://gitlab.com/-/user_settings/personal_access_tokens) with `api` scope.
- OAuth2 tokens (from `glab auth login`) expire periodically; re-run `glab auth login` and copy the new token from `~/.config/glab-cli/config.yml` when expired.

## Reviewer Push Flow

Use `notion-auto push` when your GitLab process requires another developer to review and merge:

```bash
notion-auto push --message "Implement ticket changes"
```

This command:

1. stages all tracked and untracked changes with `git add -A`
2. commits them (skips the commit if the worktree is already clean)
3. pushes the current branch
4. creates or reuses an MR targeting `dev`
5. assigns the configured reviewers

Configure the target repo's `.notion.local`:

```bash
GITLAB_TOKEN="glpat-..."
GITLAB_TARGET_BRANCH="dev"
GITLAB_REVIEWER_IDS="12345,67890"
# Optional fallback when --message is omitted:
# NOTION_PUSH_COMMIT_MESSAGE="Implement ticket changes"
```

Reviewer IDs are numeric GitLab user IDs. Find your ID under GitLab **Preferences → Account**, or obtain project member IDs through GitLab's project members page/API.

If `--message` and `NOTION_PUSH_COMMIT_MESSAGE` are both omitted, the command derives a message from the current branch name. Use `--dry-run true` to preview without committing, pushing, or creating the MR.

## Merge To Notion Status Sync

When bridge is running, merged MRs can automatically move the linked Notion ticket to `Fix Deployed Dev`:

- bridge reads tracked ticket branches from `.notion/worktree-map.json`
- checks GitLab for merged MRs to target branch (`dev` by default)
- updates ticket status in Notion using `NOTION_STATUS_PROPERTY`

Optional env:

- `GITLAB_STATUS_SYNC_ON_MERGE` (default: `true`)
- `GITLAB_MERGED_NOTION_STATUS` (default: `Fix Deployed Dev`)
- `GITLAB_SYNC_INTERVAL_SECONDS` (default: `30`)

## Generated Files

Per workspace, the toolkit writes:

- `.notion/intake/<page>-<slug>-<timestamp>.prompt.md`
- `.notion/intake/<page>-<slug>-<timestamp>.context.json`
- `.notion/intake/assets/<page-id>/*` (downloaded ticket attachments when enabled)
- `.notion/handoffs/<branch-flat>.agent-handoff.md`
- `notion-handoff.md` (stable alias that always points to the latest handoff)
- `.notion/runtime.json`
- `.notion/bridge-state.json`
- `.notion/worktree-map.json` and `.notion/active-tickets.md` (when worktree mode is enabled)

When `NOTION_CLEANUP_ON_STATUS=true`, bridge automatically removes a ticket's intake files/assets when status becomes `NOTION_CLEANUP_STATUS` (default: `Fix Deployed Dev`).

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
scripts/notion-mcp-handoff.sh --ticket "<url-or-id>" --model composer-2.5
```

Minimum requirements for this mode:

- `cursor-agent` CLI installed and available on PATH (or pass `--agent-bin`).
- Notion MCP server installed in Cursor and authenticated.
- A Notion page URL or page ID.
- Write access to the target workspace for `notion-handoff.md`.

## Model selection (token cost)

Most toolkit commands talk directly to Notion or GitLab APIs and do **not** use LLM tokens (`notion-auto done`, `reply-latest`, polling bridge, intake fetch).

LLM tokens are spent when **cursor-agent** runs (intake dispatch, MCP handoff) and in your **IDE Agent chat** while working the ticket.

Configure a cheap model for script-driven agent calls in `.notion.local`:

```bash
# Default for intake dispatch (--model injected into NOTION_AGENT_COMMAND)
NOTION_AGENT_MODEL="composer-2.5"
# Optional override for notion-mcp-handoff.sh only
# NOTION_MCP_HANDOFF_MODEL="auto"
```

Set `NOTION_AGENT_MODEL=inherit` to skip injection and use the cursor-agent session default.

For in-chat work, keep your premium model for implementation. Copy `scripts/notion-ticket-agent-rules.md` to `.notion/agent-rules.md` — it instructs the agent to delegate Notion MCP and GitLab status checks to a cheap subagent (`composer-2.5` or `auto`).

## Notes About Notion Triggering

- This project uses **database polling** (`NOTION_DATABASE_ID`) instead of Monday-style webhook + tunnel orchestration.
- For Notion databases with multiple data sources, set `NOTION_DATA_SOURCE_ID` and `NOTION_API_VERSION="2025-09-03"` in `.notion.local`.
- Polling only evaluates pages with matching `NOTION_TRIGGER_STATUS`.
- Optional filters are supported via assignee IDs and routing key properties.
- No Notion-side webhook is required for the default flow.
- Optional multi-ticket mode via git worktrees: set `NOTION_AGENT_WORKTREE_MODE=true`.
- In worktree mode, cleanup on `NOTION_CLEANUP_STATUS` also updates `.notion/worktree-map.json` and `.notion/active-tickets.md`, and can auto-remove worktrees (`NOTION_AGENT_WORKTREE_AUTO_REMOVE_ON_CLEANUP=true`).

## Troubleshooting

See `SETUP_GUIDE.md` § Troubleshooting for common setup and runtime issues (status text mismatch, assignee filter, multi-data-source databases, GitLab token, etc.).
