/**
 * «الأمان» — THE OWNER'S SECURITY CONSOLE (DECISIONS row 206).
 *
 * Four tiles (live blocks, detections in 24 hours, decoy hits and trap-data
 * uses over 7 days), three tabs — «الحظر», «السجل», «النقاط» — and an incident
 * drawer: its blocks, what happened, the evidence (codes, country, network
 * operator — never an address), the trap-data batch and «ما الذي أُعطي له»,
 * the fake answer regenerated from its batch. «رفع الحظر» and «رفع كل حظر هذه
 * الحادثة», each behind a confirmation.
 *
 * WHO. Mounted by src/pages/Admin.tsx only for the verified owner — a
 * courtesy; /api/admin/security refuses everyone else on the server.
 */
import { useCallback, useEffect, useState } from 'react';
import { ShieldAlert, X } from 'lucide-react';
import { useLanguage } from '../../LanguageContext';
import { api, failureText } from '../../lib/api';
import { eventCodeText, securityText, type SecurityStringKey } from './strings';

type BlockKind = 'account' | 'device' | 'network';
interface BlockDto {
  id: string;
  incident_id: string;
  reference: string;
  actor_kind: BlockKind;
  actor: { kind: BlockKind; user_id?: string; name?: string | null; email?: string | null; tag?: string; cc?: string | null; asn?: string | null };
  reason: 'canary_used' | 'decoy_hit' | 'score_threshold';
  signal: string;
  created_at: string;
  expires_at: string;
  hits: number;
  lifted_at: string | null;
  active: boolean;
  evidence: Record<string, string | null>;
}
interface EventDto {
  id: string;
  kind: string;
  code: string;
  actor_id: string | null;
  actor_class: string;
  method: string;
  route: string;
  status: number;
  count: number;
  last_at: string;
  detail: Record<string, unknown>;
}
interface ScoreDto {
  actor_kind: BlockKind;
  actor: { user_id?: string; name?: string | null; tag?: string };
  score: number;
  updated_at: string;
  signals: Record<string, number>;
}
interface Summary {
  installed: boolean;
  /** False when the Worker has no key: decoys answer, but carry no trap data and no tag is set. */
  canaries?: boolean;
  active_blocks: Record<BlockKind, number>;
  detections_24h: number;
  decoy_hits_7d: number;
  canary_uses_7d: number;
  incidents_7d: number;
}
interface IncidentDto {
  id: string;
  reference: string;
  reason: BlockDto['reason'];
  created_at: string;
  blocks: BlockDto[];
  events: EventDto[];
  batch: { batch_id: string; decoy: string; issued_at: string; first_used_at: string | null; use_count: number } | null;
  preview: string[] | null;
}

type Tab = 'blocks' | 'log' | 'scores';
const REASON_KEY: Record<BlockDto['reason'], SecurityStringKey> = { decoy_hit: 'reasonDecoy', canary_used: 'reasonCanary', score_threshold: 'reasonScore' };
const KIND_KEY: Record<BlockKind, SecurityStringKey> = { account: 'kindAccount', device: 'kindDevice', network: 'kindNetwork' };

function when(iso: string | null | undefined, lang: string): string {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString(lang === 'en' ? 'en-GB' : 'ar-IQ', { dateStyle: 'medium', timeStyle: 'short' });
  } catch {
    return iso;
  }
}

