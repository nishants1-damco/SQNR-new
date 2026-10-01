import "@fastify/cookie";
import { Body, Controller, HttpCode, Inject, Post, Req, Res } from "@nestjs/common";
import { ApiBearerAuth, ApiCookieAuth, ApiTags } from "@nestjs/swagger";
import type { ApiConfig } from "@spatial/config";
import type { FastifyReply, FastifyRequest } from "fastify";
import { ZodResponse } from "nestjs-zod";
import { ApiError } from "../common/api-error";
import { API_CONFIG } from "../config/config.module";
import {
  AuthSessionDto,
  PasswordResetConfirmDto,
  PasswordResetDto,
  SignInDto,
  SignUpDto,
  VerifyEmailDto,
} from "./auth.dto";
import { AuthService, type IssuedSession } from "./auth.service";
import type { AuthUser, ClientInfo } from "./auth.types";
import { CurrentUser } from "./current-user.decorator";
import { Public } from "./public.decorator";

/** HttpOnly refresh cookie, only ever sent to /v1/auth/* (plan §10.2). */
export const REFRESH_COOKIE = "sc_refresh";
export const REFRESH_COOKIE_PATH = "/v1/auth";

function clientInfo(request: FastifyRequest): ClientInfo {
  const userAgent = request.headers["user-agent"];
  return { ip: request.ip || null, userAgent: userAgent ? userAgent.slice(0, 500) : null };
}

@ApiTags("auth")
@Controller("auth")
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
  ) {}

  @Public()
  @Post("sign-up")
  @ZodResponse({ status: 201, type: AuthSessionDto, description: "Account created and signed in" })
  async signUp(
    @Body() body: SignUpDto,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    return this.withCookie(reply, await this.auth.signUp(body, clientInfo(request)));
  }

  @Public()
  @Post("sign-in")
  @ZodResponse({ status: 200, type: AuthSessionDto })
  async signIn(
    @Body() body: SignInDto,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    return this.withCookie(reply, await this.auth.signIn(body, clientInfo(request)));
  }

  @Public()
  @ApiCookieAuth(REFRESH_COOKIE)
  @Post("refresh")
  @ZodResponse({
    status: 200,
    type: AuthSessionDto,
    description: "A new access token; the refresh cookie is rotated",
  })
  async refresh(@Req() request: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply) {
    this.assertAllowedOrigin(request);
    try {
      return this.withCookie(
        reply,
        await this.auth.refresh(request.cookies[REFRESH_COOKIE], clientInfo(request)),
      );
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) this.clearCookie(reply);
      throw err;
    }
  }

  @Public()
  @ApiCookieAuth(REFRESH_COOKIE)
  @Post("sign-out")
  @HttpCode(204)
  async signOut(@Req() request: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply) {
    this.assertAllowedOrigin(request);
    await this.auth.signOut(request.cookies[REFRESH_COOKIE]);
    this.clearCookie(reply);
  }

  @Public()
  @Post("verify-email")
  @HttpCode(204)
  async verifyEmail(@Body() body: VerifyEmailDto, @Req() request: FastifyRequest) {
    await this.auth.verifyEmail(body.token, clientInfo(request));
  }

  @ApiBearerAuth()
  @Post("verify-email/resend")
  @HttpCode(204)
  async resendVerification(@CurrentUser() user: AuthUser) {
    await this.auth.resendVerification(user);
  }

  @Public()
  @Post("password-reset")
  @HttpCode(202)
  async requestPasswordReset(@Body() body: PasswordResetDto, @Req() request: FastifyRequest) {
    await this.auth.requestPasswordReset(body.email, clientInfo(request));
  }

  @Public()
  @Post("password-reset/confirm")
  @HttpCode(204)
  async confirmPasswordReset(
    @Body() body: PasswordResetConfirmDto,
    @Req() request: FastifyRequest,
  ) {
    await this.auth.confirmPasswordReset(body, clientInfo(request));
  }

  private withCookie(reply: FastifyReply, issued: IssuedSession) {
    void reply.setCookie(REFRESH_COOKIE, issued.refreshToken, {
      httpOnly: true,
      secure: this.config.auth.cookieSecure,
      sameSite: "strict",
      path: REFRESH_COOKIE_PATH,
      expires: issued.refreshExpiresAt,
    });
    void reply.header("cache-control", "no-store");
    return issued.session;
  }

  private clearCookie(reply: FastifyReply) {
    void reply.clearCookie(REFRESH_COOKIE, {
      httpOnly: true,
      secure: this.config.auth.cookieSecure,
      sameSite: "strict",
      path: REFRESH_COOKIE_PATH,
    });
  }

  /**
   * CSRF defence for the cookie-authenticated endpoints, on top of
   * SameSite=Strict: a browser request from another site is refused.
   * Requests without an Origin header (non-browser clients) are allowed.
   */
  private assertAllowedOrigin(request: FastifyRequest) {
    const origin = request.headers.origin;
    if (origin && !this.config.web.origins.includes(origin)) {
      throw ApiError.unauthorized("This origin may not use the session cookie");
    }
  }
}
