import { type DynamicModule, Global, Module } from "@nestjs/common";
import type { ApiConfig } from "@spatial/config";

/** Injection token for the validated ApiConfig. */
export const API_CONFIG = Symbol("API_CONFIG");

@Global()
@Module({})
export class ConfigModule {
  /** The config is loaded once in main.ts (or built by a test) and injected everywhere. */
  static forRoot(config: ApiConfig): DynamicModule {
    return {
      module: ConfigModule,
      providers: [{ provide: API_CONFIG, useValue: config }],
      exports: [API_CONFIG],
    };
  }
}
