"use client";

/**
 * Printer-connection sheet (slice S6).
 *
 * Capability honesty (mandate §12 + gap table §9):
 * - On the web there is NO native printer bridge: every LAN control renders a
 *   truthful "disabled on the web" state. The bridge sources stay in the tree
 *   (native-printer-bridge.ts) but are unreachable here — all capabilities are
 *   false and nothing simulates a connection.
 * - The APK download links are GONE. In their place is an explicitly disabled
 *   "full LEVONIS app — coming soon" card with no link (mandate §12).
 * - The native LAN form/discovery/status/print flow is kept for the Capacitor
 *   build, gated behind the bridge's self-reported capabilities exactly as
 *   before.
 */

import { useState } from "react";
import type { LevoDiscoveredPrinter, LevoNativeEnvironment, LevoPrinterStatus } from "../../native-printer-bridge";
import type { StudioDictionary } from "../../i18n";
import { Icon } from "../header";

export type ConnectionMode = "lan" | "cloud" | "usb";
export type LanAction = "idle" | "discovering" | "connecting" | "transferring";

export interface ConnectSheetProps {
  t: StudioDictionary;
  profileModel: string;
  profileShortName: string;
  selectedPlate: number;
  objectCount: number;
  printReady: boolean;
  handyProjectReady: boolean;
  nativeEnvironment: LevoNativeEnvironment;
  lanAction: LanAction;
  lanIp: string;
  lanAccessCode: string;
  lanSerial: string;
  onLanIp: (value: string) => void;
  onLanAccessCode: (value: string) => void;
  onLanSerial: (value: string) => void;
  discoveredPrinters: LevoDiscoveredPrinter[];
  printerStatus: LevoPrinterStatus;
  lanMessage: string;
  lanTransferProgress: number;
  canLanConnect: boolean;
  canLanPrint: boolean;
  onDiscoverLan: () => void;
  onConnectLan: () => void;
  onDisconnectLan: () => void;
  onSendLanPrint: () => void;
  onPrepareForHandy: () => void;
  onDownloadGcode: () => void;
}

