import LegacyInvestmentHistory from './LegacyInvestmentHistory';
import { useState } from 'react';
import { ChevronLeft, Plus, Pencil } from 'lucide-react';
import { NumberInput } from '../ui/NumberInput';
import { Select } from '../ui/Field';
import { api, Button, Dialog, Empty, Feedback, Field, Loading, Money, PEOPLE, Surface, useLanguage, useMutation, useRemote, type Account, type PanelProps } from './shared';
import { investmentReturnStrings } from '../../lib/investmentReturn';
import { personFinanceStrings } from '../../lib/personFinanceStrings';
import { useFreshOnReturn } from '../../lib/useFreshOnReturn';
import { PersonCard, PersonSheet, type PersonFinance } from './PersonFinanceView';

const API = '/api/admin/investment-finance';
type Profile = { user_id: string; name: string; email: string; state: string; version: number; default_profit_share_bps: number; default_capital_share_bps: number; default_loss_share_bps: number };
type Batch = { purchase_id: string; agreed_iqd: number; received_iqd: number; allocated_iqd: number; unallocated_iqd: number; returned_iqd?: number; funding_shortfall_iqd: number; profit_share_bps: number };
type Contract = { id: string; name: string; label: string; purchase_id: string; qty_ordered: number; qty_received: number; remaining_qty: number; delivered_qty: number; principal_iqd: number; profit_share_bps: number; state: string };
type List = { profiles: Profile[]; accounts: Account[] };

/**
 * «حسابات المستثمرين» — one card per investor from the one-person picture
 * (worker/lib/personFinance.ts; DECISIONS row 304): capital put in and where
 * it is, the share of each agreement, profit earned and why it is held, the
 * return so far, and — for an investor who also works — wages and the
 * combined total. Replaces the thirteen-card capital grid of 2026-10.
 */
export default function InvestorProfiles({ from, to, month, onChanged, openContract, openOrder }: PanelProps & { openContract: (id: string) => void }) {
  const { loc, lang, dir } = useLanguage();
  const s = personFinanceStrings(lang);
  const query = new URLSearchParams(from || to ? { from: from || '', to: to || '' } : month ? { month } : {});
  const remote = useRemote<List>(`${API}/profiles?${query}`);
  const people = useRemote<{ people: PersonFinance[] }>(`${PEOPLE}/people?${query}`);
  const [editing, setEditing] = useState<Profile | 'new' | null>(null), [selected, setSelected] = useState<string | null>(null);
  const data = remote.data;
  const investors = people.data?.people.filter((p) => p.investor) ?? [];
  const reload = async () => { await Promise.all([remote.load(), people.load()]); };
  useFreshOnReturn(reload, { pollWhileVisibleMs: 30_000, minIntervalMs: 5_000, enabled: !remote.loading && !people.loading && !editing && !selected });
  const saved = async () => { setEditing(null); await reload(); onChanged?.(); };
  const sum = (f: (p: NonNullable<PersonFinance['investor']>) => number) => investors.reduce((n, p) => n + f(p.investor!), 0);
  const person = (id: string) => people.data?.people.find((p) => p.user_id === id);
  const open = selected ? person(selected) : undefined;
  return <div className="ap fp fp-stack" dir={dir}>
    <Surface title={loc('حسابات المستثمرين', 'Investor accounts', 'هەژماری وەبەرهێنەران')} hint={s.peopleHint} action={<Button variant="primary" icon={<Plus size={16} />} onClick={() => setEditing('new')}>{loc('إضافة مستثمر', 'Add investor', 'زیادکردنی وەبەرهێنەر')}</Button>}>
      {!data || !people.data ? <Loading error={remote.error || people.error} retry={reload} /> : <><Feedback error={remote.error || people.error} />
        <div className="fp-stats">
          <div className="fp-stat"><span>{s.capitalPutIn}</span><Money value={sum((i) => i.capital.put_in_iqd)} /></div>
          <div className="fp-stat"><span>{s.profitEarned}</span><Money value={sum((i) => i.profit.earned_iqd)} /></div>
          <div className="fp-stat fp-stat-good"><span>{s.availableNow}</span><Money value={sum((i) => i.profit.available_iqd + i.capital.available_iqd)} /></div>
          <div className="fp-stat"><span>{s.heldNow}</span><Money value={sum((i) => i.profit.held_iqd + i.capital.sold_held_iqd)} /></div>
        </div>
        {!data.profiles.length ? <Empty>{loc('اختر حساب مساعد لإضافة مستثمر، ثم اختره في خطوة تمويل الشراء.', 'Choose an assistant account to register an investor, then select it when funding a purchase.', 'هەژمارێکی یاریدەدەر هەڵبژێرە بۆ تۆمارکردنی وەبەرهێنەر، پاشان لە هەنگاوی پارەدارکردنی کڕیندا هەڵیبژێرە.')}</Empty> : <div className="fp-stack">{data.profiles.map((p) => {
          const pf = person(p.user_id);
          const settings = <Button variant="ghost" size="sm" icon={<Pencil size={15} />} onClick={() => setEditing(p)}>{s.settings}</Button>;
          return pf ? <PersonCard key={p.user_id} person={pf} onOpen={() => setSelected(p.user_id)} actions={settings} />
            : <article className="fp-person" key={p.user_id}><header className="fp-rule-heading fp-staff-heading"><h3>{p.name || p.email}</h3>{settings}</header></article>;
        })}</div>}</>}
    </Surface>
    <LegacyInvestmentHistory admin />
    {editing && data && <ProfileEditor profile={editing === 'new' ? undefined : editing} accounts={data.accounts.filter((a) => editing !== 'new' || !data.profiles.some((p) => p.user_id === a.id))} onClose={() => setEditing(null)} onSaved={saved} />}
    {open && <PersonSheet person={open} onClose={() => setSelected(null)} openOrder={openOrder ? (id) => { setSelected(null); openOrder(id); } : undefined}><FundingRecord userId={open.user_id!} openContract={openContract} /></PersonSheet>}
  </div>;
}

