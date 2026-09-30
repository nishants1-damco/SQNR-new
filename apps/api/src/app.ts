// Builds the configured Nest application (plan §7.1). Shared by main.ts and
// the integration tests, so tests exercise the real HTTP stack.
import type { IncomingMessage } from "node:http";
import fastifyCookie from "@fastify/cookie";
import fastifyHelmet from "@fastify/helmet";
import { VersioningType } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import type { ApiConfig } from "@spatial/config";
import { Logger } from "nestjs-pino";
import { cleanupOpenApiDoc } from "nestjs-zod";
import { AppModule, requestIdFor } from "./app.module";
import { REFRESH_COOKIE } from "./auth/auth.controller";

/** JSON bodies stay small: images never pass through the API (plan §5.2). */
const BODY_LIMIT_BYTES = 1024 * 1024;

export async function createApp(config: ApiConfig): Promise<NestFastifyApplication> {
  const adapter = new FastifyAdapter({
    trustProxy: config.trustProxy,
    bodyLimit: BODY_LIMIT_BYTES,
    genReqId: (req: IncomingMessage) => {
      const id = requestIdFor(req);
      (req as IncomingMessage & { requestId?: string }).requestId = id;
      return id;
    },
  });
  const app = await NestFactory.create<NestFastifyApplication>(AppModule.forRoot(config), adapter, {
    bufferLogs: true,
  });
  app.useLogger(app.get(Logger));

  const fastify = app.getHttpAdapter().getInstance();
  fastify.addHook("onRequest", async (request, reply) => {
    void reply.header("x-request-id", request.id);
  });

  // The API serves JSON; the default CSP would break the Swagger UI outside production.
  await app.register(
    fastifyHelmet,
    config.env === "production" ? {} : { contentSecurityPolicy: false },
  );
  await app.register(fastifyCookie);
  app.enableCors({
    origin: config.web.origins,
    credentials: true,
    methods: ["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["authorization", "content-type", "idempotency-key", "x-request-id"],
    exposedHeaders: ["x-request-id", "retry-after"],
    maxAge: 600,
  });
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: "1" });

  if (config.env !== "production") setupOpenApi(app);
  return app;
}

function setupOpenApi(app: NestFastifyApplication) {
  const document = SwaggerModule.createDocument(
    app,
    new DocumentBuilder()
      .setTitle("Spatial Capture API")
      .setDescription("See docs/architecture/scaling-migration-plan.md §7.3 for the endpoint plan.")
      .setVersion("1")
      .addBearerAuth()
      .addCookieAuth(REFRESH_COOKIE)
      .build(),
  );
  SwaggerModule.setup("docs", app, cleanupOpenApiDoc(document), {
    jsonDocumentUrl: "openapi.json",
  });
}
