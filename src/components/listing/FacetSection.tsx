import React, { useId } from 'react';

/**
 * One section of the filter sheet (and of the desktop filter column): a
 * heading, an optional quiet note at the far end («من ورقة المواصفات»), and
 * the control. Sections are separated by a hairline, never boxed — proximity
 * already groups them (§7 «Filter sheet»).
 */
export default function FacetSection({
  title,
  note,
  children,
  id,
}: {
  title: string;
  note?: string;
  children: (labelId: string) => React.ReactNode;
  id: string;
}) {
  const labelId = useId();
  return (
    <section data-facet={id} aria-labelledby={labelId} className="border-b border-border-subtle py-4 last:border-b-0">
      <div className="mb-2.5 flex items-baseline justify-between gap-3">
        <h3 id={labelId} className="text-[14px] font-extrabold leading-5 text-text-primary">
          {title}
        </h3>
        {note ? <span className="text-[11.5px] font-semibold text-text-muted">{note}</span> : null}
      </div>
      {children(labelId)}
    </section>
  );
}