export default function ConnectSheet(props: ConnectSheetProps) {
  const { t, nativeEnvironment, printerStatus } = props;
  const [mode, setMode] = useState<ConnectionMode>("lan");

  return (
    <div className="sheet-body connect-body">
      <p className="connection-intro">{t.connectionIntro}</p>
      <div className="connection-method-tabs" role="tablist" aria-label={t.connectTitle}>
        {(["lan", "cloud", "usb"] as ConnectionMode[]).map((tab) => (
          <button
            key={tab}
            role="tab"
            aria-selected={mode === tab}
            className={mode === tab ? "active" : ""}
            onClick={() => setMode(tab)}
          >
            <Icon name={tab === "lan" ? "print" : tab === "cloud" ? "share" : "save"} />
            <span>{tab === "lan" ? t.lanMethod : tab === "cloud" ? t.cloudMethod : t.usbMethod}</span>
          </button>
        ))}
      </div>

      {mode === "lan" ? (
        <section className="connection-method-panel lan-method-panel">
          <header>
            <span className={props.canLanConnect ? "available" : "unavailable"}><i /></span>
            <div>
              <strong>{t.lanTitle}</strong>
              <small>{nativeEnvironment.native ? t.appDetected : t.websiteDetected} · {nativeEnvironment.platform.toUpperCase()}</small>
            </div>
          </header>
          <p>{t.lanHelp}</p>
          <div className={`native-bridge-state ${props.canLanConnect ? "ready" : "blocked"}`}>
            <Icon name={props.canLanConnect ? "check" : "info"} />
            <span>
              <b>{props.canLanConnect ? t.appBridgeReady : t.appBridgePreparing}</b>
              <small>{!nativeEnvironment.native ? t.lanUnavailableWeb : !props.canLanConnect ? t.lanBridgeIncomplete : t.lanRequirements}</small>
            </span>
          </div>

          {!nativeEnvironment.native && (
            <div className="full-app-soon-card" aria-disabled="true">
              <Icon name="info" />
              <span><b>{t.fullAppSoon}</b><small>{t.fullAppSoonHelp}</small></span>
            </div>
          )}

          {props.canLanConnect && <>
            <button
              className="discover-printers-button"
              onClick={props.onDiscoverLan}
              disabled={props.lanAction !== "idle" || !nativeEnvironment.capabilities.discovery}
            >
              <Icon name="fit" /><span>{props.lanAction === "discovering" ? t.discoveringPrinters : t.discoverPrinters}</span>
            </button>
            {props.discoveredPrinters.length > 0 && (
              <div className="discovered-printers">
                {props.discoveredPrinters.map((printer) => (
                  <button key={printer.id} onClick={() => { props.onLanIp(printer.ip); props.onLanSerial(printer.serial ?? ""); }}>
                    <span><b>{printer.name}</b><small>{printer.model ?? props.profileModel} · {printer.ip}</small></span>
                    <em>{t.selectDiscoveredPrinter}</em>
                  </button>
                ))}
              </div>
            )}

            {!printerStatus.connected ? (
              <form className="lan-connection-form" onSubmit={(event) => { event.preventDefault(); props.onConnectLan(); }}>
                <label><span>{t.printerIp}</span><input dir="ltr" inputMode="decimal" autoCapitalize="none" autoCorrect="off" value={props.lanIp} onChange={(event) => props.onLanIp(event.target.value)} placeholder="192.168.1.120" required /></label>
                <label><span>{t.printerAccessCode}</span><input dir="ltr" type="password" value={props.lanAccessCode} onChange={(event) => props.onLanAccessCode(event.target.value)} autoComplete="off" required /></label>
                <label><span>{t.printerSerial}</span><input dir="ltr" autoCapitalize="characters" autoCorrect="off" value={props.lanSerial} onChange={(event) => props.onLanSerial(event.target.value)} required /></label>
                <button className="connect-lan-button" type="submit" disabled={props.lanAction !== "idle"}>
                  <Icon name="print" /><span>{props.lanAction === "connecting" ? t.connectingLan : t.connectLan}</span>
                </button>
              </form>
            ) : (
              <div className="connected-printer-card">
                <span><Icon name="check" /></span>
                <div>
                  <b>{t.connectedPrinter}</b>
                  <strong>{printerStatus.printer?.name ?? printerStatus.printer?.ip ?? props.lanIp}</strong>
                  <small>
                    {printerStatus.state ?? "idle"}
                    {typeof printerStatus.progress === "number" ? ` · ${Math.round(printerStatus.progress * 100)}%` : ""}
                    {typeof printerStatus.nozzleTemperature === "number" ? ` · N ${Math.round(printerStatus.nozzleTemperature)}°` : ""}
                    {typeof printerStatus.bedTemperature === "number" ? ` · B ${Math.round(printerStatus.bedTemperature)}°` : ""}
                  </small>
                </div>
                <button onClick={props.onDisconnectLan} disabled={props.lanAction !== "idle"}>{t.disconnectLan}</button>
              </div>
            )}

            {printerStatus.connected && (
              <button className="lan-print-button" onClick={props.onSendLanPrint} disabled={!props.canLanPrint || props.lanAction !== "idle"}>
                <Icon name="print" />
                <span><b>{props.lanAction === "transferring" ? t.sendingLanPrint : t.sendLanPrint}</b><small>{props.profileShortName} · {t.plate} {props.selectedPlate + 1}</small></span>
              </button>
            )}
            {props.lanAction === "transferring" && <progress className="lan-transfer-progress" value={props.lanTransferProgress} max={1} />}
            {props.lanMessage && <p className="lan-message" role="status">{props.lanMessage}</p>}
          </>}
          <p className="lan-security"><Icon name="info" /><span>{t.lanSecurity}</span></p>
          <a className="method-doc-link" href="https://wiki.bambulab.com/en/software/third-party-integration" target="_blank" rel="noreferrer">
            <span>{t.integrationDocs}</span><Icon name="external" />
          </a>
        </section>
      ) : mode === "cloud" ? (
        <section className="connection-method-panel cloud-method-panel">
          <header><span className="available"><i /></span><div><strong>{t.cloudTitle}</strong><small>{t.phonePrint}</small></div></header>
          <p>{t.cloudHelp}</p>
          <ol className="phone-print-steps">
            <li><b>1</b><span>{t.phoneStepOne}</span></li>
            <li><b>2</b><span>{t.phoneStepTwo}</span></li>
            <li><b>3</b><span>{t.phoneStepThree}</span></li>
          </ol>
          <div className="phone-print-actions">
            <button onClick={props.onPrepareForHandy} disabled={!props.objectCount}>
              <Icon name="save" /><span><b>{t.prepareForHandy}</b><small>{t.prepareForHandyHelp}</small></span>
            </button>
            {props.handyProjectReady && (
              <a href="https://makerworld.com/en/upload" target="_blank" rel="noreferrer">
                <span>{t.openMakerWorld}</span><Icon name="external" />
              </a>
            )}
          </div>
          <p className="phone-print-confirmation"><Icon name="check" /><span>{t.phoneConfirmation}</span></p>
          <div className="connection-policy"><Icon name="info" /><div><strong>{t.connectStatus}</strong><p>{t.connectStatusHelp}</p><p>{t.connectNext}</p></div></div>
        </section>
      ) : (
        <section className="connection-method-panel usb-method-panel">
          <header><span className="available"><i /></span><div><strong>{t.usbTitle}</strong><small>FAT32 · exFAT</small></div></header>
          <p>{t.usbHelp}</p>
          <ol className="phone-print-steps">
            <li><b>1</b><span>{t.usbStepOne}</span></li>
            <li><b>2</b><span>{t.usbStepTwo}</span></li>
            <li><b>3</b><span>{t.usbStepThree}</span></li>
          </ol>
          <button className="usb-download-button" onClick={props.onDownloadGcode} disabled={!props.printReady}>
            <Icon name="save" />
            <span><b>{t.downloadForUsb}</b><small>{props.printReady ? `${props.profileShortName} · ${t.plate} ${props.selectedPlate + 1}` : t.printNotReady}</small></span>
          </button>
          <p className="usb-compatibility"><Icon name="info" /><span>{t.usbCompatibility}</span></p>
        </section>
      )}
    </div>
  );
}
