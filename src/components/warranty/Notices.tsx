import React from 'react';
import { X } from 'lucide-react';
import { FOCUS } from './ui';

/**
 * THE PAGE'S NOTICES STAY UNTIL THE CUSTOMER PUTS THEM AWAY.
 *
 * They used to vanish after six seconds — a customer who looked down at the
 * phone's keyboard, or who reads slowly in a second language, never saw «تم
 * إرسال المطالبة» at all. Each one now waits for its own X, may carry the one
 * action it is about («فتح المحادثة»), and is announced politely once.
 */
export interface PageNotice {
  id: string;
  tone: 'ok' | 'info' | 'warn';
  text: string;
  action?: { label: string; run: (trigger: HTMLElement) => void };
}

const TONE: Record<PageNotice['tone'], string> = {
  ok: 'lv-alert lv-alert-success',
  info: 'lv-alert lv-alert-info',
  warn: 'lv-alert lv-alert-warning',
};

export function NoticeStack({
  notices,
  onDismiss,
  dismissLabel,
}: {
  notices: PageNotice[];
  onDismiss: (id: string) => void;
  dismissLabel: string;
}) {
  return (
    <div aria-live="polite" className={notices.length ? 'space-y-2' : ''} data-warranty-notices>
      {notices.map((n) => (
        <div key={n.id} role="status" className={`${TONE[n.tone]} flex items-start gap-2`} data-warranty-notice={n.id}>
          <div className="min-w-0 flex-1">
            <p className="text-[13px] font-medium leading-relaxed text-text-primary">{n.text}</p>
            {n.action && (
              <button
                type="button"
                onClick={(e) => n.action!.run(e.currentTarget)}
                className={`mt-1 inline-flex min-h-[44px] items-center rounded text-[13px] font-bold text-text-primary underline underline-offset-2 ${FOCUS}`}
              >
                {n.action.label}
              </button>
            )}
          </div>
          <button
            type="button"
            onClick={() => onDismiss(n.id)}
            aria-label={dismissLabel}
            className={`-my-2 -me-2 inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-text-secondary hover:text-text-primary transition-colors ${FOCUS}`}
          >
            <X aria-hidden="true" className="w-4 h-4" />
          </button>
        </div>
      ))}
    </div>
  );
}
