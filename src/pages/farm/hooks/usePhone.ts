import { useEffect, useState } from 'react';

const PHONE_QUERY = '(max-width: 639px)';

/** Sheet on a phone, anchored window from 640px — the PurchaseConfirm rule. */
export function usePhone(): boolean {
  const [phone, setPhone] = useState(() => typeof window !== 'undefined' && window.matchMedia(PHONE_QUERY).matches);
  useEffect(() => {
    const mq = window.matchMedia(PHONE_QUERY);
    const onChange = () => setPhone(mq.matches);
    onChange();
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  return phone;
}
