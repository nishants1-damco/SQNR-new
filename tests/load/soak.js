// Hours of ordinary traffic (plan §18.1): a steady read mix plus a trickle of
// captures, to surface leaks (memory, connections, Redis keys) and drift.
//
//   k6 run -e DURATION=2h tests/load/soak.js
import exec from "k6/execution";
import readMix, { setup as readSetup } from "./read-mix.js";
import { createScan, uploadFrames } from "./lib.js";

const DURATION = __ENV.DURATION || "1h";

export const options = {
  setupTimeout: "10m",
  scenarios: {
    reads: {
      executor: "constant-arrival-rate",
      exec: "reads",
      rate: Number(__ENV.RATE || 20),
      timeUnit: "1s",
      duration: DURATION,
      preAllocatedVUs: 20,
      maxVUs: 80,
    },
    captures: {
      executor: "constant-arrival-rate",
      exec: "captures",
      rate: Number(__ENV.CAPTURES_PER_MINUTE || 4),
      timeUnit: "1m",
      duration: DURATION,
      preAllocatedVUs: 4,
      maxVUs: 16,
    },
  },
  thresholds: {
    "http_req_duration{kind:read}": ["p(95)<300"],
    checks: ["rate>0.99"],
  },
};

export const setup = readSetup;
export const reads = readMix;

export function captures(users) {
  const user = users[exec.scenario.iterationInTest % users.length];
  const scan = createScan(user.token, "Soak room");
  if (scan) uploadFrames(user.token, scan.id, 12);
}
