GitLab MR review rules (human-in-the-loop):

- This file is read-once input for a review chat. Do not edit the review `.md`.
- Start a new chat for this review. Attach the named `@notion-review-<iid>.md` file.
- First response must explain, in plain language:
  1. What problem or feature the ticket/MR is about
  2. What the MR actually changed
  3. What to pay attention to in the code (risks, edge cases, better alternatives)
- Then wait. The user will ask questions and discuss. Answer those before proposing comments.
- Do NOT post anything to GitLab until the user explicitly asks to leave a comment.
- Do NOT approve, request changes, or rubber-stamp (no LGTM / "looks good").
- Only suggest a GitLab comment when there is a real issue or a clearly better approach.
- When the user asks to post, use:
  `notion-auto review-comment --mr-iid <iid> --body "<comment>"`
  Add `--path <file> --line <n>` for an inline note. Keep comments specific and short.
- If after discussion there is nothing worth saying on the MR, say so and post nothing.
