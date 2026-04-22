import { useCallback, useEffect, useRef, useState } from 'react';
import { platform } from '@/platform';
import type { CompanionDevice, CompanionDeviceEvent, CompanionInfo } from '@/platform';

/**
 * Owns companion-server lifecycle + device registry. Multiple components
 * can call `useCompanion()` safely — everything routes through the single
 * main-process server, the hook just mirrors its state.
 */
export function useCompanion() {
  const [info, setInfo] = useState<CompanionInfo | null>(null);
  const [devices, setDevices] = useState<CompanionDevice[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const unsubRef = useRef<(() => void) | null>(null);

  const applyEvent = useCallback((evt: CompanionDeviceEvent) => {
    setDevices((prev) => {
      switch (evt.type) {
        case 'joined':
          // de-dup by id
          return [...prev.filter((d) => d.id !== evt.device.id), evt.device];
        case 'left':
          return prev.filter((d) => d.id !== evt.id);
        case 'phase':
          return prev.map((d) => (d.id === evt.id ? { ...d, phase: evt.phase } : d));
        case 'offset':
          return prev.map((d) =>
            d.id === evt.id ? { ...d, clockOffsetMs: evt.clockOffsetMs } : d,
          );
        case 'upload-progress':
          return prev.map((d) =>
            d.id === evt.id
              ? {
                  ...d,
                  uploadedBytes: evt.uploadedBytes,
                  uploadTotalBytes: evt.uploadTotalBytes,
                }
              : d,
          );
        case 'upload-done':
          return prev.map((d) =>
            d.id === evt.id
              ? {
                  ...d,
                  uploadedFile: evt.file,
                  durationMs: evt.durationMs,
                  mimeType: evt.mimeType,
                  phase: 'done',
                }
              : d,
          );
        default:
          // rtc-signal and any future pass-through events — the device
          // list doesn't change. The RTC hook subscribes separately.
          return prev;
      }
    });
  }, []);

  const start = useCallback(async () => {
    setError(null);
    setStarting(true);
    try {
      const got = await platform.companionStart();
      if (got) {
        setInfo(got);
        setDevices(got.devices ?? []);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setStarting(false);
    }
  }, []);

  // Subscribe to device events whenever the server is up.
  useEffect(() => {
    if (!info) return;
    unsubRef.current?.();
    unsubRef.current = platform.companionSubscribe(applyEvent);
    return () => {
      unsubRef.current?.();
      unsubRef.current = null;
    };
  }, [info, applyEvent]);

  return {
    info,
    devices,
    error,
    starting,
    start,
    available: platform.kind === 'electron',
  };
}
