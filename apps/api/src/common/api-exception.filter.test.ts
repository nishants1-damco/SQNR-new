import type { ArgumentsHost } from "@nestjs/common";
import { InternalServerErrorException, NotFoundException } from "@nestjs/common";
import type { PinoLogger } from "nestjs-pino";
import { describe, expect, it, vi } from "vitest";
import { ApiError } from "./api-error";
import { ApiExceptionFilter } from "./api-exception.filter";

function run(exception: unknown) {
  const logger = { error: vi.fn() };
  const reply = {
    statusCode: 0,
    body: undefined as unknown,
    headers: {} as Record<string, string>,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    header(name: string, value: string) {
      this.headers[name] = value;
      return this;
    },
    send(body: unknown) {
      this.body = body;
      return this;
    },
  };
  const request = { id: "req-1", method: "GET", url: "/v1/thing?x=1" };
  const host = {
    switchToHttp: () => ({ getResponse: () => reply, getRequest: () => request }),
  } as unknown as ArgumentsHost;
  new ApiExceptionFilter(logger as unknown as PinoLogger).catch(exception, host);
  return { reply, logger };
}

describe("ApiExceptionFilter", () => {
  it("renders ApiError as the envelope, with Retry-After when rate limited", () => {
    const { reply, logger } = run(ApiError.rateLimited(42));
    expect(reply.statusCode).toBe(429);
    expect(reply.body).toEqual({
      code: "rate_limited",
      message: "Too many attempts. Try again in 42s.",
    });
    expect(reply.headers["retry-after"]).toBe("42");
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("maps Nest HTTP errors to stable codes without the query string", () => {
    const { reply } = run(new NotFoundException());
    expect(reply.statusCode).toBe(404);
    expect(reply.body).toEqual({ code: "not_found", message: "No route for GET /v1/thing" });
  });

  it("logs server errors with the request id and hides their details from the client", () => {
    const boom = new Error("database password is hunter2");
    for (const exception of [boom, new InternalServerErrorException("secret detail")]) {
      const { reply, logger } = run(exception);
      expect(reply.statusCode).toBe(500);
      expect(reply.body).toEqual({ code: "internal_error", message: "Something went wrong" });
      expect(logger.error).toHaveBeenCalledOnce();
      expect(logger.error.mock.calls[0]?.[0]).toMatchObject({ reqId: "req-1" });
    }
  });

  it("passes Fastify client errors (bad JSON, body too large) through as invalid_request", () => {
    const tooLarge = Object.assign(new Error("Request body is too large"), { statusCode: 413 });
    const { reply, logger } = run(tooLarge);
    expect(reply.statusCode).toBe(413);
    expect(reply.body).toEqual({ code: "invalid_request", message: "Request body is too large" });
    expect(logger.error).not.toHaveBeenCalled();
  });
});
