-- Phase 5: the global daily AI spend check (plan §9.7.6) sums the last 24
-- hours of runs across all users.
CREATE INDEX scan_analyses_started_idx ON public.scan_analyses (started_at);
