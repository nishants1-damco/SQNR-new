import {
  AddressRequestSchema,
  AddressResponseSchema,
  CompleteUploadRequestSchema,
  CompleteUploadResponseSchema,
  ConsentResponseSchema,
  CaptureConsentSchema,
  CreateScanRequestSchema,
  ExportQuerySchema,
  FlagsResponseSchema,
  GeocodeQuerySchema,
  GeocodeResponseSchema,
  PhotoParamsSchema,
  PhotoUrlsRequestSchema,
  PhotoUrlsResponseSchema,
  ScanDetailResponseSchema,
  ScanListQuerySchema,
  ScanListResponseSchema,
  ScanParamsSchema,
  ScanResponseSchema,
  UpdateScanRequestSchema,
  UploadRequestSchema,
  UploadSessionParamsSchema,
  UploadSessionResponseSchema,
} from "@spatial/contracts";
import { createZodDto } from "nestjs-zod";

export class ScanParamsDto extends createZodDto(ScanParamsSchema) {}
export class PhotoParamsDto extends createZodDto(PhotoParamsSchema) {}
export class UploadSessionParamsDto extends createZodDto(UploadSessionParamsSchema) {}

export class ScanListQueryDto extends createZodDto(ScanListQuerySchema) {}
export class ScanListResponseDto extends createZodDto(ScanListResponseSchema) {}
export class CreateScanDto extends createZodDto(CreateScanRequestSchema) {}
export class UpdateScanDto extends createZodDto(UpdateScanRequestSchema) {}
export class ScanResponseDto extends createZodDto(ScanResponseSchema) {}
export class ScanDetailResponseDto extends createZodDto(ScanDetailResponseSchema) {}
export class PhotoUrlsDto extends createZodDto(PhotoUrlsRequestSchema) {}
export class PhotoUrlsResponseDto extends createZodDto(PhotoUrlsResponseSchema) {}

export class UploadRequestDto extends createZodDto(UploadRequestSchema) {}
export class UploadSessionResponseDto extends createZodDto(UploadSessionResponseSchema) {}
export class CompleteUploadDto extends createZodDto(CompleteUploadRequestSchema) {}
export class CompleteUploadResponseDto extends createZodDto(CompleteUploadResponseSchema) {}

export class ExportQueryDto extends createZodDto(ExportQuerySchema) {}
export class AddressDto extends createZodDto(AddressRequestSchema) {}
export class AddressResponseDto extends createZodDto(AddressResponseSchema) {}
export class GeocodeQueryDto extends createZodDto(GeocodeQuerySchema) {}
export class GeocodeResponseDto extends createZodDto(GeocodeResponseSchema) {}
export class ConsentDto extends createZodDto(CaptureConsentSchema) {}
export class ConsentResponseDto extends createZodDto(ConsentResponseSchema) {}
export class FlagsResponseDto extends createZodDto(FlagsResponseSchema) {}
