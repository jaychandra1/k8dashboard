import Modal from '../ui/Modal';

export const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || '');
export const MOD = IS_MAC ? '⌘' : 'Ctrl';

const GROUPS = [
  { title: 'Global', rows: [
    { keys: [`${MOD} K`], what: 'Open the command palette' },
    { keys: ['?'], what: 'Show this shortcuts sheet' },
    { keys: ['/'], what: 'Focus the search box of the current view' },
    { keys: ['Esc'], what: 'Close the drawer, menu, dialog or navigation' },
  ] },
  { title: 'Tables & lists', rows: [
    { keys: ['↑', '↓'], what: 'Move between rows' },
    { keys: ['Home', 'End'], what: 'First / last row' },
    { keys: ['Enter'], what: 'Open the selected row' },
    { keys: ['Shift F10'], what: 'Open the row actions menu' },
  ] },
  { title: 'YAML editor', rows: [
    { keys: [`${MOD} S`], what: 'Apply the YAML' },
  ] },
];

/** Keyboard shortcuts help, opened with `?`. */
export default function ShortcutsSheet({ open, onClose }) {
  return (
    <Modal open={open} onClose={onClose} title="Keyboard shortcuts" size="md" icon="details" className="shortcuts-sheet">
      {GROUPS.map((g) => (
        <section key={g.title} className="shortcuts-group" aria-labelledby={`sc-${g.title}`}>
          <h3 id={`sc-${g.title}`} className="shortcuts-title">{g.title}</h3>
          <table className="shortcuts-table">
            <thead className="sr-only"><tr><th scope="col">Keys</th><th scope="col">Action</th></tr></thead>
            <tbody>
              {g.rows.map((r) => (
                <tr key={r.what}>
                  <td className="shortcuts-keys">{r.keys.map((k) => <kbd key={k} className="cmdk-kbd">{k}</kbd>)}</td>
                  <td>{r.what}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ))}
    </Modal>
  );
}

export { ShortcutsSheet };
