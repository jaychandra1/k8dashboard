// Typed failures of the update check. Each carries a stable `code`, a
// user-facing `message` and an HTTP status for the backend routes. `detail` is
// extra technical context for logs — never a token, header or credential.
export class UpdateError extends Error {
  constructor(code, message, { status, detail, cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'UpdateError';
    this.code = code;
    this.status = status ?? STATUS[code] ?? 500;
    if (detail !== undefined) this.detail = detail;
  }
}

const STATUS = {
  offline: 503,
  timeout: 504,
  invalid_response: 502,
  malformed_version: 500,
  busy: 409,
  failed: 500,
};

// What users read. It names no hosting service and no address.
export const MESSAGES = {
  offline: 'K8Board could not reach the update service. Please check your network connection.',
  timeout: 'The update service took too long to respond. Please try again.',
  invalid_response: 'The update service returned a response K8Board could not read. Please try again later.',
  malformed_version: "K8Board can't read its own version number.",
  busy: 'K8Board is already checking for updates.',
  failed: 'K8Board could not check for updates. Please try again.',
};

export const updateError = (code, message, opts) =>
  new UpdateError(code, message || MESSAGES[code] || MESSAGES.failed, opts);
