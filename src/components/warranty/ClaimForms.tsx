import React, { useEffect, useRef, useState } from 'react';
import { Paperclip, X } from 'lucide-react';
import type { Language } from '../../translations';
import { api, ApiError, newIdempotencyKey, uploadTimeoutMs } from '../../lib/api';
import { Overlay } from '../ui/Overlay';
import type { Attachment, Device } from './types';
import { productName } from './types';
import type { WarrantyStrings } from './strings';
import { BTN_PRIMARY, ERROR_BOX, FOCUS, INPUT } from './ui';

/**
 * The claim form. `Overlay`, not `Sheet`: a drag-to-dismiss gesture over a
 * form with typed text and freshly uploaded evidence is a way to lose work,
 * not a way to close a window. It grows out of the control that raised it
 * (`anchor`) so, in a stack of near-identical device cards, the window itself
 * says which printer it is about. The scrim is inert for the same reason;
 * Escape and the X close.
 *
 * THERE WAS A SECOND FORM HERE, AND THE OWNER REMOVED IT: «يحذف — فالضمان
 * للطابعات فقط». `LegacyClaimOverlay` raised «منتج غير مرتبط كطابعة؟ قدّم
 * مطالبة عامة» and posted the free-form claim at POST
 * /api/profile/warranty-claims. Only the AFFORDANCE is gone. That route still
 * exists and is not sealed: it is the only writer of `warranty_claims` rows
 * with `unit_id IS NULL`, and both GET /api/devices/claims and the admin queue
 * LIST those rows — the general claims customers already filed must stay
 * visible and answerable. Nothing new opens one.
 */

const ACCEPT = 'image/jpeg,image/png,image/webp,image/gif,video/mp4';
const MAX_ATTACHMENTS = 6;

function CloseX({ onClick, label }: { onClick: () => void; label: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      className={`absolute top-4 end-4 p-2 text-zinc-500 hover:text-white bg-zinc-900 rounded-full transition-colors ${FOCUS}`}
    >
      <X aria-hidden="true" className="w-4 h-4" />
    </button>
  );
}

function Field({ id, label, children }: { id: string; label: string; children: React.ReactNode }) {
  return (
    <div>
      <label htmlFor={id} className="text-[12px] text-zinc-400 mb-1.5 block font-medium">
        {label}
        <span className="text-red-400" aria-hidden="true">
          *
        </span>
      </label>
      {children}
    </div>
  );
}

// ------------------------------------------------------- device claim form