function ProfileEditor({ profile, accounts, onClose, onSaved }: { profile?: Profile; accounts: Account[]; onClose: () => void; onSaved: () => Promise<void> }) {
  const { loc } = useLanguage(), op = useMutation();
  const [user, setUser] = useState(profile?.user_id || ''), [profit, setProfit] = useState<number | null>(profile ? profile.default_profit_share_bps / 100 : 35), [capital, setCapital] = useState<number | null>(profile ? profile.default_capital_share_bps / 100 : 100), [loss, setLoss] = useState<number | null>(profile ? profile.default_loss_share_bps / 100 : 0), [state, setState] = useState(profile?.state || 'active');
  return <Dialog open onClose={onClose} busy={op.busy} title={profile ? loc('إعدادات المستثمر', 'Investor settings') : loc('إضافة مستثمر', 'Add investor')}><div className="fp-stack">
    {profile ? <h3>{profile.name || profile.email}</h3> : <Field label={loc('حساب المساعد', 'Assistant account')}><Select value={user} onChange={(e) => setUser(e.target.value)}><option value="">{loc('اختر الحساب', 'Choose account')}</option>{accounts.map((a) => <option value={a.id} key={a.id}>{a.name || a.email}</option>)}</Select></Field>}
    <Field label={loc('نسبة الربح الافتراضية', 'Default profit share')}><NumberInput value={profit} min={0} max={100} unit="%" onValueChange={(n, valid) => setProfit(valid ? n : null)} /></Field>
    <details className="fp-detail"><summary>{loc('التمويل والخسارة والحالة', 'Funding, loss and status')}</summary><div className="fp-stack"><Field label={loc('نسبة التمويل المقترحة', 'Suggested capital funding share')}><NumberInput value={capital} min={0.01} max={100} unit="%" onValueChange={(n, valid) => setCapital(valid ? n : null)} /></Field><Field label={loc('نسبة تحمّل الخسارة', 'Loss share')}><NumberInput value={loss} min={0} max={100} unit="%" onValueChange={(n, valid) => setLoss(valid ? n : null)} /></Field><Field label={loc('الحالة', 'State')}><Select value={state} onChange={(e) => setState(e.target.value)}><option value="active">{loc('نشط', 'Active')}</option><option value="archived">{loc('مؤرشف', 'Archived')}</option></Select></Field></div></details>
    <p className="fp-note">{loc('تطبق الإعدادات الافتراضية على الاتفاقات الجديدة فقط. رأس المال ونسبة الربح والخسارة ثلاث قيم مستقلة. الحساب يرى أرباحه فقط دون صلاحيات مالية عامة.', 'Defaults apply only to new agreements. Capital, profit share and loss share are independent. This role grants access only to the account’s own earnings.')}</p><Feedback error={op.error} />
  </div><footer className="fp-footer"><Button variant="ghost" onClick={onClose} disabled={op.busy}>{loc('رجوع', 'Back')}</Button><Button variant="primary" loading={op.busy} disabled={!user || profit == null || loss == null || capital == null} onClick={() => op.run(async () => { await api.post(`${API}/profiles`, { user_id: user, version: profile?.version, default_profit_share_bps: Math.round(profit! * 100), default_capital_share_bps: Math.round(capital! * 100), default_loss_share_bps: Math.round(loss! * 100), state }); await onSaved(); })}>{loc('حفظ', 'Save')}</Button></footer></Dialog>;
}

