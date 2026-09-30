-- Identity: users replace Supabase's auth.users (migration plan §8.2, §10).
--
-- Extensions are provisioned by infrastructure, not migrations: locally by
-- infra/docker/postgres/initdb/10-extensions.sql, in Azure by the IaC that
-- allow-lists them. The migrator role cannot create PostGIS or pgvector.
DO $$
DECLARE
  missing text;
BEGIN
  SELECT string_agg(ext, ', ') INTO missing
  FROM unnest(ARRAY['postgis', 'vector', 'citext', 'pg_trgm']) AS ext
  WHERE NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = ext);
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'Missing extensions: %. Create them as a superuser before migrating (see infra/docker/postgres/initdb/10-extensions.sql).', missing;
  END IF;
END $$;

CREATE FUNCTION public.set_updated_at() RETURNS trigger
LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE TABLE public.users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email citext NOT NULL UNIQUE,
  -- Argon2id. Accounts imported from Supabase keep their bcrypt hash until
  -- their next sign-in re-hashes it. NULL means the account has no password
  -- (imported accounts that only ever used Google sign-in).
  password_hash text,
  email_verified_at timestamptz,
  last_sign_in_at timestamptz,
  disabled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER users_updated_at BEFORE UPDATE ON public.users
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- Same shape as the Supabase table; created in the sign-up transaction instead
-- of by a trigger on auth.users.
CREATE TABLE public.profiles (
  id uuid PRIMARY KEY REFERENCES public.users (id) ON DELETE CASCADE,
  display_name text,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Opaque refresh tokens, stored as SHA-256 hex. Rotated on every use; a token
-- presented after it was rotated revokes its whole family (theft detection).
CREATE TABLE public.auth_refresh_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.users (id) ON DELETE CASCADE,
  family_id uuid NOT NULL,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  replaced_by uuid REFERENCES public.auth_refresh_tokens (id) ON DELETE SET NULL,
  user_agent text,
  ip inet,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX auth_refresh_tokens_family_idx ON public.auth_refresh_tokens (family_id);
CREATE INDEX auth_refresh_tokens_user_idx ON public.auth_refresh_tokens (user_id);
CREATE INDEX auth_refresh_tokens_expires_idx ON public.auth_refresh_tokens (expires_at);
CREATE INDEX auth_refresh_tokens_replaced_by_idx ON public.auth_refresh_tokens (replaced_by);

-- Single-use tokens from emailed links, stored as SHA-256 hex.
CREATE TABLE public.auth_email_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.users (id) ON DELETE CASCADE,
  purpose text NOT NULL CHECK (purpose IN ('verify_email', 'reset_password')),
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX auth_email_tokens_user_purpose_idx ON public.auth_email_tokens (user_id, purpose);
CREATE INDEX auth_email_tokens_expires_idx ON public.auth_email_tokens (expires_at);
