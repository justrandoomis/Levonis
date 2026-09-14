import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError } from './api';
import { mascot } from './mascot';

/** The same hook serves customer/merchant chat and the admin order thread.
 * Local edits ONLY publish a boolean. Only the participant-filtered server
 * response may acquire a mascot typing lease. No text leaves via presence.
 */
export function useChatPresence(chatId: string | undefined | null, enabled = true) {
  const [typing, setTyping] = useState(false);
  const editRef = useRef<(hasText: boolean) => void>(() => {});
  const stopRef = useRef<() => void>(() => {});
  useEffect(() => {
    if (!chatId || !enabled) { setTyping(false); return; }
    const endpoint = `/api/chats/${encodeURIComponent(chatId)}/typing`;
    setTyping(false);
    let alive = true;
    let polling = false;
    let denied = false;
    let pollTimer: ReturnType<typeof setTimeout> | undefined;
    let expiry: ReturnType<typeof setTimeout> | undefined;
    let stopTimer: ReturnType<typeof setTimeout> | undefined;
    let releaseTyping: (() => void) | undefined;
    let pollController: AbortController | undefined;
    let publishing = false;
    let wanted = false;
    let announced = false;
    let sentAt = 0;
    const clearRemote = () => {
      clearTimeout(expiry); releaseTyping?.(); releaseTyping = undefined;
      if (alive) setTyping(false);
    };
    // Serialize start/stop so a late start response cannot overtake stop.
    const publish = (value: boolean) => {
      wanted = value;
      if (denied || publishing || (value && (!alive || document.hidden))) return;
      if (value === announced && (!value || Date.now() - sentAt < 2500)) return;
      publishing = true; sentAt = Date.now();
      void api.post(endpoint, { typing: value }, { mascot: 'silent', timeoutMs: 5000 })
        .then(() => { announced = value; })
        .catch((e: unknown) => { if (e instanceof ApiError && [401,403,404].includes(e.status)) denied = true; })
        .finally(() => { publishing = false; if (wanted !== value) publish(wanted); });
    };
    const stop = () => { clearTimeout(stopTimer); publish(false); };
    const poll = async () => {
      if (!alive || denied || document.hidden || polling) return;
      polling = true;
      pollController = new AbortController();
      try {
        const result = await api.get<{ typing: boolean; remainingMs: number }>(endpoint,
          { mascot: 'silent', timeoutMs: 5000, signal: pollController.signal });
        if (!alive || document.hidden) return;
        clearTimeout(expiry);
        const ttl = Number.isFinite(result.remainingMs) ? Math.min(7000, Math.max(0, result.remainingMs)) : 0;
        if (result.typing === true && ttl > 0) {
          if (!releaseTyping) releaseTyping = mascot.begin('typing');
          setTyping(true); expiry = setTimeout(clearRemote, ttl);
        } else clearRemote();
      } catch (e) {
        clearRemote();
        if (e instanceof ApiError && [401,403,404].includes(e.status)) denied = true;
      } finally {
        polling = false;
        if (alive && !denied && !document.hidden) pollTimer = setTimeout(poll, 2000);
      }
    };
    editRef.current = (hasText) => {
      if (!hasText) { stop(); return; }
      publish(true);
      clearTimeout(stopTimer); stopTimer = setTimeout(stop, 1800);
    };
    stopRef.current = stop;
    const visibility = () => {
      clearTimeout(pollTimer);
      if (document.hidden) { pollController?.abort(); stop(); clearRemote(); }
      else void poll();
    };
    document.addEventListener('visibilitychange', visibility);
    window.addEventListener('pagehide', stop);
    void poll();
    return () => {
      alive = false; stop(); clearRemote(); clearTimeout(pollTimer); pollController?.abort();
      editRef.current = () => {}; stopRef.current = () => {};
      document.removeEventListener('visibilitychange', visibility);
      window.removeEventListener('pagehide', stop);
    };
  }, [chatId, enabled]);
  return { typing, onEdit: useCallback((text: string) => editRef.current(text.trim().length > 0), []),
    onStop: useCallback(() => stopRef.current(), []) };
}
