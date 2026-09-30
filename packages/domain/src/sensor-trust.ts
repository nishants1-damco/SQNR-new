// Which phone measurements are trustworthy enough to show the model as
// evidence. Dead-reckoned positions drift, and phone-speaker acoustics are
// easily thrown off by tiled rooms and noise; handing the model a position
// with ±300 m drift, or telling it a wall "must" sit at an echo distance,
// costs accuracy. Filtering here beats asking the model to judge.
//
// Pure module: safe in tests.

/** Inertial positions with more estimated drift than this aren't shown. */
export const MAX_TRUSTED_DRIFT_M = 1;
/** Chirp peak above the noise floor needed before acoustic cross-checks are used. */
export const MIN_ACOUSTIC_SNR_DB = 12;
/** Largest RT60 disagreement between chirps before the measurement is doubted. */
export const MAX_RT60_SPREAD_S = 0.2;

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);

export function isTrustedPose(pose: { drift_m?: number | null } | null | undefined): boolean {
  if (!pose) return false;
  const drift = num(pose.drift_m);
  return drift == null || drift <= MAX_TRUSTED_DRIFT_M;
}

/** True when the acoustic probe is clean enough for its volume/reflection cross-checks. */
export function acousticsReliable(acoustics: Record<string, unknown> | null | undefined): boolean {
  if (!acoustics) return false;
  const snr = num(acoustics["ping_snr_db"]);
  if (snr == null || snr < MIN_ACOUSTIC_SNR_DB) return false;
  const chirps = num(acoustics["chirps"]) ?? 1;
  const spread = num(acoustics["rt60_spread_s"]);
  return chirps < 2 || spread == null || spread <= MAX_RT60_SPREAD_S;
}
