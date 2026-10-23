import { useState } from 'react';
import { SevMini } from './severity';

// What to do about an image's vulnerabilities, from the server's
// remediation summary (lib/security-insights.mjs remediationFor): how many
// have a fix, where the fixes are (base image OS packages vs application
// dependencies), and the package upgrades that fix them — biggest wins first.

const SHOWN = 8;
const where = (u) => u.packagePath || (u.class === 'lang-pkgs' ? u.target : '') || '';

export default function Remediation({ image }) {
  const [all, setAll] = useState(false);
  const r = image?.remediation;
  if (!r || !r.total) return null;
  const vulns = image.vulnerabilities || [];
  const critHigh = vulns.filter((v) => v.severity === 'CRITICAL' || v.severity === 'HIGH').length;
  const critHighFix = (r.fixableBySeverity?.CRITICAL || 0) + (r.fixableBySeverity?.HIGH || 0);
  const upgrades = r.upgrades || [];
  const shown = all ? upgrades : upgrades.slice(0, SHOWN);
  const repo = image.repository || image.image;

  return (
    <section className="sec-fix" aria-label="Remediation">
      <h3 className="sec-drawer-section">Remediation</h3>
      <p className="sec-fix-lead">
        <strong>{r.fixable} of {r.total}</strong> vulnerabilities have a fix
        {critHigh ? <> — <strong>{critHighFix} of {critHigh}</strong> critical and high</> : null}.
      </p>
      <ul className="sec-fix-tips">
        {image.tag && (
          <li>
            <strong>Newer image.</strong> Check for a newer release of <code>{repo}</code> (this one is <code>{image.tag}</code>) — maintainers rebuild
            images with fixed packages, so upgrading the workload is often the quickest fix.
          </li>
        )}
        {r.osFixes > 0 && (
          <li>
            <strong>Base image.</strong> {r.osFixes} {r.osFixes === 1 ? 'fix is an' : 'fixes are'} operating-system package update{r.osFixes === 1 ? '' : 's'}
            {image.os ? <> ({image.os})</> : null}: rebuild the image on the latest patch of its base image, or upgrade the packages below in the Dockerfile.
          </li>
        )}
        {r.appFixes > 0 && (
          <li>
            <strong>Dependencies.</strong> {r.appFixes} {r.appFixes === 1 ? 'fix is a' : 'fixes are'} library upgrade{r.appFixes === 1 ? '' : 's'} in the application — bump the versions below and rebuild.
          </li>
        )}
        {r.noFix > 0 && (
          <li className="sec-dim">
            <strong>No fix yet.</strong> {r.noFix} {r.noFix === 1 ? 'has' : 'have'} no fixed version published. Check the advisories (linked in the table below) for mitigations, or consider a different base image.
          </li>
        )}
      </ul>

      {upgrades.length > 0 && (
        <div className="sec-fix-table-wrap">
          <table className="sec-fix-table">
            <caption className="sr-only">Package upgrades that fix vulnerabilities in {image.image}</caption>
            <thead>
              <tr><th scope="col">Package</th><th scope="col">Installed</th><th scope="col">Upgrade to</th><th scope="col">Fixes</th></tr>
            </thead>
            <tbody>
              {shown.map((u) => (
                <tr key={`${u.pkg}|${u.installedVersion}|${where(u)}`}>
                  <td>
                    <span className="sec-mono">{u.pkg}</span>
                    {where(u) ? <span className="sec-fix-where" title={where(u)}>{where(u)}</span> : null}
                  </td>
                  <td className="sec-mono sec-dim">{u.installedVersion}</td>
                  <td className="sec-mono sec-fix-to">{u.upgradeTo}</td>
                  <td><SevMini summary={u.bySeverity} /></td>
                </tr>
              ))}
            </tbody>
          </table>
          {upgrades.length > SHOWN && (
            <button type="button" className="sec-linkbtn" onClick={() => setAll((a) => !a)}>
              {all ? 'Show fewer' : `Show all ${upgrades.length} upgrades`}
            </button>
          )}
        </div>
      )}
    </section>
  );
}
