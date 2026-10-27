/**
 * «شنو أنشر اليوم؟» — the studio’s front page (spec §10, §33).
 *
 * The OPPORTUNITIES are deterministic: computed by the server from the shop’s
 * own records (arrivals, returns to stock, live offers, coverage gaps,
 * approved services) and shown with or without AI. Claude’s IDEAS appear
 * only when the provider is ready and the owner asks; each shows every field
 * the contract validates (audience, message, CTA, post type, composition,
 * caption, alt text), says why and which evidence it rests on (an idea
 * without evidence is refused upstream), and «use this idea» carries all of
 * it into New design. The request sends NO priorities: the owner’s own live
 * in Settings, and the opportunity kinds on screen are not priorities.
 * «تحديث الكتالوج» runs the catalogue watch to the end of a pass (arrivals
 * and returns to stock are detected only by it), and says when that pass was
 * only the baseline. Then the recent drafts and the two ways to start.
 */
import { useEffect, useRef, useState } from 'react';
import { Button } from '../ui/Button';
import { Card } from '../ui/Card';
import { StatusChip } from '../ui/Badge';
import type { IdeaRecordDto, IdeasResponse } from '../../../packages/creativeDoc/src/api';
import { localized } from '../../../packages/creativeDoc/src/snapshot';
import { VARIANT_LABELS } from '../../../packages/creativeDoc/src/templates';
import { ai, documents, idempotencyKey, watch } from './client';
import { FORMAT_TEXT, OBJECTIVE_TEXT, OPPORTUNITY_TEXT, STATUS_TEXT, S, fill } from './strings';
import { AiNotReady, RemoteView, failText, shortTime, useRemote, useStudio, useText } from './shared';
import { ideaPrefill, ideasRequest, opportunityPrefill, runCatalogSync, type SyncTotals } from './screensModel';
import HomeChat from './HomeChat';

const POST_TYPE_TEXT = { single: S.homePostSingle, carousel: S.homePostCarousel, story: S.homePostStory } as const;

