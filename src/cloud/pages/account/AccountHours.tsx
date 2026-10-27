/**
 * /account/hours — PRINTING HOURS, CLASS BY CLASS (GET /me/credits,
 * /me/credits/reservations, /me/credits/ledger; POST /me/credits/convert).
 *
 * Per printer class: what is in the account (free + held), free, held for
 * prints and used — the server's own seconds — and the purchases that make it
 * up, each with its own expiry as the server applies it (a lot is past its
 * expiry from the instant named; what a print already holds stays with that
 * print, credits.ts). Then the hours held by prints, the latest movements, and
 * the conversion between classes.
 *
 * THE CONVERSION CANNOT BE PREVIEWED BY NUMBER. No customer door states which
 * pairs the workshop allows or at what ratio (the rules are an admin
 * catalogue), so the screen never guesses what will arrive: the confirmation
 * says the workshop's rule decides it, and the result shows the server's own
 * `received_seconds`. A pair the workshop does not allow is refused
 * CONVERSION_DISABLED, in the server's words. The request is a money door:
 * one Idempotency-Key per intent (shared.tsx `useIntentKey`).
 */
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { StatusChip } from '../../../components/ui/Badge';
import { Button } from '../../../components/ui/Button';
import { ConfirmDialog } from '../../../components/ui/ConfirmDialog';
import { Field, Select } from '../../../components/ui/Field';
import { NumberInput } from '../../../components/ui/NumberInput';
import { Skeleton } from '../../../components/ui/Skeleton';
import { cloudErrorText, convertCredits, getCredits, listCreditLedger, listCreditReservations, listPrinters } from '../../api';
import { useCloud } from '../../CloudContext';
import { formatDate, formatDateTime, formatDuration, hoursParts } from '../../format';
import { creditEntry, hoursText, lotSource, sect } from '../../strings/account';
import { tx, useCloudText } from '../../text';
import type { ConvertResult, CreditLot, CreditReservation, CreditTierBalance, PrinterModel } from '../../types';
import { ArrowLeftRight, Clock, CloudEmptyState, CloudErrorState, CloudPageSkeleton, SectionHeader } from '../../ui';
import { useCloudQuery } from '../../useCloudQuery';
import { creditFigures, expiryTone, ledgerMovement, lotExpiry, MIN_CONVERT_SECONDS, tierOptions, typedSeconds, type LotExpiry } from './logic';
import { CapNote, Figures, MoneyLine, MovementFigure, SubPageHeader, useIntentKey, useStatusWord } from './shared';

/** How many movements the page asks for; the full history pages exactly in Transactions. */
const LEDGER_PAGE = 50;
/** The server's own cap on the reservations it lists (GET /me/credits/reservations). */
const RESERVATIONS_CAP = 200;
/** The server's own cap on the purchases it lists (GET /me/credits: «the 100 most recent lots»). */
const LOTS_CAP = 100;

const enc = encodeURIComponent;

type TierNames = (tierId: string) => string;

function useExpiryWord() {
  const { t, lang } = useCloudText();
  return (e: LotExpiry): string => {
    switch (e.kind) {
      case 'never':
        return t(hoursText.neverExpires);
      case 'unknown':
        return t(hoursText.expiryUnknown);
      case 'expired':
        return t(hoursText.expiredOn, { date: formatDate(e.at, lang) });
      case 'soon':
        return t(hoursText.expiresSoon, { date: formatDate(e.at, lang) });
      default:
        return t(hoursText.expiresOn, { date: formatDate(e.at, lang) });
    }
  };
}