/** The purchases this investor funded and their agreements, as recorded. */
function FundingRecord({ userId, openContract }: { userId: string; openContract: (id: string) => void }) {
  const { loc, lang } = useLanguage(), remote = useRemote<{ contracts: Contract[]; batches: Batch[] }>(`${API}/profiles/${userId}`);
  return <details className="fp-detail"><summary>{loc('سجل التمويل والدفعات', 'Funding record and batches', 'تۆماری پارەدارکردن و بارەکان')}</summary>
    {!remote.data ? <Loading error={remote.error} retry={remote.load} /> : <div className="fp-stack">{remote.data.batches.map((b) => <Surface key={b.purchase_id} title={`${loc('دفعة', 'Batch', 'بار')} ${b.purchase_id.slice(-8)}`} hint={`${loc('حصة الربح', 'Profit share', 'بەشی قازانج')} ${b.profit_share_bps / 100}%`}><div className="fp-rows"><div className="fp-row"><span>{loc('التمويل المتفق / المستلم', 'Agreed / received funding', 'پارەدارکردنی ڕێککەوتوو / وەرگیراو')}</span><span><Money value={b.agreed_iqd} /> / <Money value={b.received_iqd} /></span></div>{b.funding_shortfall_iqd > 0 && <p className="fp-note">{investmentReturnStrings(lang).shortfall}: <Money value={b.funding_shortfall_iqd} /></p>}{(b.returned_iqd ?? b.unallocated_iqd) > 0 && <p className="fp-note">{investmentReturnStrings(lang).returned}: <Money value={b.returned_iqd ?? b.unallocated_iqd} /></p>}{remote.data!.contracts.filter((c) => c.purchase_id === b.purchase_id).map((c) => <ContractRow key={c.id} contract={c} onClick={() => openContract(c.id)} />)}</div></Surface>)}
      {remote.data.contracts.filter((c) => !remote.data!.batches.some((b) => b.purchase_id === c.purchase_id)).map((c) => <ContractRow key={c.id} contract={c} onClick={() => openContract(c.id)} />)}{!remote.data.contracts.length && <Empty>{loc('لا دفعات بعد. اختر هذا المستثمر أثناء إنشاء الشراء.', 'No batches yet. Select this investor when creating a purchase.', 'هێشتا هیچ بارێک نییە. لە کاتی دروستکردنی کڕیندا ئەم وەبەرهێنەرە هەڵبژێرە.')}</Empty>}
      <p className="fp-note">{loc('رأس المال المسترد مستقل عن الربح. التحصيل وتثبيت التكلفة يحددان ما يصبح متاحًا للسحب.', 'Recovered capital is separate from profit. Collection and verified costs decide what becomes withdrawable.', 'سەرمایەی گەڕاوە جیاوازە لە قازانج. کۆکردنەوەی پارە و پشتڕاستکردنەوەی تێچوو دیاری دەکەن چی بەردەست دەبێت بۆ ڕاکێشان.')}</p></div>}
  </details>;
}
function ContractRow({ contract: c, onClick }: { contract: Contract; onClick: () => void }) {
  const { loc } = useLanguage();
  return <button type="button" className="fp-rule text-start" onClick={onClick}><div className="fp-rule-heading"><strong>{c.label || c.name}</strong><ChevronLeft size={17} /></div><p className="fp-muted">{loc('مستلم / مباع مسلّم / متبقٍ', 'Received / sold and delivered / remaining', 'وەرگیراو / فرۆشراو و گەیەندراو / ماوە')}: {c.qty_received} / {c.delivered_qty} / {c.remaining_qty}</p><div className="fp-row"><span>{loc('رأس المال', 'Principal', 'سەرمایە')}: <Money value={c.principal_iqd} /></span><span>{c.profit_share_bps / 100}% · {c.state === 'void' ? loc('مبطل', 'Voided', 'هەڵوەشاوە') : loc('نشط', 'Active', 'چالاک')}</span></div></button>;
}
