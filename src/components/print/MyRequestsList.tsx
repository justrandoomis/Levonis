/**
 * "طلباتي" — the customer's own requests, told as a story rather than a table.
 *
 * WHY THIS IS NOT `RequestList`. The public board renders what a stranger may
 * see about somebody's request; this renders what its OWNER needs: the estimate
 * Levonis produced, how many merchants answered, which one they picked and when
 * it was promised. Those come from an owner-scoped route
 * (`GET /api/marketplace/print/my-requests`) rather than from widening the
 * board's privacy whitelist — see the comment on that handler.
 *
 * Each row is the owner card of the shared request card (community UI plan
 * C3, `RequestListCard variant="owner"`): the first picture, the own
 * budget, the estimate, the chosen merchant and its price, and the marks a
 * row must keep (the technical review, an estimate over some parts only,
 * models left out of it, the estimate confidence, a partial or substituted
 * order). Pages arrive as the list end comes into view (plan B3 `cursor`).
 * The board filters (the owner states, the process, the governorate) and
 * its search narrow the rows read so far.
 *
 * "إعادة الطلب" copies a request into a NEW one and PUBLISHES it — the copy
 * goes through the same matching as a first publish, so the merchants who can
 * make it are told (audit 03 §10 E: copies used to land on the board unmatched).
 * It asks first, in a sheet, because it duplicates files, starts a fresh 30-day
 * clock and notifies merchants; then it takes the person to the copy. If the
 * publish step failed, the copy is a draft and the person is told so, with the
 * draft's own Publish button one tap away — never a success that was not one.
 */

import { useCallback, useEffect, useState } from 'react';
import { PackageSearch } from 'lucide-react';
import { useLanguage } from '../../LanguageContext';
import { useAuth } from '../../AuthContext';
import { UnauthorizedState } from '../ui/AsyncStates';
import { Skeleton, SkeletonGroup } from '../ui/Skeleton';
import { printApi, type MyRequestRow } from '../../lib/printApi';
import { iqdNumber, iqdUnit } from '../../lib/money';
import { apiRefusal } from '../../lib/refusalStrings';
import { asLang } from '../orders/format';
import ConfirmSheet from './ConfirmSheet';
import { CommunityLoadError } from '../../pages/community/access';
import { fill, requestStrings } from '../community/requests/strings';
import { customOrderChips } from '../chat/cards/cardWords';
import RequestListCard from '../community/requests/RequestListCard';
import { MINE_STATES, PageSentinel, type BoardFilterValues } from '../community/requests/FilterSelect';

/**
 * WHAT THE SUMMARY ADDS TO A ROW OF «طلباتي» (P1-05, DECISIONS row 267 §8;
 * review 3): the technical review, an estimate that sums only the priced
 * parts (never read as the price of the job, R10), and the model files the
 * estimate did not price — each an empty string when it does not apply, or on
 * an older Worker that sends no summary. The unpriced files are said only
 * beside an estimate, as the request page says them (review 4): a draft or an
 * unpriced job has no estimate for a file to be left out of.
 */
export function myRequestNotes(r: Pick<MyRequestRow, 'summary' | 'print'>, lang: string): { review: string; partial: string; unpriced: string } {
  const s = requestStrings(lang);
  const sum = r.summary;
  const estimated = !!r.print && (r.print.estimate_low_iqd !== null || r.print.estimate_high_iqd !== null);
  return {
    review: sum?.review_state === 'needs_technical_review' ? s.reviewChip : '',
    partial: sum && sum.estimate_complete === false ? s.estimatePricedOnly : '',
    unpriced: estimated && sum && sum.models_unpriced > 0 ? fill(s.modelsUnpriced, { n: sum.models_unpriced }) : '',
  };
}

const NO_FILTERS: BoardFilterValues = { state: null, process: null, governorate: null };

/** The rows the filters and the search keep: the owner states, the process, the governorate, the title. */
export function filterMine(rows: MyRequestRow[], f: BoardFilterValues, q: string): MyRequestRow[] {
  const needle = q.trim().toLowerCase();
  return rows.filter(
    (r) =>
      (!f.state || (MINE_STATES[f.state] ?? []).includes(r.state)) &&
      (!f.process || r.print?.process === f.process) &&
      (!f.governorate || r.governorate === f.governorate) &&
      (!needle || r.title.toLowerCase().includes(needle))
  );
}

