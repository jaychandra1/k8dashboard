// Image references are long and mostly the same registry prefix (an ECR host
// is ~50 characters before the repository), so a table cell truncated from the
// right showed only the prefix. Show the image's own name (repo:tag) first,
// with where it comes from on a dim second line, and the whole reference on
// hover. Environment identifiers (AWS account ids in ECR hosts, IPs) are
// masked like everywhere else in the UI.
import { redactSensitive } from '../../lib/redact';

const isRegistry = (seg) => seg.includes('.') || seg.includes(':') || seg === 'localhost';

/**
 * "123456789012.dkr.ecr.eu-west-1.amazonaws.com/team/api:1.2" →
 * { name: 'api:1.2', location: '••••9012.dkr.ecr.eu-west-1.amazonaws.com/team', full: '…' }
 * (masked). Docker Hub images keep their namespace in the name: "grafana/grafana:10.4".
 */
export function splitImage(ref) {
  const full = redactSensitive(String(ref || ''));
  const parts = full.split('/');
  if (parts.length === 1) return { name: full, location: '', full };
  const registry = isRegistry(parts[0]) ? parts.shift() : '';
  // Without a registry (Docker Hub) "org/name" reads as one name.
  if (!registry) return { name: parts.join('/'), location: '', full };
  const name = parts.pop();
  return { name, location: [registry, ...parts].join('/'), full };
}

/** Masked full reference, for titles, captions and accessible names. */
export const displayImage = (ref) => redactSensitive(String(ref || ''));

export default function ImageName({ image, badge }) {
  const { name, location } = splitImage(image);
  return (
    <span className="sec-imgname">
      <span className="sec-imgname-main">
        <span className="sec-imgname-text">{name}</span>
        {badge}
      </span>
      {location && <span className="sec-imgname-loc">{location}</span>}
    </span>
  );
}
