Ticket intake rules:
- Investigate and explain likely root cause before proposing fixes.
- Do not propose security relaxations, access-widening shortcuts, or fake-success behavior.
- Keep implementation scope minimal and aligned with ticket intent.
- If behavior changes are required, call them out explicitly as approval-needed.
- Provide a deterministic validation plan: focused regression first, then confidence checks.
- Always propose a clear branch name based on task slug (no ticket id in branch name unless explicitly requested).
- After reading the handoff `.md` and confirming the prepared branch, rename the current chat to match the branch name without the configured prefix (example: `dev/notion/fix-login-timeout` -> `fix-login-timeout`).
- If ticket data is insufficient, list exact missing inputs needed to proceed.

Sprint / backlog rules (mandatory):
- New tickets stay in backlog while the Sprint property is empty. Starting work means assigning the current Sprint so the item leaves backlog.
- Intake automation assigns Sprint on the triggered ticket and cascades the same Sprint to Sub-item pages when those are still empty.
- If you manually move a parent into a sprint, also set the same Sprint on all Sub-items (sub-tasks remain visible in backlog otherwise).
- Do not leave started work with an empty Sprint property.

Model usage (token cost control):
- Use your selected premium model ONLY for ticket understanding, solution design, code edits, and debugging.
- For auxiliary work, delegate to a fast/cheap subagent (model: composer-2.5 or auto):
  - Notion MCP reads, comment lookups, and status/property updates
  - Running `notion-auto reply-latest`, `notion-auto done`, or other toolkit CLI without code changes
  - GitLab MR/pipeline status checks (not merge-conflict resolution)
- Do NOT use premium thinking models for repetitive Notion/GitLab fetches.

Completion and handoff rules (mandatory when user asks to commit):
- Do not hardcode personal names/emails in shared rules or ticket comments.
- Use custom signing/author commit command only when user explicitly asks for it.
- If user does not explicitly request custom signing/author, use normal commit flow (`git commit -m "<message>"`).
- Write a meaningful commit message:
  - use `fix|feat|chore` style subject
  - state user-visible outcome and why
  - avoid vague messages like "update" or "changes"
  - `notion-auto done` / `notion-auto push` use these commit messages as the MR "Solution" section, plus Notion ticket context and link
- Staged-first closeout workflow:
  - User reviews and stages intended files, then tells agent that changes are staged.
  - On command `staged push` (or equivalent intent), agent must:
    1) verify staged diff is not empty
    2) commit staged changes only (do not auto-add unrelated files)
    3) push branch (`git push -u origin HEAD` if no upstream, else `git push origin HEAD`)
    4) post Notion update using toolkit command:
       `notion-auto done`
