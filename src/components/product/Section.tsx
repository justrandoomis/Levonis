import React, { useState } from 'react';
import { ChevronDown } from 'lucide-react';

/**
 * THE PRODUCT PAGE'S ACCORDION SECTION — «الوصف», «محتويات العلبة»,
 * «المواصفات» … one disclosure each, closed unless it is the description.
 *
 * Its own module so the lazy knowledge tabs (the Bambu import spec §G.2: «the
 * existing Section accordion on phones») draw the very same control as the
 * page, not a lookalike. Moved out of src/pages/Product.tsx unchanged.
 */
export default function Section({
  title,
  icon,
  children,
  defaultOpen = false,
  id,
}: {
  title: string;
  icon: React.ReactNode;
  children: React.ReactNode;
  defaultOpen?: boolean;
  /** A stable hook for tests and the knowledge tabs (`data-section`). */
  id?: string;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="lv-surface overflow-hidden" data-section={id}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="w-full p-4 min-h-[44px] flex justify-between items-center text-text-primary font-bold gap-3 hover:bg-white/5 transition-colors"
      >
        <span className="flex items-center gap-2 text-start">
          {icon}
          <span>{title}</span>
        </span>
        <ChevronDown aria-hidden="true" className={`w-5 h-5 text-text-secondary shrink-0 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open ? <div className="px-4 pb-4">{children}</div> : null}
    </div>
  );
}
