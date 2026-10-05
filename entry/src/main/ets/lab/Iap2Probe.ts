// SPDX-License-Identifier: GPL-3.0-only
// Wire constants and frame layout adapted from DiPlay 0.2.12 Iap2LinkEngine.kt.
// This observes detection and valid link frames; it does not negotiate a session.
export const IAP2_UUID = '00000000-deca-fade-deca-deafdecacafe';
export const IAP2_MARKER: number[] = [0xff, 0x55, 0x02, 0x00, 0xee, 0x10];

export class ProbeEvent {
  kind: string;
  detail: string;
  constructor(kind: string, detail: string) { this.kind = kind; this.detail = detail; }
}

export class Iap2Probe {
  private pending: number[] = [];
  private detected: boolean = false;

  feed(data: Uint8Array): ProbeEvent[] {
    const events: ProbeEvent[] = [];
    if (this.pending.length + data.length > 131070) {
      this.pending = [];
      events.push(new ProbeEvent('overflow', '接收缓冲区超过限制'));
      return events;
    }
    for (let i = 0; i < data.length; i++) { this.pending.push(data[i]); }
    if (!this.detected) {
      while (this.pending.length >= IAP2_MARKER.length) {
        let match = true;
        for (let j = 0; j < IAP2_MARKER.length; j++) {
          if (this.pending[j] !== IAP2_MARKER[j]) { match = false; break; }
        }
        if (match) {
          this.detected = true;
          this.pending.splice(0, IAP2_MARKER.length);
          events.push(new ProbeEvent('marker', '收到 iAP2 检测标记'));
          break;
        }
        this.pending.shift();
      }
    }
    if (!this.detected) { return events; }
    while (this.pending.length >= 9) {
      if (this.pending[0] !== 0xff || this.pending[1] !== 0x5a) {
        this.pending.shift(); continue;
      }
      const size = (this.pending[2] << 8) | this.pending[3];
      if (size < 9 || !this.validChecksum(this.pending.slice(0, 9))) {
        this.pending.shift();
        events.push(new ProbeEvent('invalid', '忽略无效 iAP2 帧头'));
        continue;
      }
      if (this.pending.length < size) { break; }
      const frame = this.pending.splice(0, size);
      if (size > 9 && !this.validChecksum(frame.slice(9))) {
        events.push(new ProbeEvent('invalid', '忽略校验失败的 iAP2 负载')); continue;
      }
      const control = frame[4];
      events.push(new ProbeEvent('frame', `有效 iAP2 帧：${size} 字节，控制 0x${control.toString(16)}`));
      if ((control & 0x80) !== 0) {
        events.push(new ProbeEvent('sync', '收到对端 SYN 帧；尚未进行会话协商'));
      }
      if ((control & 0x10) !== 0) {
        events.push(new ProbeEvent('reset', '对端发送链路重置'));
      }
    }
    return events;
  }

  private validChecksum(bytes: number[]): boolean {
    let sum = 0;
    for (let i = 0; i < bytes.length; i++) { sum += bytes[i]; }
    return (sum & 0xff) === 0;
  }
}
