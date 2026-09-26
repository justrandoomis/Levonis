import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { motion } from 'motion/react';
import { useLanguage } from '../LanguageContext';
import { useGoBack } from '../lib/useGoBack';
import { useMotion } from '../lib/motion';
import { useConfirm } from '../components/ui/ConfirmDialog';
import { emptyAnswers } from '../lib/finder/answers';
import type { FinderAnswers, FinderPriority } from '../../packages/catalog/src/discovery';
import type { FinderMeta } from '../../packages/catalog/src/discoveryTypes';
import FinderChrome, { ChromeTextButton } from '../components/finder/FinderChrome';
import AnsweredChips from '../components/finder/AnsweredChips';
import FinderStep from '../components/finder/FinderStep';
import FinderFooter from '../components/finder/FinderFooter';
import FinderResults from '../components/finder/FinderResults';
import { fetchFinderMeta } from '../components/finder/data';
import {
  AUTO_ADVANCE,
  AUTO_ADVANCE_MS,
  LEAVE_CONFIRM_AFTER,
  SKIPPABLE,
  STEPS,
  STEP_COUNT,
  answer,
  answeredBefore,
  answeredCount,
  backView,
  canContinue,
  finderSearch,
  nextView,
  readFinderUrl,
  skip,
  togglePriority,
  type FinderView,
  type StepKey,
} from '../components/finder/flow';
import { finderUi, question, resultsUi, type FinderLang } from '../components/finder/strings';

/**
 * «مرشد الطابعات» — /printer-finder (docs/ux/CATALOG_DISCOVERY.md §3.4, §8;
 * IMPLEMENTATION_PLAN.md S6b). Mockups 05, 06, 07.
 *
 * A FOCUSED, FULL-SCREEN FLOW: six questions, one per screen, then the best
 * three (or four) printers with the reason for each. The app's bottom nav and
 * header are not drawn (App.tsx routes it in the full-screen shell); the
 * finder's own chrome is ✕ (back to where it was opened), the step label, the
 * progress bar and «تخطَّ».
 *
 * THE URL IS THE STATE (src/components/finder/flow.ts). Every answer REPLACES
 * the query string, so a refresh keeps the answers and the question, a link
 * can be shared, and with all six answered the page opens on its results. The
 * in-page «رجوع» goes to the previous QUESTION.
 *
 * Single-choice questions advance 220 ms after a tap (enough to see the check);
 * a keyboard press does not advance — «التالي» is always there. Each new
 * question moves focus to its heading, which the step label announces. The
 * move is a short slide in the reading direction, a cross-fade when the viewer
 * asked for reduced motion.
 */
