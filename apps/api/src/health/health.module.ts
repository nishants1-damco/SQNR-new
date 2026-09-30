import { Module } from "@nestjs/common";
import { HealthController, ShutdownState } from "./health.controller";

@Module({
  controllers: [HealthController],
  providers: [ShutdownState],
})
export class HealthModule {}
