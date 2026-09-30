import { Body, Controller, HttpCode, Param, Post } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { ZodResponse } from "nestjs-zod";
import type { AuthUser } from "../auth/auth.types";
import { CurrentUser } from "../auth/current-user.decorator";
import {
  CompleteUploadDto,
  CompleteUploadResponseDto,
  ScanParamsDto,
  UploadRequestDto,
  UploadSessionParamsDto,
  UploadSessionResponseDto,
} from "../scans/scans.dto";
import { UploadsService } from "./uploads.service";

@ApiTags("uploads")
@ApiBearerAuth()
@Controller("scans/:id/uploads")
export class UploadsController {
  constructor(private readonly uploads: UploadsService) {}

  /** Signs one create-only upload URL per file (valid 15 minutes). */
  @Post()
  @ZodResponse({ status: 201, type: UploadSessionResponseDto })
  issue(
    @CurrentUser() user: AuthUser,
    @Param() params: ScanParamsDto,
    @Body() body: UploadRequestDto,
  ) {
    return this.uploads.issue(user.id, params.id, body);
  }

  /** Verifies the uploaded blobs and records the frames (and depth file). */
  @Post(":sessionId/complete")
  @HttpCode(200)
  @ZodResponse({ status: 200, type: CompleteUploadResponseDto })
  complete(
    @CurrentUser() user: AuthUser,
    @Param() params: UploadSessionParamsDto,
    @Body() body: CompleteUploadDto,
  ) {
    return this.uploads.complete(user.id, params.id, params.sessionId, body);
  }
}