export default function PrinterFinder() {
  const { lang: appLang } = useLanguage();
  const lang = appLang as FinderLang;
  const ui = finderUi(lang);
  const location = useLocation();
  const navigate = useNavigate();
  const goBack = useGoBack('/');
  const m = useMotion();
  const [confirm, confirmDialog] = useConfirm();

  const { answers, view } = useMemo(() => readFinderUrl(location.search), [location.search]);

  const write = useCallback(
    (a: FinderAnswers, v: FinderView) => {
      const search = finderSearch(a, v);
      navigate({ pathname: location.pathname, search: search ? `?${search}` : '' }, { replace: true, state: location.state });
    },
    [navigate, location.pathname, location.state]
  );

  // ------------------------------------------------------------ live counts
  const [meta, setMeta] = useState<FinderMeta | null>(null);
  useEffect(() => {
    let alive = true;
    fetchFinderMeta()
      .then((res) => {
        if (alive) setMeta(res);
      })
      .catch(() => {
        /* the questions work without counts; none is invented */
      });
    return () => {
      alive = false;
    };
  }, []);

  // ------------------------------------------------------- auto-advance
  const timer = useRef<number | null>(null);
  const cancelAdvance = () => {
    if (timer.current !== null) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }
  };
  useEffect(() => cancelAdvance, []);

  /** Which way the last move went, for the slide: +1 forward, −1 back. */
  const [travel, setTravel] = useState<1 | -1>(1);
  const go = useCallback(
    (a: FinderAnswers, v: FinderView, direction: 1 | -1 = 1) => {
      cancelAdvance();
      setTravel(direction);
      write(a, v);
    },
    [write]
  );

  const stepIndex = view.kind === 'step' ? view.index : -1;
  const stepKey: StepKey | null = stepIndex >= 0 ? STEPS[stepIndex] : null;

  const onSingle = useCallback(
    (key: StepKey, value: string, viaPointer: boolean) => {
      const next = answer(answers, key, value as never);
      cancelAdvance();
      // The choice is in the URL at once (a refresh keeps it), the move follows.
      write(next, { kind: 'step', index: STEPS.indexOf(key) });
      if (viaPointer && AUTO_ADVANCE[key]) {
        timer.current = window.setTimeout(() => {
          timer.current = null;
          setTravel(1);
          write(next, nextView(next, STEPS.indexOf(key)));
        }, AUTO_ADVANCE_MS);
      }
    },
    [answers, write]
  );

  const [refused, setRefused] = useState(false);
  const onPriority = useCallback(
    (p: FinderPriority) => {
      const r = togglePriority(answers.prio, p);
      setRefused(r.refused);
      if (r.refused) return;
      // An emptied list is "not answered yet", not a skip: the skip says so itself.
      write({ ...answers, prio: r.prio.length ? r.prio : null }, { kind: 'step', index: STEPS.indexOf('prio') });
    },
    [answers, write]
  );
  useEffect(() => setRefused(false), [stepIndex]);

  const onNext = () => {
    if (!stepKey) return;
    go(answers, nextView(answers, stepIndex), 1);
  };
  const back = stepIndex >= 0 ? backView(stepIndex) : null;
  const onBack = back ? () => go(answers, back, -1) : null;
  const onSkip = () => {
    if (!stepKey) return;
    const next = skip(answers, stepKey);
    go(next, nextView(next, stepIndex), 1);
  };
  const onEdit = (key: StepKey) => go(answers, { kind: 'step', index: STEPS.indexOf(key) }, -1);
  const onRestart = () => go(emptyAnswers(), { kind: 'step', index: 0 }, -1);

  const onClose = async () => {
    cancelAdvance();
    if (view.kind === 'step' && answeredCount(answers) >= LEAVE_CONFIRM_AFTER) {
      const yes = await confirm({ title: ui.leaveTitle, consequence: ui.leaveBody, confirmLabel: ui.leaveConfirm, cancelLabel: ui.stay });
      if (!yes) return;
    }
    goBack();
  };

  // ------------------------------------------------------------- focus
  const heading = useRef<HTMLHeadingElement>(null);
  const viewKey = view.kind === 'results' ? 'results' : `step-${view.index}`;
  const firstView = useRef(true);
  const scroller = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (firstView.current) {
      firstView.current = false;
      return;
    }
    scroller.current?.scrollTo({ top: 0 });
    heading.current?.focus({ preventScroll: true });
  }, [viewKey]);

  useEffect(() => {
    const t = view.kind === 'results' ? resultsUi(lang).label : question(STEPS[view.index], lang).title;
    document.title = `${t} — ${ui.pageTitle}`;
  }, [view, lang, ui.pageTitle]);

  const chromeTitle = view.kind === 'results' ? resultsUi(lang).label : ui.stepOf(view.index + 1, STEP_COUNT);
  const chromeEnd =
    view.kind === 'results' ? (
      <ChromeTextButton onClick={onRestart} label={resultsUi(lang).restart} restart />
    ) : stepKey && SKIPPABLE[stepKey] ? (
      <ChromeTextButton onClick={onSkip} label={ui.skipShort} ariaLabel={ui.skip(question(stepKey, lang).title)} />
    ) : null;

  const offset = m.reduced ? 0 : m.inline(28) * travel;

  return (
    <div ref={scroller} data-finder-scroller className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto overscroll-contain bg-canvas text-text-primary">
      {confirmDialog}
      <FinderChrome
        closeLabel={ui.close}
        onClose={() => void onClose()}
        title={chromeTitle}
        end={chromeEnd}
        progress={view.kind === 'step' ? { current: view.index + 1, total: STEP_COUNT, label: ui.progressLabel } : null}
        wide={view.kind === 'results'}
      />

      <div className={`mx-auto w-full flex-1 px-4 pb-6 ${view.kind === 'results' ? 'max-w-[960px] pt-2' : 'max-w-[640px] pt-2'}`}>
        <motion.div
          key={viewKey}
          initial={{ opacity: 0, x: offset }}
          animate={{ opacity: 1, x: 0 }}
          transition={m.reduced ? { duration: 0.15 } : { duration: 0.18, ease: [0.2, 0, 0, 1] }}
        >
          {view.kind === 'step' && stepKey ? (
            <>
              {answeredBefore(answers, view.index).length > 0 ? (
                <div className="mb-5">
                  <AnsweredChips answers={answers} keys={answeredBefore(answers, view.index)} lang={lang} onEdit={onEdit} />
                </div>
              ) : null}
              <FinderStep
                ref={heading}
                stepKey={stepKey}
                answers={answers}
                meta={meta}
                lang={lang}
                onSingle={onSingle}
                onPriority={onPriority}
                priorityRefused={refused}
              />
            </>
          ) : (
            <FinderResults answers={answers} meta={meta} lang={lang} headingRef={heading} onEdit={onEdit} />
          )}
        </motion.div>
      </div>

      {view.kind === 'step' && stepKey ? (
        <FinderFooter
          backLabel={ui.back}
          onBack={onBack}
          nextLabel={nextView(answers, view.index).kind === 'results' && canContinue(answers, stepKey) ? ui.seeResults : ui.next}
          onNext={onNext}
          nextDisabled={!canContinue(answers, stepKey)}
        />
      ) : null}
    </div>
  );
}
