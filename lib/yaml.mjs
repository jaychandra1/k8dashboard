// The app's YAML (js-yaml 5), set up the way Kubernetes tooling reads it.
//
//   load / loadAll  YAML 1.2 core schema plus `<<` merge keys. kubectl resolves
//                   anchors merged with `<<: *base`, so a manifest that applies
//                   with kubectl applies here too; js-yaml 5's default schema
//                   would keep "<<" as a field. Scalars stay as written:
//                   `2024-01-01` stays that string (js-yaml 4 turned it into a
//                   Date and changed the value on the way back out), and only
//                   true/false are booleans.
//   dump            js-yaml's default (DUMP_SCHEMA): any string another parser
//                   could read differently — yes, on, 0755, 12:30, a date — is
//                   quoted, so Kubernetes' YAML 1.1 reader gets the same value.
//                   js-yaml 5 only dumps plain objects, and the Kubernetes
//                   client returns class instances (V1Pod, V1Secret, …), so
//                   those are copied to plain objects first — the same fields
//                   js-yaml 4 wrote.
import * as jsYaml from 'js-yaml';

const LOAD_SCHEMA = jsYaml.CORE_SCHEMA.withTags(jsYaml.mergeTag);

/**
 * Class instances → plain objects (own enumerable fields), recursively. Dates
 * and binary data are kept as they are; an object referenced twice stays one
 * object, so `noRefs: false` still writes an anchor.
 */
export function toPlain(value, seen = new WeakMap()) {
  if (value === null || typeof value !== 'object') return value;
  if (value instanceof Date || ArrayBuffer.isView(value)) return value;
  if (seen.has(value)) return seen.get(value);
  if (Array.isArray(value)) {
    const out = [];
    seen.set(value, out);
    for (const item of value) out.push(toPlain(item, seen));
    return out;
  }
  const out = {};
  seen.set(value, out);
  for (const [k, v] of Object.entries(value)) out[k] = toPlain(v, seen);
  return out;
}

export const load = (text, options = {}) => jsYaml.load(text, { schema: LOAD_SCHEMA, ...options });
export const loadAll = (text, options = {}) => jsYaml.loadAll(text, { schema: LOAD_SCHEMA, ...options });
export const dump = (value, options) => jsYaml.dump(toPlain(value), options);
export const { YAMLException } = jsYaml;

export default { load, loadAll, dump, YAMLException };
