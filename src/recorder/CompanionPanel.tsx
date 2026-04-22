import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import {
  Smartphone,
  Loader2,
  Check,
  CircleDashed,
  ShieldCheck,
  Eye,
  EyeOff,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import type { CompanionDevice, CompanionInfo } from '@/platform';

/**
 * Studio-side panel for connecting phones. Shows QR + URL + a live list
 * of devices with their phase (connected / ready / recording / uploading).
 *
 * The live camera preview used to render inline in the device row — now
 * it's hoisted into the main preview grid in RecorderView, so the list
 * here just offers a toggle that flips which device (if any) the parent
 * is mirroring.
 */
interface Props {
  available: boolean; // platform.kind === 'electron'
  info: CompanionInfo | null;
  devices: CompanionDevice[];
  starting: boolean;
  error: string | null;
  onStart: () => void;
  /** The device id currently shown in the main preview grid, or null. */
  previewDeviceId: string | null;
  /** Click handler for each row's Preview button — toggles the target. */
  onTogglePreview: (deviceId: string) => void;
}

export function CompanionPanel({
  available,
  info,
  devices,
  starting,
  error,
  onStart,
  previewDeviceId,
  onTogglePreview,
}: Props) {
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!info) {
      setQrDataUrl(null);
      return;
    }
    QRCode.toDataURL(info.url, { margin: 1, width: 240, color: { dark: '#09090b', light: '#fafafa' } })
      .then(setQrDataUrl)
      .catch(() => setQrDataUrl(null));
  }, [info?.url]);

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
        <Smartphone className="size-4" />
        Phone
      </div>

      {!available && (
        <p className="text-xs text-muted-foreground">
          Desktop app only — phones join over WiFi, which the browser can't
          host.
        </p>
      )}

      {available && !info && (
        <button
          type="button"
          onClick={onStart}
          disabled={starting}
          className="w-full px-3 py-2 text-sm rounded-md border border-border hover:border-foreground/40 disabled:opacity-60"
        >
          {starting ? (
            <span className="inline-flex items-center gap-2 justify-center">
              <Loader2 className="size-3.5 animate-spin" /> Starting…
            </span>
          ) : (
            'Add phone'
          )}
        </button>
      )}

      {error && (
        <div className="text-xs text-destructive-foreground bg-destructive/20 border border-destructive/30 rounded-md p-2">
          {error}
        </div>
      )}

      {available && info && (
        <div className="rounded-md border border-border bg-card/50 p-3 space-y-3">
          <div className="flex gap-3 items-start">
            {qrDataUrl ? (
              <img
                src={qrDataUrl}
                alt="QR code"
                className="size-24 rounded-md bg-background p-1"
              />
            ) : (
              <div className="size-24 rounded-md bg-background flex items-center justify-center">
                <Loader2 className="size-4 animate-spin text-muted-foreground" />
              </div>
            )}
            <div className="min-w-0 flex-1">
              <div className="text-xs text-muted-foreground mb-1">
                Scan on a phone on the same WiFi
              </div>
              <code className="block text-[11px] font-mono break-all leading-tight text-foreground">
                {info.url}
              </code>
              <CertInstallHint
                certBaseUrl={info.certInstallUrl}
                publicCertActive={info.publicCertActive}
                fallbackUrl={info.urlFallback}
              />
            </div>
          </div>
          <DeviceList
            devices={devices}
            previewDeviceId={previewDeviceId}
            onTogglePreview={onTogglePreview}
          />
        </div>
      )}
    </div>
  );
}

function DeviceList({
  devices,
  previewDeviceId,
  onTogglePreview,
}: {
  devices: CompanionDevice[];
  previewDeviceId: string | null;
  onTogglePreview: (id: string) => void;
}) {
  if (devices.length === 0) {
    return (
      <div className="text-xs text-muted-foreground flex items-center gap-2">
        <CircleDashed className="size-3.5" />
        Waiting for a phone to connect…
      </div>
    );
  }
  return (
    <div className="space-y-1.5">
      {devices.map((d) => (
        <DeviceRow
          key={d.id}
          device={d}
          previewActive={previewDeviceId === d.id}
          onTogglePreview={onTogglePreview}
        />
      ))}
    </div>
  );
}

