// Renders every error as the standard envelope (plan §7.3), so clients branch
// on a stable `code`. Unexpected errors are logged with the request id and
// reach the client only as a generic internal_error.
import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  HttpStatus,
} from "@nestjs/common";
import type { ErrorCode, ErrorEnvelope } from "@spatial/contracts";
import type { FastifyReply, FastifyRequest } from "fastify";
import { InjectPinoLogger, PinoLogger } from "nestjs-pino";
import { ZodSerializationException, ZodValidationException } from "nestjs-zod";
import type { ZodError } from "zod";
import { ApiError } from "./api-error";

const STATUS_CODES: Partial<Record<number, ErrorCode>> = {
  400: "invalid_request",
  401: "unauthorized",
  403: "unauthorized",
  404: "not_found",
  413: "invalid_request",
  415: "invalid_request",
  429: "rate_limited",
  503: "service_unavailable",
};

@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  // pino directly (not Nest's Logger bridge): server errors must never be lost.
  constructor(@InjectPinoLogger(ApiExceptionFilter.name) private readonly logger: PinoLogger) {}

  catch(exception: unknown, host: ArgumentsHost) {
    const http = host.switchToHttp();
    const reply = http.getResponse<FastifyReply>();
    const request = http.getRequest<FastifyRequest>();

    const { status, body, retryAfter } = this.toResponse(exception, request);
    if (retryAfter) void reply.header("retry-after", String(retryAfter));
    void reply.status(status).send(body);
  }

  private toResponse(
    exception: unknown,
    request: FastifyRequest,
  ): { status: number; body: ErrorEnvelope; retryAfter?: number } {
    if (exception instanceof ApiError) {
      return {
        status: exception.status,
        body: {
          code: exception.code,
          message: exception.message,
          ...(exception.details === undefined ? {} : { details: exception.details }),
        },
        ...(exception.retryAfterSeconds ? { retryAfter: exception.retryAfterSeconds } : {}),
      };
    }

    if (exception instanceof ZodValidationException) {
      const error = exception.getZodError() as ZodError;
      return {
        status: 400,
        body: {
          code: "invalid_request",
          message: "The request is invalid",
          details: error.issues.map((issue) => ({
            path: issue.path.join("."),
            message: issue.message,
          })),
        },
      };
    }

    if (exception instanceof ZodSerializationException) {
      this.logger.error({ err: exception, reqId: request.id }, "response failed its schema");
      return internal();
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      if (status >= 500) {
        this.logger.error(
          { err: exception, cause: exception.cause, reqId: request.id },
          "server error",
        );
        return internal();
      }
      const code = STATUS_CODES[status] ?? (status >= 500 ? "internal_error" : "invalid_request");
      const message =
        status === HttpStatus.NOT_FOUND
          ? `No route for ${request.method} ${request.url.split("?")[0]}`
          : exception.message;
      return { status, body: { code, message } };
    }

    // Fastify's own errors (bad JSON, body too large, unsupported media type).
    const fastifyStatus = (exception as { statusCode?: unknown })?.statusCode;
    if (typeof fastifyStatus === "number" && fastifyStatus >= 400 && fastifyStatus < 500) {
      return {
        status: fastifyStatus,
        body: {
          code: STATUS_CODES[fastifyStatus] ?? "invalid_request",
          message: (exception as Error).message,
        },
      };
    }

    this.logger.error({ err: exception, reqId: request.id }, "unhandled error");
    return internal();
  }
}

function internal() {
  return {
    status: 500,
    body: { code: "internal_error" as const, message: "Something went wrong" },
  };
}
