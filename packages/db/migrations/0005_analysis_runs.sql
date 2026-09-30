-- Analysis as a queued, checkpointed job (migration plan §9.1, §9.4). Additive
-- apart from widening the scan_analyses status check.

-- A run now exists before a worker picks it up.
ALTER TABLE public.scan_analyses DROP CONSTRAINT scan_analyses_status_check;
ALTER TABLE public.scan_analyses ADD CONSTRAINT scan_analyses_status_check
  CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'timed_out'));

-- Job attempts that worked on this run (a retry resumes from checkpoints).
ALTER TABLE public.scan_analyses ADD COLUMN attempts integer NOT NULL DEFAULT 0;

-- At most one live run per scan: two concurrent submits can't both claim it.
CREATE UNIQUE INDEX scan_analyses_live_uniq ON public.scan_analyses (scan_id)
  WHERE status IN ('queued', 'running');

-- The output of each finished stage of a run. A retried job skips stages that
-- already have a row, so a worker replaced mid-run never pays for the same
-- model pass twice. Rows are removed when the run succeeds, and swept a week
-- after a run fails.
CREATE TABLE public.analysis_checkpoints (
  analysis_id uuid NOT NULL REFERENCES public.scan_analyses (id) ON DELETE CASCADE,
  stage text NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (analysis_id, stage)
);
