// How discovered EKS clusters relate to the loaded kubeconfig (pure helpers).
// Used by the AWS import dialog to say what a fresh sign-in means for each
// cluster, and by the import to never overwrite a different cluster that
// happens to use the same context name.

// Value of `--flag value` or `--flag=value` in exec args.
export function execArg(args, ...flags) {
  for (const f of flags) {
    const i = args.indexOf(f);
    if (i >= 0 && i + 1 < args.length) return String(args[i + 1]);
    const eq = args.find((a) => a.startsWith(`${f}=`));
    if (eq) return eq.slice(f.length + 1);
  }
  return undefined;
}

/**
 * The EKS identity of kubeconfig context `name`, read from its user's exec
 * args: our token helper (`--cluster/--region/--profile`) and
 * `aws eks get-token` (`--cluster-name/--region`, AWS_PROFILE env) both match.
 * null when no context has that name. `kc` is a client-node KubeConfig.
 */
export function eksEntryFor(kc, name) {
  const ctx = (kc?.contexts || []).find((c) => c.name === name);
  if (!ctx) return null;
  const user = (kc?.users || []).find((u) => u.name === ctx.user);
  const args = Array.isArray(user?.exec?.args) ? user.exec.args.map(String) : [];
  const envProfile = Array.isArray(user?.exec?.env) ? user.exec.env.find((e) => e?.name === 'AWS_PROFILE')?.value : undefined;
  return { cluster: execArg(args, '--cluster', '--cluster-name'), region: execArg(args, '--region'), profile: execArg(args, '--profile') ?? envProfile };
}

/** Same EKS cluster (name, and region when recorded)? Only then may an entry be rewritten. */
export const sameEksCluster = (entry, c) => !!entry && entry.cluster === c.name && (!entry.region || entry.region === c.region);

/**
 * Each discovered cluster with its relation to the kubeconfig:
 *   imported  a context with this name exists
 *   conflict  …but it is a different cluster or config (never overwritten)
 *   current   …and it already authenticates with this sign-in (nothing to do)
 * `auth`: { sso: { startUrl, account, role } } or { profile }.
 * `profiles`: aws-eks listProfiles() output (needed for SSO sign-ins).
 */
export function eksClusterStatus(kc, clusters, auth, profiles = []) {
  return clusters.map((c) => {
    const base = { name: c.name, region: c.region, ...(c.account ? { account: c.account } : {}) };
    const entry = eksEntryFor(kc, c.name);
    if (!entry) return { ...base, imported: false };
    if (!sameEksCluster(entry, c)) return { ...base, imported: true, conflict: true };
    let current;
    if (auth?.sso) {
      const p = profiles.find((x) => x.name === entry.profile);
      current = !!p && p.ssoStartUrl === auth.sso.startUrl && String(p.ssoAccountId) === String(auth.sso.account) && p.ssoRoleName === auth.sso.role;
    } else {
      current = (entry.profile || '') === (auth?.profile || '');
    }
    return { ...base, imported: true, current };
  });
}
