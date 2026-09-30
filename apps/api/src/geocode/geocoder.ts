// Geocoding behind a small interface (plan §19, risk R6): OpenStreetMap
// Nominatim today, with results cached in Redis and calls held to Nominatim's
// usage policy of at most one request per second across all replicas.
// Production should move to Azure Maps (decision D7) by adding a provider.
import { createHash } from "node:crypto";
import { Logger } from "@nestjs/common";
import type { Redis } from "ioredis";

export interface ReverseGeocodeResult {
  address: string;
  /** True when the result includes a house number and street, not just a locality. */
  precise: boolean;
}

export interface Geocoder {
  reverse(lat: number, lon: number): Promise<ReverseGeocodeResult | null>;
  forward(address: string): Promise<{ lat: number; lon: number } | null>;
}

/** Fixed answers, for tests; never calls out. */
export class FakeGeocoder implements Geocoder {
  async reverse(lat: number, lon: number): Promise<ReverseGeocodeResult> {
    return {
      address: `1 Test Street, Testville (${lat.toFixed(3)}, ${lon.toFixed(3)})`,
      precise: true,
    };
  }
  async forward(address: string) {
    return address.toLowerCase().includes("nowhere") ? null : { lat: 28.6139, lon: 77.209 };
  }
}

export class DisabledGeocoder implements Geocoder {
  async reverse() {
    return null;
  }
  async forward() {
    return null;
  }
}

const TIMEOUT_MS = 5000;

/** Ported from the original geocode.server.ts / geocode.functions.ts. */
export class NominatimGeocoder implements Geocoder {
  private readonly logger = new Logger("NominatimGeocoder");

  constructor(
    private readonly userAgent: string,
    private readonly throttle: () => Promise<boolean>,
  ) {}

  async reverse(lat: number, lon: number): Promise<ReverseGeocodeResult | null> {
    const json = await this.get<{ display_name?: string; address?: Record<string, string> }>(
      `https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=18&addressdetails=1` +
        `&lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lon)}`,
    );
    if (!json) return null;
    const a = json.address ?? {};
    const houseNumber = a["house_number"];
    const road = a["road"] ?? a["pedestrian"] ?? a["residential"];
    const street = [houseNumber, road].filter(Boolean).join(" ");
    const city = a["city"] ?? a["town"] ?? a["village"] ?? a["hamlet"] ?? a["suburb"];
    const state = a["state_code"] ?? a["state"];
    const postcode = a["postcode"];
    const composed = [street, city, [state, postcode].filter(Boolean).join(" ")]
      .filter((part) => part && part.trim().length > 0)
      .join(", ");
    const address = composed || json.display_name;
    return address ? { address, precise: Boolean(houseNumber && road) } : null;
  }

  async forward(address: string) {
    const json = await this.get<Array<{ lat?: string; lon?: string }>>(
      `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&addressdetails=0` +
        `&q=${encodeURIComponent(address)}`,
    );
    const hit = json?.[0];
    const lat = Number(hit?.lat);
    const lon = Number(hit?.lon);
    return Number.isFinite(lat) && Number.isFinite(lon) ? { lat, lon } : null;
  }

  private async get<T>(url: string): Promise<T | null> {
    if (!(await this.throttle())) {
      this.logger.warn("geocoder busy; skipping request");
      return null;
    }
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": this.userAgent, Accept: "application/json" },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      return res.ok ? ((await res.json()) as T) : null;
    } catch (err) {
      this.logger.warn({ err }, "geocode request failed");
      return null;
    }
  }
}

/** One Nominatim call per second across every API replica (its usage policy). */
export function nominatimThrottle(redis: Redis): () => Promise<boolean> {
  return async () => {
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      if ((await redis.set("geocode:nominatim:slot", "1", "PX", 1100, "NX")) === "OK") return true;
      await new Promise((r) => setTimeout(r, 250));
    }
    return false;
  };
}

const DAY_SEC = 24 * 60 * 60;

/** Caches answers (30 days; empty answers 1 day) so repeat lookups never leave the building. */
export class CachedGeocoder implements Geocoder {
  constructor(
    private readonly inner: Geocoder,
    private readonly redis: Redis,
  ) {}

  reverse(lat: number, lon: number) {
    // ~1 m precision: nearby fixes from one room share an entry.
    return this.cached(`geocode:rev:${lat.toFixed(5)},${lon.toFixed(5)}`, () =>
      this.inner.reverse(lat, lon),
    );
  }

  forward(address: string) {
    const normalized = address.trim().toLowerCase().replace(/\s+/g, " ");
    const hash = createHash("sha256").update(normalized).digest("hex").slice(0, 32);
    return this.cached(`geocode:fwd:${hash}`, () => this.inner.forward(address));
  }

  private async cached<T>(key: string, load: () => Promise<T | null>): Promise<T | null> {
    const hit = await this.redis.get(key).catch(() => null);
    if (hit) return (JSON.parse(hit) as { value: T | null }).value;
    const value = await load();
    await this.redis
      .set(key, JSON.stringify({ value }), "EX", value === null ? DAY_SEC : 30 * DAY_SEC)
      .catch(() => undefined);
    return value;
  }
}
