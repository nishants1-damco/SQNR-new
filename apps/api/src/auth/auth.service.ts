// Account and session flows (plan §10). Behaviour matches the Supabase setup
// it replaces: sign-up signs the user straight in, and the verification email
// is informational rather than a gate.
import { Inject, Injectable, Logger } from "@nestjs/common";
import type { ApiConfig } from "@spatial/config";
import type {
  AuthSession,
  PasswordResetConfirmRequest,
  SignInRequest,
  SignUpRequest,
  User,
} from "@spatial/contracts";
import { ApiError } from "../common/api-error";
import { API_CONFIG } from "../config/config.module";
import { resetPasswordMail, verifyEmailMail } from "../mail/templates";
import { MailService } from "../mail/mail.service";
import { accountKey, AUTH_LIMITS, AuthRateLimiter } from "./auth-rate-limiter";
import type { AuthUser, ClientInfo } from "./auth.types";
import { EmailTokensRepository } from "./email-tokens.repository";
import { PasswordsService } from "./passwords.service";
import { RevokedUsers } from "./revoked-users";
import { SessionsRepository } from "./sessions.repository";
import { TokensService } from "./tokens.service";
import { EmailTaken, toUserDto, type UserRecord, UsersRepository } from "./users.repository";

/** A session plus the refresh token the controller puts in the cookie. */
export interface IssuedSession {
  session: AuthSession;
  refreshToken: string;
  refreshExpiresAt: Date;
}

const ipKey = (client: ClientInfo) => client.ip ?? "unknown";

@Injectable()
export class AuthService {
  private readonly logger = new Logger("AuthService");

  constructor(
    @Inject(API_CONFIG) private readonly config: ApiConfig,
    private readonly users: UsersRepository,
    private readonly sessions: SessionsRepository,
    private readonly emailTokens: EmailTokensRepository,
    private readonly passwords: PasswordsService,
    private readonly tokens: TokensService,
    private readonly limiter: AuthRateLimiter,
    private readonly mail: MailService,
    private readonly revoked: RevokedUsers,
  ) {}

  async signUp(input: SignUpRequest, client: ClientInfo): Promise<IssuedSession> {
    await this.limiter.hit("sign-up:ip", ipKey(client), AUTH_LIMITS.signUpPerIp);
    const passwordHash = await this.passwords.hash(input.password);
    let user: UserRecord;
    try {
      user = await this.users.create({
        email: input.email,
        passwordHash,
        // Same default as Supabase's handle_new_user trigger.
        displayName: input.displayName ?? input.email,
      });
    } catch (err) {
      if (err instanceof EmailTaken) {
        throw new ApiError(409, "email_taken", "An account with this email already exists");
      }
      throw err;
    }
    await this.sendVerification(user);
    return this.startSession(user, client);
  }

  async signIn(input: SignInRequest, client: ClientInfo): Promise<IssuedSession> {
    await this.limiter.hit("sign-in:ip", ipKey(client), AUTH_LIMITS.signInPerIp);
    await this.limiter.hit(
      "sign-in:account",
      accountKey(input.email),
      AUTH_LIMITS.signInPerAccount,
    );

    const user = await this.users.findByEmail(input.email);
    const { ok, needsRehash } = await this.passwords.verify(
      user?.passwordHash ?? null,
      input.password,
    );
    // One answer for unknown account, wrong password and disabled account.
    if (!user || !ok || user.disabledAt) throw ApiError.invalidCredentials();

    if (needsRehash)
      await this.users.setPasswordHash(user.id, await this.passwords.hash(input.password));
    await this.users.recordSignIn(user.id);
    return this.startSession(user, client);
  }

  async refresh(refreshToken: string | undefined, client: ClientInfo): Promise<IssuedSession> {
    await this.limiter.hit("refresh:ip", ipKey(client), AUTH_LIMITS.refreshPerIp);
    if (!refreshToken) throw ApiError.unauthorized();

    const next = this.tokens.newOpaqueToken();
    const expiresAt = this.refreshExpiry();
    const result = await this.sessions.rotate({
      presentedHash: this.tokens.hashToken(refreshToken),
      nextHash: next.hash,
      expiresAt,
      client,
    });
    if (result.kind === "reused") {
      this.logger.warn(
        { userId: result.userId, familyId: result.familyId },
        "refresh token reuse; family revoked",
      );
    }
    if (result.kind !== "rotated")
      throw ApiError.unauthorized("Your session has ended. Sign in again.");

    const user = await this.users.findById(result.userId);
    if (!user || user.disabledAt) {
      await this.sessions.revokeFamilyOf(next.hash);
      throw ApiError.unauthorized();
    }
    return {
      session: await this.sessionFor(user, result.familyId),
      refreshToken: next.token,
      refreshExpiresAt: expiresAt,
    };
  }

