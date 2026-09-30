import { SetMetadata } from "@nestjs/common";

export const IS_PUBLIC = "auth:isPublic";

/**
 * Opts a route (or controller) out of the global JwtAuthGuard. Every route is
 * authenticated unless marked public, and the tenant-isolation suite checks
 * that each public route is on its allow-list.
 */
export const Public = () => SetMetadata(IS_PUBLIC, true);
