# Vision prompts

The VLM prompt text for the reconstruction pipeline lives here as plain
markdown, so prompt wording can be reviewed and diffed on its own.

Files are read once at startup by [`src/prompts.ts`](../src/prompts.ts) and
are plain text: no frontmatter, no templating. The package ships this folder
next to `dist/`. Where a prompt needs a JSON schema string (local models
only; Claude uses structured outputs), the concatenation happens in
[`src/passes.ts`](../src/passes.ts).

- `pass1-reconstruction.md` — system prompt for the first-pass shell/object/portal reconstruction.
- `pass2-critique.md` — system prompt for the audit/critique pass that corrects the draft.
- `object-inventory.md` — system prompt for the independent high-recall object pass.
- `landmarks.md` — system prompt for the landmark-sighting pass (fully self-contained, including its own JSON schema).
- `people-screener.md` — system prompt for the privacy screener that flags frames containing people.
- `object-inventory-merge.md` — system prompt for consolidating per-viewpoint detection batches.
- `object-verification.md` — system prompt for the zoom-in verification and catalog match.

There's a single `PROMPT_VERSION` string (in
[`@spatial/domain/prompt-version`](../../domain/src/prompt-version.ts)) that's persisted to
`scans.prompt_version` / `scan_analyses.prompt_version` for every analysis.
Bump it whenever any prompt in this directory changes meaningfully, so past
analyses stay attributable to the wording that produced them.
