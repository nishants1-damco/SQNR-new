// Nest DTOs generated from the shared contracts: validation (ZodValidationPipe),
// response serialization (ZodSerializerInterceptor) and OpenAPI all come from
// the same zod schema the web app uses.
import {
  AuthSessionSchema,
  MeResponseSchema,
  PasswordResetConfirmRequestSchema,
  PasswordResetRequestSchema,
  SignInRequestSchema,
  DeleteAccountRequestSchema,
  SignUpRequestSchema,
  VerifyEmailRequestSchema,
} from "@spatial/contracts";
import { createZodDto } from "nestjs-zod";

export class SignUpDto extends createZodDto(SignUpRequestSchema) {}
export class SignInDto extends createZodDto(SignInRequestSchema) {}
export class DeleteAccountDto extends createZodDto(DeleteAccountRequestSchema) {}
export class VerifyEmailDto extends createZodDto(VerifyEmailRequestSchema) {}
export class PasswordResetDto extends createZodDto(PasswordResetRequestSchema) {}
export class PasswordResetConfirmDto extends createZodDto(PasswordResetConfirmRequestSchema) {}
export class AuthSessionDto extends createZodDto(AuthSessionSchema) {}
export class MeResponseDto extends createZodDto(MeResponseSchema) {}
