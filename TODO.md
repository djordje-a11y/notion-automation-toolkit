# Notion Automation Toolkit TODO

## GitLab MR + Notion Status Sync

### Completed

- [x] GitLab integration config (`GITLAB_TOKEN`, `GITLAB_TARGET_BRANCH`, auto-inferred project path)
- [x] `notion-auto done` command: push, create/reuse MR, enable auto-merge
- [x] Auto-merge retry with delay when pipeline is not ready (4 retries, 10s apart)
- [x] Auto-merge failure is non-fatal (warns but doesn't halt)
- [x] OAuth2 Bearer + PAT (`glpat-`) token support
- [x] Merge detection via polling bridge (queries GitLab for merged MRs)
- [x] Notion status sync on merge (sets ticket to `Fix Deployed Dev`)
- [x] Cleanup flow triggers on status change (worktree removal, handoff/alias cleanup)
- [x] Filter cleanup-pending tickets from `tickets --checkout` list
- [x] Docs updated for done-flow, merge sync, and env config

### Pending

#### Post MR Link to Notion

After MR is created or reused by `notion-auto done`:

- [ ] Resolve the Notion page ID from the current worktree (via worktree-map.json)
- [ ] Post a comment on the Notion ticket with the MR URL (e.g. "MR opened: <url>")
- [ ] Skip if a comment with the same MR URL already exists (idempotency)

#### Auto-Merge Conflict Recovery

When `notion-auto done` enables auto-merge but it fails due to merge conflicts:

- [ ] Detect conflict failure in `notion-auto done` output
- [ ] Instruct the agent to resolve the conflict (rebase/merge onto target branch) and push
- [ ] Automatically re-run `notion-auto done` after conflict resolution to retry auto-merge
- [ ] Add agent rule: on auto-merge conflict, resolve and retry without user intervention

## Daily Activity Reporting (Slack)

### Goal

Run one command at end-of-day to collect all ticket work performed that day and publish a task-by-task summary to a dedicated Slack tracking channel.

### Implementation Tasks

- [ ] Define command, e.g. `notion-auto daily-report`
- [ ] Aggregate daily activity per ticket from:
  - [ ] active/closed worktree map entries
  - [ ] local git commits by date and branch
  - [ ] MR links/status (if available)
  - [ ] Notion ticket metadata (title, status, URL)
- [ ] Render concise per-task summary blocks:
  - [ ] ticket title/link
  - [ ] branch/MR
  - [ ] what was done today
  - [ ] current state/blockers
- [ ] Add Slack integration config:
  - [ ] Slack webhook URL or bot token
  - [ ] target channel id/name
- [ ] Post message to Slack channel with idempotency guard (avoid duplicate EOD posts)
- [ ] Add dry-run mode to preview report before sending