export default function MyRequestsList({ onOpen, filters = NO_FILTERS, q = '' }: { onOpen: (id: string) => void; filters?: BoardFilterValues; q?: string }) {
  const { lang, loc } = useLanguage();
  const s = requestStrings(lang);
  const { isAuthenticated } = useAuth();
  const [rows, setRows] = useState<MyRequestRow[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [more, setMore] = useState(false);
  const [moreError, setMoreError] = useState(false);
  const [repeating, setRepeating] = useState('');
  const [error, setError] = useState('');
  /** The request the customer asked to repeat — the sheet confirms it. */
  const [asking, setAsking] = useState<MyRequestRow | null>(null);
  const [notice, setNotice] = useState('');
  const [loadError, setLoadError] = useState<unknown>(null);

  const load = useCallback(() => {
    if (!isAuthenticated) {
      setRows([]);
      return;
    }
    setLoadError(null);
    printApi
      .myRequests()
      .then((d) => {
        setRows(d.requests);
        setCursor(d.next_cursor ?? null);
      })
      .catch((e: unknown) => setLoadError(e));
  }, [isAuthenticated]);

  useEffect(load, [load]);

  async function loadMore() {
    if (!cursor || more) return;
    setMore(true);
    setMoreError(false);
    try {
      const d = await printApi.myRequests(cursor);
      setRows((r) => [...(r ?? []), ...d.requests.filter((x) => !(r ?? []).some((y) => y.id === x.id))]);
      setCursor(d.next_cursor ?? null);
    } catch {
      setMoreError(true);
    } finally {
      setMore(false);
    }
  }

  async function repeat(row: MyRequestRow) {
    setRepeating(row.id);
    setError('');
    setNotice('');
    try {
      const d = await printApi.repeat(row.id);
      setAsking(null);
      load();
      // W5-A: a repeat is always a DRAFT — reviewed, then published.
      if (!d.published) setNotice(s.repeatedDraft);
      onOpen(d.request_id);
    } catch (e) {
      setError(apiRefusal(e, asLang(lang), s.couldNotRepeat));
    } finally {
      setRepeating('');
    }
  }

  if (!isAuthenticated) return <UnauthorizedState next="/requests?view=mine" />;

  if (rows === null) {
    // A list that did not load is not «you have no requests».
    if (loadError) return <CommunityLoadError error={loadError} onRetry={load} />;
    return (
      <SkeletonGroup className="space-y-3">
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-40 w-full rounded-xl" />
        ))}
      </SkeletonGroup>
    );
  }

  if (!rows.length) {
    return (
      <div className="py-14 text-center" data-requests-empty="mine">
        <PackageSearch aria-hidden="true" className="mx-auto mb-3 h-9 w-9 text-text-muted" />
        <p className="text-[13px] text-text-secondary">{s.noRequestsYet}</p>
      </div>
    );
  }

  const shown = filterMine(rows, filters, q);
  const L = asLang(lang);
  return (
    <div className="space-y-3" data-my-requests>
      {notice && (
        <p role="status" className="lv-alert lv-alert-warning text-[12.5px] text-text-primary">
          {notice}
        </p>
      )}

      <ConfirmSheet
        open={!!asking}
        testId="repeat-request"
        title={s.repeatQ}
        confirmLabel={s.repeatConfirm}
        busyLabel={s.repeating}
        busy={!!asking && repeating === asking.id}
        error={error}
        onConfirm={() => asking && repeat(asking)}
        onClose={() => setAsking(null)}
      >
        {asking && fill(s.repeatBody, { title: asking.title })}
      </ConfirmSheet>

      {!shown.length && (
        <p className="py-10 text-center text-[13px] text-text-secondary" data-requests-empty={q ? 'search' : 'filters'}>
          {q ? <bdi>{fill(s.noResultsFor, { q })}</bdi> : s.noFilterMatch}
        </p>
      )}

      {shown.map((r) => {
        const p = r.print;
        const notes = myRequestNotes(r, lang);
        const accepted = r.accepted;
        // A partial or substituted order is never read as the whole job (P1-05 review 6).
        const orderChips = r.accepted ? customOrderChips(r.accepted, loc) : [];
        const estimated = !!p && (p.estimate_low_iqd !== null || p.estimate_high_iqd !== null);
        const chips = [
          notes.review,
          // A sum over some parts is not the job price: said beside it (R10, P1-05).
          estimated ? notes.partial : '',
          notes.unpriced,
          estimated && p?.estimate_confidence ? s.confidence[p.estimate_confidence] : '',
          ...orderChips,
        ].filter(Boolean);
        const chosen = accepted
          ? accepted.price_iqd !== null
            ? `${accepted.merchant_name} · ${iqdNumber(accepted.price_iqd, L)} ${iqdUnit(L)}`
            : accepted.merchant_name
          : null;
        return (
          <div
            key={r.id}
            data-my-request={r.id}
            data-my-request-review={notes.review ? '' : undefined}
            data-my-request-partial={estimated && notes.partial ? '' : undefined}
            data-my-request-accepted-chip={orderChips.length ? '' : undefined}
          >
            <RequestListCard
              variant="owner"
              request={{
                id: r.id,
                title: r.title,
                state: r.state,
                quantity: r.quantity,
                material: p?.material_id || r.material,
                governorate: r.governorate,
                offer_count: r.offer_count,
                file_count: r.file_count,
                deadline: r.deadline,
                created_at: r.created_at,
                summary: r.summary ? { parts_count: r.summary.parts_count, pieces_per_set: r.summary.pieces_per_set } : null,
                cover_url: r.cover_url ?? null,
                budget_iqd: r.budget_iqd,
                estimate_low_iqd: p?.estimate_low_iqd ?? null,
                estimate_high_iqd: p?.estimate_high_iqd ?? null,
                accepted_merchant: chosen,
              }}
              chips={chips}
              onRepeat={() => {
                if (repeating) return;
                setError('');
                setAsking(r);
              }}
            />
          </div>
        );
      })}
      <PageSentinel more={!!cursor} busy={more} failed={moreError} onMore={loadMore} s={s} />
    </div>
  );
}
