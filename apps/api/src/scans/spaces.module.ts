// Spaces: scans, their frames and uploads, exports, geocoding, consent and
// flags (plan §7.2, phase 2).
import { Module } from "@nestjs/common";
import type { ApiConfig } from "@spatial/config";
import type { Redis } from "ioredis";
import { API_CONFIG } from "../config/config.module";
import { ConsentsController } from "../consents/consents.controller";
import { ExportsController } from "../exports/exports.controller";
import { FlagsController } from "../flags/flags.controller";
import { GEOCODER, GeocodeController } from "../geocode/geocode.controller";
import {
  CachedGeocoder,
  DisabledGeocoder,
  FakeGeocoder,
  type Geocoder,
  NominatimGeocoder,
  nominatimThrottle,
} from "../geocode/geocoder";
import { REDIS } from "../redis/redis.module";
import { UploadsController } from "../uploads/uploads.controller";
import { UploadsService } from "../uploads/uploads.service";
import { ScansController } from "./scans.controller";
import { ScansRepository } from "./scans.repository";
import { ScansService } from "./scans.service";

function createGeocoder(config: ApiConfig, redis: Redis): Geocoder {
  switch (config.geocoder.provider) {
    case "fake":
      return new FakeGeocoder();
    case "disabled":
      return new DisabledGeocoder();
    case "nominatim":
      return new CachedGeocoder(
        new NominatimGeocoder(config.geocoder.userAgent, nominatimThrottle(redis)),
        redis,
      );
  }
}

@Module({
  controllers: [
    ScansController,
    UploadsController,
    ExportsController,
    GeocodeController,
    ConsentsController,
    FlagsController,
  ],
  providers: [
    ScansRepository,
    ScansService,
    UploadsService,
    { provide: GEOCODER, inject: [API_CONFIG, REDIS], useFactory: createGeocoder },
  ],
})
export class SpacesModule {}
