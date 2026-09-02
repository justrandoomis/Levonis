import { useEffect, useState } from 'react';

/**
 * Is the viewport short — a phone browser with its bars, an iPad in
 * landscape? auth.css keys its compaction on the same query; this hook lets
 * the two provider buttons switch to their icon-only variants in step with
 * it (the Google mark is Google's own iframe, so its shape is a prop).
 */
const QUERY = '(max-height: 740px)';

export function useShortViewport(): boolean {
  const [short, setShort] = useState(() => typeof window !== 'undefined' && window.matchMedia(QUERY).matches);
  useEffect(() => {
    const mq = window.matchMedia(QUERY);
    const onChange = () => setShort(mq.matches);
    onChange();
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  return short;
}
