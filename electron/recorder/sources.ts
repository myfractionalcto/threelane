import { desktopCapturer, systemPreferences } from 'electron';

/**
 * Enumerate capturable screens and windows. We return thumbnails as data
 * URLs so the renderer can show a picker without additional IPC round trips.
 *
 * macOS Screen Recording permission notes:
 *
 * - `desktopCapturer.getSources` throws a bare "Failed to get sources" when
 *   Screen Recording hasn't been granted. We swallow it so the rest of the
 *   recorder (cam / mic / phone) keeps working.
 *
 * - The first `getSources` call against an unprivileged process triggers the
 *   system prompt AND causes macOS to register the app in the Screen
 *   Recording pane of Privacy & Security. We only do that once per launch —
 *   every call re-pops the prompt, and the renderer refreshes sources often.
 *
 * - After the user flips the toggle in Settings, the permission only takes
 *   effect for *future* process launches. `getMediaAccessStatus('screen')`
 *   keeps returning the cached pre-grant value until the app is fully quit
 *   and relaunched. There is no API to force a re-read mid-process.
 */
let tccProbeDone = false;

export async function listScreenSources() {
  if (process.platform === 'darwin') {
    const status = systemPreferences.getMediaAccessStatus('screen');
    if (status !== 'granted') {
      // One-shot TCC probe. Without this the app never appears in the
      // Screen Recording settings pane; with it called on every refresh,
      // macOS repeatedly shows the permission prompt. Compromise: do it
      // once per launch, then fall silent until the user relaunches.
      if (!tccProbeDone) {
        tccProbeDone = true;
        try {
          await desktopCapturer.getSources({
            types: ['screen'],
            thumbnailSize: { width: 1, height: 1 },
            fetchWindowIcons: false,
          });
        } catch {
          // expected — permission not granted yet
        }
      }
      return [];
    }
  }

  try {
    const sources = await desktopCapturer.getSources({
      types: ['screen', 'window'],
      thumbnailSize: { width: 320, height: 180 },
      fetchWindowIcons: false,
    });
    return sources.map((s) => ({
      id: s.id,
      name: s.name,
      thumbnailDataUrl: s.thumbnail.isEmpty()
        ? undefined
        : s.thumbnail.toDataURL(),
    }));
  } catch (e) {
    console.warn('[recorder] listScreenSources failed:', e);
    return [];
  }
}
