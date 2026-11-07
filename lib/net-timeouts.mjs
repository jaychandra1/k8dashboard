// Upper bounds for calls to cloud APIs (audit REL-02), so a slow or
// partitioned network fails a request instead of pinning it, and its spinner,
// indefinitely. Kubernetes API calls get theirs from lib/k8s-ops.mjs
// (withDefaultTimeout); credential helpers from lib/exec-gate.mjs.

/** Connecting may take this long, the whole request this long. */
export const CLOUD_CONNECT_TIMEOUT_MS = 10_000;
export const CLOUD_REQUEST_TIMEOUT_MS = 30_000;

/**
 * `requestHandler` for AWS SDK v3 clients. A fresh object per client. Without
 * throwOnRequestTimeout the SDK only logs a warning when requestTimeout passes.
 */
export const awsRequestHandler = () => ({
  connectionTimeout: CLOUD_CONNECT_TIMEOUT_MS,
  requestTimeout: CLOUD_REQUEST_TIMEOUT_MS,
  throwOnRequestTimeout: true,
});

/** AbortSignal for a cloud `fetch` (Azure sign-in and Resource Manager calls). */
export const cloudSignal = (ms = CLOUD_REQUEST_TIMEOUT_MS) => AbortSignal.timeout(ms);
