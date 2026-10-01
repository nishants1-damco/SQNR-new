# Load tests (k6)

Scripts for plan §18.1. They need nothing from the workspace, so they run from the `grafana/k6` image.

| Script              | What it does                                                                                           |
| ------------------- | ------------------------------------------------------------------------------------------------------ |
| `read-mix.js`       | Steady mix of reads: catalog pages, search, space detail, profile, flags. `ONLY=<name>` runs one kind. |
| `upload-burst.js`   | Many captures finishing at once: create a space, sign URLs, PUT frames to storage, complete.           |
| `analysis-burst.js` | Many analyses at once against the model stub. 429s and 503s count as admission control, not as errors. |
| `soak.js`           | Hours of reads plus a trickle of captures, to find leaks.                                              |

## Running locally

1. Start the stack (`pnpm infra:up`), then run the API with `TRUST_PROXY=true`, so each test user can claim its own address past the sign-up limit of 10 per hour per IP.
2. For `analysis-burst.js`, run the worker with `LLM_STUB=true` (and a short `LLM_STUB_LATENCY_MS`, for example 2000). The stub is refused in production.
3. Run k6:

   ```sh
   docker run --rm -v "$PWD/tests/load:/scripts" -w /scripts \
     -e BASE_URL=http://host.docker.internal:3000 -e BLOB_HOST=host.docker.internal:10000 \
     grafana/k6:1.3.0 run -e RATE=50 read-mix.js
   ```

   `BLOB_HOST` points the SAS URLs at Azurite from inside the container. The signature doesn't cover the host, so this is safe.

Against staging, create the users in advance instead: there, `TRUST_PROXY` is a hop count, so a test can't claim other addresses.

## Status

Only `read-mix.js` has been run, and only at small scale on a development laptop, where Docker Desktop's networking dominates the numbers. Those runs found and fixed four problems:

- Space detail used four pooled connections per request; it now uses one query.
- An exhausted connection pool returned a 500; it now returns a retryable 503.
- A span for every Fastify hook halved API throughput; hook spans are off and the API samples traces in production.
- Signing a frame URL built an SDK client each time.

The other scripts haven't been run, and none have been run against a deployed environment.
