// Shared steps for the spaces tests: a signed-in user, a scan, and a real
// upload (signed URLs from the API, bytes PUT straight to Azurite).
import type {
  AuthSession,
  CompleteUploadResponse,
  ScanResponse,
  UploadSessionResponse,
} from "@spatial/contracts";
import { expect } from "vitest";
import { Client, type TestApp, uniqueEmail } from "./test-app";

export interface User {
  client: Client;
  token: string;
  id: string;
}

export async function signUp(t: TestApp, label = "space"): Promise<User> {
  const client = new Client(t.app);
  const res = await client.request<AuthSession>({
    method: "POST",
    url: "/v1/auth/sign-up",
    body: { email: uniqueEmail(label), password: "space-tests-password" },
  });
  expect(res.status).toBe(201);
  return { client, token: res.body.accessToken, id: res.body.user.id };
}

export async function createScan(user: User, body: Record<string, unknown> = {}) {
  const res = await user.client.request<ScanResponse>({
    method: "POST",
    url: "/v1/scans",
    token: user.token,
    body: { name: "Test room", ...body },
  });
  expect(res.status).toBe(201);
  return res.body.scan;
}

/** The start of a real JPEG, enough for magic-byte checks. */
export const JPEG_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70, 0, 1]);

export interface FrameSpec {
  station?: number;
  heading?: number;
}

export async function issueUpload(user: User, scanId: string, files: Record<string, unknown>[]) {
  const res = await user.client.request<UploadSessionResponse>({
    method: "POST",
    url: `/v1/scans/${scanId}/uploads`,
    token: user.token,
    body: { files },
  });
  return res;
}

export async function putFile(
  file: UploadSessionResponse["files"][number],
  body: Uint8Array = JPEG_BYTES,
  headers: Record<string, string> = {},
): Promise<number> {
  const res = await fetch(file.upload.url, {
    method: "PUT",
    headers: { ...file.upload.headers, ...headers },
    body,
  });
  return res.status;
}

/** Issue, PUT every file, complete. Returns the completion response. */
export async function uploadFrames(
  user: User,
  scanId: string,
  frames: FrameSpec[],
  options: { replaceStations?: number[]; depth?: boolean } = {},
) {
  const files: Record<string, unknown>[] = frames.map(() => ({
    kind: "frame",
    contentType: "image/jpeg",
    sizeBytes: JPEG_BYTES.length,
  }));
  if (options.depth) {
    files.push({
      kind: "depth",
      contentType: "application/octet-stream",
      sizeBytes: 3,
      fileName: "room scan.ply",
    });
  }
  const issued = await issueUpload(user, scanId, files);
  expect(issued.status).toBe(201);
  for (const file of issued.body.files) {
    expect(
      await putFile(
        file,
        file.kind === "depth" ? new Uint8Array([1, 2, 3]) : JPEG_BYTES,
        file.kind === "depth" ? { "content-type": "application/octet-stream" } : {},
      ),
    ).toBe(201);
  }
  const complete = await user.client.request<CompleteUploadResponse>({
    method: "POST",
    url: `/v1/scans/${scanId}/uploads/${issued.body.sessionId}/complete`,
    token: user.token,
    body: {
      frames: frames.map((frame, i) => ({
        fileIndex: i,
        headingDeg: frame.heading ?? i * 22.5,
        sensorPayload: frame.station === undefined ? {} : { station: frame.station },
      })),
      ...(options.depth ? { depthFileIndex: frames.length } : {}),
      ...(options.replaceStations ? { replaceStations: options.replaceStations } : {}),
    },
  });
  return { issued: issued.body, complete };
}
