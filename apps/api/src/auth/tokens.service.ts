// Access tokens and refresh-token material (plan §10.2).
//   * Access token: 15-minute EdDSA (Ed25519) JWT with sub = user id and
//     sid = refresh family. Verified locally with the public key; the JWKS
//     endpoint publishes the current key and, during a rotation, the previous one.
//   * Refresh token: 256 random bits, base64url. Only its SHA-256 is stored.
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  type KeyObject,
  randomBytes,
  randomUUID,
} from "node:crypto";
import { Inject, Injectable, Logger } from "@nestjs/common";
import type { ApiConfig } from "@spatial/config";
import { errors, exportJWK, type JWK, jwtVerify, SignJWT } from "jose";
import { API_CONFIG } from "../config/config.module";
import type { AuthUser } from "./auth.types";

const ALG = "EdDSA";

interface SigningKey {
  keyId: string;
  privateKey: KeyObject;
  publicKey: KeyObject;
}

export class InvalidAccessToken extends Error {
  override name = "InvalidAccessToken";
}

@Injectable()
export class TokensService {
  private readonly logger = new Logger("TokensService");
  private readonly current: SigningKey;
  private readonly verificationKeys = new Map<string, KeyObject>();

  constructor(@Inject(API_CONFIG) private readonly config: ApiConfig) {
    const configured = config.auth.signingKey;
    if (configured) {
      const privateKey = createPrivateKey(configured.privateKeyPem);
      if (privateKey.asymmetricKeyType !== "ed25519") {
        throw new Error("JWT_PRIVATE_KEY must be an Ed25519 private key (PKCS#8 PEM)");
      }
      this.current = {
        keyId: configured.keyId,
        privateKey,
        publicKey: createPublicKey(privateKey),
      };
    } else {
      // Never in production: loadApiConfig requires a key there.
      const { privateKey, publicKey } = generateKeyPairSync("ed25519");
      this.current = { keyId: `ephemeral-${randomUUID().slice(0, 8)}`, privateKey, publicKey };
      if (config.env === "development") {
        this.logger.warn(
          "No JWT_PRIVATE_KEY set: using a per-process key, so sessions end on restart. Run `pnpm --filter @spatial/api keys:generate`.",
        );
      }
    }
    this.verificationKeys.set(this.current.keyId, this.current.publicKey);
    if (config.auth.previousKey) {
      this.verificationKeys.set(
        config.auth.previousKey.keyId,
        createPublicKey(config.auth.previousKey.publicKeyPem),
      );
    }
  }

  get accessTokenTtlSeconds(): number {
    return this.config.auth.accessTokenTtlSeconds;
  }

  async issueAccessToken(user: AuthUser): Promise<string> {
    return new SignJWT({ sid: user.sessionId })
      .setProtectedHeader({ alg: ALG, kid: this.current.keyId, typ: "JWT" })
      .setSubject(user.id)
      .setIssuer(this.config.auth.issuer)
      .setAudience(this.config.auth.audience)
      .setIssuedAt()
      .setExpirationTime(`${this.config.auth.accessTokenTtlSeconds}s`)
      .setJti(randomUUID())
      .sign(this.current.privateKey);
  }

  async verifyAccessToken(token: string): Promise<AuthUser> {
    try {
      const { payload } = await jwtVerify(
        token,
        (header) => {
          const key = header.kid ? this.verificationKeys.get(header.kid) : undefined;
          if (!key) throw new InvalidAccessToken("unknown signing key");
          return key;
        },
        {
          algorithms: [ALG],
          issuer: this.config.auth.issuer,
          audience: this.config.auth.audience,
        },
      );
      if (typeof payload.sub !== "string" || typeof payload["sid"] !== "string") {
        throw new InvalidAccessToken("missing claims");
      }
      return { id: payload.sub, sessionId: payload["sid"] };
    } catch (err) {
      if (err instanceof InvalidAccessToken) throw err;
      if (err instanceof errors.JOSEError) throw new InvalidAccessToken(err.code);
      throw err;
    }
  }

  /** Public keys for `/.well-known/jwks.json`. */
  async jwks(): Promise<{ keys: JWK[] }> {
    const keys = await Promise.all(
      [...this.verificationKeys].map(async ([kid, key]) => ({
        ...(await exportJWK(key)),
        kid,
        alg: ALG,
        use: "sig",
      })),
    );
    return { keys };
  }

  /** A new opaque token for a refresh cookie or an emailed link, and the hash to store. */
  newOpaqueToken(): { token: string; hash: string } {
    const token = randomBytes(32).toString("base64url");
    return { token, hash: this.hashToken(token) };
  }

  hashToken(token: string): string {
    return createHash("sha256").update(token).digest("hex");
  }
}
