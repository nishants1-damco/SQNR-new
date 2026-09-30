import { Controller, Get } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { ZodResponse } from "nestjs-zod";
import { MeResponseDto } from "./auth.dto";
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
}