function DeviceRow({
  device,
  previewActive,
  onTogglePreview,
}: {
  device: CompanionDevice;
  previewActive: boolean;
  onTogglePreview: (id: string) => void;
}) {
  const phase = device.phase;
  const progress =
    device.uploadedBytes && device.uploadTotalBytes
      ? Math.min(100, (device.uploadedBytes / device.uploadTotalBytes) * 100)
      : null;

  // Only offer preview once the phone has granted camera permission —
  // before that, there's no track to send and the offer fails.
  const previewAvailable =
    phase === 'ready' || phase === 'recording' || phase === 'uploading';

  return (
    <div className="flex items-center gap-2 text-xs py-1">
      <span
        className={cn(
          'size-2 rounded-full shrink-0',
          phase === 'recording' && 'bg-red-500',
          phase === 'ready' && 'bg-green-500',
          phase === 'connected' && 'bg-yellow-500',
          phase === 'uploading' && 'bg-blue-500',
          phase === 'done' && 'bg-green-500',
        )}
      />
      <span className="font-medium truncate">{device.label}</span>
      <span className="text-muted-foreground font-mono">
        {phaseLabel(phase)}
      </span>

      {phase === 'uploading' && progress !== null && (
        <>
          <span className="text-muted-foreground ml-auto font-mono">
            {progress.toFixed(0)}%
          </span>
          <div className="w-16 h-1 rounded-full bg-secondary overflow-hidden">
            <div
              className="h-full bg-gradient-to-r from-orange-500 to-pink-600"
              style={{ width: `${progress}%` }}
            />
          </div>
        </>
      )}
      {phase === 'done' && <Check className="size-3.5 text-green-500 ml-auto" />}

      {previewAvailable && (
        <button
          type="button"
          onClick={() => onTogglePreview(device.id)}
          title={previewActive ? 'Hide live preview' : 'Show live preview'}
          aria-pressed={previewActive}
          className={cn(
            'ml-auto inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px]',
            previewActive
              ? 'bg-primary/15 text-primary hover:bg-primary/25'
              : 'text-muted-foreground hover:text-foreground',
          )}
        >
          {previewActive ? (
            <>
              <EyeOff className="size-3" /> Hide
            </>
          ) : (
            <>
              <Eye className="size-3" /> Preview
            </>
          )}
        </button>
      )}
    </div>
  );
}

function CertInstallHint({
  certBaseUrl,
  publicCertActive,
  fallbackUrl,
}: {
  certBaseUrl: string;
  publicCertActive: boolean;
  fallbackUrl: string;
}) {
  const [expanded, setExpanded] = useState(false);

  // When the public cert is active (the common case), the hint is a
  // collapsed "Trouble connecting?" affordance — users shouldn't need to
  // think about certs at all. When it's not active (first-boot offline, or
  // the public-cert service is unreachable), we surface the CA flow more
  // prominently since it's the only working option.
  const label = publicCertActive
    ? expanded
      ? 'Hide troubleshooting'
      : 'Trouble connecting? Tap here'
    : expanded
      ? 'Hide'
      : 'First time? Install certificate on phone';

  return (
    <div className="mt-2 space-y-1">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="inline-flex items-center gap-1 text-[11px] text-orange-400 hover:text-orange-300"
      >
        <ShieldCheck className="size-3" />
        {label}
      </button>

      {expanded && (
        <div className="text-[11px] text-muted-foreground space-y-2 bg-muted/30 rounded-md p-2">
          {publicCertActive ? (
            <p className="font-medium text-foreground/80">
              If the QR link doesn't load on the phone, your WiFi probably
              blocks public DNS for LAN IPs. Install the Threelane CA once
              and use the fallback URL below:
            </p>
          ) : (
            <p className="font-medium text-foreground/80">
              Install the Threelane CA so the phone trusts the connection
              (one-time):
            </p>
          )}

          <p>
            On the phone, open{' '}
            <code className="text-[10px] bg-muted px-1 rounded">{certBaseUrl}</code>{' '}
            — this is plain HTTP on purpose, so iOS Safari will actually let
            the profile download.
          </p>

          <div>
            <p className="font-medium text-foreground/70">iPhone / iPad:</p>
            <ol className="list-decimal list-inside space-y-0.5 pl-1">
              <li>
                Tap "iPhone / iPad — download profile" (or open{' '}
                <code className="text-[10px] bg-muted px-1 rounded">
                  {certBaseUrl}/ca.mobileconfig
                </code>
                ) in Safari
              </li>
              <li>Tap "Allow" when prompted to download the profile</li>
              <li>Open Settings → "Profile Downloaded" → Install</li>
              <li>Settings → General → VPN & Device Management → install the profile</li>
              <li>Settings → General → About → Certificate Trust Settings → enable "Threelane Local CA"</li>
            </ol>
          </div>

          <div>
            <p className="font-medium text-foreground/70">Android:</p>
            <ol className="list-decimal list-inside space-y-0.5 pl-1">
              <li>
                Tap "Android — download .crt" (or open{' '}
                <code className="text-[10px] bg-muted px-1 rounded">
                  {certBaseUrl}/ca.crt
                </code>
                ) in Chrome
              </li>
              <li>Tap the downloaded file → name it "Threelane" → install</li>
            </ol>
          </div>

          {publicCertActive && (
            <p>
              After install, point the phone at the fallback URL instead of
              the QR:{' '}
              <code className="text-[10px] bg-muted px-1 rounded break-all">
                {fallbackUrl}
              </code>
            </p>
          )}

          <p className="text-muted-foreground/70">
            {publicCertActive
              ? 'The QR path still works on any network with normal DNS — no install needed there.'
              : 'After installing, reload the companion page — it should load with no warnings and the PWA can be installed.'}
          </p>
        </div>
      )}
    </div>
  );
}

function phaseLabel(phase: CompanionDevice['phase']): string {
  switch (phase) {
    case 'connected':
      return 'Connecting';
    case 'ready':
      return 'Ready';
    case 'recording':
      return 'Recording';
    case 'uploading':
      return 'Uploading';
    case 'done':
      return 'Uploaded';
  }
}
