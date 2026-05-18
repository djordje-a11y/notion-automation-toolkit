# Notion Automation Toolkit: Owner Brief

## Why this exists

Development flow currently loses time on repeated, manual ticket handoff steps:

- copy/paste ticket title + description into chat
- re-attach screenshots/gifs manually
- prepare git branch repeatedly (`checkout acceptance`, `pull`, `create branch`, `checkout branch`)
- rewrite the same implementation instructions every ticket
- post-close updates back to Notion manually

This toolkit removes those repeated steps and turns ticket intake into a consistent, low-friction workflow.

---

## What this automates

When a Notion ticket matches trigger rules (status + assignee), the toolkit automatically:

1. Detects the ticket via polling bridge.
2. Fetches ticket details (title, body, comments, metadata).
3. Downloads ticket attachments (images/gifs/files) into local intake assets.
4. Prepares deterministic branch naming (feature/fix/chore rules by ticket type).
5. Optionally prepares/switches branch safely from configured base branch.
6. Generates:
   - branch-specific handoff file in `.notion/handoffs/`
   - named root aliases (`notion-handoff-<ticket-slug>.md`) for quick `@` attach per active ticket
   - stable alias `notion-handoff.md` for latest ticket compatibility
7. Applies standard agent rules to ensure consistent output and closeout behavior.
8. In multi-ticket mode, creates isolated git worktrees and tracks them under `.notion/worktree-map.json`.
9. Provides a ticket switching CLI (`notion-auto tickets --checkout`) for fast worktree selection.

At closeout, toolkit can also:

- post reply to latest Notion discussion
- set status (for example to `Fix Deployed Dev`) in one command

---

## Repeated steps removed

This toolkit directly reduces or removes these manual tasks per ticket:

- manual copy/paste of full ticket context
- manual extraction of comments/discussion context
- manual download/upload of screenshots/gifs
- manual branch naming decisions (especially feature vs fix consistency)
- manual handoff formatting for the coding agent
- manual Notion update + status transition at completion

---

## Compared to using Notion MCP server only

Notion MCP server is excellent for on-demand reads inside chat, but by itself it does not provide full workflow automation.

### MCP only

- Great for manual queries ("fetch this ticket", "search docs")
- Requires user to initiate every step
- No persistent poll/trigger loop by status
- No built-in branch prep, handoff file lifecycle, cleanup policies
- No local artifact strategy by default

### This toolkit

- Persistent local trigger flow (status/assignee based)
- Standardized handoff generation every time
- Attachment capture + local asset linking
- Branch strategy + git prep integration
- Local-only artifacts (excluded from repo by `.git/info/exclude`)
- Automatic cleanup when ticket reaches completion status (prevents asset buildup)
- Consistent closeout command back to Notion

Bottom line:

- MCP = powerful manual retrieval tool
- Toolkit = operational workflow automation layer

They are complementary, not conflicting.

---

## Delivery modes (flexible)

### 1) Full automation mode (recommended for team throughput)

Status change in Notion triggers full local flow automatically.

Best for:

- high ticket volume
- strict consistency
- minimal context-switching

### 2) Manual one-step mode

Use a single command to generate handoff from ticket URL/ID via MCP.

Best for:

- ad-hoc tickets
- partial rollout teams
- users not ready for always-on polling

Both modes generate the same handoff style and are compatible with the same coding workflow.

---

## Why this should be used in development

1. **Speed**
   - Cuts repeated preparation steps before coding starts.
2. **Consistency**
   - Every ticket enters development with a predictable structure.
3. **Quality**
   - Includes ticket body/comments/attachments; less context loss.
4. **Traceability**
   - Standard intake and closeout flow improves auditability.
5. **Lower cognitive load**
   - Developers focus on implementation, not ticket plumbing.
6. **Safer local operations**
   - Artifacts remain local by default and are not pushed to remote.

---

## Expected practical impact

For each ticket, this typically saves multiple minutes of mechanical prep and reduces avoidable mistakes:

- missing screenshot/gif context
- wrong branch naming or branch base
- partial ticket copy/paste
- forgotten Notion reply/status updates

Over sprint scale, this compounds into meaningful developer throughput gains and cleaner execution.

---

## Key safeguards

- Workspace-local runtime files under `.notion/`
- Local ignore entries enforced via `init` (`.notion/`, `.notion.local`, `notion-handoff.md`)
- Optional single-ticket mode to avoid parallel dispatch noise
- Dedupe and polling-state tracking
- Cleanup policy to remove stale intake assets after `Fix Deployed Dev`
- Worktree cleanup safety guard:
  - never auto-removes dirty worktrees
  - never auto-removes branches with unpushed commits
  - verifies push-state against the matching remote branch name
- Handoff safety guard:
  - handoff includes mandatory pre-edit branch/worktree verification instructions

---

## Current implementation highlights

- Status + assignee filtered polling bridge
- Multi-data-source Notion support (`NOTION_DATA_SOURCE_ID`)
- Ticket body extraction into handoff
- Attachment extraction and local download
- Branch prefix rules based on ticket `Type`
- Multi-ticket worktree isolation with per-ticket named handoff aliases
- Interactive worktree switching (`notion-auto tickets --checkout`) with optional `fzf` arrow-key picker
- Copy/paste path output mode (`notion-auto tickets --paths true`) for fast manual switching
- Stable + named handoff aliases for fast chat attach (`@notion-handoff*.md`)
- One-command closeout update + status transition

---

## Recommendation

Adopt this toolkit as the standard intake layer for development tickets.

Use full automation mode for daily flow, keep MCP one-step mode as fallback. This gives:

- operational reliability
- lower manual overhead
- consistent developer handoff quality
- faster path from ticket status change to active implementation

