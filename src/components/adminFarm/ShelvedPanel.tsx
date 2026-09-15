/**
 * «قريبا — تحت التطوير»: the one switch that decides whether customers may
 * play, on the screen the owner already uses for the farm.
 *
 * It is NOT one of the balancing sections above it. Those edit the versioned
 * `printerFarmConfig` document and a save must carry a matching
 * `expected_version`; this is a single settings row with nothing to race on,
 * so closing or reopening the game is one request that cannot be blocked by
 * somebody else's half-finished edit — and needs no deploy.
 *
 * What the panel promises, and what the server actually does:
 *   * while it is closed, every /api/farm route answers 503 FARM_SHELVED to a
 *     customer — the page being hidden in the app is presentation on top;
 *   * an admin is let through the whole time, so the game can be finished;
 *   * closing deletes nothing: no farm, no coin, no job, no session.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { Lock, LockOpen, RefreshCw } from 'lucide-react';
import { btnGhost } from '../adminProducts/form/formUi';
import Spinner from '../ui/Spinner';
import { farmAdminErrorText } from '../../lib/farmAdminApi';
import { farmShelvedApi } from './shelvedApi';
import { Switch, btnGold } from './inputs';
import type { FarmAdminStrings } from './strings';

export function ShelvedPanel({ s }: { s: FarmAdminStrings }) {
  /** The server's answer. `null` until it has given one — never assumed. */
  const [shelved, setShelved] = useState<boolean | null>(null);
  const [draft, setDraft] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);

  const load = useCallback(async () => {
    const res = await farmShelvedApi.read();
    setShelved(res.shelved);
    setDraft(!res.shelved);
  }, []);

  useEffect(() => {
    let alive = true;
    load().catch((e: unknown) => {
      if (alive) setNote({ ok: false, text: farmAdminErrorText(e, s.loadFailed) });
    });
    return () => {
      alive = false;
    };
  }, [load, s.loadFailed]);

  const apply = async () => {
    if (draft === null || busy) return;
    setBusy(true);
    setNote(null);
    try {
      const res = await farmShelvedApi.set(draft);
      setShelved(res.shelved);
      setDraft(!res.shelved);
      setNote({ ok: true, text: s.shelvedState(!res.shelved) });
    } catch (e) {
      // The server refused — an assistant admin may close the game but not
      // open it. Its sentence is shown as it arrived, never reworded.
      setNote({ ok: false, text: farmAdminErrorText(e, s.saveFailed) });
      setDraft(shelved === null ? null : !shelved);
    } finally {
      setBusy(false);
    }
  };

  /** `draft` is where the admin wants the switch; `!shelved` is where it stands. */
  const unchanged = draft !== null && shelved !== null && draft === !shelved;

  return (
    <section className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-3.5 space-y-3 min-w-0" data-farm-shelved-panel>
      <div className="flex items-start gap-2 min-w-0">
        {shelved === false ? (
          <LockOpen className="w-4 h-4 text-gold shrink-0 mt-0.5" aria-hidden="true" />
        ) : (
          <Lock className="w-4 h-4 text-gold shrink-0 mt-0.5" aria-hidden="true" />
        )}
        <div className="min-w-0 flex-1">
          <h3 className="text-[13.5px] font-bold text-white">{s.shelvedTitle}</h3>
          <p className="text-[12px] text-zinc-400 leading-relaxed mt-0.5">{s.shelvedBody}</p>
        </div>
      </div>

      {shelved === null && note === null && (
        <div role="status" className="flex items-center gap-2 py-2 text-[12.5px] text-zinc-400">
          <Spinner size="sm" delayMs={0} decorative />
          {s.loading}
        </div>
      )}

      {shelved !== null && (
        <>
          <p className="text-[12.5px] text-white font-bold" data-farm-shelved-state={shelved ? 'closed' : 'open'}>
            {s.shelvedState(!shelved)}
          </p>
          <Switch checked={draft === true} onChange={setDraft} label={s.shelvedSwitch} disabled={busy} id="farm-shelved-switch" />
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" onClick={() => void apply()} disabled={busy || unchanged} className={btnGold} data-farm-shelved-apply>
              {busy ? s.saving : s.save}
            </button>
            <button
              type="button"
              onClick={() => {
                setNote(null);
                load().catch((e: unknown) => setNote({ ok: false, text: farmAdminErrorText(e, s.loadFailed) }));
              }}
              disabled={busy}
              className={btnGhost}
              data-farm-shelved-refresh
            >
              <RefreshCw className="w-3.5 h-3.5" aria-hidden="true" />
              {s.refresh}
            </button>
          </div>
        </>
      )}

      {note && (
        <p role={note.ok ? 'status' : 'alert'} className={`text-[12px] ${note.ok ? 'text-emerald-300' : 'text-red-400'}`} data-farm-shelved-note>
          {note.text}
        </p>
      )}
    </section>
  );
}
