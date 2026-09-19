import React from 'react';
import { Info } from 'lucide-react';
import { useLanguage } from '../../LanguageContext';
import { tri, type CompareLang, type CompareResult } from '../../lib/compare';
import { compareStrings } from './strings';

/**
 * ONE LINE NAMING THE BASIS — «مقارنة بين طابعتي FDM», or that this is a mixed
 * comparison.
 *
 * IT IS HERE SO NOBODY EVER WONDERS WHY A ROW IS EMPTY. Further down the page
 * there will be groups that apply to one machine and not another, and cells
 * reading «غير مذكور». Without this line those look like a broken page or a bad
 * machine; with it they are the obvious consequence of a sentence the reader
 * has already read. That is the whole job: it costs one line and it removes the
 * single most common misreading of a spec table.
 *
 * THE SERVER DECIDED THE BASIS, not this component. `basis` is one of three
 * values and `basis_label` is the trilingual name of what the products have in
 * common — «طابعة ثلاثية الأبعاد FDM» for two FDM machines, the bare type name
 * when the technologies differ. Composing that label here from the product
 * cards would be a second opinion about what these things are, and it would
 * disagree with the groups below the first time a product's section moves.
 */
export default function BasisNote({ result }: { result: CompareResult }) {
  const { lang } = useLanguage();
  const s = compareStrings(lang);
  const what = tri(result.basis_label, lang as CompareLang);

  const line =
    result.basis === 'same_section'
      ? s.basisSameSection(what)
      : result.basis === 'same_type'
        ? s.basisSameType(what)
        : s.basisMixed;

  return (
    <p className="flex items-start gap-2 text-[12px] leading-5 text-[var(--color-text-secondary)]">
      <Info aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--color-text-muted)]" />
      <span>
        {line}{' '}
        <span className="text-[var(--color-text-muted)]">{s.basisWhyEmpty}</span>
      </span>
    </p>
  );
}
