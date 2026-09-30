// Every API route, classified by who may call it (migration plan §10.3). The
// tenant-isolation suite fails if a route is missing from here, so a new
// endpoint can't ship without a decision about its access rules.
import type { Client } from "./helpers/test-app";

/** Callable without a token. Keep this list short and deliberate. */
export const PUBLIC_ROUTES = [
  "GET /health/live",
  "GET /health/ready",
  "GET /.well-known/jwks.json",
  "POST /v1/auth/sign-up",
  "POST /v1/auth/sign-in",
  "POST /v1/auth/refresh",
  "POST /v1/auth/sign-out",
  "POST /v1/auth/verify-email",
  "POST /v1/auth/password-reset",
  "POST /v1/auth/password-reset/confirm",
] as const;

/** Need a token, and only ever act on the caller's own account (no resource ids). */
export const SELF_SCOPED_ROUTES = ["GET /v1/me", "POST /v1/auth/verify-email/resend"] as const;

/**
 * Need a token and address another resource by id. Each case creates a
 * resource as its owner, then the suite checks that a different user gets
 * 404 (never 403: existence isn't revealed) and the owner still succeeds.
 */
export interface TenantScopedRoute {
  route: `${"GET" | "POST" | "PATCH" | "PUT" | "DELETE"} /v1/${string}`;
  /** Creates what the route addresses, as `owner`; returns the concrete URL and body. */
  setup(owner: { client: Client; token: string }): Promise<{ url: string; body?: unknown }>;
  /** Status the owner gets for the same request. */
  ownerStatus: number;
}

// Phase 2 adds the scans, uploads and exports routes here.
export const TENANT_SCOPED_ROUTES: TenantScopedRoute[] = [];
