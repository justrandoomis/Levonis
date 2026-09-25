/**
 * The store's buyers — searchable on the server (name, or a phone on their
 * orders here), paged by cursor, opened by a link to their own page (W3-B).
 * Only people who bought here; no phone in the list (it is on their page,
 * as the store already sees it on their orders).
 * OWNER: Sorani to be written by hand (every new line of this screen).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Search } from 'lucide-react';
import { useLanguage } from '../../../LanguageContext';
import { governorateName } from '../../../../packages/shipping/src/iraqGovernorates';
import { DataList, type DataListColumn } from '../../ui/DataList';
import { Field, Input } from '../../ui/Field';
import { Button } from '../../ui/Button';
import { Money } from '../../ui/Money';
import { dateLocale } from '../../orders/format';
import { formatFigure } from '../../../lib/localeNumber';
import { merchantRefusal } from '../shell/refusal';
import { customersApi, searchTerm, type CustomerRow } from './api';

export default function CustomerList({ href }: { href: (link: string) => string }) {
  const { loc, lang } = useLanguage();
  const L = lang as 'ar' | 'en' | 'ckb';
  const [text, setText] = useState('');
  const [q, setQ] = useState('');
  const [rows, setRows] = useState<CustomerRow[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(false);
  const [more, setMore] = useState<'idle' | 'loading' | 'error'>('idle');
  const seq = useRef(0);

  // The search is the server's; typing waits a beat before asking.
  useEffect(() => {
    const term = searchTerm(text);
    if (term === null) return;
    const t = setTimeout(() => setQ(term), 300);
    return () => clearTimeout(t);
  }, [text]);

  const load = useCallback(() => {
    const mine = ++seq.current;
    setLoading(true);
    setError(null);
    customersApi
      .list({ q })
      .then((d) => {
        if (mine !== seq.current) return;
        setRows(d.customers);
        setCursor(d.next_cursor);
        setMore('idle');
      })
      .catch((e) => mine === seq.current && setError(e))
      .finally(() => mine === seq.current && setLoading(false));
  }, [q]);
  useEffect(load, [load]);

  const loadMore = async () => {
    if (!cursor) return;
    const mine = seq.current;
    setMore('loading');
    try {
      const d = await customersApi.list({ q, cursor });
      if (mine !== seq.current) return;
      setRows((prev) => {
        const seen = new Set((prev ?? []).map((r) => r.key));
        return [...(prev ?? []), ...d.customers.filter((r) => !seen.has(r.key))];
      });
      setCursor(d.next_cursor);
      setMore('idle');
    } catch {
      if (mine === seq.current) setMore('error');
    }
  };

  const date = (iso: string) => new Intl.DateTimeFormat(dateLocale(L), { day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(iso));
  const columns: DataListColumn<CustomerRow>[] = [
    { id: 'name', header: loc('الزبون', 'Customer'), cell: (r) => r.name || '—', card: 'title', width: '32%' },
    { id: 'gov', header: loc('المحافظة', 'Governorate'), cell: (r) => (r.governorate ? governorateName(r.governorate, L) : '—'), card: 'meta' },
    { id: 'orders', header: loc('الطلبات', 'Orders', 'داواکاری'), cell: (r) => formatFigure(r.order_count, L), numeric: true },
    { id: 'spent', header: loc('أنفق هنا', 'Spent here'), cell: (r) => <Money iqd={r.spent_iqd} />, numeric: true },
    { id: 'last', header: loc('آخر طلب', 'Last order'), cell: (r) => date(r.last_order_at) },
  ];
  const tooShort = text.trim() !== '' && searchTerm(text) === null;

  return (
    <div className="space-y-3" data-customers>
      <Field
        label={loc('ابحث بالاسم أو رقم الهاتف', 'Search by name or phone number')}
        hint={tooShort ? loc('اكتب حرفين على الأقل.', 'Type at least 2 characters.') : undefined}
        className="max-w-md"
      >
        <div className="relative">
          <Search aria-hidden="true" className="pointer-events-none absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-text-muted" />
          <Input type="search" value={text} onChange={(e) => setText(e.target.value)} className="ps-9" enterKeyHint="search" data-customer-search />
        </div>
      </Field>
      <DataList
        label={loc('زبائن متجرك', 'Your store’s customers')}
        columns={columns}
        rows={rows}
        rowKey={(r) => r.key}
        rowHref={(r) => href(r.link)}
        loading={loading}
        error={error}
        onRetry={load}
        wideAt={640}
        empty={
          q
            ? { title: loc('لا أحد بهذا الاسم أو الرقم', 'Nobody by that name or number'), description: loc('البحث في من اشترى من متجرك فقط.', 'Only people who bought from your store are searched.') }
            : { title: loc('لا يوجد عملاء بعد', 'No customers yet', 'هێشتا کڕیار نییە'), description: loc('يظهر هنا كل من اشترى من متجرك — الطلبات الملغاة لا تجعل أحدًا زبونًا.', 'Everyone who buys from your store appears here — a cancelled order does not make a customer.') }
        }
      />
      {rows && cursor && (
        <Button variant="ghost" block onClick={loadMore} loading={more === 'loading'} data-customers-more>
          {more === 'error'
            ? loc('تعذر تحميل المزيد — إعادة المحاولة', 'Failed to load more — retry', 'زیاتر بارنەبوو — دووبارە هەوڵ بدەوە')
            : loc('عرض المزيد', 'Load more', 'زیاتر پیشان بدە')}
        </Button>
      )}
      {error && rows ? <p role="alert" className="text-[12.5px] text-danger">{merchantRefusal(error, L, loc('تعذّر التحديث', 'Could not refresh'))}</p> : null}
    </div>
  );
}
