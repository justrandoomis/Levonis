/**
 * /account — THE CUSTOMER'S OWN PAGE (prototype IMG_8441: the profile, the
 * two balances, the shortcuts, the grouped menu).
 *
 * Only what is theirs and real: the name, handle and picture of the Levonis
 * session (no badge — the platform has no Print Cloud membership to show, and
 * an invented «Premium» would be a lie); the hours and the filament as the
 * server counts them (GET /me/credits, GET /me/inventory); the Levonis
 * wallet's balance (GET /me/wallet), whose deposits live on Levonis itself.
 * The menu leads to the account's own screens and to the sections that own
 * the rest — prints (/jobs), orders (/orders), files (/library).
 */
import { useState } from 'react';
import VariantImg from '../../../components/ui/VariantImg';
import { Money } from '../../../components/ui/Money';
import { initialOf } from '../../../lib/initials';
import { getCredits, getWallet, listInventory } from '../../api';
import { useCloud } from '../../CloudContext';
import { formatHours, hoursParts, massParts, progressPercent } from '../../format';
import { account, hoursText } from '../../strings/account';
import { tx, useCloudText } from '../../text';
import type { CreditsSummary, InventoryBalance } from '../../types';
import {
  ArrowLeftRight,
  Box,
  Clock,
  CloudErrorState,
  CloudPageSkeleton,
  Disc3,
  Folder,
  HandCoins,
  Headphones,
  History,
  QuickAction,
  Settings,
  ShoppingBag,
  StatCard,
  Truck,
  Wallet,
} from '../../ui';
import { useCloudQuery } from '../../useCloudQuery';
import { filamentGrams, isLow } from './logic';
import { MenuGroup, MenuRow } from './shared';

function Avatar({ name, avatarKey }: { name: string; avatarKey: string | null | undefined }) {
  const [failed, setFailed] = useState<string | null>(null);
  const initial = initialOf(name);
  const showPhoto = !!avatarKey && failed !== avatarKey;
  return (
    <span aria-hidden="true" className="flex h-16 w-16 shrink-0 items-center justify-center overflow-hidden rounded-full bg-olive text-xl font-bold text-snow shadow-1">
      {showPhoto ? (
        <VariantImg sizes="64px" src={`/files/${avatarKey}`} alt="" referrerPolicy="no-referrer" onError={() => setFailed(avatarKey ?? '')} className="h-full w-full object-cover" />
      ) : (
        initial || null
      )}
    </span>
  );
}

function Profile() {
  const { t } = useCloudText();
  const { user, mainSite } = useCloud();
  const name = (user?.name ?? '').trim() || (user?.username ?? '').trim() || t(account.noName);
  return (
    <section aria-label={t(account.profile)} className="lv-surface flex flex-wrap items-center gap-4 p-4">
      <Avatar name={name} avatarKey={user?.avatar_key} />
      <div className="min-w-0 flex-1">
        <h1 dir="auto" className="truncate text-2xl font-bold leading-tight text-text-primary">
          {name}
        </h1>
        {user?.username ? (
          <p dir="ltr" className="truncate text-start text-[13px] text-text-muted">
            @{user.username}
          </p>
        ) : null}
      </div>
      {mainSite ? (
        <a href={`${mainSite}/edit-profile`} className="lv-button lv-button-secondary lv-button-sm">
          {t(account.editProfile)}
        </a>
      ) : null}
    </section>
  );
}

function HoursCard({ credits }: { credits: CreditsSummary }) {
  const { t, lang } = useCloudText();
  const tiers = credits.tiers;
  if (tiers.length === 0) {
    return (
      <StatCard to="/account/hours" icon={<Clock className="h-5 w-5" />} title={t(account.hoursCard)} value={null} sub={t(account.noHours)} tone="accent" />
    );
  }
  // Hours of different classes are never spent on each other; their sum is
  // said as what it is — held across N classes — and the hours page splits it.
  const available = tiers.reduce((s, x) => s + x.available_seconds, 0);
  const total = tiers.reduce((s, x) => s + x.available_seconds + x.reserved_seconds + x.consumed_seconds, 0);
  const parts = hoursParts(available, lang);
  const sub =
    tiers.length > 1
      ? t(account.acrossClasses, { n: tiers.length })
      : total > available
        ? t(account.ofTotal, { total: formatHours(total, lang) })
        : tx(tiers[0].name, lang) || tiers[0].code;
  return (
    <StatCard
      to="/account/hours"
      icon={<Clock className="h-5 w-5" />}
      title={t(account.hoursCard)}
      value={parts.value}
      unit={parts.unit}
      sub={sub}
      progress={progressPercent(available, total)}
      progressLabel={t(account.hoursLeft)}
      tone="accent"
    />
  );
}

