import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { type ArgumentMetadata, type DynamicModule, Injectable, Module } from "@nestjs/common";
import { APP_FILTER, APP_INTERCEPTOR, APP_PIPE } from "@nestjs/core";
import type { ApiConfig } from "@spatial/config";
import { LoggerModule } from "nestjs-pino";
import { createZodValidationPipe, ZodSerializerInterceptor } from "nestjs-zod";
import { AuthModule } from "./auth/auth.module";
import { ApiExceptionFilter } from "./common/api-exception.filter";
import { ConfigModule } from "./config/config.module";
import { DatabaseModule } from "./database/database.module";
import { HealthModule } from "./health/health.module";
import { MailModule } from "./mail/mail.module";
import { QuotaModule } from "./quota/quota.service";
import { RedisModule } from "./redis/redis.module";
import { SpacesModule } from "./scans/spaces.module";
import { StorageModule } from "./storage/storage.module";

const StrictZodValidationPipe = createZodValidationPipe({ strictSchemaDeclaration: true });

/**
 * Every @Body/@Query/@Param must be a zod DTO, so no request input reaches a
 * handler unvalidated. Custom parameter decorators (@CurrentUser) carry
 * server-derived values, not client input, so they pass through untouched.
 */
@Injectable()
export class AppValidationPipe extends StrictZodValidationPipe {
  override transform(value: unknown, metadata: ArgumentMetadata) {
    return metadata.type === "custom" ? value : super.transform(value, metadata);
  }
}

/** Incoming `x-request-id` if it looks sane, else a new UUID (plan §16.1). */
export function requestIdFor(req: IncomingMessage): string {
  const incoming = req.headers["x-request-id"];
  return typeof incoming === "string" && /^[\w.-]{1,64}$/.test(incoming) ? incoming : randomUUID();
}

@Module({})
export class AppModule {
  static forRoot(config: ApiConfig): DynamicModule {
    return {
      module: AppModule,
      imports: [
        ConfigModule.forRoot(config),
        LoggerModule.forRoot({
          pinoHttp: {
            level: config.logLevel,
            // Same id as Fastify's request.id (set by the adapter's genReqId).
            genReqId: (req) =>
              (req as IncomingMessage & { requestId?: string }).requestId ?? requestIdFor(req),
            redact: {
              paths: [
                "req.headers.authorization",
                "req.headers.cookie",
                'res.headers["set-cookie"]',
              ],
              censor: "[redacted]",
            },
            // Successful probes are noise; failing ones and every other request are kept.
            customLogLevel: (req, res, err) => {
              if (err || res.statusCode >= 500) return "error";
              if (res.statusCode >= 400) return "warn";
              return req.url?.startsWith("/health/") ? "silent" : "info";
            },
            ...(config.env === "development"
              ? { transport: { target: "pino-pretty", options: { singleLine: true } } }
              : {}),
          },
        }),
        DatabaseModule,
        RedisModule,
        MailModule,
        StorageModule,
        QuotaModule,
        HealthModule,
        AuthModule,
        SpacesModule,
      ],
      providers: [
        { provide: APP_PIPE, useClass: AppValidationPipe },
        { provide: APP_INTERCEPTOR, useClass: ZodSerializerInterceptor },
        { provide: APP_FILTER, useClass: ApiExceptionFilter },
      ],
    };
  }
}
