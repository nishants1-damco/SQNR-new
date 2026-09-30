-- Direct-to-Blob uploads and the transactional outbox (migration plan §5.2,
-- §7.4, §12.3). Additive only.

-- One batch of signed upload URLs. Completion accepts only the keys recorded
-- here, so a client can't attach blobs the API never signed for it.
CREATE TABLE public.upload_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.users (id) ON DELETE CASCADE,
  scan_id uuid NOT NULL REFERENCES public.scans (id) ON DELETE CASCADE,
  -- [{ "index", "kind": "frame" | "depth", "key", "contentType", "maxBytes" }]
  files jsonb NOT NULL,
  expires_at timestamptz NOT NULL,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX upload_sessions_scan_idx ON public.upload_sessions (scan_id);
CREATE INDEX upload_sessions_user_idx ON public.upload_sessions (user_id);
-- The sweep for abandoned sessions only looks at open ones.
CREATE INDEX upload_sessions_open_idx ON public.upload_sessions (expires_at)
  WHERE completed_at IS NULL;

-- Side effects that must happen after a commit (delete blobs, process a new
-- frame) are written here in the same transaction as the change, then relayed
-- to the job queue by the worker. Nothing is lost if the process dies between
-- the commit and the enqueue, and nothing is enqueued for a rolled-back change.
CREATE TABLE public.outbox (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  topic text NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  dispatched_at timestamptz,
  attempts integer NOT NULL DEFAULT 0,
  last_error text
);
CREATE INDEX outbox_pending_idx ON public.outbox (id) WHERE dispatched_at IS NULL;

-- Written by the worker's media job: a small JPEG for lists, and when the
-- frame's bytes were checked (magic bytes, EXIF stripped).
ALTER TABLE public.scan_photos
  ADD COLUMN thumbnail_path text,
  ADD COLUMN media_checked_at timestamptz;
