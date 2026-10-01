import { Body, Controller, Delete, Get, HttpCode, Res } from "@nestjs/common";
import { ApiBearerAuth, ApiNoContentResponse, ApiTags } from "@nestjs/swagger";
import type { FastifyReply } from "fastify";
import { ZodResponse } from "nestjs-zod";
import { REFRESH_COOKIE, REFRESH_COOKIE_PATH } from "./auth.controller";
import { DeleteAccountDto, MeResponseDto } from "./auth.dto";
import { AuthService } from "./auth.service";
import type { AuthUser } from "./auth.types";
import { CurrentUser } from "./current-user.decorator";

@ApiTags("account")
@ApiBearerAuth()
@Controller("me")
export class MeController {
  constructor(private readonly auth: AuthService) {}

  @Get()
  @ZodResponse({ status: 200, type: MeResponseDto })
  async me(@CurrentUser() caller: AuthUser) {
    return { user: await this.auth.me(caller) };
  }

  @Delete()
  @HttpCode(204)
  @ApiNoContentResponse({ description: "The account and all its spaces and files are deleted" })
  async remove(
    @CurrentUser() caller: AuthUser,
    @Body() body: DeleteAccountDto,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    await this.auth.deleteAccount(caller, body.password);
    void reply.clearCookie(REFRESH_COOKIE, { path: REFRESH_COOKIE_PATH });
  }
}
