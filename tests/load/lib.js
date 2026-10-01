// Shared steps for the k6 load tests (plan §18.1). Plain k6 JavaScript with no
// workspace imports, so the scripts run from the grafana/k6 image.
import http from "k6/http";
import { check, fail } from "k6";
import { Counter, Trend } from "k6/metrics";

export const BASE_URL = (__ENV.BASE_URL || "http://127.0.0.1:3000").replace(/\/$/, "");
// Inside the k6 container, 127.0.0.1 in a SAS URL means the container itself.
// BLOB_HOST rewrites the host; the signature doesn't cover it.
const BLOB_HOST = __ENV.BLOB_HOST || "";
const FRAME = open("./fixtures/frame.jpg", "b");

export const throttled = new Counter("throttled");
export const overloaded = new Counter("overloaded");
export const uploadDuration = new Trend("upload_session_duration", true);

export function api(method, path, token, body, tags = {}) {
  const headers = { "content-type": "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = http.request(
    method,
    `${BASE_URL}${path}`,
    body === undefined ? null : JSON.stringify(body),
    { headers, tags: Object.assign({ name: path }, tags) },
  );
  if (res.status === 429) throttled.add(1);
  if (res.status === 503) overloaded.add(1);
  return res;
}

/**
 * Sign-up allows 10 an hour per address. Locally the API runs with
 * TRUST_PROXY=true and each user claims its own address. Against a deployed
 * environment, reuse seeded users instead (see README).
 */
export function signUp(label, i) {
  const ip = `10.${(i >> 16) & 255}.${(i >> 8) & 255}.${i & 255}`;
  const email = `load-${label}-${Date.now()}-${i}@example.test`;
  const res = http.post(
    `${BASE_URL}/v1/auth/sign-up`,
    JSON.stringify({ email, password: "load-test-password-1" }),
    {
      headers: { "content-type": "application/json", "x-forwarded-for": ip },
      tags: { name: "POST /v1/auth/sign-up" },
    },
  );
  if (res.status !== 201) fail(`sign-up ${res.status}: ${res.body}`);
  const body = res.json();
  return { token: body.accessToken, id: body.user.id, email };
}

export function createScan(token, name = "Load-test room") {
  const res = api("POST", "/v1/scans", token, { name }, { name: "POST /v1/scans" });
  check(res, { "scan created": (r) => r.status === 201 });
  return res.status === 201 ? res.json().scan : null;
}

const blobUrl = (url) => (BLOB_HOST ? url.replace(/^(https?:\/\/)[^/]+/, `$1${BLOB_HOST}`) : url);

/** Get signed URLs from the API, PUT the frames straight to storage, then complete. */
export function uploadFrames(token, scanId, count) {
  const started = Date.now();
  const files = [];
  for (let i = 0; i < count; i++) {
    files.push({ kind: "frame", contentType: "image/jpeg", sizeBytes: FRAME.byteLength });
  }
  const issued = api(
    "POST",
    `/v1/scans/${scanId}/uploads`,
    token,
    { files },
    {
      name: "POST /v1/scans/:id/uploads",
    },
  );
  if (!check(issued, { "upload signed": (r) => r.status === 201 })) return false;
  const session = issued.json();
  const puts = http.batch(
    session.files.map((file) => ({
      method: "PUT",
      url: blobUrl(file.upload.url),
      body: FRAME,
      params: { headers: file.upload.headers, tags: { name: "PUT blob" } },
    })),
  );
  if (!check(puts, { "frames stored": (rs) => rs.every((r) => r.status === 201) })) return false;
  const complete = api(
    "POST",
    `/v1/scans/${scanId}/uploads/${session.sessionId}/complete`,
    token,
    {
      frames: session.files.map((_, i) => ({
        fileIndex: i,
        headingDeg: (i * 360) / count,
        sensorPayload: { station: 0 },
      })),
    },
    { name: "POST /v1/scans/:id/uploads/:session/complete" },
  );
  const ok = check(complete, { "upload completed": (r) => r.status === 200 });
  if (ok) uploadDuration.add(Date.now() - started);
  return ok;
}
