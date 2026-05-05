Ticket intake rules:
- Investigate and explain likely root cause before proposing fixes.
- Do not propose security relaxations, access-widening shortcuts, or fake-success behavior.
- Keep implementation scope minimal and aligned with ticket intent.
- If behavior changes are required, call them out explicitly as approval-needed.
- Provide a deterministic validation plan: focused regression first, then confidence checks.
- Always propose a clear branch name based on task slug (no ticket id in branch name unless explicitly requested).
- After reading the handoff `.md` and confirming the prepared branch, rename the current chat to match the branch name without the configured prefix (example: `dev/notion/fix-login-timeout` -> `fix-login-timeout`).
- If ticket data is insufficient, list exact missing inputs needed to proceed.

Completion and handoff rules (mandatory when user asks to commit):
- Do not hardcode personal names/emails in shared rules or ticket comments.
- Use custom signing/author commit command only when user explicitly asks for it.
- If user does not explicitly request custom signing/author, use normal commit flow (`git commit -m "<message>"`).
- Write a meaningful commit message:
  - use `fix|feat|chore` style subject
  - state user-visible outcome and why
  - avoid vague messages like "update" or "changes"
- Staged-first closeout workflow:
  - User reviews and stages intended files, then tells agent that changes are staged.
  - On command `staged push` (or equivalent intent), agent must:
    1) verify staged diff is not empty
    2) commit staged changes only (do not auto-add unrelated files)
    3) push branch (`git push -u origin HEAD` if no upstream, else `git push origin HEAD`)
    4) post Notion update using toolkit command:
       `notion-auto reply-latest --workspace "$PWD" --page-id "<page-id>" --body-file "<reply-file.md>" --set-status "AI fix ready"`
