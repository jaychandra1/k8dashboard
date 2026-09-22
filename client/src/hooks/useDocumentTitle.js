import { useEffect } from 'react';

const BASE = 'k8dashboard';

/** Sets document.title to "<title> · k8dashboard" while mounted; restores on unmount. */
export default function useDocumentTitle(title, { suffix = true } = {}) {
  useEffect(() => {
    if (typeof document === 'undefined') return undefined;
    const prev = document.title;
    document.title = title ? (suffix ? `${title} · ${BASE}` : title) : BASE;
    return () => { document.title = prev; };
  }, [title, suffix]);
}

export { useDocumentTitle };
