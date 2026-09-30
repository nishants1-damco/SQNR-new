// Global guard: every route needs a valid access token unless marked @Public().
import { type CanActivate, type ExecutionContext, Injectable } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { FastifyRequest } from "fastify";
import { ApiError } from "../common/api-error";
import { IS_PUBLIC } from "./public.decorator";
import { InvalidAccessToken, TokensService } from "./tokens.service";

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tokens: TokensService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest<FastifyRequest>();
    const header = request.headers.authorization;
    const match = header?.match(/^Bearer ([A-Za-z0-9._-]+)$/);
    if (!match?.[1]) throw ApiError.unauthorized();

    try {
      request.user = await this.tokens.verifyAccessToken(match[1]);
    } catch (err) {
      if (err instanceof InvalidAccessToken) {
        throw ApiError.unauthorized("Your session has expired. Sign in again.");
      }
      throw err;
    }
    return true;
  }
}
