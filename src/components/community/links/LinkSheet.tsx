/**
 * «إرسال رابط» — the chat composer's link sheet (docs/COMMUNITY_ECOSYSTEM.md
 * §9.4 "Link cards"). One field, one button. The address is checked here
 * only for its shape (an http(s) address, at most 2 KB); everything else —
 * the host, the fetch, the card — is the server's, through
 * `POST /api/chats/:id/cards/link`, which the parent calls in `onSend`.
 *
 * The parent owns the send (it draws the optimistic bubble and keeps the
 * `client_id`); this sheet closes when it settles and, when it refuses,
 * says why under the field in the reader's language (LINK_URL_INVALID,
 * LINK_HOST_BLOCKED — src/lib/refusalStrings.ts) and keeps the address so
 * it can be corrected rather than retyped.
 *
 * A LAZY CHUNK: src/pages/Chat.tsx imports it the first time the action is
 * chosen, like the commerce sheets — a plain conversation never pays for it.
 */
import { useEffect, useRef, useState } from 'react';
import { useLanguage } from '../../../LanguageContext';
import { apiRefusal } from '../../../lib/refusalStrings';
import { Button } from '../../ui/Button';
import { Field, Input } from '../../ui/Field';
import { Sheet } from '../../ui/Sheet';
import { LINK_URL_MAX } from './api';
import { useLinkStrings } from './strings';

export interface LinkSheetProps {
  open: boolean;
  onClose: () => void;
  /** Send the address; reject with the server's refusal to keep the sheet open with the reason. */
  onSend: (url: string) => Promise<void>;
}

/** The shape the sheet accepts before the server sees it. */
export function looksLikeLink(value: string): boolean {
  const v = value.trim();
  return /^https?:\/\/\S+$/i.test(v) && v.length <= LINK_URL_MAX;
}

export default function LinkSheet({ open, onClose, onSend }: LinkSheetProps) {
  const s = useLinkStrings();
  const { lang } = useLanguage();
  const [url, setUrl] = useState('');
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setUrl('');
      setError(null);
    }
  }, [open]);

  const send = async () => {
    const value = url.trim();
    if (!looksLikeLink(value)) {
      setError(s.invalidUrl);
      inputRef.current?.focus();
      return;
    }
    setError(null);
    try {
      await onSend(value);
      onClose();
    } catch (e) {
      setError(apiRefusal(e, lang === 'en' ? 'en' : lang === 'ckb' ? 'ckb' : 'ar', s.fetchFailed));
      inputRef.current?.focus();
    }
  };

  return (
    <Sheet
      open={open}
      onClose={onClose}
      label={s.sendLink}
      dragHandle
      dirty={url.trim().length > 0}
      initialFocus={inputRef}
      testId="chat-link-sheet"
      header={
        <h2 className="px-4 pb-2 pt-1 text-[16px] font-bold text-text-primary" data-chat-link-title>
          {s.sendLink}
        </h2>
      }
      footer={
        <Button variant="primary" block onClick={send} disabled={!url.trim()} loadingLabel={s.sending} data-chat-link-send>
          {s.send}
        </Button>
      }
    >
      <div className="px-4 pb-4">
        <Field label={s.urlLabel} error={error}>
          <Input
            ref={inputRef}
            ltr
            type="url"
            inputMode="url"
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            enterKeyHint="send"
            value={url}
            maxLength={LINK_URL_MAX}
            placeholder={s.urlPlaceholder}
            onChange={(e) => {
              setUrl(e.target.value);
              if (error) setError(null);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                void send();
              }
            }}
            data-chat-link-url
          />
        </Field>
      </div>
    </Sheet>
  );
}
