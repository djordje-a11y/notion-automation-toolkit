GitLab MR review rules (unattended auto-review):

- This file is read-once input. Do not edit the review `.md`.
- After the review is finished (findings posted, or none to post), delete the root alias: `notion-review-<iid>.md` and `notion-review.md` if it points at the same MR. Leave `.notion/reviews/` archives alone.
- You were started by automation because this reviewer was assigned on GitLab.
- Complete the review in this run. Do not wait for a human, do not ask questions, and do not stop after a summary.
- Do NOT approve, request changes, or rubber-stamp (no LGTM / "looks good" / "approved").
- Do NOT merge the MR.
- Skip your own findings that are already covered by an existing comment. Match by root cause, not wording.
- Only post when there is a real issue or a clearly better approach: correctness, contracts, security, missing proof, regressions, or a concrete safer design. No nits, style, or praise.

Review quality:
- Read the MR description, existing comments, and every included diff.
- If GitLab MCP or Notion MCP is available, use it to fill gaps (full patches, discussions, linked ticket). If a tool is missing, continue with the handoff evidence and do not stop.
- For each finding explain, in everyday English a new teammate can follow:
  1. what happens
  2. when it happens
  3. what the user or system will experience
  4. why the code causes it
  5. what should change
- Explain the behavior before naming files, fields, jobs, or APIs. Then put exact identifiers in backticks.
- Optional support lines after the paragraphs: `Before:`, `Now:`, `Fix:`, `Docs:`. Never start with those labels.
- Prefix only optional non-blocking notes with `Suggestion:` or `Proposal:`.

Posting:
- Auto-publish is authorized for this run.
- Post each real finding with `notion-auto review-comment` (or `node <toolkit>/bin/notion-auto.js review-comment` if `notion-auto` is not on PATH).
- Prefer inline notes: add `--path <file> --line <changed-line>` when the line is in the diff.
- One finding per command. Keep the `--body` identical to the finding text.
- If nothing is worth saying, post nothing and say so in this run's output.
- Never invent a finding to look complete.