export default function Home() {
  const studio = useStudio();
  const { lang, w } = useText();
  const [opps, reloadOpps] = useRemote(() => ai.opportunities(), []);
  const [drafts, reloadDrafts] = useRemote(() => documents.list({ status: 'draft', limit: 8 }), []);
  const [ideas, setIdeas] = useState<IdeasResponse | null>(null);
  const [ideasBusy, setIdeasBusy] = useState(false);
  const [ideasError, setIdeasError] = useState('');
  const ready = studio.provider?.ready === true;
  const [sync, setSync] = useState<{ running: boolean; totals: SyncTotals | null; error: string }>({ running: false, totals: null, error: '' });
  const gone = useRef(false);
  useEffect(() => () => { gone.current = true; }, []);

  const askIdeas = async () => {
    setIdeasError('');
    setIdeasBusy(true);
    try {
      setIdeas(await ai.ideas(ideasRequest(idempotencyKey())));
    } catch (e) {
      setIdeasError(failText(e, lang));
    } finally {
      setIdeasBusy(false);
    }
  };

  const syncCatalog = async () => {
    setSync({ running: true, totals: null, error: '' });
    let last: SyncTotals | null = null;
    try {
      last = await runCatalogSync(() => watch.sync(), (t) => { last = t; if (!gone.current) setSync({ running: true, totals: t, error: '' }); }, () => gone.current);
      if (!gone.current) setSync({ running: false, totals: last, error: '' });
      reloadOpps();
    } catch (e) {
      if (!gone.current) setSync({ running: false, totals: last, error: failText(e, lang) });
    }
  };

  const syncText = (t: SyncTotals | null, running: boolean): string => {
    if (!t) return running ? fill(w(S.homeSyncProgress), { n: 0 }) : '';
    if (running) return fill(w(S.homeSyncProgress), { n: t.processed });
    if (!t.complete) return fill(w(S.homeSyncPartial), { n: t.processed });
    if (t.baseline) return fill(w(S.homeSyncBaseline), { n: t.processed });
    return fill(w(S.homeSyncDone), { n: t.processed, arrivals: t.arrivals, back: t.back_in_stock });
  };

  const startFromIdea = (idea: IdeaRecordDto) => studio.startNew(ideaPrefill(idea));

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-4 p-4" data-studio-home>
      <h1 className="text-xl font-bold text-text-primary">{w(S.homeQuestion)}</h1>
      <div className="flex flex-wrap gap-2">
        <Button variant="primary" onClick={() => studio.startNew({ mode: 'product' })}>{w(S.homeStartProduct)}</Button>
        <Button onClick={() => studio.startNew({ mode: 'multi' })} data-start-multi>{w(S.homeStartMulti)}</Button>
        <Button onClick={() => studio.startNew({ mode: 'service' })}>{w(S.homeStartService)}</Button>
      </div>

      <HomeChat />

      <Card
        title={w(S.homeQuestion)}
        description={w(S.homeEvidenceNote)}
        action={<Button size="sm" loading={sync.running} onClick={syncCatalog} data-sync-catalog>{w(S.homeSyncCatalog)}</Button>}
      >
        <p className="mb-2 text-xs text-text-muted">{w(S.homeSyncHint)}</p>
        {sync.running || sync.totals ? <p className="mb-3 text-sm text-text-secondary" role="status" data-sync-status={sync.running ? 'running' : sync.totals?.baseline ? 'baseline' : sync.totals?.complete ? 'done' : 'partial'}>{syncText(sync.totals, sync.running)}</p> : null}
        {sync.error ? <p className="mb-3 text-sm text-danger" role="alert">{sync.error}</p> : null}
        <RemoteView remote={opps} onRetry={reloadOpps} compact>
          {(list) => (
            <>
              {list.length === 0 ? <p className="text-sm text-text-muted">{w(S.homeNoOpportunities)}</p> : (
                <ul className="flex flex-col gap-2" data-opportunities>
                  {list.map((o) => (
                    <li key={o.id}>
                      {/* Each row opens New design: a product row on that product, a topic row with its goal set. */}
                      <button
                        type="button"
                        className="flex w-full flex-wrap items-start gap-2 rounded-lg border border-border-subtle p-2 text-start hover:bg-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
                        onClick={() => studio.startNew(opportunityPrefill(o))}
                        aria-label={`${w(S.homeOpenOpportunity)}: ${localized(o.label, lang)}`}
                        data-opportunity={o.kind}
                      >
                        <StatusChip tone={o.kind === 'arrival' || o.kind === 'back_in_stock' ? 'success' : o.kind === 'offer' ? 'accent' : 'neutral'}>{w(OPPORTUNITY_TEXT[o.kind])}</StatusChip>
                        <span className="min-w-0 flex-1">
                          <span className="block text-sm text-text-primary">{localized(o.label, lang)}</span>
                          {o.detail ? <span className="block text-xs text-text-muted">{o.detail}</span> : null}
                        </span>
                        {o.detected_at ? <span className="text-xs text-text-muted">{shortTime(o.detected_at, lang)}</span> : null}
                        <span className="text-xs text-accent" aria-hidden="true">{w(S.homeOpenOpportunity)}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              <div className="mt-4 flex flex-col gap-2">
                <h3 className="text-sm font-semibold text-text-primary">{w(S.homeIdeas)}</h3>
                {ready ? (
                  <Button size="sm" loading={ideasBusy} onClick={askIdeas}>{w(S.homeAskIdeas)}</Button>
                ) : (
                  <AiNotReady provider={studio.provider} onSettings={() => studio.goTab('settings')} />
                )}
                {ideasError ? <p className="text-sm text-danger" role="alert">{ideasError}</p> : null}
                {ideas ? (
                  <>
                    {ideas.rejected > 0 ? <p className="text-xs text-text-muted">{fill(w(S.homeIdeasRejected), { n: ideas.rejected })}</p> : null}
                    <ul className="flex flex-col gap-2" data-ideas>
                      {ideas.ideas.map((idea) => (
                        <li key={idea.id} className="rounded-lg border border-border-subtle p-3">
                          <p className="text-sm font-semibold text-text-primary">{idea.headline}</p>
                          {idea.subhead ? <p className="text-sm text-text-secondary">{idea.subhead}</p> : null}
                          <p className="mt-1 text-xs text-text-muted">{w(OBJECTIVE_TEXT[idea.objective])} · {w(POST_TYPE_TEXT[idea.post_type])} · {w(S.homeIdeaLayout)}: {VARIANT_LABELS[idea.layout][lang]}</p>
                          <dl className="mt-2 grid gap-x-3 gap-y-1 text-sm sm:grid-cols-[max-content_1fr]" data-idea-fields>
                            {([
                              [S.homeIdeaAudience, idea.audience],
                              [S.homeIdeaMessage, idea.message],
                              [S.homeIdeaCta, idea.cta],
                              [S.homeIdeaCaption, idea.caption],
                              [S.homeIdeaAlt, idea.alt_text],
                            ] as const).filter(([, v]) => v).map(([label, v]) => (
                              <div key={label.en} className="contents">
                                <dt className="text-text-muted">{w(label)}</dt>
                                <dd className="min-w-0 whitespace-pre-line text-text-primary">{v}</dd>
                              </div>
                            ))}
                          </dl>
                          <p className="mt-1 text-sm"><span className="text-text-muted">{w(S.homeIdeaWhy)}: </span>{idea.reason}</p>
                          <p className="mt-1 text-xs text-text-muted">
                            {w(S.homeIdeaEvidence)}: {idea.evidence_ids.map((id) => {
                              const o = list.find((x) => x.id === id);
                              return o ? `${w(OPPORTUNITY_TEXT[o.kind])} — ${localized(o.label, lang)}` : id;
                            }).join('، ')}
                          </p>
                          <Button size="sm" className="mt-2" onClick={() => startFromIdea(idea)}>{w(S.homeUseIdea)}</Button>
                        </li>
                      ))}
                    </ul>
                    {ideas.notes.length ? <ul className="list-disc ps-5 text-xs text-text-muted">{ideas.notes.map((n, i) => <li key={i}>{n}</li>)}</ul> : null}
                  </>
                ) : null}
              </div>
            </>
          )}
        </RemoteView>
      </Card>

      <Card title={w(S.homeRecent)}>
        <RemoteView remote={drafts} onRetry={reloadDrafts} compact>
          {({ documents: list, migrated }) => (
            !migrated ? <p className="text-sm text-text-muted">{w(S.notMigrated)}</p>
              : list.length === 0 ? <p className="text-sm text-text-muted">{w(S.homeNoDrafts)}</p>
              : (
                <ul className="grid gap-2 sm:grid-cols-2" data-recent-drafts>
                  {list.map((d) => (
                    <li key={d.id}>
                      <button type="button" className="flex w-full flex-col rounded-lg border border-border-subtle p-3 text-start focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus" onClick={() => studio.openDocument(d.id)}>
                        <span className="truncate text-sm font-semibold text-text-primary">{d.title}</span>
                        <span className="text-xs text-text-muted">{w(STATUS_TEXT[d.status])} · {w(FORMAT_TEXT[d.format.id])} · {fill(w(S.archiveUpdated), { time: shortTime(d.updated_at, lang) })}</span>
                        {d.product_name ? <span className="truncate text-xs text-text-secondary">{localized(d.product_name, lang)}</span> : null}
                      </button>
                    </li>
                  ))}
                </ul>
              )
          )}
        </RemoteView>
      </Card>
    </div>
  );
}
