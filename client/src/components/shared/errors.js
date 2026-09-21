// Error-title helpers shared by the Argo CD / Security / Custom Resource views.
// The backend answers 403 with `code: 'forbidden'` when the kube RBAC role
// can't read something — say so instead of a generic "failed".

export const isForbidden = (err) => !!err && (err.status === 403 || err.code === 'forbidden');
export const isNotFound = (err) => !!err && (err.status === 404 || err.code === 'not_found');
export const isUpstream = (err) => !!err && (err.status === 502 || err.status === 503 || err.status === 504);

/** "Your RBAC role can't read X" for 403, "X not found" for 404, else "Couldn't load X". */
export function errorTitle(err, what, { notFound } = {}) {
  if (isForbidden(err)) return `Your RBAC role can't read ${what}`;
  if (isNotFound(err)) return notFound || `${what[0].toUpperCase()}${what.slice(1)} not found`;
  if (isUpstream(err)) return `The cluster didn't answer for ${what}`;
  return `Couldn't load ${what}`;
}