function FilamentCard({ inventory }: { inventory: InventoryBalance[] }) {
  const { t, lang } = useCloudText();
  const rows = filamentGrams(inventory);
  if (rows.length === 0) {
    return (
      <StatCard to="/account/materials" icon={<Disc3 className="h-5 w-5" />} title={t(account.filamentCard)} value={null} sub={t(account.noFilament)} tone="success" />
    );
  }
  // Grams only: the one unit that may be added across variants.
  const available = rows.reduce((s, r) => s + r.available_qty, 0);
  const held = rows.reduce((s, r) => s + r.available_qty + r.reserved_qty + r.consumed_qty, 0);
  const low = rows.some(isLow);
  const parts = massParts(available, lang);
  const sub = low ? t(account.runningLow) : rows.length === 1 ? tx(rows[0].name, lang) : t(account.materialsCount, { n: rows.length });
  return (
    <StatCard
      to="/account/materials"
      icon={<Disc3 className="h-5 w-5" />}
      title={t(account.filamentCard)}
      value={parts.value}
      unit={parts.unit}
      sub={sub}
      progress={progressPercent(available, held)}
      progressLabel={t(account.filamentLeft)}
      tone={low ? 'warning' : 'success'}
    />
  );
}

function WalletFigure() {
  const { t } = useCloudText();
  const { dashboardVersion } = useCloud();
  const wallet = useCloudQuery((signal) => getWallet({ signal }), [dashboardVersion]);
  // A wallet that cannot be read is «—», never a zero: the page itself still works.
  if (!wallet.data) return <span className="text-text-muted">—</span>;
  return (
    <span className="flex flex-col items-end">
      <Money iqd={wallet.data.available_iqd} />
      {wallet.data.connected ? null : <span className="text-[11px] font-medium text-warning">{t(account.walletOff)}</span>}
    </span>
  );
}

export default function AccountHome() {
  const { t } = useCloudText();
  const { mainSite, dashboardVersion } = useCloud();
  const balances = useCloudQuery(
    (signal) => Promise.all([getCredits({ signal }), listInventory(undefined, { signal })]).then(([credits, inventory]) => ({ credits, inventory })),
    [dashboardVersion]
  );

  return (
    <div className="space-y-5">
      <Profile />

      {balances.error ? (
        <CloudErrorState compact error={balances.error} onRetry={balances.reload} />
      ) : !balances.data ? (
        <CloudPageSkeleton />
      ) : (
        <section aria-label={t(hoursText.title)} className="grid grid-cols-2 gap-3">
          <HoursCard credits={balances.data.credits} />
          <FilamentCard inventory={balances.data.inventory} />
        </section>
      )}

      <section aria-label={t(account.shortcuts)} className="grid grid-cols-4 gap-2">
        <QuickAction to="/jobs" icon={<Box className="h-5 w-5" />} label={t(account.myPrints)} />
        <QuickAction to="/orders" icon={<ShoppingBag className="h-5 w-5" />} label={t(account.orders)} />
        <QuickAction to="/account/shipments" icon={<Truck className="h-5 w-5" />} label={t(account.shipments)} />
        <QuickAction to="/account/transactions" icon={<History className="h-5 w-5" />} label={t(account.transactions)} />
      </section>

      <MenuGroup label={t(account.groupRecords)}>
        <MenuRow to="/orders" icon={<ShoppingBag className="h-5 w-5" />} title={t(account.orders)} sub={t(account.ordersSub)} />
        <MenuRow to="/jobs" icon={<Box className="h-5 w-5" />} title={t(account.myPrints)} sub={t(account.myPrintsSub)} />
        <MenuRow to="/account/hours" icon={<Clock className="h-5 w-5" />} title={t(account.hoursCard)} sub={t(account.hoursSub)} />
        <MenuRow to="/account/materials" icon={<Disc3 className="h-5 w-5" />} title={t(account.materials)} sub={t(account.materialsSub)} />
        <MenuRow to="/library" icon={<Folder className="h-5 w-5" />} title={t(account.files)} sub={t(account.filesSub)} />
      </MenuGroup>

      <MenuGroup label={t(account.groupMoves)}>
        <MenuRow to="/account/shipments" icon={<Truck className="h-5 w-5" />} title={t(account.shipments)} sub={t(account.shipmentsSub)} />
        <MenuRow to="/account/buyback" icon={<HandCoins className="h-5 w-5" />} title={t(account.buyback)} sub={t(account.buybackSub)} />
        <MenuRow to="/account/transactions" icon={<ArrowLeftRight className="h-5 w-5" />} title={t(account.transactions)} sub={t(account.transactionsSub)} />
        <MenuRow
          href={mainSite ? `${mainSite}/wallet` : undefined}
          icon={<Wallet className="h-5 w-5" />}
          title={t(account.wallet)}
          sub={t(account.walletSub)}
          trailing={<WalletFigure />}
        />
      </MenuGroup>

      <MenuGroup label={t(account.groupMore)}>
        <MenuRow to="/account/settings" icon={<Settings className="h-5 w-5" />} title={t(account.settings)} sub={t(account.settingsSub)} />
        {mainSite ? <MenuRow href={`${mainSite}/support`} icon={<Headphones className="h-5 w-5" />} title={t(account.help)} sub={t(account.helpSub)} /> : null}
      </MenuGroup>
    </div>
  );
}
