// A burst of captures finishing at once (plan §18.1): each iteration creates
// a space and uploads a full frame set through signed URLs.
//
//   k6 run -e VUS=20 -e FRAMES=24 tests/load/upload-burst.js
import exec from "k6/execution";
import { createScan, signUp, uploadFrames } from "./lib.js";

const VUS = Number(__ENV.VUS || 20);
const FRAMES = Number(__ENV.FRAMES || 24);

export const options = {
  setupTimeout: "10m",
  scenarios: {
    burst: {
      executor: "ramping-vus",
      startVUs: 0,
      stages: [
        { duration: "20s", target: VUS },
        { duration: __ENV.HOLD || "1m", target: VUS },
        { duration: "10s", target: 0 },
      ],
    },
  },
  thresholds: {
    "http_req_duration{name:POST /v1/scans/:id/uploads}": ["p(95)<500"],
    "http_req_duration{name:POST /v1/scans/:id/uploads/:session/complete}": ["p(95)<1000"],
    checks: ["rate>0.99"],
  },
};

export function setup() {
  // One user per VU: the upload-session quota is per user (120 an hour).
  const tokens = [];
  for (let i = 0; i < VUS; i++) tokens.push(signUp("upload", i).token);
  return tokens;
}

export default function (tokens) {
  const token = tokens[(exec.vu.idInTest - 1) % tokens.length];
  const scan = createScan(token);
  if (scan) uploadFrames(token, scan.id, FRAMES);
}
