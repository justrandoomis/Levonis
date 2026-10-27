/**
 * «محادثة» — a free conversation with Claude on Home (POST /ai/chat): talk an idea
 * through or ask for a design. The history lives here (the last CHAT_LIMITS.turns
 * turns are sent); each answer is `{reply, suggested_ideas[]}` checked by the Worker
 * (no price, no link, no unsupported claim), and a suggested idea opens New design
 * with its words, its goal and its product.
 */
import { useRef, useState } from 'react';
import { Button } from '../ui/Button';
import { Card } from '../ui/Card';
import { Textarea } from '../ui/Field';
import { CHAT_LIMITS, type ChatIdea } from '../../../packages/creativeDoc/src/aiContracts';
import type { ChatTurn } from '../../../packages/creativeDoc/src/api';
import { ai, idempotencyKey } from './client';
import { OBJECTIVE_TEXT, S, fill } from './strings';
import { AiNotReady, failText, useStudio, useText } from './shared';
import { chatIdeaPrefill } from './screensModel';

interface Entry extends ChatTurn { ideas?: ChatIdea[]; jobId?: string; dropped?: number }

export default function HomeChat() {
  const studio = useStudio();
  const { lang, w } = useText();
  const [entries, setEntries] = useState<Entry[]>([]);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const endRef = useRef<HTMLDivElement | null>(null);
  const ready = studio.provider?.ready === true;

  const send = async () => {
    const text = draft.trim().slice(0, CHAT_LIMITS.chars);
    if (!text || busy) return;
    const next: Entry[] = [...entries, { role: 'user', text }];
    setEntries(next);
    setDraft('');
    setError('');
    setBusy(true);
    try {
      const res = await ai.chat({ messages: next.slice(-CHAT_LIMITS.turns).map(({ role, text: t }) => ({ role, text: t })), idempotency_key: idempotencyKey() });
      setEntries([...next, { role: 'assistant', text: res.reply, ideas: res.suggested_ideas, jobId: res.job_id, dropped: res.dropped }]);
    } catch (e) {
      setError(failText(e, lang));
    } finally {
      setBusy(false);
      requestAnimationFrame(() => endRef.current?.scrollIntoView({ block: 'nearest' }));
    }
  };

  return (
    <Card title={w(S.homeChatTitle)} description={w(S.homeChatHint)} action={entries.length ? <Button size="sm" variant="ghost" onClick={() => { setEntries([]); setError(''); }}>{w(S.homeChatClear)}</Button> : undefined}>
      {!ready ? <AiNotReady provider={studio.provider} onSettings={() => studio.goTab('settings')} /> : (
        <div className="flex flex-col gap-3" data-home-chat>
          {entries.length ? (
            <ol className="flex max-h-96 flex-col gap-2 overflow-y-auto" aria-live="polite">
              {entries.map((m, i) => (
                <li key={i} className={`rounded-xl p-3 text-sm ${m.role === 'user' ? 'bg-surface text-text-primary' : 'border border-border-subtle text-text-primary'}`}>
                  <span className="mb-1 block text-xs text-text-muted">{m.role === 'user' ? w(S.homeChatYou) : 'Claude'}</span>
                  <span className="block whitespace-pre-line">{m.text}</span>
                  {m.ideas?.length ? (
                    <div className="mt-2 flex flex-col gap-2">
                      <span className="text-xs font-semibold text-text-secondary">{w(S.homeChatIdeas)}</span>
                      {m.ideas.map((idea, j) => (
                        <div key={j} className="rounded-lg border border-border-subtle p-2">
                          <p className="font-semibold">{idea.headline}</p>
                          {idea.subhead ? <p className="text-text-secondary">{idea.subhead}</p> : null}
                          <p className="text-xs text-text-muted">{w(OBJECTIVE_TEXT[idea.objective])}{idea.note ? ` · ${idea.note}` : ''}</p>
                          <Button size="sm" className="mt-1" onClick={() => studio.startNew(chatIdeaPrefill(idea, m.jobId ?? ''))} data-chat-idea>{w(S.homeUseIdea)}</Button>
                        </div>
                      ))}
                    </div>
                  ) : null}
                  {m.dropped ? <span className="mt-1 block text-xs text-text-muted">{fill(w(S.homeChatDropped), { n: m.dropped })}</span> : null}
                </li>
              ))}
            </ol>
          ) : null}
          <div ref={endRef} />
          {error ? <p className="text-sm text-danger" role="alert">{error}</p> : null}
          <Textarea
            rows={2}
            value={draft}
            maxLength={CHAT_LIMITS.chars}
            placeholder={w(S.homeChatPlaceholder)}
            aria-label={w(S.homeChatPlaceholder)}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send(); } }}
            data-chat-input
          />
          <Button variant="primary" loading={busy} disabled={!draft.trim()} onClick={send} data-chat-send>{w(S.homeChatSend)}</Button>
        </div>
      )}
    </Card>
  );
}
