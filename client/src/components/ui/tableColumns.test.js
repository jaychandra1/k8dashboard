import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { HEADER_ROOM, nameRoom } from './tableColumns';

describe('table column helpers', () => {
  it('a header needs room for its label in capitals, the padding and the sort arrow', () => {
    expect(HEADER_ROOM('Age')).toBe(74);
    expect(HEADER_ROOM('Namespace')).toBe(125);
    expect(HEADER_ROOM('Vulnerabilities')).toBe(176);
  });

  it('the room a list of names needs follows its longest name', () => {
    expect(nameRoom([])).toBe(56);
    expect(nameRoom([{ name: 'short' }, {}, null, { name: 'x'.repeat(40) }])).toBe(56 + 264);
  });
});

// Every table in the app is a <DataTable>, where a column is exactly as wide as
// it says. A column added without a width would be sized by whichever rows are
// rendered again, so the table would move as rows scroll or sort into view.
describe('every table names a width for every column', () => {
  const SRC = path.resolve(__dirname, '..', '..');
  const files = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.jsx$/.test(e.name) && !/\.test\.jsx$/.test(e.name)) files.push(p);
    }
  };
  walk(SRC);
  const tables = files
    .map((f) => ({ f, rel: path.relative(SRC, f).replace(/\\/g, '/'), src: fs.readFileSync(f, 'utf8') }))
    // (ui/DataTable.jsx is the table itself; resources/columns.jsx only mentions it, and has its own test.)
    .filter((t) => /<DataTable\b/.test(t.src) && !['components/ui/DataTable.jsx', 'components/resources/columns.jsx'].includes(t.rel));
  // A column definition: an object that starts with `key: '…', header:`.
  const columnsOf = (src) => {
    const out = [];
    const re = /\{\s*key: '([\w]+)', header: /g;
    let m;
    while ((m = re.exec(src))) {
      // The object literal: from this `{` to its matching `}`.
      let depth = 0;
      let end = m.index;
      for (let i = m.index; i < src.length; i++) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}' && --depth === 0) { end = i; break; }
      }
      out.push({ key: m[1], body: src.slice(m.index, end + 1) });
    }
    return out;
  };

  it('finds the tables (so this test is looking at something)', () => {
    expect(tables.map((t) => t.rel).sort()).toEqual([
      'components/AccessControl.jsx',
      'components/CustomResourceDetail.jsx',
      'components/Events.jsx',
      'components/Helm.jsx',
      'components/Namespaces.jsx',
      'components/Nodes.jsx',
      'components/ResourceViewer.jsx',
      'components/Topology.jsx',
      'components/argocd/AppResourceGraph.jsx',
      'components/argocd/AppsTable.jsx',
      'components/argocd/SimpleTables.jsx',
      'components/security/ChecksTable.jsx',
      'components/security/FindingDrawer.jsx',
      'components/security/VulnTable.jsx',
    ]);
  });

  it('no column is left to be sized by its cells, and no table turns fixed widths off', () => {
    let seen = 0;
    for (const t of tables) {
      expect(t.src, `${t.rel} turns fixedColumns off`).not.toMatch(/fixedColumns=\{false\}/);
      for (const col of columnsOf(t.src)) {
        seen++;
        expect(/\bwidth: /.test(col.body), `${t.rel}: column "${col.key}" has no width`).toBe(true);
      }
    }
    // The resource lists' columns live in resources/columns.jsx (checked by columns.test.jsx).
    expect(seen).toBeGreaterThan(80);
  });

  it('each table has exactly one column that takes the spare room', () => {
    // One `fill` per column set; files with several tables (or two variants of one) have as many.
    const fills = Object.fromEntries(tables.map((t) => [t.rel, (t.src.match(/\bfill: true\b/g) || []).length]));
    expect(fills).toEqual({
      'components/AccessControl.jsx': 1,
      'components/CustomResourceDetail.jsx': 1,
      'components/Events.jsx': 1,
      'components/Helm.jsx': 1,
      'components/Namespaces.jsx': 1,
      'components/Nodes.jsx': 2,
      'components/ResourceViewer.jsx': 0, // columnsFor() marks the last column
      'components/Topology.jsx': 1,
      'components/argocd/AppResourceGraph.jsx': 1,
      'components/argocd/AppsTable.jsx': 1,
      'components/argocd/SimpleTables.jsx': 4,
      'components/security/ChecksTable.jsx': 1,
      'components/security/FindingDrawer.jsx': 1,
      'components/security/VulnTable.jsx': 3,
    });
  });
});
