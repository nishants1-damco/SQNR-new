import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  Res,
} from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import type { FastifyReply } from "fastify";
import { ZodResponse } from "nestjs-zod";
import type { AuthUser } from "../auth/auth.types";
import { CurrentUser } from "../auth/current-user.decorator";
import {
  CreateScanDto,
  PhotoParamsDto,
  PhotoUrlsDto,
  PhotoUrlsResponseDto,
  ScanDetailResponseDto,
  ScanListQueryDto,
  ScanListResponseDto,
  ScanParamsDto,
  ScanResponseDto,
  UpdateScanDto,
} from "./scans.dto";
import { ScansService } from "./scans.service";

@ApiTags("scans")
@ApiBearerAuth()
@Controller("scans")
export class ScansController {
  constructor(private readonly scans: ScansService) {}

  @Get()
  @ZodResponse({ status: 200, type: ScanListResponseDto })
  list(@CurrentUser() user: AuthUser, @Query() query: ScanListQueryDto) {
    return this.scans.list(user.id, query);
  }

  /** 201 for a new space; 200 with the existing one when the capture id was already used. */
  @Post()
  @ZodResponse({ status: 201, type: ScanResponseDto })
  async create(
    @CurrentUser() user: AuthUser,
    @Body() body: CreateScanDto,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const { scan, created } = await this.scans.create(user.id, body);
    if (!created) void reply.status(200);
    return { scan };
  }

  @Post("photo-urls")
  @HttpCode(200)
  @ZodResponse({ status: 200, type: PhotoUrlsResponseDto })
  photoUrls(@CurrentUser() user: AuthUser, @Body() body: PhotoUrlsDto) {
    return this.scans.photoUrls(user.id, body.paths);
  }

  @Get(":id")
  @ZodResponse({ status: 200, type: ScanDetailResponseDto })
  detail(@CurrentUser() user: AuthUser, @Param() params: ScanParamsDto) {
    return this.scans.detail(user.id, params.id);
  }

  @Patch(":id")
  @ZodResponse({ status: 200, type: ScanResponseDto })
  update(
    @CurrentUser() user: AuthUser,
    @Param() params: ScanParamsDto,
    @Body() body: UpdateScanDto,
  ) {
    return this.scans.update(user.id, params.id, body);
  }

  @Delete(":id")
  @HttpCode(204)
  async remove(@CurrentUser() user: AuthUser, @Param() params: ScanParamsDto) {
    await this.scans.remove(user.id, params.id);
  }

  @Delete(":id/photos/:photoId")
  @HttpCode(204)
  async removePhoto(@CurrentUser() user: AuthUser, @Param() params: PhotoParamsDto) {
    await this.scans.removePhoto(user.id, params.id, params.photoId);
  }
}
