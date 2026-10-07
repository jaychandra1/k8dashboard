// Typed updater failures. Every step of the release / update flow throws an
// UpdateError with a stable `code` the UI keys its dialogs on, a user-facing
// `message`, and an HTTP status for the backend routes. `detail` is extra
// technical context for logs — never a token, header or credential.
export class UpdateError extends Error {
  constructor(code, message, { status, retryable, detail, cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'UpdateError';
    this.code = code;
    this.status = status ?? STATUS[code] ?? 500;
    this.retryable = retryable ?? RETRYABLE.has(code);
    if (detail !== undefined) this.detail = detail;
  }
}

const STATUS = {
  offline: 503,
  timeout: 504,
  rate_limited: 429,
  github_unavailable: 502,
  invalid_response: 502,
  no_releases: 404,
  malformed_version: 502,
  no_asset_for_os: 404,
  no_asset_for_arch: 404,
  download_failed: 502,
  cancelled: 409,
  verification_unavailable: 422,
  verification_failed: 422,
  unsupported: 501,
  busy: 409,
  invalid_state: 409,
  installer_launch_failed: 500,
  install_failed: 500,
  permission_denied: 403,
  restart_failed: 500,
};

const RETRYABLE = new Set([
  'offline',
  'timeout',
  'rate_limited',
  'github_unavailable',
  'invalid_response',
  'download_failed',
  'verification_failed',
  'installer_launch_failed',
  'install_failed',
  'permission_denied',
]);

// Default user-facing copy, used when a step has nothing more specific to say.
export const MESSAGES = {
  offline: 'KubePilot could not connect to GitHub. Please check your network connection.',
  timeout: 'GitHub took too long to respond. Please try again.',
  rate_limited: 'GitHub is limiting requests from your network right now. Please try again later.',
  github_unavailable: 'GitHub is not available right now. Please try again later.',
  invalid_response: 'GitHub returned a response KubePilot could not read. Please try again later.',
  no_releases: 'No KubePilot releases have been published yet.',
  malformed_version: 'The latest KubePilot release has a version number KubePilot could not read.',
  download_failed: 'The update could not be downloaded. Please check your network connection and try again.',
  cancelled: 'The update was cancelled.',
  verification_failed: 'The downloaded KubePilot update could not be verified and will not be installed.',
  install_failed:
    'The update could not be installed. Your existing KubePilot installation has not been modified.',
  installer_launch_failed:
    'The KubePilot installer could not be started. Your existing KubePilot installation has not been modified.',
  permission_denied:
    'KubePilot does not have permission to install the update. Your existing KubePilot installation has not been modified.',
  restart_failed: 'KubePilot could not restart itself. Close and reopen KubePilot to finish the update.',
};

export const updateError = (code, message, opts) =>
  new UpdateError(code, message || MESSAGES[code] || 'The update failed.', opts);

// JSON body for an error response / state snapshot.
export const errorBody = (err) =>
  err instanceof UpdateError
    ? { code: err.code, message: err.message, retryable: err.retryable }
    : { code: 'install_failed', message: MESSAGES.install_failed, retryable: true };
