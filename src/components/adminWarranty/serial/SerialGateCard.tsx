/**
 * THE OWNER'S SWITCH FOR §19 — «تبقى أرقام تسلسلية غير مرتبطة لهذا الطلب.»
 * becomes a refusal at the hand-over doors only once the owner turns it on.
 *
 * Owner default (2026-10-07): it ships OFF, and the owner switches it on with
 * a cutover date — orders created before that date are never held, so an
 * order already in a van is not stopped by a rule written after it left. The
 * date defaults to now; the server stamps it when none is sent. Everyone else
 * sees the state with a lock (PUT /api/admin/settings/serialPrepGate is the
 * owner's on the server too).
 */
import { useCallback, useEffect, useId, useState } from 'react';
import { Lock, ScanLine } from 'lucide-react';
import { api } from '../../../lib/api';
import { useLanguage } from '../../../LanguageContext';
import { useAuth } from '../../../AuthContext';
import { Switch } from '../../ui/Switch';
import { useToast } from '../../ui/Toast';
import { serialStrings } from '../../adminOrders/serials/strings';
import { serialRefusal, shortDate } from '../../adminOrders/serials/serialsApi';

interface Gate {
  enabled: boolean;
  since: string | null;
}

/** `YYYY-MM-DD` for a date input, in the viewer's own calendar day. */
const dayOf = (iso: string | null) => {
  const d = iso ? new Date(iso) : new Date();
  if (Number.isNaN(d.getTime())) return '';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

export default function SerialGateCard() {
  const { lang, dir } = useLanguage();
  const s = serialStrings(lang);
  const toast = useToast();
  const { user } = useAuth();
  const owner = !!user?.is_owner;
  const dateId = useId();
  const [gate, setGate] = useState<Gate | null>(null);
  const [day, setDay] = useState(dayOf(null));
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await api.get<{ settings: Record<string, unknown> }>('/api/admin/settings');
      const g = (res.settings?.serialPrepGate ?? null) as Gate | null;
      setGate(g && typeof g === 'object' ? { enabled: g.enabled === true, since: typeof g.since === 'string' ? g.since : null } : { enabled: false, since: null });
    } catch {
      setGate(null);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async (enabled: boolean) => {
    if (!owner || busy) return;
    setBusy(true);
    try {
      // Start of the chosen day, local time; today means "from now on".
      const since = enabled ? (day === dayOf(null) ? new Date().toISOString() : new Date(`${day}T00:00:00`).toISOString()) : gate?.since ?? null;
      await api.put('/api/admin/settings/serialPrepGate', { value: { enabled, since } });
      toast.success(s.gateSaved);
      await load();
    } catch (e) {
      toast.error(serialRefusal(e, lang).text);
    } finally {
      setBusy(false);
    }
  };

  if (!gate) return null;
  return (
    <section dir={dir} className="rounded-[var(--ap-radius-lg)] border border-[var(--ap-border)] bg-[var(--ap-surface-1)] p-4 space-y-3" data-serial-gate-card={gate.enabled ? 'on' : 'off'}>
      <div className="flex items-start gap-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-[var(--ap-accent-soft)] text-[var(--ap-accent-text)]">
          <ScanLine className="h-[18px] w-[18px]" aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <Switch
            checked={gate.enabled}
            onChange={(next) => void save(next)}
            disabled={!owner}
            busy={busy}
            label={s.gateTitle}
            description={gate.enabled && gate.since ? s.gateOn(shortDate(gate.since, lang)) : s.gateOff}
          />
        </div>
      </div>
      <p className="text-[12px] leading-relaxed text-[var(--ap-text-3)]">{s.gateBody}</p>
      {owner ? (
        !gate.enabled && (
          <div className="flex flex-wrap items-center gap-2">
            <label htmlFor={dateId} className="text-[12.5px] text-[var(--ap-text-2)]">
              {s.cutoverLabel}
            </label>
            <input
              id={dateId}
              type="date"
              dir="ltr"
              value={day}
              onChange={(e) => setDay(e.target.value)}
              className="h-10 rounded-[var(--ap-radius-md)] border border-[var(--ap-border)] bg-[var(--ap-surface-2)] px-3 text-[13px] text-[var(--ap-text-1)] focus:outline-none focus:border-[var(--ap-accent)]"
            />
          </div>
        )
      ) : (
        <p className="inline-flex items-center gap-1.5 text-[12px] text-[var(--ap-text-3)]">
          <Lock className="h-3.5 w-3.5" aria-hidden />
          {s.ownerOnly}
        </p>
      )}
    </section>
  );
}
