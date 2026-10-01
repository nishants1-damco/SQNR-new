// Global request throttle (plan §11): a ceiling per signed-in user, and per
// IP on routes that need no token, so one client can't take a replica's
// capacity from everyone else. Runs after JwtAuthGuard, so `request.user` is
// set on authenticated routes. Health probes and the JWKS are exempt.
//
// Unlike the auth limits and the quotas, this fails open: an outage of the
// cache Redis shouldn't take the whole API down with it.
import { appMetrics } from "@spatial/observability";
import {
  type CanActivate,
  type ExecutionContext,
  Inject,
  Injectable,
  Logger,
} from "@nestjs/common";
import type { ApiConfig } from "@spatial/config";
import type { FastifyRequest } from "fastify";
import { ApiError } from "../common/api-error";
import { RateLimiter } from "../common/rate-limiter";
import { API_CONFIG } from "../config/config.module";

const MINUTE = 60_000;
const EXEMPT = /^\/(health\/|\.well-known\/)/;

@Injectable()
export class RequestThrottleGuard implements CanActivate {
  private readonly logger = new Logger("RequestThrottle");

  constructor(
    @Inject(API_CONFIG) private readonly config: ApiConfig,
    private readonly limiter: RateLimiter,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<FastifyRequest>();
    if (EXEMPT.test(request.url)) return true;
    const { userPerMinute, ipPerMinute } = this.config.limits.throttle;
    const [key, max] = request.user
      ? [`throttle:user:${request.user.id}`, userPerMinute]
      : [`throttle:ip:${request.ip}`, ipPerMinute];
    if (max <= 0) return true;

    let decision;
    try {
      decision = await this.limiter.hit(key, { max, windowMs: MINUTE });
    } catch (err) {
      this.logger.warn({ err }, "request throttle unavailable; letting the request through");
      return true;
    }
    if (!decision.allowed) {
      appMetrics().quotaRejections.add(1, {
        kind: "throttle",
        bucket: request.user ? "user" : "ip",
      });
      throw ApiError.rateLimited(Math.max(1, Math.ceil(decision.retryAfterMs / 1000)));
    }
    return true;
  }
}
