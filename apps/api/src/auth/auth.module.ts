import { Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { AuthController } from "./auth.controller";
import { AuthRateLimiter } from "./auth-rate-limiter";
import { AuthService } from "./auth.service";
import { EmailTokensRepository } from "./email-tokens.repository";
import { JwksController } from "./jwks.controller";
import { JwtAuthGuard } from "./jwt-auth.guard";
import { MeController } from "./me.controller";
import { PasswordsService } from "./passwords.service";
import { SessionsRepository } from "./sessions.repository";
import { TokensService } from "./tokens.service";
import { UsersRepository } from "./users.repository";

@Module({
  controllers: [AuthController, MeController, JwksController],
  providers: [
    AuthService,
    AuthRateLimiter,
    EmailTokensRepository,
    PasswordsService,
    SessionsRepository,
    TokensService,
    UsersRepository,
    // Every route requires a valid access token unless marked @Public().
    { provide: APP_GUARD, useClass: JwtAuthGuard },
  ],
  exports: [TokensService, PasswordsService],
})
export class AuthModule {}
