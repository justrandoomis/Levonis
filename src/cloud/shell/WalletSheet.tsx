/**
 * THE LEVONIS WALLET, SEEN FROM PRINT CLOUD (the wallet contract: GET /me/wallet).
 *
 * A summary only — the balance the Levonis wallet page itself shows, whether
 * Print Cloud orders may be paid from it right now, and the official rate
 * when the platform has one. Deposits are the wallet's own business and
 * happen on Levonis (`${mainSite}/wallet`), where its receipts, reviews and
 * limits live; nothing here moves money. Read when the sheet opens, never
 * from memory.
 */
import { Sheet } from '../../components/ui/Overlay';
import { IconButton } from '../../components/ui/Button';
import { StatusChip } from '../../components/ui/Badge';
import { Money } from '../../components/ui/Money';
import { Skeleton } from '../../components/ui/Skeleton';
import { getWallet } from '../api';
import { useCloud } from '../CloudContext';
import { common, header } from '../strings/common';
import { useCloudText } from '../text';
import { CloudErrorState } from '../ui/ErrorState';
import { ExternalLink, Wallet, X } from '../ui/icons';
import { useCloudQuery } from '../useCloudQuery';

function WalletBody({ close }: { close: () => void }) {
  const { t, dir } = useCloudText();
  const { mainSite } = useCloud();
  const wallet = useCloudQuery((signal) => getWallet({ signal }), []);

  return (
    <div dir={dir} className="flex flex-col">
      <div className="flex items-center justify-between gap-2 border-b border-border-subtle px-4 py-2">
        <h2 className="flex items-center gap-2 text-[15px] font-bold text-text-primary">
          <Wallet aria-hidden="true" className="h-4 w-4 text-text-secondary" />
          {t(header.walletTitle)}
        </h2>
        <IconButton label={t(common.close)} icon={<X aria-hidden="true" className="h-4 w-4" />} onClick={close} />
      </div>
      <div className="space-y-4 px-4 py-4">
        {wallet.error ? (
          <CloudErrorState compact error={wallet.error} onRetry={wallet.reload} />
        ) : !wallet.data ? (
          <div aria-busy="true" className="space-y-2">
            <Skeleton className="h-4 w-28 rounded" />
            <Skeleton className="h-8 w-40 rounded-md" />
          </div>
        ) : (
          <>
            <div>
              <p className="text-[13px] font-medium text-text-secondary">{t(header.walletAvailable)}</p>
              <p className="mt-1 text-ui-xl font-bold text-text-primary">
                <Money iqd={wallet.data.available_iqd} />
              </p>
            </div>
            {wallet.data.connected ? (
              <p className="text-sm leading-relaxed text-text-muted">{t(header.walletUse)}</p>
            ) : (
              <StatusChip tone="warning">{t(header.walletOff)}</StatusChip>
            )}
            {wallet.data.exchange_rate != null && wallet.data.exchange_rate > 0 ? (
              <div className="flex items-center justify-between gap-3 rounded-xl lv-well px-3 py-2 text-[13px]">
                <span className="text-text-secondary">{t(header.walletRate)}</span>
                <span className="font-semibold text-text-primary">
                  <Money iqd={wallet.data.exchange_rate} />
                </span>
              </div>
            ) : null}
          </>
        )}
        {mainSite ? (
          <a href={`${mainSite}/wallet`} className="lv-button lv-button-secondary w-full">
            {t(header.walletAddFunds)}
            <ExternalLink aria-hidden="true" className="h-4 w-4" />
          </a>
        ) : null}
      </div>
    </div>
  );
}

export function WalletSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useCloudText();
  return (
    <Sheet open={open} onClose={onClose} docked label={t(header.walletTitle)} z={220} testId="cloud-wallet-sheet" panelClassName="w-full max-w-md">
      {({ close }) => <WalletBody close={close} />}
    </Sheet>
  );
}
