/**
 * WHAT A REPORT NAMES, DRAWN FOR THE DESK — one preview per kind the queue
 * renders (`RenderedTarget`, worker/routes/adminModeration.ts `renderTargets`):
 * a post as its card (cover, title, words, author, and the hide in force), a
 * comment or a request comment or an order update as its words and its
 * author, an account as its name and standing, a store, a product, a request.
 * A target that no longer exists says so. Nothing here is an email, a phone
 * or a storage key — the server sends none — and every «فتح» opens the thing
 * where the public sees it, in a new tab, so the desk keeps its place.
 */
import type { ReactNode } from 'react';
import { ExternalLink, Paperclip, Store, UserRound } from 'lucide-react';
import { StatusChip } from '../../ui/Badge';
import type { PersonRef, RenderedTarget } from './api';
import { deskDate, deskStrings, type DeskLang } from './strings';

/** A person's standing as a chip — nothing for an active account. */
export function StandingChip({ status, until, lang }: { status?: string; until?: string | null; lang: DeskLang }) {
  const s = deskStrings(lang);
  if (!status || status === 'active' || !(status in s.statuses)) return null;
  const date = until ? deskDate(until, lang) : '';
  return (
    <StatusChip tone={status === 'restricted' ? 'warning' : 'danger'} className="align-middle">
      {s.statuses[status as keyof typeof s.statuses]}
      {date ? ` · ${s.until(date)}` : ''}
    </StatusChip>
  );
}

/** «الكاتب: سارة (@sara) · مقيَّد». */
export function PersonLine({ role, person, lang }: { role: string; person: PersonRef | null | undefined; lang: DeskLang }) {
  if (!person?.id) return null;
  return (
    <p className="mt-1.5 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[12px] text-text-muted" data-target-person={person.id}>
      <span>{role}:</span>
      <bdi className="font-semibold text-text-secondary">{person.name || person.username || person.id}</bdi>
      {person.username && (
        <span dir="ltr" className="text-text-muted">
          @{person.username}
        </span>
      )}
      <StandingChip status={person.status} lang={lang} />
    </p>
  );
}

function OpenLink({ href, lang }: { href: string | null | undefined; lang: DeskLang }) {
  if (!href) return null;
  const s = deskStrings(lang);
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className="lv-button lv-button-ghost lv-button-sm gap-1.5" data-target-open>
      <ExternalLink aria-hidden="true" className="h-3.5 w-3.5" />
      {s.open}
    </a>
  );
}

function Quote({ children }: { children: ReactNode }) {
  return (
    <p dir="auto" className="whitespace-pre-wrap break-words border-s-2 border-border-subtle ps-3 text-[13px] leading-relaxed text-text-primary line-clamp-4">
      {children}
    </p>
  );
}

function HiddenMark({ reason, lang }: { reason?: string; lang: DeskLang }) {
  const s = deskStrings(lang);
  return (
    <p className="mt-2 flex flex-wrap items-center gap-1.5 text-[12px] text-text-secondary" data-target-hidden>
      <StatusChip tone="danger">{s.hidden}</StatusChip>
      {reason && <span dir="auto">{reason}</span>}
    </p>
  );
}

function Mark({ src, round, fallback }: { src?: string | null; round?: boolean; fallback: ReactNode }) {
  return (
    <span className={`flex size-12 shrink-0 items-center justify-center overflow-hidden bg-surface-selected text-text-muted ${round ? 'rounded-full' : 'rounded-lg'}`}>
      {src ? <img src={src} alt="" loading="lazy" referrerPolicy="no-referrer" className="h-full w-full object-cover" /> : fallback}
    </span>
  );
}