function LotRow({ lot, now }: { lot: CreditLot; now: number }) {
  const { t, lang } = useCloudText();
  const expiryWord = useExpiryWord();
  const e = lotExpiry(lot.expires_at, now);
  const source = Object.prototype.hasOwnProperty.call(lotSource, lot.source) ? lotSource[lot.source as keyof typeof lotSource] : lotSource.other;
  return (
    <li className="rounded-xl lv-well px-3 py-2">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <p className="text-sm font-semibold tabular-nums text-text-primary">
          {t(hoursText.lotLeft, { left: formatDuration(lot.seconds_remaining, lang), total: formatDuration(lot.seconds_total, lang) })}
        </p>
        <StatusChip tone={expiryTone(e)}>{expiryWord(e)}</StatusChip>
      </div>
      <p className="mt-0.5 text-[12px] text-text-muted">
        {t(source, { date: formatDate(lot.created_at, lang) })}
        {lot.paid_iqd > 0 ? (
          <>
            {' · '}
            <MoneyLine text={hoursText.paid} iqd={lot.paid_iqd} />
          </>
        ) : null}
      </p>
      {lot.seconds_held > 0 ? <p className="text-[12px] text-text-secondary">{t(hoursText.lotHeld, { amount: formatDuration(lot.seconds_held, lang) })}</p> : null}
      {e.kind === 'expired' ? <p className="text-[12px] leading-relaxed text-text-muted">{t(hoursText.expiredNote)}</p> : null}
    </li>
  );
}

function TierCard({ tier, lots, now }: { tier: CreditTierBalance; lots: CreditLot[]; now: number }) {
  const { t, lang } = useCloudText();
  const f = creditFigures(tier);
  const live = lots.filter((l) => l.seconds_remaining > 0);
  const usedUp = lots.length - live.length;
  const parts = hoursParts(tier.available_seconds, lang);
  const headingId = `cloud-tier-${tier.tier_id}`;
  return (
    <article aria-labelledby={headingId} className="lv-surface space-y-3 p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id={headingId} className="min-w-0 truncate text-[17px] font-bold text-text-primary">
          {tx(tier.name, lang) || tier.code}
        </h2>
        <p className="flex items-baseline gap-1 text-ui-xl font-bold tabular-nums text-text-primary">
          <bdi>{parts.value}</bdi>
          <span className="text-sm font-semibold text-text-secondary">{parts.unit}</span>
        </p>
      </div>
      <Figures
        items={[
          { label: t(hoursText.inAccount), value: formatDuration(f.owned, lang) },
          { label: t(hoursText.available), value: formatDuration(f.available, lang) },
          { label: t(hoursText.held), value: formatDuration(f.reserved, lang) },
          { label: t(hoursText.used), value: formatDuration(f.used, lang) },
        ]}
      />
      <div>
        <h3 className="mb-2 text-sm font-bold text-text-primary">{t(hoursText.lotsTitle)}</h3>
        {live.length === 0 ? (
          <p className="text-[12px] text-text-muted">{t(hoursText.lotsEmpty)}</p>
        ) : (
          <ul className="space-y-2">
            {live.map((lot) => (
              <LotRow key={lot.id} lot={lot} now={now} />
            ))}
          </ul>
        )}
        {usedUp > 0 ? <p className="mt-2 text-[12px] text-text-muted">{t(hoursText.usedUpHidden)}</p> : null}
      </div>
      <Link to={`/store?tab=hours&tier=${enc(tier.tier_id)}`} className="lv-button lv-button-secondary lv-button-sm">
        {t(hoursText.buy)}
      </Link>
    </article>
  );
}

