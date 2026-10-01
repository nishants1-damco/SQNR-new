// Many analyses at once against the model stub (plan §18.1; the worker runs
// with LLM_STUB=true). Each user starts one analysis and follows it to the
// end. Admission control is part of the test: 429s (budgets, quotas) and 503s
// (queue full, global budget) are expected answers, not errors.
//
//   k6 run -e USERS=50 tests/load/analysis-burst.js
import { check, sleep } from "k6";
import exec from "k6/execution";
import { Counter, Trend } from "k6/metrics";
import { api, createScan, signUp, uploadFrames } from "./lib.js";

const USERS = Number(__ENV.USERS || 50);
const POLL_SECONDS = Number(__ENV.POLL_SECONDS || 3);
const MAX_WAIT_SECONDS = Number(__ENV.MAX_WAIT_SECONDS || 1800);

const endToEnd = new Trend("analysis_end_to_end", true);
const succeeded = new Counter("analysis_succeeded");
const failed = new Counter("analysis_failed");
const refused = new Counter("analysis_refused");

export const options = {
  setupTimeout: "15m",
  scenarios: {
    burst: {
      executor: "per-vu-iterations",
      vus: USERS,
      iterations: 1,
      maxDuration: `${MAX_WAIT_SECONDS + 120}s`,
    },
  },
  thresholds: {
    "http_req_duration{name:POST /v1/scans/:id/analysis}": ["p(95)<1000"],
    "http_req_duration{name:GET /v1/scans/:id/analysis}": ["p(95)<300"],
    analysis_failed: ["count==0"],
  },
};

export function setup() {
  const spaces = [];
  for (let i = 0; i < USERS; i++) {
    const user = signUp("analysis", i);
    const scan = createScan(user.token);
    if (scan && uploadFrames(user.token, scan.id, 12)) {
      spaces.push({ token: user.token, scanId: scan.id });
    }
  }
  return spaces;
}

export default function (spaces) {
  const space = spaces[exec.vu.idInTest - 1];
  if (!space) return;
  const started = Date.now();
  const res = api(
    "POST",
    `/v1/scans/${space.scanId}/analysis`,
    space.token,
    {},
    {
      name: "POST /v1/scans/:id/analysis",
    },
  );
  if (res.status === 429 || res.status === 503) {
    refused.add(1, { status: String(res.status) });
    return;
  }
  if (!check(res, { "analysis queued": (r) => r.status === 202 })) return;

  while (Date.now() - started < MAX_WAIT_SECONDS * 1000) {
    sleep(POLL_SECONDS);
    const status = api("GET", `/v1/scans/${space.scanId}/analysis`, space.token, undefined, {
      name: "GET /v1/scans/:id/analysis",
    });
    if (status.status !== 200) continue;
    const run = status.json().run;
    if (!run || run.status === "queued" || run.status === "running") continue;
    endToEnd.add(Date.now() - started);
    if (run.status === "succeeded") succeeded.add(1);
    else failed.add(1, { error: String(run.errorCode) });
    return;
  }
  failed.add(1, { error: "k6_timeout" });
}
