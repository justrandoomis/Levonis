/**
 * «شنو أنشر اليوم؟» — the studio’s front page (spec §10, §33).
 *
 * The OPPORTUNITIES are deterministic: computed by the server from the shop’s
 * own records (arrivals, returns to stock, live offers, coverage gaps,
 * approved services) and shown with or without AI. Claude’s IDEAS appear
 * only when the provider is ready and the owner asks; each says why and
 * which evidence it rests on (an idea without evidence is refused upstream).
 * Then the recent drafts and the two ways to start.
 */
import { useState } from 'react';
import { Button } from '../ui/Button';
import { Card } from '../ui/Card';
import { StatusChip } from '../ui/Badge';
import type { IdeaRecordDto, IdeasResponse, OpportunityDto } from '../../../packages/creativeDoc/src/api';
import { localized } from '../../../packages/creativeDoc/src/snapshot';
import { ai, documents, idempotencyKey } from './client';
import { FORMAT_TEXT, OBJECTIVE_TEXT, OPPORTUNITY_TEXT, STATUS_TEXT, S, fill } from './strings';
import { AiNotReady, RemoteView, failText, shortTime, useRemote, useStudio, useText } from './shared';

export default function Home() {
  const studio = useStudio();
  const { lang, w } = useText();
  const [opps, reloadOpps] = useRemote(() => ai.opportunities(), []);
  const [drafts, reloadDrafts] = useRemote(() => documents.list({ status: 'draft', limit: 8 }), []);
  const [ideas, setIdeas] = useState<IdeasResponse | null>(null);
  const [ideasBusy, setIdeasBusy] = useState(false);
  const [ideasError, setIdeasError] = useState('');
  const ready = studio.provider?.ready === true;

  const askIdeas = async (list: OpportunityDto[]) => {
    setIdeasError('');
    setIdeasBusy(true);
    try {
      const priorities = [...new Set(list.map((o) => o.kind))];
      setIdeas(await ai.ideas({ count: 5, priorities, idempotency_key: idempotencyKey() }));
    } catch (e) {
      setIdeasError(failText(e, lang));
    } finally {
      setIdeasBusy(false);
    }
  };

  const startFromIdea = (idea: IdeaRecordDto) => {
    studio.startNew({
      mode: idea.target_kind === 'service' ? 'service' : 'product',
      productId: idea.target_kind === 'product' ? idea.target_ref : undefined,
      claimId: idea.target_kind === 'service' ? idea.target_ref : undefined,
      objective: idea.objective,
      copy: { headline: idea.headline, subhead: idea.subhead, cta: idea.cta },
      jobId: idea.job_id,
    });
  };

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-4 p-4" data-studio-home>
      <h1 className="text-xl font-bold text-text-primary">{w(S.homeQuestion)}</h1>
      <div className="flex flex-wrap gap-2">
        <Button variant="primary" onClick={() => studio.startNew({ mode: 'product' })}>{w(S.homeStartProduct)}</Button>
        <Button onClick={() => studio.startNew({ mode: 'service' })}>{w(S.homeStartService)}</Button>
      </div>

      <Card title={w(S.homeQuestion)} description={w(S.homeEvidenceNote)}>
        <RemoteView remote={opps} onRetry={reloadOpps} compact>
          {(list) => (
            <>
              {list.length === 0 ? <p className="text-sm text-text-muted">{w(S.homeNoOpportunities)}</p> : (
                <ul className="flex flex-col gap-2" data-opportunities>
                  {list.map((o) => (
                    <li key={o.id} className="flex flex-wrap items-start gap-2 rounded-lg border border-border-subtle p-2">
                      <StatusChip tone={o.kind === 'arrival' || o.kind === 'back_in_stock' ? 'success' : o.kind === 'offer' ? 'accent' : 'neutral'}>{w(OPPORTUNITY_TEXT[o.kind])}</StatusChip>
                      <span className="min-w-0 flex-1">
                        <span className="block text-sm text-text-primary">{localized(o.label, lang)}</span>
                        {o.detail ? <span className="block text-xs text-text-muted">{o.detail}</span> : null}
                      </span>
                      {o.detected_at ? <span className="text-xs text-text-muted">{shortTime(o.detected_at, lang)}</span> : null}
                    </li>
                  ))}
                </ul>
              )}
              <div className="mt-4 flex flex-col gap-2">
                <h3 className="text-sm font-semibold text-text-primary">{w(S.homeIdeas)}</h3>
                {ready ? (
                  <Button size="sm" loading={ideasBusy} onClick={() => askIdeas(list)}>{w(S.homeAskIdeas)}</Button>
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
                          <p className="mt-1 text-xs text-text-muted">{w(OBJECTIVE_TEXT[idea.objective])}</p>
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
