// Prompt provenance: written to `scans.prompt_version` and
// `scan_analyses.prompt_version` on every run (the API stamps it when it
// queues a run, the worker when it finishes). Bump it whenever the prompt
// text in packages/pipeline/prompts changes in a way that could affect
// output quality, so metrics can be sliced per prompt revision.
export const PROMPT_VERSION = "recon-v6";
