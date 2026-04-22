import { useEffect, useRef, useState } from 'react';
import { platform } from '@/platform';

/**
 * Studio-side live-preview hook. The phone is the WebRTC offerer (it owns
 * the camera); the studio runs the answerer and pipes the incoming track
 * into a video element.
 *
 * Usage:
 *   const { videoRef, state, active } = usePhonePreview(targetDeviceId);
 *
 * Lifecycle is driven by the `deviceId` prop:
 * - non-null → open a peer connection, send `preview-request` `enable: true`
 *   to the phone, receive its SDP offer and ICE via `rtc-signal` events.
 * - null or changed → tear down the old PC and signal the phone to stop.
 *
 * Why driven by prop (not an internal `active` flag): the preview tile now
 * lives in the main grid, not next to the device row, so the parent needs
 * to decide which device is being shown. Letting the parent set the target
 * id keeps the "only one preview at a time" invariant trivially enforceable.
 */
export function usePhonePreview(deviceId: string | null) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const [state, setState] = useState<RTCPeerConnectionState | 'idle'>('idle');

  // Listen for incoming signaling blobs targeted at this device, plus
  // `left` events so we can notice the phone disappeared. We cascade the
  // teardown by clearing the PC ref here — the parent should also drop
  // `deviceId` when the device leaves, but we don't want to leak if it
  // forgets.
  useEffect(() => {
    if (!deviceId) return;
    const unsub = platform.companionSubscribe((evt) => {
      if (evt.type === 'rtc-signal' && evt.id === deviceId) {
        void handleSignal(pcRef.current, deviceId, evt.payload);
      } else if (evt.type === 'left' && evt.id === deviceId) {
        const pc = pcRef.current;
        if (pc) {
          try {
            pc.close();
          } catch {
            /* ignore */
          }
          pcRef.current = null;
          if (videoRef.current) videoRef.current.srcObject = null;
          setState('idle');
        }
      }
    });
    return unsub;
  }, [deviceId]);

  // Open/close a peer connection as the target device changes. All side
  // effects are scoped to this effect so React's cleanup guarantees a
  // tear-down on deviceId change, unmount, and StrictMode double-invoke.
  useEffect(() => {
    if (!deviceId) {
      setState('idle');
      return;
    }

    const pc = new RTCPeerConnection({ iceServers: [] });
    pcRef.current = pc;
    setState(pc.connectionState);

    // The phone's offer has a sendonly video m-section, so we answer with
    // a matching recvonly transceiver. Declaring it up-front keeps the
    // answer SDP from shifting if `ontrack` fires before we get a chance
    // to set it implicitly.
    pc.addTransceiver('video', { direction: 'recvonly' });

    pc.ontrack = (ev) => {
      const [remoteStream] = ev.streams;
      if (!remoteStream) return;
      const v = videoRef.current;
      if (v) {
        v.srcObject = remoteStream;
        v.play().catch(() => {
          /* autoplay blocked — the video element's controls will prompt */
        });
      }
    };
    pc.onicecandidate = (e) => {
      if (e.candidate) {
        void platform.companionSendToDevice(deviceId, {
          type: 'rtc-signal',
          payload: { kind: 'candidate', candidate: e.candidate.toJSON() },
        });
      }
    };
    pc.onconnectionstatechange = () => {
      setState(pc.connectionState);
    };

    void platform.companionSendToDevice(deviceId, {
      type: 'preview-request',
      enable: true,
    });

    return () => {
      try {
        pc.close();
      } catch {
        /* ignore */
      }
      if (pcRef.current === pc) pcRef.current = null;
      if (videoRef.current) videoRef.current.srcObject = null;
      setState('idle');
      // Best-effort — phone may already be gone.
      void platform.companionSendToDevice(deviceId, {
        type: 'preview-request',
        enable: false,
      });
    };
  }, [deviceId]);

  return { videoRef, state, active: !!deviceId };
}

async function handleSignal(
  pc: RTCPeerConnection | null,
  deviceId: string,
  payload: unknown,
) {
  if (!pc || !payload || typeof payload !== 'object') return;
  const p = payload as {
    kind: string;
    sdp?: string;
    sdpType?: RTCSdpType;
    candidate?: RTCIceCandidateInit;
  };
  if (p.kind === 'offer' && p.sdp) {
    await pc.setRemoteDescription({ type: 'offer', sdp: p.sdp });
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    await platform.companionSendToDevice(deviceId, {
      type: 'rtc-signal',
      payload: { kind: 'answer', sdp: answer.sdp, sdpType: answer.type },
    });
  } else if (p.kind === 'candidate' && p.candidate) {
    try {
      await pc.addIceCandidate(p.candidate);
    } catch (e) {
      console.warn('addIceCandidate failed', e);
    }
  }
}