export function DeviceClaimOverlay({
  device,
  anchor,
  lang,
  s,
  onClose,
  onSubmitted,
}: {
  /** The device the claim is about; null when the window is closed. */
  device: Device | null;
  anchor: React.RefObject<HTMLElement | null>;
  lang: Language;
  s: WarrantyStrings;
  onClose: () => void;
  /**
   * `replay` is the route's own word that this press landed on a claim
   * ALREADY recorded under this window's key — see `submit` below.
   */
  onSubmitted: (result: { id: string; replay: boolean }) => void;
}) {
  // The window must keep its contents while it animates OUT: `device` is the
  // open flag AND the data, so the last one is held for the exit.
  const lastDevice = useRef<Device | null>(null);
  if (device) lastDevice.current = device;
  const shown = device ?? lastDevice.current;

  const [subject, setSubject] = useState('');
  const [description, setDescription] = useState('');
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [uploadBusy, setUploadBusy] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  /**
   * ONE KEY PER OPEN — the overlay's half of the replay guard the route
   * describes (worker/routes/devices.ts, POST /units/:unitId/claims).
   *
   * `busy` above stops a second press only while the first request is still
   * in flight; it releases the moment that request settles, so a customer
   * whose submit appeared to fail pressed send again and got two claims about
   * one printer. The key is what makes the retry land back on the claim
   * already recorded.
   *
   * It is seeded HERE, where the form resets, and not at mount and not per
   * keystroke: this effect runs on every OPEN of the window, which is exactly
   * the boundary the route asks for. A key that outlived the overlay would
   * silently replay the first claim instead of recording a genuine SECOND
   * claim on the same printer — a worse bug than the duplicate it removes —
   * and a key reminted per keystroke or per press would guard nothing at all.
   */
  const claimKey = useRef('');
  const unitId = device?.unit_id ?? null;
  useEffect(() => {
    // A fresh form for every device the window opens on.
    if (unitId) {
      setSubject('');
      setDescription('');
      setAttachments([]);
      setError('');
      claimKey.current = newIdempotencyKey();
    }
  }, [unitId]);

  const handleFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setError('');
    setUploadBusy(true);
    try {
      let count = attachments.length;
      for (const file of Array.from(files)) {
        if (count >= MAX_ATTACHMENTS) break;
        const form = new FormData();
        form.append('file', file);
        /**
         * A DEADLINE SIZED FOR THE FILE — this is the «فشل في الشبكة» the
         * owner photographed on a warranty claim.
         *
         * The route accepts images to 8 MB and VIDEO TO 40 MB
         * (worker/routes/devices.ts). Without a timeout this post took
         * `DEFAULT_TIMEOUT_MS`, 20 seconds, which a 40 MB body clears only at
         * a sustained 2 MB/s. Everywhere else the abort is indistinguishable
         * from a dropped socket — src/lib/api.ts turns both into "Network
         * error — check your connection" — so a working connection was blamed
         * for a deadline the client set itself. `uploadTimeoutMs` says so in
         * its own words, and every other upload in the app already passes it;
         * these two claim uploads were the ones that never did.
         */
        const res = await api.post<{ key: string; url: string }>('/api/devices/claims/upload', form, {
          timeoutMs: uploadTimeoutMs(file.size),
        });
        count += 1;
        const video = file.type.startsWith('video/');
        setAttachments((a) => (a.length >= MAX_ATTACHMENTS ? a : [...a, { key: res.key, url: res.url, name: file.name, video }]));
      }
    } catch (e) {
      setError(e instanceof ApiError ? e.message : s.error);
    } finally {
      setUploadBusy(false);
    }
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!device || busy || uploadBusy) return;
    setBusy(true);
    setError('');
    try {
      const res = await api.post<{ id: string; replay?: boolean }>(`/api/devices/units/${encodeURIComponent(device.unit_id)}/claims`, {
        subject: subject.trim(),
        description: description.trim(),
        attachments: attachments.map((a) => a.key),
        idempotencyKey: claimKey.current,
      });
      /**
       * A REPLAY IS NOT A SUBMIT, AND THE CUSTOMER IS TOLD SO.
       *
       * The route keeps the FIRST version of a claim when a retry carries the
       * same key (worker/routes/devices.ts, «WHAT A REPLAY COSTS»): the
       * customer whose first press timed out, who then added the photo of the
       * cracked nozzle and pressed again, has a claim WITHOUT that photo. This
       * screen used to read that 200 as a fresh submit and say «تم إرسال
       * المطالبة». The flag goes up to the page, which says what happened and
       * opens the claim's conversation — the one place the missing evidence
       * can still be sent.
       */
      onSubmitted({ id: res.id, replay: res.replay === true });
      onClose();
    } catch (e2) {
      setError(e2 instanceof ApiError ? e2.message : s.error);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Overlay
      open={!!device}
      onClose={onClose}
      labelledBy="warranty-device-claim-title"
      anchor={anchor}
      dismissOnScrim={false}
      z={60}
      testId="warranty-device-claim"
      panelClassName="w-full max-w-md max-h-[90vh] overflow-y-auto"
    >
      <div className="p-6">
        <CloseX onClick={onClose} label={s.close} />
        <h2 id="warranty-device-claim-title" className="text-white text-lg font-bold mb-1 pe-10">
          {s.newClaimTitle}
        </h2>
        <p className="text-zinc-500 text-sm mb-4 truncate">
          {shown && productName(shown.product, lang)}
          {shown?.serial && (
            <>
              {' · '}
              <span dir="ltr" className="font-mono">{shown.serial}</span>
            </>
          )}
        </p>
        <form onSubmit={submit} className="space-y-4">
          {error && (
            <div role="alert" className={ERROR_BOX}>
              {error}
            </div>
          )}
          <Field id="warranty-claim-subject" label={s.subject}>
            <input
              id="warranty-claim-subject"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              minLength={3}
              maxLength={200}
              required
              autoComplete="off"
              placeholder={s.subjectPh}
              className={INPUT}
            />
          </Field>
          <Field id="warranty-claim-description" label={s.description}>
            <textarea
              id="warranty-claim-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              minLength={10}
              maxLength={5000}
              required
              rows={4}
              placeholder={s.descriptionPh}
              className={`${INPUT} resize-none`}
            />
          </Field>
          <div>
            <span id="warranty-claim-attachments-label" className="text-[12px] text-zinc-400 mb-1.5 block font-medium">
              {s.attachments}
            </span>
            <label
              htmlFor="warranty-claim-files"
              aria-describedby="warranty-claim-attachments-label"
              className={`inline-flex items-center gap-2 min-h-[44px] bg-zinc-900 border border-zinc-800 rounded-xl px-3 text-zinc-300 text-sm cursor-pointer hover:border-zinc-700 transition-colors focus-within:ring-2 focus-within:ring-[#BAA369] ${
                uploadBusy || attachments.length >= MAX_ATTACHMENTS ? 'opacity-60 pointer-events-none' : ''
              }`}
            >
              <Paperclip aria-hidden="true" className="w-4 h-4" />
              {uploadBusy ? s.uploading : s.attach}
              <input
                id="warranty-claim-files"
                type="file"
                accept={ACCEPT}
                multiple
                className="sr-only"
                disabled={uploadBusy || attachments.length >= MAX_ATTACHMENTS}
                onChange={(e) => {
                  handleFiles(e.target.files);
                  e.target.value = '';
                }}
              />
            </label>
            {attachments.length > 0 && (
              <ul className="flex gap-2 mt-2 flex-wrap">
                {attachments.map((a) => (
                  <li key={a.key} className="relative w-16 h-16 rounded-lg overflow-hidden border border-zinc-800 bg-zinc-950">
                    {a.video ? (
                      <div className="w-full h-full flex items-center justify-center text-[9px] text-zinc-400 px-1 text-center break-all">{a.name}</div>
                    ) : (
                      <img src={a.url} alt="" className="w-full h-full object-cover" />
                    )}
                    <button
                      type="button"
                      onClick={() => setAttachments((arr) => arr.filter((x) => x.key !== a.key))}
                      className={`absolute top-0.5 end-0.5 bg-black/70 rounded-full p-1 text-zinc-300 hover:text-white ${FOCUS}`}
                      aria-label={s.removeAttachment}
                    >
                      <X aria-hidden="true" className="w-3 h-3" />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <button type="submit" disabled={busy || uploadBusy} className={`${BTN_PRIMARY} w-full`}>
            {busy ? s.submitting : s.submit}
          </button>
        </form>
      </div>
    </Overlay>
  );
}
