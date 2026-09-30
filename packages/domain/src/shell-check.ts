// Sanity check for a measured room size before it replaces the
// reconstruction's own estimate. Triangulation and walked legs are only as
// good as the phone's inertial and compass data; when that data is bad they
// can turn a 3 x 4 m room into 4.5 x 17 m. A measurement that disagrees with
// the model's estimate by more than MAX_SHELL_RATIO on either axis is more
// likely broken than the estimate (typically within ±25%), so it's rejected.
//
// Pure module: safe in tests.

/** Largest accepted measured/estimated ratio on either axis (60% off). */
export const MAX_SHELL_RATIO = 1.6;

interface Shell {
  width_m: number;
  length_m: number;
}

/** Worst per-axis disagreement factor (>= 1); Infinity for unusable sizes. */
export function shellDisagreement(measured: Shell, estimate: Shell): number {
  const ratio = (a: number, b: number) =>
    a > 0 && b > 0 && Number.isFinite(a) && Number.isFinite(b) ? Math.max(a / b, b / a) : Infinity;
  return Math.max(
    ratio(measured.width_m, estimate.width_m),
    ratio(measured.length_m, estimate.length_m),
  );
}

export function shellAgrees(measured: Shell, estimate: Shell, max = MAX_SHELL_RATIO): boolean {
  // Tiny tolerance so a ratio exactly at the limit isn't lost to rounding.
  return shellDisagreement(measured, estimate) <= max + 1e-9;
}
