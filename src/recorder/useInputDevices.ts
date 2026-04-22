import { useCallback, useEffect, useState } from 'react';
import { platform } from '@/platform';
import type { ScreenSource } from '@/platform';

export interface DeviceInfo {
  deviceId: string;
  label: string;
}

export interface InputDevices {
  cams: DeviceInfo[];
  mics: DeviceInfo[];
  screens: ScreenSource[];
  permissionsGranted: boolean;
}

/**
 * Enumerates webcams, microphones, and screen sources. Browser labels
 * are empty strings until the user grants camera/mic permission — so we
 * expose a `requestPermissions` call and refresh the list afterwards.
 */
export function useInputDevices() {
  const [devices, setDevices] = useState<InputDevices>({
    cams: [],
    mics: [],
    screens: [],
    permissionsGranted: false,
  });
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [mediaDevices, screens] = await Promise.all([
        navigator.mediaDevices.enumerateDevices(),
        platform.listScreenSources(),
      ]);
      const cams: DeviceInfo[] = [];
      const mics: DeviceInfo[] = [];
      for (const d of mediaDevices) {
        if (d.kind === 'videoinput') {
          cams.push({ deviceId: d.deviceId, label: d.label || 'Camera' });
        } else if (d.kind === 'audioinput') {
          mics.push({ deviceId: d.deviceId, label: d.label || 'Microphone' });
        }
      }
      // If any label is empty, permissions probably haven't been granted yet.
      const permissionsGranted =
        cams.every((c) => c.label !== 'Camera') &&
        mics.every((m) => m.label !== 'Microphone');
      setDevices({ cams, mics, screens, permissionsGranted });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  const requestPermissions = useCallback(async () => {
    try {
      // Prompt for both at once so the user sees one dialog, not two.
      const s = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: true,
      });
      // We only needed the permission — drop the tracks immediately.
      for (const t of s.getTracks()) t.stop();
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [refresh]);

  useEffect(() => {
    refresh();
    const h = () => refresh();
    navigator.mediaDevices.addEventListener?.('devicechange', h);
    return () => navigator.mediaDevices.removeEventListener?.('devicechange', h);
  }, [refresh]);

  return { devices, error, refresh, requestPermissions };
}
