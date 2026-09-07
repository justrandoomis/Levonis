/**
 * Players: look one up by user id and see the farm as the server holds it
 * (the admin read does NOT resolve prints — nothing moves), then grant or
 * deduct Farm Coins with a reason and an idempotency key, behind an in-app
 * confirmation. Every figure on this card is a server field; Levonis Points
 * are never read or written here.
 */
import React, { useId, useRef, useState, type ReactNode } from 'react';
import { Coins, RefreshCw, Search, Users } from 'lucide-react';
import type { Language } from '../../translations';
import { newIdempotencyKey } from '../../lib/api';
import {
  FARM_ADMIN_CODES,
  farmAdminApi,
  farmAdminErrorCode,
  farmAdminErrorText,
  type FarmAdminPlayerFarm,
  type FarmAdminPlayerResponse,
} from '../../lib/farmAdminApi';
import { statValue, type FarmJob } from '../../lib/farmApi';
import { formatCoins, formatInt, formatPercent, formatSignedCoins, formatStars, nameOf } from '../../pages/farm/format';
import { formatDateTime } from '../orders/format';
import { btnGhost, iconBtn } from '../adminProducts/form/formUi';
import { Overlay } from '../ui/Overlay';
import Note from '../ui/Note';
import { FarmField, NumInput, TextBox, btnGold } from './inputs';
import type { FarmAdminStrings } from './strings';

const MIN_REASON = 5;

