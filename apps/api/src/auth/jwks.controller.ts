import { Controller, Get, Header, VERSION_NEUTRAL } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { Public } from "./public.decorator";
import { TokensService } from "./tokens.service";

/** Public keys for verifying access tokens, e.g. by other services or gateways. */
@ApiTags("auth")
@Public()
@Controller({ path: ".well-known", version: VERSION_NEUTRAL })
export class JwksController {
  constructor(private readonly tokens: TokensService) {}

  @Get("jwks.json")
  @Header("cache-control", "public, max-age=300")
  jwks() {
    return this.tokens.jwks();
  }
}
