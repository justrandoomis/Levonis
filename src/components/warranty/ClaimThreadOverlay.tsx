import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Paperclip, Send, X } from 'lucide-react';
import type { Language } from '../../translations';
import { api, ApiError, uploadTimeoutMs } from '../../lib/api';
import { Overlay } from '../ui/Overlay';
import { Skeleton, SkeletonGroup } from '../ui/Skeleton';
import { ErrorState } from '../ui/AsyncStates';
import { ClaimProgress, PriorityBadge } from './ClaimCard';
import type { ClaimDetail, ClaimMessage } from './types';
import { fmtDate, fmtDateTime, isVideoUrl } from './types';
import type { WarrantyStrings } from './strings';
import { ERROR_BOX, FOCUS, INPUT } from './ui';

const ACCEPT = 'image/jpeg,image/png,image/webp,image/gif,video/mp4';

/**
 * The conversation about one claim. `Overlay`, not `Sheet`: the middle is a
 * scrolling transcript and the bottom is a text field, so a vertical drag
 * already means two things here and must not mean "throw the window away"
 * as well. It grows out of the claim card that was tapped, and it keeps its
 * last transcript while it animates out so the window that leaves is the
 * window that was there.
 */
export function ClaimThreadOverlay({
  claimId,
  anchor,
  lang,
  s,
  onClose,
  notice = '',
}: {
  claimId: string | null;
  anchor: React.RefObject<HTMLElement | null>;
  lang: Language;
  s: WarrantyStrings;
  onClose: () => void;
  /** Said at the top of the thread — the replayed-submit warning, which the
   *  page cannot show behind this window. */
  notice?: string;
}) {
  const [detail, setDetail] = useState<ClaimDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [replyText, setReplyText] = useState('');
  const [replyBusy, setReplyBusy] = useState(false);
  const [replyError, setReplyError] = useState('');
  const listRef = useRef<HTMLDivElement | null>(null);

  const load = useCallback(async (id: string) => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.get<ClaimDetail>(`/api/devices/claims/${encodeURIComponent(id)}`);
      setDetail(res);
    } catch (e) {
      setError(e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!claimId) return;
    // Every open starts clean; nothing stale can show. Closing does NOT clear
    // the transcript — that only emptied the panel while it was still leaving.
    setDetail(null);
    setReplyText('');
    setReplyError('');
    load(claimId);
  }, [claimId, load]);

  useEffect(() => {
    const el = listRef.current;
    if (el && detail) el.scrollTop = el.scrollHeight;
  }, [detail]);

  const refresh = async () => {
    if (!claimId) return;
    const res = await api.get<ClaimDetail>(`/api/devices/claims/${encodeURIComponent(claimId)}`);
    setDetail(res);
  };

  /**
   * THE SENT MESSAGE IS APPENDED, NOT THE THREAD RELOADED. The route answers
   * with the row it stored, so the bubble appears where the customer is
   * looking instead of the whole conversation being fetched again behind it.
   * A server that predates that answer (no `message`) still gets the reload.
   */
  const appendOrRefresh = async (res: { message?: ClaimMessage }) => {
    const m = res.message;
    if (m) setDetail((d) => (d ? { ...d, messages: [...d.messages, m] } : d));
    else await refresh();
  };

  const send = async () => {
    if (!claimId || replyBusy || !replyText.trim()) return;
    setReplyBusy(true);
    setReplyError('');
    try {
      const res = await api.post<{ message?: ClaimMessage }>(`/api/devices/claims/${encodeURIComponent(claimId)}/messages`, {
        body: replyText.trim(),
      });
      setReplyText('');
      await appendOrRefresh(res);
    } catch (e) {
      setReplyError(e instanceof ApiError ? e.message : s.error);
    } finally {
      setReplyBusy(false);
    }
  };

  const attach = async (files: FileList | null) => {
    if (!files || files.length === 0 || !claimId || replyBusy) return;
    setReplyBusy(true);
    setReplyError('');
    try {
      const form = new FormData();
      form.append('file', files[0]);
      // Same deadline the claim form uses, and for the same reason: a
      // 40 MB video cannot clear DEFAULT_TIMEOUT_MS, and the abort reaches the
      // customer as "Network error" — blaming a connection that was working.
      // See uploadTimeoutMs in src/lib/api.ts.
      const up = await api.post<{ key: string }>('/api/devices/claims/upload', form, {
        timeoutMs: uploadTimeoutMs(files[0].size),
      });
      const res = await api.post<{ message?: ClaimMessage }>(`/api/devices/claims/${encodeURIComponent(claimId)}/messages`, {
        body: replyText.trim(),
        file_key: up.key,
      });
      setReplyText('');
      await appendOrRefresh(res);
    } catch (e) {
      setReplyError(e instanceof ApiError ? e.message : s.error);
    } finally {
      setReplyBusy(false);
    }
  };

  const facts = detail?.warranty_facts;

  return (
    <Overlay
      open={!!claimId}
      onClose={onClose}
      labelledBy="warranty-thread-title"
      anchor={anchor}
      dismissOnScrim={false}
      z={60}
      testId="warranty-claim-thread"
      panelClassName="w-full max-w-md max-h-[90vh] flex flex-col overflow-hidden"
    >
      <div className="p-5 border-b border-zinc-800/70 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 min-w-0">
            <h2 id="warranty-thread-title" className="text-white text-base font-bold truncate">
              {detail?.claim.subject ?? s.thread}
            </h2>
            {detail?.claim.priority && <PriorityBadge s={s} />}
          </div>
          {facts && (
            <p className="text-zinc-500 text-[11px] mt-1 tabular-nums">
              {facts.order_id && (
                <>
                  {s.orderRef}: <span dir="ltr" className="font-mono">{facts.order_id}</span>
                  {' · '}
                </>
              )}
              {s.deliveredAt}: {fmtDate(facts.delivered_at, lang)}
              {' · '}
              {s.warrantyEnd}: {fmtDate(facts.warranty_end_at, lang)}
            </p>
          )}
        </div>
        <button
          type="button"
          onClick={onClose}
          className={`p-2 text-zinc-500 hover:text-white bg-zinc-900 rounded-full transition-colors shrink-0 ${FOCUS}`}
          aria-label={s.close}
        >
          <X aria-hidden="true" className="w-4 h-4" />
        </button>
      </div>

      <div ref={listRef} className="p-5 overflow-y-auto flex-1 space-y-3 min-h-[160px]">
        {loading && (
          <SkeletonGroup className="space-y-3">
            <Skeleton className="h-3 w-full" />
            <Skeleton className="h-16 w-full rounded-xl" />
            <Skeleton className="h-10 w-3/4 rounded-xl" />
            <Skeleton className="h-10 w-2/3 rounded-xl ms-auto" />
          </SkeletonGroup>
        )}
        {error != null && !loading && <ErrorState error={error} onRetry={() => claimId && load(claimId)} compact />}
        {notice && (
          <div
            role="status"
            className="bg-amber-500/10 border border-amber-500/30 text-amber-200 text-[13px] font-medium rounded-xl p-3"
            data-claim-thread-notice
          >
            {notice}
          </div>
        )}
        {detail && (
          <>
            <p className="text-zinc-500 text-[12px] leading-relaxed" data-claim-thread-intro>
              {s.threadIntro}
            </p>
            <ClaimProgress stage={detail.claim.stage} s={s} className="mb-4" />
            <div className="bg-zinc-900/70 rounded-xl px-3 py-2 text-sm text-zinc-300 whitespace-pre-wrap">{detail.claim.description}</div>
            {detail.claim.evidence.length > 0 && (
              <div className="flex gap-2 flex-wrap">
                {detail.claim.evidence.map((ev) => (
                  <a
                    key={ev.key}
                    href={ev.url}
                    target="_blank"
                    rel="noreferrer"
                    className={`block w-16 h-16 rounded-lg overflow-hidden border border-zinc-800 bg-zinc-950 ${FOCUS}`}
                  >
                    {isVideoUrl(ev.key) || isVideoUrl(ev.url) ? (
                      <span className="w-full h-full flex items-center justify-center text-[9px] text-zinc-400">MP4</span>
                    ) : (
                      <img src={ev.url} alt="" className="w-full h-full object-cover" loading="lazy" />
                    )}
                  </a>
                ))}
              </div>
            )}
            {detail.claim.decision_reason && (
              <p className="text-zinc-400 text-[12px]">
                <span className="text-zinc-300 font-bold">{s.decisionReason}:</span> {detail.claim.decision_reason}
              </p>
            )}
            {detail.claim.admin_note && (
              <p className="text-zinc-400 text-[12px]">
                <span className="text-zinc-300 font-bold">{s.adminNote}:</span> {detail.claim.admin_note}
              </p>
            )}
            {detail.messages.map((msg) => (
              <div
                key={msg.id}
                className={`max-w-[85%] rounded-xl px-3 py-2 text-sm ${
                  msg.mine ? 'bg-[#BAA369]/15 border border-[#BAA369]/20 text-zinc-100 ms-auto' : 'bg-zinc-800/70 text-zinc-200'
                }`}
              >
                {msg.body && <p className="whitespace-pre-wrap break-words">{msg.body}</p>}
                {msg.file_url && (
                  <a href={msg.file_url} target="_blank" rel="noreferrer" className={`block mt-1 rounded-lg ${FOCUS}`}>
                    {isVideoUrl(msg.file_url) ? (
                      <video src={msg.file_url} controls preload="none" className="max-h-40 rounded-lg" />
                    ) : (
                      <img src={msg.file_url} alt="" className="max-h-40 rounded-lg" loading="lazy" />
                    )}
                  </a>
                )}
                <time dateTime={msg.created_at} className="block text-[10px] text-zinc-500 mt-1 tabular-nums">
                  {fmtDateTime(msg.created_at, lang)}
                </time>
              </div>
            ))}
          </>
        )}
      </div>

      <div className="p-4 border-t border-zinc-800/70">
        {replyError && (
          <div role="alert" className={`${ERROR_BOX} mb-2`}>
            {replyError}
          </div>
        )}
        <div className="flex items-center gap-2">
          <label
            htmlFor="warranty-thread-file"
            className={`p-2.5 min-h-[44px] min-w-[44px] inline-flex items-center justify-center bg-zinc-900 border border-zinc-800 rounded-xl text-zinc-400 hover:text-white cursor-pointer transition-colors shrink-0 focus-within:ring-2 focus-within:ring-[#BAA369] ${
              replyBusy ? 'opacity-50 pointer-events-none' : ''
            }`}
          >
            <Paperclip aria-hidden="true" className="w-4 h-4" />
            <span className="sr-only">{s.attach}</span>
            <input
              id="warranty-thread-file"
              type="file"
              accept={ACCEPT}
              className="sr-only"
              disabled={replyBusy}
              onChange={(e) => {
                attach(e.target.files);
                e.target.value = '';
              }}
            />
          </label>
          <input
            value={replyText}
            onChange={(e) => setReplyText(e.target.value)}
            placeholder={s.reply}
            aria-label={s.reply}
            maxLength={3000}
            className={INPUT}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
          />
          <button
            type="button"
            onClick={send}
            disabled={replyBusy || !replyText.trim()}
            className={`p-2.5 min-h-[44px] min-w-[44px] inline-flex items-center justify-center bg-[#BAA369]/15 text-[#BAA369] border border-[#BAA369]/30 rounded-xl hover:bg-[#BAA369]/25 disabled:opacity-40 transition-colors shrink-0 ${FOCUS}`}
            aria-label={s.send}
          >
            <Send aria-hidden="true" className={`w-4 h-4 ${lang === 'en' ? '' : '-scale-x-100'}`} />
          </button>
        </div>
      </div>
    </Overlay>
  );
}
