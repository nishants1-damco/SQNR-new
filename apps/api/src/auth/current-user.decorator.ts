import { createParamDecorator, type ExecutionContext } from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import { ApiError } from "../common/api-error";
import type { AuthUser } from "./auth.types";

/** The authenticated caller. Only valid on routes behind JwtAuthGuard. */
export const CurrentUser = createParamDecorator(
  (_: unknown, context: ExecutionContext): AuthUser => {
    const user = context.switchToHttp().getRequest<FastifyRequest>().user;
    if (!user) throw ApiError.unauthorized();
    return user;
  },
);
