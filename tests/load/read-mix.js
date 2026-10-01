// The everyday read mix (plan §18.1) at a steady arrival rate: catalog pages,
// space detail, profile and flags. Setup gives each user a few spaces with
// frames, so detail pages sign real frame URLs.
//
//   k6 run -e RATE=50 -e DURATION=2m tests/load/read-mix.js
import { check } from "k6";
import exec from "k6/execution";
import { api, createScan, signUp, uploadFrames } from "./lib.js";

const USERS = Number(__ENV.USERS || 20);
const RATE = Number(__ENV.RATE || 50);

export const options = {
  setupTimeout: "10m",
  scenarios: {
    reads: {
      executor: "constant-arrival-rate",
      rate: RATE,
      timeUnit: "1s",
      duration: __ENV.DURATION || "2m",
      preAllocatedVUs: Math.max(10, RATE),
      maxVUs: RATE * 4,
    },
  },
  thresholds: {
    // Plan §3: reads p95 under 300 ms.
    "http_req_duration{kind:read}": ["p(95)<300", "p(99)<800"],
    "checks{kind:read}": ["rate>0.99"],
    dropped_iterations: ["count<10"],
  },
};

export function setup() {
  const users = [];
  for (let i = 0; i < USERS; i++) {
    const user = signUp("read", i);
    const scans = [];
    for (let s = 0; s < 3; s++) {
      const scan = createScan(user.token, `Room ${s + 1}`);
      if (scan && uploadFrames(user.token, scan.id, 8)) scans.push(scan.id);
    }
    users.push({ token: user.token, scans });
  }
  return users;
}

const READS = [
  // [share, name, path for a user]
  [0.45, "GET /v1/scans", () => "/v1/scans?limit=30"],
  [0.1, "GET /v1/scans?q", () => "/v1/scans?q=room&sort=name"],
  [
    0.3,
    "GET /v1/scans/:id",
    (u) => `/v1/scans/${u.scans[Math.floor(Math.random() * u.scans.length)]}`,
  ],
  [0.1, "GET /v1/me", () => "/v1/me"],
  [0.05, "GET /v1/flags", () => "/v1/flags"],
];

// ONLY=<name> runs one request kind, to find which one is slow.
const MIX = __ENV.ONLY
  ? READS.filter(([, name]) => name === __ENV.ONLY).map(([, n, p]) => [1, n, p])
  : READS;

export default function (users) {
  const user = users[exec.scenario.iterationInTest % users.length];
  let roll = Math.random();
  const [, name, path] = MIX.find(([share]) => (roll -= share) < 0) || MIX[0];
  const res = api("GET", path(user), user.token, undefined, { kind: "read", name });
  check(res, { "read ok": (r) => r.status === 200 }, { kind: "read" });
}
