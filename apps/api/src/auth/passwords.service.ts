// Password hashing (plan §10.2). New hashes are Argon2id with the OWASP
// baseline parameters. Accounts imported from Supabase arrive with bcrypt
// hashes; they verify with bcrypt once and are re-hashed to Argon2id on that
// sign-in, so nobody has to reset their password after the migration.
import { Injectable } from "@nestjs/common";
import { hash, verify } from "@node-rs/argon2";
import bcrypt from "bcryptjs";

/** OWASP Password Storage Cheat Sheet: m=19 MiB, t=2, p=1. Algorithm defaults to Argon2id. */
const ARGON2 = { memoryCost: 19_456, timeCost: 2, parallelism: 1 } as const;
const CURRENT_PREFIX = `$argon2id$v=19$m=${ARGON2.memoryCost},t=${ARGON2.timeCost},p=${ARGON2.parallelism}$`;
const BCRYPT = /^\$2[aby]\$\d{2}\$/;

export interface VerifyResult {
  ok: boolean;
  /** True when the password was right but the stored hash is bcrypt or older parameters. */
  needsRehash: boolean;
}

@Injectable()
export class PasswordsService {
  /** Hash of a random string, so unknown accounts cost as much time as known ones. */
  private readonly dummyHash: Promise<string> = hash(`dummy-${Math.random()}`, ARGON2);

  hash(password: string): Promise<string> {
    return hash(password, ARGON2);
  }

  async verify(stored: string | null, password: string): Promise<VerifyResult> {
    if (!stored) {
      await this.burnTime(password);
      return { ok: false, needsRehash: false };
    }
    if (stored.startsWith("$argon2")) {
      const ok = await verify(stored, password).catch(() => false);
      return { ok, needsRehash: ok && !stored.startsWith(CURRENT_PREFIX) };
    }
    if (BCRYPT.test(stored)) {
      const ok = await bcrypt.compare(password, stored);
      return { ok, needsRehash: ok };
    }
    await this.burnTime(password);
    return { ok: false, needsRehash: false };
  }

  /** Spend a verification's worth of time when there is nothing to verify against. */
  async burnTime(password: string): Promise<void> {
    await verify(await this.dummyHash, password).catch(() => false);
  }
}