export default function TargetPreview({ target, lang }: { target: RenderedTarget; lang: DeskLang }) {
  const s = deskStrings(lang);
  const shell = 'rounded-xl bg-surface-raised p-3';
  if (!target.exists) {
    return (
      <div className={`${shell} text-[12.5px] text-text-muted`} data-target={target.kind} data-target-gone>
        {s.kinds[target.kind]} · {s.gone}
      </div>
    );
  }
  switch (target.kind) {
    case 'post': {
      const card = target.card;
      return (
        <div className={shell} data-target="post">
          <div className="flex items-start gap-3">
            <Mark src={card?.cover?.kind === 'image' ? card.cover.url : null} fallback={<span className="text-[11px]">{s.kinds.post}</span>} />
            {/* Beside its picture the title keeps the page's side; <bdi> keeps
                an Arabic title's words in order inside an English desk. */}
            <div className="min-w-0 flex-1">
              <p className="line-clamp-2 text-[13.5px] font-bold leading-snug text-text-primary">
                <bdi>{card?.title || s.kinds.post}</bdi>
              </p>
              {card?.excerpt && (
                <p className="mt-0.5 line-clamp-2 text-[12.5px] text-text-secondary">
                  <bdi>{card.excerpt}</bdi>
                </p>
              )}
            </div>
          </div>
          {target.hidden && <HiddenMark reason={target.hidden.reason} lang={lang} />}
          <PersonLine role={s.roles.author} person={target.author} lang={lang} />
          <div className="mt-1 flex justify-end">
            <OpenLink href={card?.url} lang={lang} />
          </div>
        </div>
      );
    }
    case 'comment':
    case 'request_comment':
    case 'order_update': {
      const href =
        target.kind === 'comment'
          ? target.post_url
          : target.kind === 'request_comment' && target.request_id
            ? `/requests/${encodeURIComponent(target.request_id)}`
            : null;
      const state = target.kind === 'order_update' ? '' : target.state ?? '';
      const reason = target.kind === 'order_update' ? '' : target.hidden_reason ?? '';
      return (
        <div className={shell} data-target={target.kind}>
          <Quote>{target.body || '—'}</Quote>
          {target.kind === 'order_update' && target.has_file && (
            <p className="mt-1.5 flex items-center gap-1 text-[12px] text-text-muted">
              <Paperclip aria-hidden="true" className="h-3.5 w-3.5" />
              {s.attachment}
            </p>
          )}
          {state === 'hidden' && <HiddenMark reason={reason} lang={lang} />}
          <PersonLine role={s.roles.author} person={target.author} lang={lang} />
          <div className="mt-1 flex items-center justify-between gap-2">
            <span className="text-[11.5px] text-text-muted">{deskDate(target.created_at, lang, true)}</span>
            <OpenLink href={href} lang={lang} />
          </div>
        </div>
      );
    }
    case 'user':
      return (
        <div className={shell} data-target="user">
          <div className="flex items-center gap-3">
            <Mark src={target.avatarUrl} round fallback={<UserRound aria-hidden="true" className="h-5 w-5" />} />
            <div className="min-w-0 flex-1">
              <p className="flex flex-wrap items-center gap-1.5 text-[13.5px] font-bold text-text-primary">
                <bdi>{target.name || target.username || target.id}</bdi>
                {target.staff && <StatusChip tone="info">{s.staff}</StatusChip>}
                <StandingChip status={target.status} until={target.status_until} lang={lang} />
              </p>
              {target.username && (
                <p className="text-[12px] text-text-muted">
                  <bdi dir="ltr">@{target.username}</bdi>
                </p>
              )}
              {target.status_reason && target.status !== 'active' && (
                <p className="mt-0.5 text-[12px] text-text-secondary">
                  <bdi>{target.status_reason}</bdi>
                </p>
              )}
            </div>
          </div>
          <div className="mt-1 flex justify-end">
            <OpenLink href={target.creator_public && target.username ? `/u/${encodeURIComponent(target.username)}` : null} lang={lang} />
          </div>
        </div>
      );
    case 'store':
      return (
        <div className={shell} data-target="store">
          <div className="flex items-center gap-3">
            <Mark src={target.logoUrl} fallback={<Store aria-hidden="true" className="h-5 w-5" />} />
            <div className="min-w-0 flex-1">
              <p className="text-[13.5px] font-bold text-text-primary">
                <bdi>{target.name}</bdi>
              </p>
              {target.slug && (
                <p className="text-[12px] text-text-muted">
                  <bdi dir="ltr">{target.slug}</bdi>
                </p>
              )}
              <p className="mt-1 flex flex-wrap gap-1.5">
                <StandingChip status={target.status} lang={lang} />
                {target.merchant_status !== target.status && <StandingChip status={target.merchant_status} lang={lang} />}
              </p>
            </div>
          </div>
          <div className="mt-1 flex justify-end">
            <OpenLink href={target.slug ? `/community/store/${encodeURIComponent(target.slug)}` : null} lang={lang} />
          </div>
        </div>
      );
    case 'product': {
      const name = (lang !== 'en' && target.name_ar) || target.name || target.name_ar || '';
      return (
        <div className={shell} data-target="product">
          <p className="text-[13.5px] font-bold text-text-primary">
            <bdi>{name}</bdi>
          </p>
          {target.hidden && <HiddenMark reason={target.hidden.reason} lang={lang} />}
          <div className="mt-1 flex justify-end">
            <OpenLink href={target.store_slug && target.slug ? `/community/store/${encodeURIComponent(target.store_slug)}/p/${encodeURIComponent(target.slug)}` : null} lang={lang} />
          </div>
        </div>
      );
    }
    case 'request':
      return (
        <div className={shell} data-target="request">
          <p className="text-[13.5px] font-bold text-text-primary">
            <bdi>{target.title}</bdi>
          </p>
          <PersonLine role={s.roles.customer} person={target.customer ? { ...target.customer, username: null } : null} lang={lang} />
          <div className="mt-1 flex justify-end">
            <OpenLink href={`/requests/${encodeURIComponent(target.id)}`} lang={lang} />
          </div>
        </div>
      );
  }
}