  async signOut(refreshToken: string | undefined): Promise<void> {
    if (refreshToken) await this.sessions.revokeFamilyOf(this.tokens.hashToken(refreshToken));
  }

  /**
   * Erases the caller's account and everything in it (plan §10.4). The
   * password is checked again, at the sign-in rate per account, so a stolen
   * access token alone can neither delete an account nor guess its password.
   */
  async deleteAccount(caller: AuthUser, password: string): Promise<void> {
    await this.limiter.hit("delete-account:user", caller.id, AUTH_LIMITS.signInPerAccount);
    const user = await this.users.findById(caller.id);
    if (!user || user.disabledAt) throw ApiError.unauthorized();
    const { ok } = await this.passwords.verify(user.passwordHash, password);
    // 403, not 401: the session is fine, and clients treat 401 as signed out.
    if (!ok) throw new ApiError(403, "invalid_credentials", "That password isn't right");
    await this.users.deleteAccount(user.id);
    // Refresh tokens went with the account; this ends the live access tokens.
    await this.revoked.revoke(user.id);
    this.logger.log({ userId: user.id }, "account deleted");
  }

  async me(caller: AuthUser): Promise<User> {
    const user = await this.users.findById(caller.id);
    if (!user || user.disabledAt) throw ApiError.unauthorized();
    return toUserDto(user);
  }

  async verifyEmail(token: string, client: ClientInfo): Promise<void> {
    await this.limiter.hit("token:ip", ipKey(client), AUTH_LIMITS.tokenRedeemPerIp);
    const userId = await this.emailTokens.consume(this.tokens.hashToken(token), "verify_email");
    if (!userId) throw ApiError.tokenInvalid();
    await this.users.markEmailVerified(userId);
  }

  async resendVerification(caller: AuthUser): Promise<void> {
    await this.limiter.hit(
      "resend-verification:user",
      caller.id,
      AUTH_LIMITS.resendVerificationPerUser,
    );
    const user = await this.users.findById(caller.id);
    if (!user || user.disabledAt) throw ApiError.unauthorized();
    if (!user.emailVerifiedAt) await this.sendVerification(user);
  }

  /** Always succeeds from the caller's point of view, so it can't reveal which emails have accounts. */
  async requestPasswordReset(email: string, client: ClientInfo): Promise<void> {
    await this.limiter.hit("reset:ip", ipKey(client), AUTH_LIMITS.resetRequestPerIp);
    await this.limiter.hit("reset:account", accountKey(email), AUTH_LIMITS.resetRequestPerAccount);
    const user = await this.users.findByEmail(email);
    if (!user || user.disabledAt) return;

    const { token, hash } = this.tokens.newOpaqueToken();
    await this.emailTokens.create(user.id, "reset_password", hash);
    const url = `${this.config.web.appBaseUrl}/auth/reset-password?token=${token}`;
    await this.mail.send(resetPasswordMail(user.email, url));
  }

  async confirmPasswordReset(
    input: PasswordResetConfirmRequest,
    client: ClientInfo,
  ): Promise<void> {
    await this.limiter.hit("token:ip", ipKey(client), AUTH_LIMITS.tokenRedeemPerIp);
    const userId = await this.emailTokens.consume(
      this.tokens.hashToken(input.token),
      "reset_password",
    );
    if (!userId) throw ApiError.tokenInvalid();

    await this.users.setPasswordHash(userId, await this.passwords.hash(input.password));
    // Following the link proves the user controls the inbox.
    await this.users.markEmailVerified(userId);
    // Whoever knew the old password is signed out everywhere.
    await this.sessions.revokeAllForUser(userId);
  }

  private async sendVerification(user: UserRecord): Promise<void> {
    const { token, hash } = this.tokens.newOpaqueToken();
    await this.emailTokens.create(user.id, "verify_email", hash);
    const url = `${this.config.web.appBaseUrl}/auth/verify-email?token=${token}`;
    await this.mail.send(verifyEmailMail(user.email, url));
  }

  private refreshExpiry(): Date {
    return new Date(Date.now() + this.config.auth.refreshTokenTtlDays * 24 * 60 * 60 * 1000);
  }

  private async startSession(user: UserRecord, client: ClientInfo): Promise<IssuedSession> {
    const { token, hash } = this.tokens.newOpaqueToken();
    const expiresAt = this.refreshExpiry();
    const { familyId } = await this.sessions.start({
      userId: user.id,
      tokenHash: hash,
      expiresAt,
      client,
    });
    return {
      session: await this.sessionFor(user, familyId),
      refreshToken: token,
      refreshExpiresAt: expiresAt,
    };
  }

  private async sessionFor(user: UserRecord, familyId: string): Promise<AuthSession> {
    return {
      accessToken: await this.tokens.issueAccessToken({ id: user.id, sessionId: familyId }),
      tokenType: "Bearer",
      expiresIn: this.tokens.accessTokenTtlSeconds,
      user: toUserDto(user),
    };
  }
}
