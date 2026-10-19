/**
 * THE WORKSPACE'S SEARCH — ⌘K (or the search field) opens it: the screens,
 * the quick creates, and the store's own orders, products and customers from
 * `/api/merchant/search`, one request per pause in typing.
 *
 * Its own lazy chunk with the palette primitive (tests/bundleBudget.test.ts):
 * the frame keeps only the key that opens it (`isPaletteKey`), so the frame's
 * closure carries none of the search until the first ⌘K.
 */
import { useEffect, useRef, useState } from 'react';
import { ExternalLink, Plus } from 'lucide-react';
import { useLanguage } from '../../../LanguageContext';
import { api } from '../../../lib/api';
import { formatMoney } from '../../../lib/money';
import { merchantHref } from '../../../lib/merchantRoutes';
import { CommandPalette } from '../../ui/CommandPalette';
import { SEARCH_DEBOUNCE_MS, paletteGroups, searchable, type QuickAction, type SearchResults } from './paletteModel';
import { W, say } from './strings';

export default function WorkspacePalette({
  open,
  onOpenChange,
  base,
  storeUrl,
  canSell,
  canDraft = canSell,
  href,
  recentKey,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  base: string;
  storeUrl: string;
  canSell: boolean;
  /** Product drafts stay open under review (Community V3 push 1.3): «new product» follows them. */
  canDraft?: boolean;
  href: (link: string) => string;
  recentKey: string;
}) {
  const { loc, lang } = useLanguage();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResults | null>(null);
  const [loading, setLoading] = useState(false);
  const seq = useRef(0);

  // One request per pause in typing; an answer to an older query is dropped.
  useEffect(() => {
    const q = query.trim();
    if (!open || !searchable(q)) {
      setLoading(false);
      return;
    }
    const mine = ++seq.current;
    setLoading(true);
    const t = window.setTimeout(() => {
      api
        .get<{ success: true } & SearchResults>(`/api/merchant/search?q=${encodeURIComponent(q)}`)
        .then((r) => {
          if (mine === seq.current) setResults(r);
        })
        .catch(() => {
          // The local destinations still answer; a failed search is not a dead palette.
          if (mine === seq.current) setResults(null);
        })
        .finally(() => {
          if (mine === seq.current) setLoading(false);
        });
    }, SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(t);
  }, [query, open]);

  const actions: QuickAction[] = [
    ...(canDraft ? [{ id: 'new-product', label: say(loc, W.newProduct), href: href(merchantHref.newProduct()), icon: <Plus className="h-4 w-4" /> }] : []),
    ...(canSell
      ? [
          { id: 'new-coupon', label: say(loc, W.newCoupon), href: href(merchantHref.newCoupon()), icon: <Plus className="h-4 w-4" /> },
          { id: 'new-collection', label: say(loc, W.newCollection), href: href(merchantHref.newCollection()), icon: <Plus className="h-4 w-4" /> },
        ]
      : []),
    {
      id: 'view-store',
      label: say(loc, W.viewStore),
      icon: <ExternalLink className="h-4 w-4" />,
      onSelect: () => window.open(storeUrl, '_blank', 'noopener,noreferrer'),
    },
  ];

  const groups = paletteGroups({
    loc,
    lang,
    base,
    query,
    results,
    actions,
    money: (iqd) => formatMoney(iqd, lang),
    href,
    icon: (Icon) => <Icon className="h-4 w-4" />,
  });

  return (
    <CommandPalette
      open={open}
      onOpenChange={(o) => {
        onOpenChange(o);
        if (!o) setQuery('');
      }}
      groups={groups}
      recentKey={recentKey}
      label={say(loc, W.search)}
      placeholder={say(loc, W.searchPlaceholder)}
      onQueryChange={setQuery}
      loading={loading}
    />
  );
}
