import { Body, Controller, Get, HttpCode, Param, Post, Req, Res } from "@nestjs/common";
import { ApiBearerAuth, ApiProduces, ApiTags } from "@nestjs/swagger";
import {
  AnalysisStatusResponseSchema,
  PrivacyPurgeResponseSchema,
  StartAnalysisRequestSchema,
  StartAnalysisResponseSchema,
} from "@spatial/contracts";
import type { FastifyReply, FastifyRequest } from "fastify";
import { createZodDto, ZodResponse } from "nestjs-zod";
import type { AuthUser } from "../auth/auth.types";
import { CurrentUser } from "../auth/current-user.decorator";
import { ApiError } from "../common/api-error";
import { ScanParamsDto } from "../scans/scans.dto";
import { AnalysisEventsHub } from "./analysis-events";
import { AnalysisService } from "./analysis.service";

class StartAnalysisDto extends createZodDto(StartAnalysisRequestSchema) {}
class StartAnalysisResponseDto extends createZodDto(StartAnalysisResponseSchema) {}
class AnalysisStatusResponseDto extends createZodDto(AnalysisStatusResponseSchema) {}
class PrivacyPurgeResponseDto extends createZodDto(PrivacyPurgeResponseSchema) {}

/** Keeps proxies and load balancers from closing an idle stream (plan §9.6). */
const HEARTBEAT_MS = 15_000;
/** Streams are reopened by the client after this, so no connection lives forever. */
const MAX_STREAM_MS = 60 * 60 * 1000;
const FINAL_STAGES = new Set(["done", "failed"]);

@ApiTags("analysis")
@ApiBearerAuth()
@Controller("scans")
export class AnalysisController {
  constructor(
    private readonly analysis: AnalysisService,
    private readonly events: AnalysisEventsHub,
  ) {}

  /**
   * 202 with the queued run; 200 when a run is already in progress or the
   * capture id belongs to another space. Replaces the `analyzeScan` call that
   * held the request open for the whole run.
   */
  @Post(":id/analysis")
  @ZodResponse({ status: 202, type: StartAnalysisResponseDto })
  async start(
    @CurrentUser() user: AuthUser,
    @Param() params: ScanParamsDto,
    @Body() body: StartAnalysisDto,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const result = await this.analysis.start(user.id, params.id, body);
    void reply.status(result.status);
    return result.body;
  }

  /** The polling fallback for the event stream. */
  @Get(":id/analysis")
  @ZodResponse({ status: 200, type: AnalysisStatusResponseDto })
  status(@CurrentUser() user: AuthUser, @Param() params: ScanParamsDto) {
    return this.analysis.status(user.id, params.id);
  }

  /**
   * Server-sent events: one `status` snapshot, then the worker's progress as
   * it happens, ending after `done` or `failed`. Browsers' EventSource can't
   * send the Authorization header, so the web client reads this with fetch.
   */
  @Get(":id/analysis/events")
  @ApiProduces("text/event-stream")
  async stream(
    @CurrentUser() user: AuthUser,
    @Param() params: ScanParamsDto,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ) {
    // Ownership first: a stream is never opened for someone else's scan.
    await this.analysis.status(user.id, params.id);
    if (!this.events.tryOpenStream()) {
      throw ApiError.unavailable("Too many open event streams. Poll the status instead.");
    }

    let closed = false;
    const timers: NodeJS.Timeout[] = [];
    let unsubscribe: (() => Promise<void>) | null = null;
    const raw = reply.raw;
    const close = () => {
      if (closed) return;
      closed = true;
      timers.forEach(clearTimeout);
      this.events.closeStream();
      void unsubscribe?.();
      raw.end();
    };
    const send = (event: string | null, data: unknown) => {
      if (closed) return;
      raw.write(`${event ? `event: ${event}\n` : ""}data: ${JSON.stringify(data)}\n\n`);
    };

    try {
      // Subscribe before reading the snapshot, so no event falls in between.
      unsubscribe = await this.events.listen(params.id, (message) => {
        let parsed: { stage?: string } | null = null;
        try {
          parsed = JSON.parse(message) as { stage?: string };
        } catch {
          return;
        }
        send("progress", parsed);
        if (parsed?.stage && FINAL_STAGES.has(parsed.stage)) close();
      });
      const snapshot = await this.analysis.status(user.id, params.id);

      reply.hijack();
      raw.writeHead(200, {
        // CORS and request-id headers set by the hooks before the handler.
        ...(reply.getHeaders() as Record<string, string>),
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "x-accel-buffering": "no",
      });
      request.raw.on("close", close);
      send("status", snapshot);
      if (snapshot.scanStatus !== "processing") {
        close();
        return;
      }
      const heartbeat = setInterval(() => !closed && raw.write(": ping\n\n"), HEARTBEAT_MS);
      timers.push(heartbeat, setTimeout(close, MAX_STREAM_MS));
    } catch (err) {
      if (!reply.sent) {
        this.events.closeStream();
        await unsubscribe?.();
        throw err;
      }
      close();
    }
  }

  /** Queues a re-screen of every frame for people; matches are deleted. */
  @Post(":id/privacy-purge")
  @HttpCode(202)
  @ZodResponse({ status: 202, type: PrivacyPurgeResponseDto })
  purge(@CurrentUser() user: AuthUser, @Param() params: ScanParamsDto) {
    return this.analysis.requestPrivacyPurge(user.id, params.id);
  }
}
