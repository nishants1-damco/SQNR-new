// Analysis runs and the privacy sweep (plan §7.2, phase 3). The work itself
// runs in apps/worker; this module queues it and reports on it.
import { Module } from "@nestjs/common";
import { AnalysisEventsHub } from "./analysis-events";
import { AnalysisLimits } from "./analysis-limits";
import { AnalysisController } from "./analysis.controller";
import { AnalysisService } from "./analysis.service";

@Module({
  controllers: [AnalysisController],
  providers: [AnalysisService, AnalysisEventsHub, AnalysisLimits],
})
export class AnalysisModule {}