export default function AdminSecurity() {
  const { lang, dir } = useLanguage();
  const s = (k: SecurityStringKey) => securityText(k, lang);
  const [tab, setTab] = useState<Tab>('blocks');
  const [summary, setSummary] = useState<Summary | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [blocks, setBlocks] = useState<BlockDto[] | null>(null);
  const [blocksNext, setBlocksNext] = useState<string | null>(null);
  const [events, setEvents] = useState<EventDto[] | null>(null);
  const [eventsNext, setEventsNext] = useState<string | null>(null);
  const [scores, setScores] = useState<ScoreDto[] | null>(null);
  const [error, setError] = useState('');
  const [incident, setIncident] = useState<IncidentDto | null>(null);
  const [confirm, setConfirm] = useState<{ block: BlockDto; whole: boolean } | null>(null);
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);

  const loadSummary = useCallback(() => {
    api.get<{ summary: Summary }>('/api/admin/security/summary').then((d) => setSummary(d.summary)).catch(() => undefined);
  }, []);
  const loadBlocks = useCallback(
    async (cursor?: string) => {
      const q = new URLSearchParams({ state: showAll ? 'all' : 'active' });
      if (cursor) q.set('cursor', cursor);
      const d = await api.get<{ blocks: BlockDto[]; next: string | null }>(`/api/admin/security/blocks?${q}`);
      setBlocks((prev) => (cursor && prev ? [...prev, ...d.blocks] : d.blocks));
      setBlocksNext(d.next);
    },
    [showAll]
  );
  const loadEvents = useCallback(async (cursor?: string) => {
    const q = new URLSearchParams();
    if (cursor) q.set('cursor', cursor);
    const d = await api.get<{ events: EventDto[]; next: string | null }>(`/api/admin/security/events?${q}`);
    setEvents((prev) => (cursor && prev ? [...prev, ...d.events] : d.events));
    setEventsNext(d.next);
  }, []);
  const loadScores = useCallback(async () => {
    const d = await api.get<{ scores: ScoreDto[] }>('/api/admin/security/scores');
    setScores(d.scores);
  }, []);

  const refresh = useCallback(() => {
    setError('');
    loadSummary();
    const job = tab === 'blocks' ? loadBlocks() : tab === 'log' ? loadEvents() : loadScores();
    job.catch((e) => setError(failureText(e, s('failed'))));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, loadBlocks, loadEvents, loadScores, loadSummary]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const openIncident = (id: string) => {
    api
      .get<{ incident: IncidentDto }>(`/api/admin/security/incidents/${encodeURIComponent(id)}`)
      .then((d) => setIncident(d.incident))
      .catch((e) => setError(failureText(e, s('failed'))));
  };

  const lift = async () => {
    if (!confirm) return;
    setBusy(true);
    try {
      await api.post(`/api/admin/security/blocks/${encodeURIComponent(confirm.block.id)}/lift`, { incident: confirm.whole });
      setNotice(s('liftDone'));
      setConfirm(null);
      setIncident(null);
      refresh();
    } catch (e) {
      setError(failureText(e, s('failed')));
      setConfirm(null);
    } finally {
      setBusy(false);
    }
  };

  const actorText = (b: Pick<BlockDto, 'actor' | 'actor_kind'>) => {
    if (b.actor_kind === 'account') return b.actor.name || b.actor.email || b.actor.user_id || '—';
    if (b.actor_kind === 'device') return `${s('kindDevice')} ${b.actor.tag ?? ''}…`;
    return [b.actor.cc, b.actor.asn].filter(Boolean).join(' · ') || s('kindNetwork');
  };

  const tiles: Array<[SecurityStringKey, number]> = summary
    ? [
        ['activeBlocks', summary.active_blocks.account + summary.active_blocks.device + summary.active_blocks.network],
        ['detections24h', summary.detections_24h],
        ['decoyHits7d', summary.decoy_hits_7d],
        ['canaryUses7d', summary.canary_uses_7d],
      ]
    : [];

  return (
    <div dir={dir} className="space-y-4">
      <header className="flex items-start gap-3">
        <ShieldAlert className="mt-1 h-6 w-6 shrink-0 text-amber-400" aria-hidden="true" />
        <div>
          <h2 className="text-lg font-semibold">{s('tab')}</h2>
          <p className="text-sm text-zinc-400">{s('subtitle')}</p>
        </div>
      </header>

      {summary && !summary.installed && <p className="rounded-xl border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-200">{s('notInstalled')}</p>}
      {summary && summary.canaries === false && <p className="rounded-xl border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-200">{s('canariesOff')}</p>}

      <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
        {tiles.map(([k, v]) => (
          <div key={k} className="lv-surface p-3">
            <div className="text-xs text-text-muted">{s(k)}</div>
            <div className="mt-1 text-2xl font-semibold tabular-nums">{v}</div>
          </div>
        ))}
      </div>

      <div role="tablist" className="lv-well flex gap-1 rounded-xl border border-border-subtle p-1">
        {(['blocks', 'log', 'scores'] as const).map((t) => (
          <button
            key={t}
            role="tab"
            aria-selected={tab === t}
            onClick={() => setTab(t)}
            className={`min-h-[40px] flex-1 rounded-lg px-3 text-sm ${tab === t ? 'bg-zinc-700 text-white' : 'text-zinc-400 hover:text-white'}`}
          >
            {s(t === 'blocks' ? 'tabBlocks' : t === 'log' ? 'tabLog' : 'tabScores')}
          </button>
        ))}
      </div>

      {notice && <p className="rounded-xl border border-emerald-500/40 bg-emerald-500/10 p-3 text-sm text-emerald-200">{notice}</p>}
      {error && (
        <div className="flex items-center justify-between gap-2 rounded-xl border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-200">
          <span>{error}</span>
          <button onClick={refresh} className="rounded-lg border border-red-400/40 px-3 py-1">
            {s('retry')}
          </button>
        </div>
      )}

      {tab === 'blocks' && (
        <section className="space-y-2">
          <label className="flex items-center gap-2 text-sm text-zinc-300">
            <input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} />
            {s('showAll')}
          </label>
          {blocks && blocks.length === 0 && <p className="py-8 text-center text-sm text-zinc-400">{s('empty')}</p>}
          <ul className="lv-surface divide-y divide-border-subtle overflow-hidden">
            {(blocks ?? []).map((b) => (
              <li key={b.id} className="flex flex-wrap items-center justify-between gap-2 p-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2 text-sm">
                    <span className="rounded-md bg-zinc-800 px-2 py-0.5 text-xs">{s(KIND_KEY[b.actor_kind])}</span>
                    <span className="truncate font-medium">{actorText(b)}</span>
                    {!b.active && <span className="text-xs text-zinc-500">{b.lifted_at ? s('lifted') : s('expired')}</span>}
                  </div>
                  <div className="mt-1 text-xs text-zinc-400">
                    {s(REASON_KEY[b.reason])} · <bdi className="font-mono">{b.reference}</bdi> · {when(b.created_at, lang)} · {s('until')} {when(b.expires_at, lang)} · {s('hits')}: {b.hits}
                  </div>
                </div>
                <div className="flex gap-2">
                  <button onClick={() => openIncident(b.incident_id)} className="min-h-[36px] rounded-lg border border-zinc-700 px-3 text-sm">
                    {s('details')}
                  </button>
                  {b.active && (
                    <button onClick={() => setConfirm({ block: b, whole: false })} className="min-h-[36px] rounded-lg bg-amber-500 px-3 text-sm text-black">
                      {s('lift')}
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
          {blocksNext && (
            <button onClick={() => loadBlocks(blocksNext).catch(() => undefined)} className="w-full rounded-lg border border-zinc-700 py-2 text-sm">
              {s('more')}
            </button>
          )}
        </section>
      )}

      {tab === 'log' && (
        <section className="space-y-2">
          {events && events.length === 0 && <p className="py-8 text-center text-sm text-zinc-400">{s('emptyLog')}</p>}
          <ul className="lv-surface divide-y divide-border-subtle overflow-hidden">
            {(events ?? []).map((e) => (
              <li key={e.id} className="p-3 text-sm">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-medium">{eventCodeText(e.code, lang)}</span>
                  <span className="text-xs text-zinc-400">{when(e.last_at, lang)} · ×{e.count}</span>
                </div>
                <div className="mt-1 text-xs text-zinc-400">
                  <bdi className="font-mono">
                    {e.method} {e.route}
                  </bdi>{' '}
                  · {e.status} · {e.actor_id ?? s('guest')}
                  {typeof e.detail.ref === 'string' && (
                    <>
                      {' '}
                      · <bdi className="font-mono">{e.detail.ref}</bdi>
                    </>
                  )}
                </div>
              </li>
            ))}
          </ul>
          {eventsNext && (
            <button onClick={() => loadEvents(eventsNext).catch(() => undefined)} className="w-full rounded-lg border border-zinc-700 py-2 text-sm">
              {s('more')}
            </button>
          )}
        </section>
      )}

      {tab === 'scores' && (
        <section className="space-y-2">
          {scores && scores.length === 0 && <p className="py-8 text-center text-sm text-zinc-400">{s('emptyScores')}</p>}
          <ul className="lv-surface divide-y divide-border-subtle overflow-hidden">
            {(scores ?? []).map((r, i) => (
              <li key={`${r.actor_kind}-${i}`} className="flex flex-wrap items-center justify-between gap-2 p-3 text-sm">
                <div>
                  <span className="rounded-md bg-zinc-800 px-2 py-0.5 text-xs">{s(KIND_KEY[r.actor_kind])}</span>{' '}
                  <span>{r.actor.name || r.actor.user_id || `${r.actor.tag ?? ''}…`}</span>
                  <div className="mt-1 text-xs text-zinc-400">
                    {Object.entries(r.signals)
                      .map(([k, v]) => `${eventCodeText(k, lang)} ×${v}`)
                      .join(' · ')}
                  </div>
                </div>
                <span className="text-lg font-semibold tabular-nums">{r.score}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {incident && (
        <div className="fixed inset-0 z-50 flex justify-end bg-black/60" onClick={() => setIncident(null)}>
          <aside
            role="dialog"
            aria-modal="true"
            aria-label={s('incident')}
            onClick={(e) => e.stopPropagation()}
            className="h-full w-full max-w-xl overflow-y-auto border-s border-border-subtle bg-surface-raised p-4 shadow-2xl"
            dir={dir}
          >
            <div className="mb-3 flex items-center justify-between">
              <h3 className="text-base font-semibold">
                {s('incident')} · <bdi className="font-mono">{incident.reference}</bdi>
              </h3>
              <button onClick={() => setIncident(null)} aria-label={s('close')} className="rounded-lg p-2 hover:bg-zinc-800">
                <X className="h-5 w-5" />
              </button>
            </div>
            <p className="text-sm text-zinc-300">
              {s(REASON_KEY[incident.reason])} · {when(incident.created_at, lang)}
            </p>
            <ul className="mt-3 space-y-2">
              {incident.blocks.map((b) => (
                <li key={b.id} className="flex items-center justify-between gap-2 rounded-lg border border-zinc-800 p-2 text-sm">
                  <span>
                    {s(KIND_KEY[b.actor_kind])} · {actorText(b)} · {b.active ? `${s('until')} ${when(b.expires_at, lang)}` : b.lifted_at ? s('lifted') : s('expired')}
                  </span>
                  {b.active && (
                    <button onClick={() => setConfirm({ block: b, whole: false })} className="rounded-lg bg-amber-500 px-2 py-1 text-xs text-black">
                      {s('lift')}
                    </button>
                  )}
                </li>
              ))}
            </ul>
            {incident.blocks.some((b) => b.active) && (
              <button onClick={() => setConfirm({ block: incident.blocks.find((b) => b.active)!, whole: true })} className="mt-2 w-full rounded-lg border border-amber-500/40 py-2 text-sm text-amber-200">
                {s('liftIncident')}
              </button>
            )}
            <h4 className="mt-4 text-sm font-semibold">{s('evidence')}</h4>
            <div className="mt-1 flex flex-wrap gap-1">
              {Object.entries(incident.blocks[0]?.evidence ?? {})
                .filter(([, v]) => v)
                .map(([k, v]) => (
                  <span key={k} className="rounded-md bg-zinc-800 px-2 py-0.5 font-mono text-xs">
                    {k}: {v}
                  </span>
                ))}
            </div>
            <h4 className="mt-4 text-sm font-semibold">{s('timeline')}</h4>
            <ul className="mt-1 space-y-1 text-xs text-zinc-300">
              {incident.events.map((e) => (
                <li key={e.id}>
                  {when(e.last_at, lang)} · {eventCodeText(e.code, lang)} · <bdi className="font-mono">{e.route}</bdi>
                </li>
              ))}
            </ul>
            {incident.batch && (
              <>
                <h4 className="mt-4 text-sm font-semibold">{s('batch')}</h4>
                <p className="text-xs text-zinc-300">
                  <bdi className="font-mono">{incident.batch.batch_id}</bdi> · {s('firstUsed')}: {incident.batch.first_used_at ? when(incident.batch.first_used_at, lang) : s('notUsed')} · {s('uses')}:{' '}
                  {incident.batch.use_count}
                </p>
              </>
            )}
            {incident.preview && (
              <>
                <h4 className="mt-4 text-sm font-semibold">{s('given')}</h4>
                <p className="text-xs text-zinc-400">{s('givenNote')}</p>
                <pre dir="ltr" className="mt-1 max-h-80 overflow-auto rounded-lg border border-zinc-800 bg-black p-2 text-[11px] leading-relaxed text-zinc-300">
                  {incident.preview.join('\n')}
                </pre>
              </>
            )}
          </aside>
        </div>
      )}

      {confirm && (
        <div className="fixed inset-0 z-100 flex items-center justify-center bg-black/70 p-4">
          <div role="alertdialog" aria-modal="true" className="w-full max-w-sm rounded-2xl border border-border-subtle bg-surface-raised p-4 shadow-2xl" dir={dir}>
            <p className="text-sm">{s('liftConfirm')}</p>
            <p className="mt-1 text-xs text-zinc-400">
              {confirm.whole ? s('liftIncident') : `${s(KIND_KEY[confirm.block.actor_kind])} · ${actorText(confirm.block)}`} · <bdi className="font-mono">{confirm.block.reference}</bdi>
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <button onClick={() => setConfirm(null)} className="min-h-[40px] rounded-lg border border-zinc-700 px-4 text-sm" disabled={busy}>
                {s('cancel')}
              </button>
              <button onClick={lift} className="min-h-[40px] rounded-lg bg-amber-500 px-4 text-sm text-black" disabled={busy}>
                {confirm.whole ? s('liftIncident') : s('lift')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
