# Notion Automation Toolkit TODO

## Next Major Automation: GitLab MR + Notion Status Sync

### Goal

When implementation is complete, reduce final manual steps by automating:

1. local push + MR creation to `dev`
2. Notion status update to `Pushed to dev` only after merge to `dev`
3. existing cleanup flow (worktree + temp artifacts) via status transition

### Proposed UX

- In agent chat, user says a keyword such as `task done`.
- Toolkit performs:
  - validate working tree state
  - push branch (`git push -u origin HEAD` when needed)
  - create merge request targeting `dev`
  - post MR link back into Notion ticket comments

Then, after merge:

- GitLab webhook (or scheduled poll fallback) detects merge to `dev`
- Toolkit updates Notion ticket status to `Pushed to dev`
- Existing cleanup automation removes safe worktrees and temporary intake assets

### Implementation Tasks

- [ ] Define explicit completion trigger contract (`task done` keywords + guardrails)
- [ ] Add GitLab integration config:
  - [ ] `GITLAB_TOKEN`
  - [ ] `GITLAB_PROJECT_ID`
  - [ ] `GITLAB_TARGET_BRANCH` (default `dev`)
  - [ ] optional webhook secret
- [ ] Add command to perform done-flow:
  - [ ] ensure branch is clean and commit state is valid
  - [ ] push current branch (`-u` when branch has no upstream)
  - [ ] open MR to `dev`
  - [ ] enable GitLab "Set to auto-merge when pipeline succeeds" on created MR
  - [ ] write MR URL to Notion comment
- [ ] Add merge detection:
  - [ ] webhook endpoint handler or polling bridge extension
  - [ ] verify MR merged to `dev`
  - [ ] map MR -> Notion ticket page id
- [ ] Add Notion status sync on merge:
  - [ ] set status to `Pushed to dev`
  - [ ] optional comment "Merged to dev: <MR URL>"
- [ ] Ensure idempotency and safe retries across:
  - [ ] duplicate trigger phrases
  - [ ] duplicate webhooks
  - [ ] partial failures (push ok / MR fail / Notion fail)
- [ ] Update docs with operator setup and troubleshooting

### Auto-Merge Conflict Recovery

When `notion-auto done` enables auto-merge but it fails due to merge conflicts:

- [ ] Detect conflict failure in `notion-auto done` output
- [ ] Instruct the agent to resolve the conflict (rebase/merge onto target branch) and push
- [ ] Automatically re-run `notion-auto done` after conflict resolution to retry auto-merge
- [ ] Add agent rule: on auto-merge conflict, resolve and retry without user intervention

### Post MR Link to Notion

After MR is created or reused by `notion-auto done`:

- [ ] Resolve the Notion page ID from the current worktree (via worktree-map.json)
- [ ] Post a comment on the Notion ticket with the MR URL (e.g. "MR opened: <url>")
- [ ] Skip if a comment with the same MR URL already exists (idempotency)

### Open Decisions

- [ ] Prefer webhook-first or poll-first for GitLab merge detection
- [ ] Final keyword(s): `task done`, `done`, or explicit command only
- [ ] Whether MR title/description is generated from handoff metadata
- [ ] Whether to auto-request reviewers/labels

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

