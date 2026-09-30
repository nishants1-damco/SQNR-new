// Scores a reconstruction against a fixture's ground truth, ported from the
// original `scripts/run-eval.ts`. One change: an object whose label doesn't
// match exactly is matched by category instead, because models name the same
// sofa differently from run to run ("Sofa" vs "3-seat fabric sofa").
import type { Actual, Fixture } from "./fixtures";

export interface FixtureResult {
  id: string;
  status: "pass" | "fail" | "no_data";
  failures: string[];
}

export function scoreFixture(fixture: Fixture, actual: Actual): FixtureResult {
  const failures: string[] = [];
  const shellTol = fixture.tolerance.shell_m;
  const check = (label: string, gt: number, act: number | undefined, tol: number) => {
    if (act == null) {
      failures.push(`${label}: actual missing`);
      return;
    }
    if (Math.abs(act - gt) > tol) failures.push(`${label}: expected ${gt} ±${tol}, got ${act}`);
  };
  check("width_m", fixture.ground_truth.width_m, actual.width_m, shellTol);
  check("length_m", fixture.ground_truth.length_m, actual.length_m, shellTol);
  check("height_m", fixture.ground_truth.height_m, actual.height_m, shellTol);

  const unmatched = [...(actual.objects ?? [])];
  const take = (pred: (o: NonNullable<Actual["objects"]>[number]) => boolean) => {
    const i = unmatched.findIndex(pred);
    return i === -1 ? undefined : unmatched.splice(i, 1)[0];
  };
  for (const gtObj of fixture.ground_truth.objects ?? []) {
    const match =
      take((o) => o.label?.toLowerCase() === gtObj.label.toLowerCase()) ??
      take((o) => o.category?.toLowerCase() === gtObj.category.toLowerCase());
    if (!match) failures.push(`object "${gtObj.label}" missing`);
    else
      check(
        `object ${gtObj.label} width`,
        gtObj.width_m,
        match.width_m,
        fixture.tolerance.object_width_m,
      );
  }

  for (const gtP of fixture.ground_truth.portals ?? []) {
    const match = (actual.portals ?? []).find((p) => p.kind === gtP.kind && p.wall === gtP.wall);
    if (!match) failures.push(`portal ${gtP.kind} on ${gtP.wall} missing`);
    else
      check(
        `portal ${gtP.kind}/${gtP.wall} width`,
        gtP.width_m,
        match.width_m,
        fixture.tolerance.portal_width_m,
      );
  }

  return { id: fixture.id, status: failures.length === 0 ? "pass" : "fail", failures };
}
