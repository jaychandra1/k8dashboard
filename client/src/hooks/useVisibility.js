import { useEffect, useState } from 'react';

/** true while the document is visible (tab focused / window not minimised). */
export default function useVisibility() {
  const [visible, setVisible] = useState(() => (typeof document === 'undefined' ? true : !document.hidden));
  useEffect(() => {
    const on = () => setVisible(!document.hidden);
    document.addEventListener('visibilitychange', on);
    return () => document.removeEventListener('visibilitychange', on);
  }, []);
  return visible;
}

export { useVisibility };
