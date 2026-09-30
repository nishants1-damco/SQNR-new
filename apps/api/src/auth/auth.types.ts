/** The authenticated caller, set on the request by JwtAuthGuard. */
export interface AuthUser {
  id: string;
  /** Refresh-token family the access token was issued for. */
  sessionId: string;
}

declare module "fastify" {
  interface FastifyRequest {
    user?: AuthUser;
  }
}

/** Where a session was started from; stored with the refresh token. */
export interface ClientInfo {
  ip: string | null;
  userAgent: string | null;
}
