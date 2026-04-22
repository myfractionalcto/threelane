import type { WebSocket } from 'ws';
import { EventEmitter } from 'node:events';

/**
 * In-memory registry of connected mobile devices. One per WebSocket.
 *
 * The renderer subscribes via IPC (ipc.ts emits `companion:device-event`
 * whenever this emitter changes) so the studio UI can show who has
 * joined, who is ready to record, who has finished uploading.
 */

export type DevicePhase =
  | 'connected' // WS is open, but no permissions/readiness confirmed
  | 'ready' // phone has camera + mic permission, can record
  | 'recording' // MediaRecorder running
  | 'uploading' // upload in progress
  | 'done'; // uploaded + acknowledged

export interface Device {
  id: string;
  label: string;
  ua: string;
  phase: DevicePhase;
  /** ms offset to add to a laptop timestamp to get the phone's equivalent. */
  clockOffsetMs: number;
  /** Bytes uploaded so far / total, if known. */
  uploadedBytes?: number;
  uploadTotalBytes?: number;
  /** Filled in after the phone's track has been written to disk. */
  uploadedFile?: string;
  durationMs?: number;
  mimeType?: string;
}

export type DeviceEvent =
  | { type: 'joined'; device: Device }
  | { type: 'left'; id: string }
  | { type: 'phase'; id: string; phase: DevicePhase }
  | { type: 'offset'; id: string; clockOffsetMs: number }
  | { type: 'upload-progress'; id: string; uploadedBytes: number; uploadTotalBytes?: number }
  | {
      type: 'upload-done';
      id: string;
      file: string;
      durationMs: number;
      mimeType: string;
    }
  /**
   * Pass-through signaling from the phone for WebRTC live preview. The
   * main process doesn't interpret the payload — it just forwards it to
   * the renderer, which runs the RTCPeerConnection as the answerer.
   */
  | { type: 'rtc-signal'; id: string; payload: unknown };

class DeviceRegistry extends EventEmitter {
  private devices = new Map<string, Device & { ws: WebSocket }>();

  add(id: string, ws: WebSocket, label: string, ua: string) {
    const device: Device & { ws: WebSocket } = {
      id,
      label,
      ua,
      phase: 'connected',
      clockOffsetMs: 0,
      ws,
    };
    this.devices.set(id, device);
    this.emit('event', { type: 'joined', device: this.externalView(device) } satisfies DeviceEvent);
  }

  remove(id: string) {
    if (!this.devices.has(id)) return;
    this.devices.delete(id);
    this.emit('event', { type: 'left', id } satisfies DeviceEvent);
  }

  setPhase(id: string, phase: DevicePhase) {
    const d = this.devices.get(id);
    if (!d) return;
    d.phase = phase;
    this.emit('event', { type: 'phase', id, phase } satisfies DeviceEvent);
  }

  setOffset(id: string, clockOffsetMs: number) {
    const d = this.devices.get(id);
    if (!d) return;
    d.clockOffsetMs = clockOffsetMs;
    this.emit('event', { type: 'offset', id, clockOffsetMs } satisfies DeviceEvent);
  }

  setUploadProgress(id: string, uploadedBytes: number, uploadTotalBytes?: number) {
    const d = this.devices.get(id);
    if (!d) return;
    d.uploadedBytes = uploadedBytes;
    d.uploadTotalBytes = uploadTotalBytes;
    this.emit('event', {
      type: 'upload-progress',
      id,
      uploadedBytes,
      uploadTotalBytes,
    } satisfies DeviceEvent);
  }

  setUploaded(id: string, file: string, durationMs: number, mimeType: string) {
    const d = this.devices.get(id);
    if (!d) return;
    d.uploadedFile = file;
    d.durationMs = durationMs;
    d.mimeType = mimeType;
    d.phase = 'done';
    this.emit('event', {
      type: 'upload-done',
      id,
      file,
      durationMs,
      mimeType,
    } satisfies DeviceEvent);
    this.emit('event', { type: 'phase', id, phase: 'done' } satisfies DeviceEvent);
  }

  list(): Device[] {
    return Array.from(this.devices.values()).map((d) => this.externalView(d));
  }

  get(id: string): (Device & { ws: WebSocket }) | undefined {
    return this.devices.get(id);
  }

  broadcast(msg: unknown) {
    const payload = JSON.stringify(msg);
    for (const d of this.devices.values()) {
      try {
        if (d.ws.readyState === 1) d.ws.send(payload);
      } catch {
        // best-effort; dead sockets get cleaned on close
      }
    }
  }

  /** Send to a single device. Used for unicast messages like WebRTC
   *  signaling where only one phone should receive the answer. */
  sendTo(id: string, msg: unknown): boolean {
    const d = this.devices.get(id);
    if (!d) return false;
    try {
      if (d.ws.readyState !== 1) return false;
      d.ws.send(JSON.stringify(msg));
      return true;
    } catch {
      return false;
    }
  }

  /** Surface a WebRTC signaling blob from a phone to anyone listening
   *  (ipc.ts forwards to every renderer window). */
  emitRtcSignal(id: string, payload: unknown) {
    this.emit('event', { type: 'rtc-signal', id, payload } satisfies DeviceEvent);
  }

  private externalView(d: Device & { ws: WebSocket }): Device {
    // Don't leak the ws handle to the renderer.
    const { ws: _ws, ...rest } = d;
    return rest;
  }
}

export const devices = new DeviceRegistry();
