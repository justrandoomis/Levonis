import React from 'react';
import { ArrowLeft, ArrowRight } from 'lucide-react';
import { Button } from '../ui/Button';
import { useLanguage } from '../../LanguageContext';

/**
 * The sticky footer (§8): «رجوع» (quiet, 104 px) and «التالي» (the one primary
 * action on the screen). Single-choice steps advance on their own, and the
 * button stays for keyboard and screen-reader users. It sits over a fade so
 * the last option scrolls under it cleanly, and clears the home indicator.
 */
export default function FinderFooter({
  backLabel,
  onBack,
  nextLabel,
  onNext,
  nextDisabled,
}: {
  backLabel: string;
  onBack: (() => void) | null;
  nextLabel: string;
  onNext: () => void;
  nextDisabled: boolean;
}) {
  const { dir } = useLanguage();
  const Forward = dir === 'rtl' ? ArrowLeft : ArrowRight;
  return (
    <div className="pointer-events-none sticky bottom-0 z-10 mt-auto bg-gradient-to-t from-canvas from-70% to-transparent pt-6">
      <div className="pointer-events-auto mx-auto flex w-full max-w-[640px] gap-3 px-4 pb-[max(16px,env(safe-area-inset-bottom))]">
        <Button
          variant="secondary"
          onClick={onBack ?? undefined}
          disabled={!onBack}
          className="w-[104px] shrink-0 !rounded-2xl"
        >
          {backLabel}
        </Button>
        <Button
          variant="primary"
          onClick={onNext}
          disabled={nextDisabled}
          block
          iconEnd={<Forward aria-hidden="true" className="size-4" />}
          className="!rounded-2xl"
        >
          {nextLabel}
        </Button>
      </div>
    </div>
  );
}
