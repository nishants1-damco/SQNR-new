// Every API route, classified by who may call it (migration plan §10.3). The
// tenant-isolation suite fails if a route is missing from here, so a new
// endpoint can't ship without a decision about its access rules.
import { expect } from "vitest";
import { createScan, issueUpload, putFile, uploadFrames, type User } from "./helpers/spaces";

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

/**
 * Need a token and only ever act on, or return, the caller's own data: no
 * resource id in the path. The suite checks the list endpoints don't leak.
 */
export const SELF_SCOPED_ROUTES = [
  "GET /v1/me",
  "DELETE /v1/me",
  "POST /v1/auth/verify-email/resend",
  "GET /v1/scans",
  "POST /v1/scans",
  "POST /v1/scans/photo-urls",
  "GET /v1/geocode",
  "POST /v1/consents",
  "GET /v1/flags",
] as const;

/**
 * Need a token and address another resource by id. Each case creates a
 * resource as its owner, then the suite checks that a different user gets
 * 404 (never 403: existence isn't revealed) and the owner still succeeds.
 */
export interface TenantScopedRoute {
  route: `${"GET" | "POST" | "PATCH" | "PUT" | "DELETE"} /v1/${string}`;
  /** Creates what the route addresses, as `owner`; returns the concrete URL and body. */
  setup(owner: User): Promise<{ url: string; body?: unknown }>;
  /** Status the owner gets for the same request. */
  ownerStatus: number;
}

const frame = { kind: "frame", contentType: "image/jpeg", sizeBytes: 12 };

export const TENANT_SCOPED_ROUTES: TenantScopedRoute[] = [
  {
    route: "GET /v1/scans/:id",
    setup: async (owner) => ({ url: `/v1/scans/${(await createScan(owner)).id}` }),
    ownerStatus: 200,
  },
  {
    route: "PATCH /v1/scans/:id",
    setup: async (owner) => ({
      url: `/v1/scans/${(await createScan(owner)).id}`,
      body: { name: "Renamed" },
    }),
    ownerStatus: 200,
  },
  {
    route: "DELETE /v1/scans/:id",
    setup: async (owner) => ({ url: `/v1/scans/${(await createScan(owner)).id}` }),
    ownerStatus: 204,
  },
  {
    route: "DELETE /v1/scans/:id/photos/:photoId",
    setup: async (owner) => {
      const scan = await createScan(owner);
      const { complete } = await uploadFrames(owner, scan.id, [{}]);
      return { url: `/v1/scans/${scan.id}/photos/${complete.body.photos[0]!.id}` };
    },
    ownerStatus: 204,
  },
  {
    route: "POST /v1/scans/:id/uploads",
    setup: async (owner) => ({
      url: `/v1/scans/${(await createScan(owner)).id}/uploads`,
      body: { files: [frame] },
    }),
    ownerStatus: 201,
  },
  {
    route: "POST /v1/scans/:id/uploads/:sessionId/complete",
    setup: async (owner) => {
      const scan = await createScan(owner);
      const issued = await issueUpload(owner, scan.id, [frame]);
      expect(await putFile(issued.body.files[0]!)).toBe(201);
      return {
        url: `/v1/scans/${scan.id}/uploads/${issued.body.sessionId}/complete`,
        body: { frames: [{ fileIndex: 0, headingDeg: 0 }] },
      };
    },
    ownerStatus: 200,
  },
  {
    route: "GET /v1/scans/:id/export",
    setup: async (owner) => ({ url: `/v1/scans/${(await createScan(owner)).id}/export` }),
    ownerStatus: 200,
  },
  {
    route: "POST /v1/scans/:id/address",
    setup: async (owner) => ({
      url: `/v1/scans/${(await createScan(owner)).id}/address`,
      body: { lat: 51.5, lon: -0.12 },
    }),
    ownerStatus: 200,
  },
  {
    route: "POST /v1/scans/:id/analysis",
    setup: async (owner) => {
      const scan = await createScan(owner);
      await uploadFrames(owner, scan.id, [{}]);
      return { url: `/v1/scans/${scan.id}/analysis`, body: {} };
    },
    ownerStatus: 202,
  },
  {
    route: "GET /v1/scans/:id/analysis",
    setup: async (owner) => ({ url: `/v1/scans/${(await createScan(owner)).id}/analysis` }),
    ownerStatus: 200,
  },
  {
    // A scan that isn't processing: the stream sends its snapshot and ends.
    route: "GET /v1/scans/:id/analysis/events",
    setup: async (owner) => ({
      url: `/v1/scans/${(await createScan(owner)).id}/analysis/events`,
    }),
    ownerStatus: 200,
  },
  {
    route: "POST /v1/scans/:id/privacy-purge",
    setup: async (owner) => ({ url: `/v1/scans/${(await createScan(owner)).id}/privacy-purge` }),
    ownerStatus: 202,
  },
];