function Holds({ reservations, tierName }: { reservations: CreditReservation[]; tierName: TierNames }) {
  const { t, lang } = useCloudText();
  const active = reservations.filter((r) => r.state === 'active');
  const settled = reservations.filter((r) => r.state !== 'active').slice(0, 5);
  return (
    <section aria-labelledby="cloud-hours-holds" className="space-y-2">
      <SectionHeader id="cloud-hours-holds" title={t(hoursText.holdsTitle)} count={active.length} />
      {active.length === 0 ? (
        <p className="text-[13px] text-text-muted">{t(hoursText.holdsEmpty)}</p>
      ) : (
        <ul className="lv-surface divide-y divide-border-subtle overflow-hidden">
          {active.map((r) => (
            <li key={r.id} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 px-3 py-3">
              <div className="min-w-0">
                <p className="text-sm font-semibold tabular-nums text-text-primary">{t(hoursText.holdLine, { amount: formatDuration(r.seconds_reserved, lang) })}</p>
                <p className="truncate text-[12px] text-text-muted">
                  {tierName(r.tier_id)} · {t(hoursText.holdOn, { date: formatDate(r.created_at, lang) })}
                </p>
              </div>
              <Link to={`/jobs/${enc(r.job_id)}`} className="lv-button lv-button-ghost lv-button-sm">
                {t(sect.viewPrint)}
              </Link>
            </li>
          ))}
        </ul>
      )}
      {settled.length > 0 ? (
        <div className="space-y-2 pt-2">
          <h3 className="text-sm font-bold text-text-primary">{t(hoursText.settledTitle)}</h3>
          <ul className="space-y-1.5">
            {settled.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center justify-between gap-x-3 text-[12px] text-text-muted">
                <span className="min-w-0 truncate">
                  {r.seconds_consumed > 0
                    ? t(hoursText.settledLine, { used: formatDuration(r.seconds_consumed, lang), returned: formatDuration(r.seconds_released, lang) })
                    : t(hoursText.releasedLine)}
                  {' · '}
                  {tierName(r.tier_id)}
                </span>
                <Link to={`/jobs/${enc(r.job_id)}`} className="font-semibold text-text-secondary underline-offset-2 hover:underline">
                  {t(sect.viewPrint)}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <CapNote shown={reservations.length} cap={RESERVATIONS_CAP} />
    </section>
  );
}

function Ledger({ tierName }: { tierName: TierNames }) {
  const { t, lang } = useCloudText();
  const { dashboardVersion } = useCloud();
  const word = useStatusWord();
  const ledger = useCloudQuery((signal) => listCreditLedger({ limit: LEDGER_PAGE }, { signal }), [dashboardVersion]);
  return (
    <section aria-labelledby="cloud-hours-ledger" className="space-y-2">
      <SectionHeader id="cloud-hours-ledger" title={t(hoursText.ledgerTitle)} link={{ to: '/account/transactions', label: t(sect.fullHistory) }} />
      {ledger.error ? (
        <CloudErrorState compact error={ledger.error} onRetry={ledger.reload} />
      ) : !ledger.data ? (
        <Skeleton className="h-24 w-full rounded-xl" />
      ) : ledger.data.length === 0 ? (
        <p className="text-[13px] text-text-muted">{t(hoursText.ledgerEmpty)}</p>
      ) : (
        <>
          <ul className="lv-surface divide-y divide-border-subtle overflow-hidden">
            {ledger.data.map((e) => (
              <li key={e.id} className="flex items-center gap-3 px-3 py-2.5">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold text-text-primary">
                    {e.job_id ? (
                      <Link to={`/jobs/${enc(e.job_id)}`} className="underline-offset-2 hover:underline">
                        {word(creditEntry, e.entry_type)}
                      </Link>
                    ) : (
                      word(creditEntry, e.entry_type)
                    )}
                  </p>
                  <p className="truncate text-[12px] text-text-muted">
                    {tierName(e.tier_id)} · {formatDateTime(e.created_at, lang)}
                  </p>
                </div>
                <span className="shrink-0 text-sm font-bold">
                  <MovementFigure movement={ledgerMovement(e)} unit="seconds" />
                </span>
              </li>
            ))}
          </ul>
          <CapNote shown={ledger.data.length} cap={LEDGER_PAGE} history />
        </>
      )}
    </section>
  );
}

function ConvertHours({ tiers }: { tiers: CreditTierBalance[] }) {
  const { t, lang } = useCloudText();
  const cloud = useCloud();
  const [open, setOpen] = useState(false);
  const printers = useCloudQuery<PrinterModel[] | null>((signal) => (open ? listPrinters({ signal }) : Promise.resolve(null)), [open]);
  const sources = tiers.filter((x) => x.available_seconds > 0);
  // A class a conversion just emptied is no longer a source: the first one that still has hours is.
  const [fromPick, setFrom] = useState('');
  const from = sources.some((x) => x.tier_id === fromPick) ? fromPick : (sources[0]?.tier_id ?? '');
  const [to, setTo] = useState('');
  const [hours, setHours] = useState<{ value: number | null; valid: boolean }>({ value: null, valid: true });
  const [minutes, setMinutes] = useState<{ value: number | null; valid: boolean }>({ value: null, valid: true });
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ConvertResult | null>(null);

  const options = tierOptions(tiers, printers.data ?? []);
  const nameOf = (id: string) => {
    const o = options.find((x) => x.id === id);
    return o ? tx(o.name, lang) || o.code : id;
  };
  const fromTier = tiers.find((x) => x.tier_id === from) ?? null;
  const targets = options.filter((o) => o.id !== from);
  const typed = hours.valid && minutes.valid ? typedSeconds(hours.value, minutes.value) : null;
  const entered = hours.value !== null || minutes.value !== null;
  const problem =
    from && to && from === to
      ? t(hoursText.sameClass)
      : !entered || typed === null
        ? null
        : typed < MIN_CONVERT_SECONDS
          ? t(hoursText.tooLittle)
          : fromTier && typed > fromTier.available_seconds
            ? t(hoursText.tooMuch)
            : null;
  const body =
    fromTier && to && to !== from && typed !== null && typed >= MIN_CONVERT_SECONDS && typed <= fromTier.available_seconds
      ? { from_tier_id: from, to_tier_id: to, seconds: typed }
      : null;
  const intent = useIntentKey('convert', body);

  const submit = async () => {
    if (!body) return;
    setError(null);
    try {
      const done = await convertCredits(body, intent.key);
      setResult(done);
      setConfirming(false);
      intent.renew();
      setHours({ value: null, valid: true });
      setMinutes({ value: null, valid: true });
      cloud.refreshDashboard();
    } catch (e) {
      setError(cloudErrorText(e, lang));
    }
  };

  return (
    <section aria-labelledby="cloud-hours-convert" className="lv-surface space-y-3 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="cloud-hours-convert" className="flex items-center gap-2 text-[17px] font-bold text-text-primary">
          <ArrowLeftRight aria-hidden="true" className="h-5 w-5 text-text-secondary" />
          {t(hoursText.convertTitle)}
        </h2>
        <Button variant="secondary" size="sm" aria-expanded={open} aria-controls="cloud-hours-convert-form" onClick={() => setOpen((v) => !v)}>
          {open ? t(hoursText.convertHide) : t(hoursText.convertOpen)}
        </Button>
      </div>
      <p className="text-[13px] leading-relaxed text-text-muted">{t(hoursText.convertIntro)}</p>
      {result ? (
        <p role="status" className="rounded-xl lv-well px-3 py-2 text-[13px] font-semibold text-success">
          {t(hoursText.done, {
            given: formatDuration(result.converted_seconds, lang),
            from: nameOf(result.from_tier_id),
            received: formatDuration(result.received_seconds, lang),
            to: nameOf(result.to_tier_id),
          })}
        </p>
      ) : null}
      <div id="cloud-hours-convert-form" hidden={!open} className="space-y-3">
        {!open ? null : sources.length === 0 ? (
            <p className="text-[13px] text-text-muted">{t(hoursText.nothingToConvert)}</p>
          ) : printers.error ? (
            <CloudErrorState compact error={printers.error} onRetry={printers.reload} />
          ) : !printers.data ? (
            <Skeleton className="h-11 w-full rounded-xl" />
          ) : targets.length === 0 ? (
            <p className="text-[13px] text-text-muted">{t(hoursText.noTarget)}</p>
          ) : (
            <>
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label={t(hoursText.from)} hint={fromTier ? t(hoursText.convertAvailable, { amount: formatDuration(fromTier.available_seconds, lang) }) : undefined}>
                  <Select value={from} onChange={(e) => setFrom(e.currentTarget.value)}>
                    {sources.map((s) => (
                      <option key={s.tier_id} value={s.tier_id}>
                        {tx(s.name, lang) || s.code}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label={t(hoursText.to)}>
                  <Select value={to} onChange={(e) => setTo(e.currentTarget.value)}>
                    <option value="">{t(hoursText.choose)}</option>
                    {targets.map((o) => (
                      <option key={o.id} value={o.id}>
                        {tx(o.name, lang) || o.code}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label={t(hoursText.hoursField)}>
                  <NumberInput kind="number" decimals={0} min={0} value={hours.value} onValueChange={(value, valid) => setHours({ value, valid })} />
                </Field>
                <Field label={t(hoursText.minutesField)}>
                  <NumberInput kind="number" decimals={0} min={0} max={59} value={minutes.value} onValueChange={(value, valid) => setMinutes({ value, valid })} />
                </Field>
              </div>
              {problem ? (
                <p role="alert" className="text-[13px] font-semibold text-danger">
                  {problem}
                </p>
              ) : null}
              <Button variant="primary" disabled={!body} onClick={() => setConfirming(true)}>
                {t(hoursText.review)}
              </Button>
            </>
          )}
      </div>
      <ConfirmDialog
        open={confirming && !!body}
        title={t(hoursText.confirmTitle)}
        consequence={
          body ? (
            <span className="block space-y-2">
              <span className="block">{t(hoursText.confirmGive, { amount: formatDuration(body.seconds, lang), from: nameOf(body.from_tier_id) })}</span>
              <span className="block">{t(hoursText.confirmReceive, { to: nameOf(body.to_tier_id) })}</span>
              <span className="block">{t(hoursText.confirmRules)}</span>
            </span>
          ) : null
        }
        confirmLabel={t(hoursText.confirm)}
        cancelLabel={t(sect.goBack)}
        onConfirm={submit}
        onCancel={() => {
          setConfirming(false);
          setError(null);
        }}
        error={error}
      />
    </section>
  );
}

export default function AccountHours() {
  const { t, lang } = useCloudText();
  const { dashboardVersion } = useCloud();
  const data = useCloudQuery(
    (signal) => Promise.all([getCredits({ signal }), listCreditReservations({ signal })]).then(([credits, reservations]) => ({ credits, reservations })),
    [dashboardVersion]
  );
  const header = <SubPageHeader title={t(hoursText.title)} subtitle={t(hoursText.subtitle)} />;

  if (data.error) {
    return (
      <div>
        {header}
        <CloudErrorState error={data.error} onRetry={data.reload} />
      </div>
    );
  }
  if (!data.data) {
    return (
      <div>
        {header}
        <CloudPageSkeleton />
      </div>
    );
  }
  const { credits, reservations } = data.data;
  const tierName: TierNames = (id) => {
    const tier = credits.tiers.find((x) => x.tier_id === id);
    return tier ? tx(tier.name, lang) || tier.code : id;
  };

  if (credits.tiers.length === 0) {
    return (
      <div>
        {header}
        <CloudEmptyState
          icon={<Clock className="h-6 w-6" />}
          title={t(hoursText.emptyTitle)}
          body={t(hoursText.emptyBody)}
          action={
            <Link to="/store?tab=hours" className="lv-button lv-button-primary">
              {t(hoursText.buy)}
            </Link>
          }
        />
      </div>
    );
  }

  const now = Date.now();
  return (
    <div className="space-y-5">
      {header}
      <div className="space-y-3">
        {credits.tiers.map((tier) => (
          <TierCard key={tier.tier_id} tier={tier} lots={credits.purchases.filter((l) => l.tier_id === tier.tier_id)} now={now} />
        ))}
        {credits.purchases.length >= LOTS_CAP ? <p className="text-[12px] text-text-muted">{t(hoursText.lotsCapped, { n: LOTS_CAP })}</p> : null}
      </div>
      <Holds reservations={reservations} tierName={tierName} />
      <Ledger tierName={tierName} />
      <ConvertHours tiers={credits.tiers} />
    </div>
  );
}