export function PlayersPanel({ s, lang }: { s: FarmAdminStrings; lang: Language }) {
  const [userId, setUserId] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [player, setPlayer] = useState<FarmAdminPlayerResponse | null>(null);

  const lookup = async (id: string) => {
    const target = id.trim();
    if (!target || busy) return;
    setBusy(true);
    setErr(null);
    try {
      setPlayer(await farmAdminApi.player(target));
    } catch (e) {
      setPlayer(null);
      setErr(farmAdminErrorText(e, s.lookupFailed));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section data-farm-players className="min-w-0 rounded-xl border border-zinc-800 bg-zinc-900/40 p-3 sm:p-4">
      <h3 className="text-[14px] font-black text-white flex items-center gap-2">
        <Users className="w-4 h-4 text-gold" aria-hidden="true" />
        {s.playersTitle}
      </h3>
      <p className="text-[12px] text-zinc-400 mt-1 leading-relaxed">{s.playersBody}</p>

      <div className="mt-3 flex flex-wrap items-end gap-2 min-w-0">
        <div className="min-w-0 flex-1 max-w-sm">
          <FarmField label={s.userIdLabel} path="players.user_id">
            <TextBox value={userId} onChange={setUserId} placeholder={s.userIdPlaceholder} mono onEnter={() => void lookup(userId)} />
          </FarmField>
        </div>
        <button type="button" onClick={() => void lookup(userId)} disabled={busy || !userId.trim()} className={`${btnGold} h-10`} data-farm-lookup>
          <Search className="w-4 h-4" aria-hidden="true" />
          {busy ? s.lookingUp : s.lookup}
        </button>
      </div>
      {err && (
        <p role="alert" className="mt-2 text-[12px] text-red-400">
          {err}
        </p>
      )}

      {player && <PlayerView player={player} s={s} lang={lang} onMoved={() => void lookup(player.user.id)} />}
    </section>
  );
}

// ---------------------------------------------------------------- the farm

function PlayerView({ player, s, lang, onMoved }: { player: FarmAdminPlayerResponse; s: FarmAdminStrings; lang: Language; onMoved: () => void }) {
  const who = s.userLine(player.user.name || player.user.id, player.user.username ?? player.user.id);
  const farm = player.farm;
  return (
    <div className="mt-4 space-y-4 min-w-0" data-farm-player={player.user.id}>
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 min-w-0">
        <span className="text-[14px] font-bold text-white truncate">{who}</span>
        <code className="text-[11px] text-zinc-500" dir="ltr">
          {player.user.id}
        </code>
      </div>

      {farm ? <FarmDetails farm={farm} s={s} lang={lang} /> : <Note tone="amber" animate={false}>{s.noFarm}</Note>}

      <GrantForm userId={player.user.id} who={who} s={s} lang={lang} onMoved={onMoved} />
    </div>
  );
}

function Dl({ items }: { items: Array<[string, ReactNode]> }) {
  return (
    <dl className="grid gap-x-4 gap-y-1.5 [grid-template-columns:repeat(2,minmax(0,1fr))] sm:[grid-template-columns:repeat(4,minmax(0,1fr))] text-[12px] min-w-0">
      {items.map(([k, v]) => (
        <div key={k} className="min-w-0">
          <dt className="text-[10.5px] text-zinc-500 truncate">{k}</dt>
          <dd className="text-zinc-100 tabular-nums truncate">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

function Table({ caption, head, rows, empty }: { caption: string; head: string[]; rows: ReactNode[][]; empty: string }) {
  return (
    <div className="min-w-0">
      <h4 className="text-[12px] font-bold text-zinc-300 mb-1.5">{caption}</h4>
      {rows.length === 0 ? (
        <p className="text-[11.5px] text-zinc-500">{empty}</p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-zinc-800">
          <table className="w-full text-[11.5px] text-zinc-200">
            <thead className="bg-zinc-950/60 text-zinc-500">
              <tr>
                {head.map((h) => (
                  <th key={h} scope="col" className="px-2 py-1.5 text-start font-bold whitespace-nowrap">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((cells, i) => (
                <tr key={i} className="border-t border-zinc-800/70">
                  {cells.map((c, j) => (
                    <td key={j} className="px-2 py-1.5 whitespace-nowrap tabular-nums">
                      {c}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

const jobRow = (j: FarmJob, s: FarmAdminStrings, lang: Language): ReactNode[] => [
  nameOf(j.title, lang, j.product_key),
  j.customer_tier,
  <span key="p" dir="ltr">{j.product_key}</span>,
  formatInt(j.qty, lang),
  <span key="m" dir="ltr">{j.material}</span>,
  formatCoins(j.reward_coins, lang),
  j.state,
  j.deadline_at ? formatDateTime(j.deadline_at, lang) : s.dash,
];

function FarmDetails({ farm, s, lang }: { farm: FarmAdminPlayerFarm; s: FarmAdminStrings; lang: Language }) {
  const p = farm.profile;
  const st = p.stats;
  const stat = (...keys: string[]) => {
    const v = statValue(st, ...keys);
    return v === undefined ? s.dash : formatInt(v, lang);
  };
  const jobHead = [s.colTitle, s.colTier, s.colProduct, s.colQty, s.colMaterial, s.colReward, s.colState, s.colDeadline];
  return (
    <div className="space-y-4 min-w-0">
      <Dl
        items={[
          [s.farmName, p.farm_name || s.dash],
          [s.level(p.level), s.xp(formatInt(p.xp, lang), p.xp_next === null ? s.xpTop : formatInt(p.xp_next, lang))],
          [s.reputation, `${formatStars(p.stars)} ★`],
          [s.coins, <span key="c" className="text-gold font-bold">{formatCoins(p.coins, lang)}</span>],
          [s.state, p.state],
          [s.location, nameOf(p.location.name, lang, p.location.key)],
        ]}
      />
      <div>
        <h4 className="text-[12px] font-bold text-zinc-300 mb-1.5">{s.stats}</h4>
        <Dl
          items={[
            [s.statDelivered, stat('delivered', 'jobs_delivered')],
            [s.statLate, stat('late', 'jobs_late')],
            [s.statCancelled, stat('cancelled', 'jobs_cancelled')],
            [s.statPrints, stat('prints', 'parts')],
            [s.statFailures, stat('failures')],
            [s.statStreak, stat('streak')],
            [s.statLifetime, stat('lifetime_coins')],
          ]}
        />
      </div>

      <Table
        caption={s.printers}
        head={[s.colSlot, s.colNickname, s.colModel, s.colState, s.colHealth, s.statPrints, s.statFailures]}
        empty={s.printersNone}
        rows={farm.printers.map((pr) => [
          formatInt(pr.slot, lang),
          pr.nickname || s.dash,
          <span key="m" dir="ltr">{pr.model_key}</span>,
          pr.state,
          formatPercent(pr.health / 100, lang),
          formatInt(pr.prints, lang),
          formatInt(pr.failures, lang),
        ])}
      />

      <Table
        caption={s.spools}
        head={[s.colMaterial, s.colColor, s.colGrams, s.colQuality]}
        empty={s.emptyList}
        rows={farm.spools.map((sp) => [
          <span key="m" dir="ltr">{sp.material}</span>,
          <span key="c" dir="ltr">{sp.color}</span>,
          `${formatInt(sp.grams_left, lang)} / ${formatInt(sp.grams_total, lang)}`,
          formatPercent(sp.quality, lang),
        ])}
      />

      <Table caption={s.jobsActive} head={jobHead} empty={s.jobsNone} rows={farm.jobs.active.map((j) => jobRow(j, s, lang))} />
      <Table caption={s.jobsOffered} head={jobHead} empty={s.jobsNone} rows={farm.jobs.offered.map((j) => jobRow(j, s, lang))} />

      <Table
        caption={s.jobsRecent}
        head={[s.colId, s.colState, s.colProduct, s.colQty, s.colReward, s.colCreated]}
        empty={s.jobsNone}
        rows={farm.jobs_recent.map((j) => [
          <code key="id" dir="ltr">{j.id}</code>,
          j.state,
          <span key="p" dir="ltr">{j.product_key}</span>,
          formatInt(j.qty, lang),
          formatCoins(j.reward_coins, lang),
          formatDateTime(j.created_at, lang),
        ])}
      />

      <Table
        caption={s.ledger}
        head={[s.colKind, s.colAmount, s.colNote, s.colRef, s.colDate]}
        empty={s.ledgerNone}
        rows={farm.ledger_tail.map((row) => [
          <span key="k" dir="ltr">{row.kind}</span>,
          <span key="a" className={row.amount < 0 ? 'text-red-300' : 'text-emerald-300'} dir="ltr">
            {formatSignedCoins(row.amount, lang)}
          </span>,
          row.note || s.dash,
          <span key="r" dir="ltr">{row.ref_type ? `${row.ref_type}${row.ref_id ? `:${row.ref_id}` : ''}` : s.dash}</span>,
          formatDateTime(row.created_at, lang),
        ])}
      />
    </div>
  );
}

// ------------------------------------------------------------------- grant

function GrantForm({ userId, who, s, lang, onMoved }: { userId: string; who: string; s: FarmAdminStrings; lang: Language; onMoved: () => void }) {
  const [amount, setAmount] = useState(0);
  const [reason, setReason] = useState('');
  const [key, setKey] = useState(() => newIdempotencyKey());
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const submitRef = useRef<HTMLButtonElement | null>(null);
  const titleId = useId();
  const keyId = `${titleId}-key`;

  const amountOk = Number.isInteger(amount) && amount !== 0;
  const reasonOk = reason.trim().length >= MIN_REASON;
  const deduct = amount < 0;
  const abs = formatCoins(Math.abs(amount), lang);

  const send = async () => {
    if (!amountOk || !reasonOk || busy) return;
    setBusy(true);
    setNote(null);
    try {
      const r = await farmAdminApi.grant(userId, { amount, reason: reason.trim(), idempotencyKey: key });
      setNote({
        ok: true,
        text: r.replayed ? s.replayed(formatCoins(r.balance, lang)) : s.granted(formatSignedCoins(r.amount, lang), formatCoins(r.balance, lang)),
      });
      setConfirmOpen(false);
      // A landed (or replayed) movement is done with its key: the next attempt is a new intent.
      setKey(newIdempotencyKey());
      setAmount(0);
      setReason('');
      onMoved();
    } catch (e) {
      const code = farmAdminErrorCode(e);
      setNote({ ok: false, text: code === FARM_ADMIN_CODES.insufficient ? s.insufficient : farmAdminErrorText(e, s.grantFailed) });
      setConfirmOpen(false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="min-w-0 rounded-lg border border-zinc-800 bg-zinc-950/30 p-3" data-farm-grant={userId}>
      <h4 className="text-[13px] font-bold text-white flex items-center gap-2">
        <Coins className="w-4 h-4 text-gold" aria-hidden="true" />
        {s.grantTitle}
      </h4>
      <p className="text-[11.5px] text-zinc-400 mt-1 leading-relaxed">{s.grantBody}</p>
      <div className="mt-3 grid gap-3 [grid-template-columns:minmax(0,1fr)] md:[grid-template-columns:repeat(3,minmax(0,1fr))] min-w-0">
        <FarmField label={s.amount} hint={s.amountHint} error={amount !== 0 && !amountOk ? s.amountInvalid : null} path="grant.amount">
          <NumInput value={amount} onChange={setAmount} integer unit={s.unitCoins} />
        </FarmField>
        <FarmField label={s.reason} hint={s.reasonHint} error={reason.length > 0 && !reasonOk ? s.reasonShort : null} path="grant.reason">
          <TextBox value={reason} onChange={setReason} rtl={lang !== 'en'} />
        </FarmField>
        <FarmField label={s.idemKey} hint={s.idemHint} path="grant.idempotency_key" htmlFor={keyId}>
          <div className="flex items-center gap-1.5 min-w-0">
            <TextBox id={keyId} value={key} onChange={() => undefined} mono disabled />
            <button type="button" aria-label={s.regenerateKey} title={s.regenerateKey} onClick={() => setKey(newIdempotencyKey())} className={iconBtn}>
              <RefreshCw className="w-4 h-4" aria-hidden="true" />
            </button>
          </div>
        </FarmField>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          type="button"
          ref={submitRef}
          onClick={() => setConfirmOpen(true)}
          disabled={!amountOk || !reasonOk || busy}
          aria-haspopup="dialog"
          className={deduct ? `${btnGhost} border-red-500/40 text-red-200` : btnGold}
          data-farm-grant-submit
        >
          {deduct ? s.deductSubmit : s.grantSubmit}
        </button>
        {note && (
          <p role={note.ok ? 'status' : 'alert'} className={`text-[12px] ${note.ok ? 'text-emerald-300' : 'text-red-400'}`} data-farm-grant-note>
            {note.text}
          </p>
        )}
      </div>

      <Overlay
        open={confirmOpen}
        onClose={() => {
          if (!busy) setConfirmOpen(false);
        }}
        labelledBy={titleId}
        anchor={submitRef}
        dismissOnEscape={!busy}
        dismissOnScrim={!busy}
        testId="farm-grant-confirm"
        panelClassName="w-full max-w-md"
      >
        <div className="p-5 sm:p-6">
          <h3 id={titleId} className="text-white font-bold text-[16px]">{s.confirmGrantTitle}</h3>
          <p className="text-zinc-300 text-[13px] mt-2 leading-relaxed">{deduct ? s.confirmDeductBody(abs, who) : s.confirmGrantBody(abs, who)}</p>
          <p className="text-zinc-500 text-[11.5px] mt-2 leading-relaxed">{reason.trim()}</p>
          <div className="mt-5 flex flex-col-reverse sm:flex-row gap-2.5">
            <button type="button" onClick={() => setConfirmOpen(false)} disabled={busy} className={`${btnGhost} flex-1 h-11`}>
              {s.cancel}
            </button>
            <button type="button" onClick={() => void send()} disabled={busy} className={`${btnGold} flex-1 h-11`} data-farm-grant-confirm>
              {busy ? s.working : s.confirm}
            </button>
          </div>
        </div>
      </Overlay>
    </div>
  );
}
