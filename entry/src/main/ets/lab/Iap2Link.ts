// GPL-3.0-only. Adapted from xcertplay/DiPlay Iap2LinkEngine (shilapi).
// Caller supplies monotonic milliseconds; no platform dependencies.
import { IAP2_MARKER } from './Iap2Probe';

export class LinkEvent {
  kind: string;
  detail: string;
  data: Uint8Array;
  constructor(kind: string, detail: string, data: Uint8Array = new Uint8Array(0)) {
    this.kind = kind; this.detail = detail; this.data = data;
  }
}

class LinkPacket {
  sequence: number = 0;
  session: number;
  payload: Uint8Array;
  deadline: number = 0;
  retries: number = 0;
  constructor(session: number, payload: Uint8Array) { this.session = session; this.payload = payload.slice(); }
}

export class Iap2Link {
  state: string = 'IDLE';
  private input: number[] = [];
  private output: Uint8Array[] = [];
  private events: LinkEvent[] = [];
  private pendingBytes: number = 0;
  private sent: number = 99;
  private received: number = 0;
  private lastAck: number = 99;
  private lastReceiveAck: number = 0;
  private ackCount: number = 0;
  private peerSeen: boolean = false;
  private peerWindow: number = 4;
  private peerLength: number = 65535;
  private peerRetryTime: number = 4000;
  private peerAckTime: number = 500;
  private peerRetries: number = 4;
  private peerAcks: number = 3;
  private syncDeadline: number = -1;
  private ackDeadline: number = -1;
  private unacked: LinkPacket[] = [];
  private queued: LinkPacket[] = [];
  private reordered: LinkPacket[] = [];
  private zeroAcknowledgements: boolean = false;

  start(now: number, tunnel: boolean = false): void {
    if (this.state !== 'IDLE') { return; }
    this.state = 'DETECTING'; this.emit(new Uint8Array(IAP2_MARKER)); this.syncDeadline = now + 1000;
    if (tunnel) { this.zeroAcknowledgements=true;this.state='NEGOTIATING';this.sendSync();this.syncDeadline=now+500; }
  }

  feed(bytes: Uint8Array, now: number): void {
    for (let i = 0; i < bytes.length && this.state !== 'DEAD'; i++) {
      if (this.input.length >= 65535) { this.fail('接收缓冲区超限'); return; }
      this.input.push(bytes[i]);
      this.parse(now);
    }
  }

  private parse(now: number): void {
    if (this.state === 'DETECTING') {
      if (this.input.length < 6) { return; }
      for (let i = 0; i < 6; i++) {
        if (this.input[i] !== IAP2_MARKER[i]) { this.fail('检测回复不匹配'); return; }
      }
      this.input.splice(0, 6); this.state = 'NEGOTIATING';
      this.event(new LinkEvent('marker', '收到 iAP2 检测回复，发送 SYN'));
      this.sendSync(); this.syncDeadline = now + 500;
    }
    while (this.input.length >= 9 && this.state !== 'DEAD') {
      if (this.input[0] !== 255 || this.input[1] !== 90) { this.input.shift(); continue; }
      if (!this.valid(this.input.slice(0, 9))) { this.input.shift(); continue; }
      const length = this.input[2] * 256 + this.input[3];
      if (length < 9 || length === 10) { this.input.shift(); continue; }
      if (this.input.length < length) { return; }
      const frame = this.input.splice(0, length);
      if (length > 9 && !this.valid(frame.slice(9))) { continue; }
      const payload = length > 9 ? new Uint8Array(frame.slice(9, length - 1)) : undefined;
      this.process(frame[4], frame[5], frame[6], frame[7], payload, now);
    }
  }

  private process(control: number, sequence: number, ack: number, session: number,
    payload: Uint8Array | undefined, now: number): void {
    if ((control & 16) !== 0) { this.fail('手机发送 RESET'); return; }
    if ((control & 128) !== 0 && this.state === 'NEGOTIATING' && payload) {
      if (!this.syncPeer(payload)) { this.fail('手机 SYN 参数无效'); return; }
      this.peerSeen = true; this.received = sequence; this.lastReceiveAck = sequence;
      this.event(new LinkEvent('sync', `手机 SYN：窗口 ${this.peerWindow}，帧上限 ${this.peerLength}`));
      this.write(undefined, this.sent, 64, 0);
    }
    if ((control & 64) !== 0) {
      if (this.state === 'NEGOTIATING' && this.peerSeen && ack === this.sent) {
        this.state = 'NORMAL'; this.syncDeadline = -1;
        this.event(new LinkEvent('normal', 'iAP2 链路协商成功（尚未认证）'));
      }
      if (this.state === 'NORMAL') { this.acknowledge(ack, now); }
      this.ackCount++;
    }
    if (this.state !== 'NORMAL') { return; }
    if ((control & 32) !== 0 && payload) {
      for (let i = 0; i < this.unacked.length; i++) {
        if (payload.indexOf(this.unacked[i].sequence) >= 0) { this.retry(this.unacked[i], now); }
      }
    }
    if ((control & ~64) === 0 && payload) { this.receive(sequence, session, payload, now); }
    if (this.peerAcks > 0 && this.ackCount >= this.peerAcks) { this.sendAck(); }
  }

  private syncPeer(bytes: Uint8Array): boolean {
    if (bytes.length < 10 || bytes[0] !== 1 || (bytes.length - 10) % 3 !== 0) { return false; }
    const length = bytes[2] * 256 + bytes[3];
    const retryTime = bytes[4] * 256 + bytes[5];
    let controlSession = false;
    for (let i = 10; i < bytes.length; i += 3) {
      if (bytes[i] === 10 && bytes[i + 1] === 0 && bytes[i + 2] >= 1) { controlSession = true; }
    }
    if (bytes[1] < 1 || bytes[1] > 127 || length <= 10 || !controlSession ||
      (bytes[8] > 0 && retryTime === 0)) { return false; }
    this.peerWindow = bytes[1]; this.peerLength = length; this.peerRetryTime = retryTime;
    this.peerAckTime = bytes[6] * 256 + bytes[7]; this.peerRetries = bytes[8]; this.peerAcks = bytes[9];
    return true;
  }

  private acknowledge(ack: number, now: number): void {
    // Reject ACKs for unsent sequence numbers, including across byte wrap.
    const progress = this.distance(ack, this.lastAck);
    if (progress > this.distance(this.sent, this.lastAck)) { return; }
    this.lastAck = ack;
    this.unacked = this.unacked.filter((p: LinkPacket): boolean => {
      const ahead = this.distance(p.sequence, ack); return ahead > 0 && ahead <= this.peerWindow;
    });
    while (this.queued.length > 0 && this.distance(this.sent, this.lastAck) < this.peerWindow) {
      const packet = this.queued.shift(); if (packet) { this.sendPacket(packet, now); }
    }
  }

  private receive(sequence: number, session: number, payload: Uint8Array, now: number): void {
    const distance = this.distance(sequence, this.received);
    if (distance === 0 || distance > this.peerWindow + 10) { this.sendAck(); return; }
    if (this.reordered.some((p: LinkPacket): boolean => p.sequence === sequence)) { return; }
    if (this.reordered.length >= 64) { this.fail('乱序队列超限'); return; }
    const packet = new LinkPacket(session, payload); packet.sequence = sequence; this.reordered.push(packet);
    if (distance > 1 && distance >= this.peerWindow) {
      const missing: number[] = [];
      for (let seq = (this.received + 1) & 255; seq !== sequence; seq = (seq + 1) & 255) { missing.push(seq); }
      this.write(new Uint8Array(missing), this.sent, 32, 0); this.ackDeadline = -1;
    }
    this.reordered.sort((a: LinkPacket, b: LinkPacket): number =>
      this.distance(a.sequence, this.received) - this.distance(b.sequence, this.received));
    while (this.reordered.length > 0 && this.distance(this.reordered[0].sequence, this.received) === 1) {
      const next = this.reordered.shift();
      if (next) {
        this.received = next.sequence;
        this.event(new LinkEvent(next.session === 10 ? 'control' : 'session', `会话 ${next.session}`, next.payload));
      }
    }
    if (this.peerAcks > 0) {
      if (this.distance(this.received, this.lastReceiveAck) >= this.peerWindow) { this.sendAck(); }
      else { this.ackDeadline = now + this.peerAckTime; }
    }
  }

  sendControl(bytes: Uint8Array, now: number): void {
    if (this.state !== 'NORMAL') { throw new Error('iAP2 link is not ready'); }
    if (bytes.length < 1 || bytes.length > this.peerLength - 10) { throw new Error('payload exceeds peer frame size'); }
    const packet = new LinkPacket(10, bytes);
    if (this.distance(this.sent, this.lastAck) >= this.peerWindow) {
      if (this.queued.length >= 64) { this.fail('发送队列超限'); return; }
      this.queued.push(packet);
    } else { this.sendPacket(packet, now); }
  }

  private sendPacket(packet: LinkPacket, now: number): void {
    this.sent = (this.sent + 1) & 255; packet.sequence = this.sent; packet.deadline = now + this.peerRetryTime;
    this.write(packet.payload, packet.sequence, 64, packet.session);
    this.ackDeadline = -1; this.lastReceiveAck = this.received;
    if (this.peerRetries > 0) { this.unacked.push(packet); } else { this.lastAck = this.sent; }
  }

  advance(now: number): void {
    if (this.state === 'DEAD') { return; }
    if (this.syncDeadline >= 0 && now >= this.syncDeadline) {
      if (this.state === 'DETECTING') { this.emit(new Uint8Array(IAP2_MARKER)); this.syncDeadline = now + 1000; }
      else if (this.state === 'NEGOTIATING') { this.sendSync(); this.syncDeadline = now + 500; }
    }
    if (this.ackDeadline >= 0 && now >= this.ackDeadline) { this.sendAck(); }
    for (let i = 0; i < this.unacked.length && this.state !== 'DEAD'; i++) {
      if (now >= this.unacked[i].deadline) { this.retry(this.unacked[i], now); }
    }
  }

  private retry(packet: LinkPacket, now: number): void {
    packet.retries++;
    if (packet.retries >= this.peerRetries) { this.fail('手机未确认发送数据'); return; }
    packet.deadline = now + this.peerRetryTime; this.write(packet.payload, packet.sequence, 64, packet.session);
  }

  private sendSync(): void {
    const timing=this.zeroAcknowledgements?[0,0,0,0,0,0]:[15,160,1,244,4,3];
    this.write(new Uint8Array([1,4,255,255,...timing,10,0,2,11,2,1,12,1,2]), this.sent, 128, 0);
  }
  private sendAck(): void {
    this.ackDeadline = -1; this.lastReceiveAck = this.received; this.write(undefined, this.sent, 64, 0);
  }
  private write(payload: Uint8Array | undefined, sequence: number, control: number, session: number): void {
    const length = payload ? payload.length + 10 : 9;
    const bytes = new Uint8Array(length);
    bytes.set([255,90,length >>> 8,length & 255,control,sequence,this.received,session]);
    bytes[8] = this.checksum(bytes.slice(0,8));
    if (payload) { bytes.set(payload,9); bytes[length - 1] = this.checksum(payload); }
    this.ackCount = 0; this.emit(bytes);
  }
  private checksum(bytes: Uint8Array): number {
    let sum = 0; for (let i = 0; i < bytes.length; i++) { sum += bytes[i]; } return (-sum) & 255;
  }
  private valid(bytes: number[]): boolean {
    let sum = 0; for (let i = 0; i < bytes.length; i++) { sum += bytes[i]; } return (sum & 255) === 0;
  }
  private distance(a: number, b: number): number { return (a - b) & 255; }
  private emit(bytes: Uint8Array): void {
    if (this.state === 'DEAD') { return; }
    if (this.pendingBytes + bytes.length > 1048576) { this.fail('输出缓冲区超限'); return; }
    this.output.push(bytes); this.pendingBytes += bytes.length;
  }
  private event(event: LinkEvent): void {
    if (this.events.length >= 256) { this.fail('事件队列超限'); return; }
    this.events.push(event);
  }
  private fail(reason: string): void {
    this.state = 'DEAD'; this.input = []; this.output = []; this.pendingBytes = 0;
    this.unacked = []; this.queued = []; this.reordered = [];
    this.events = [new LinkEvent('dead', reason)];
  }
  takeOutput(): Uint8Array[] { const result = this.output; this.output = []; this.pendingBytes = 0; return result; }
  takeEvents(): LinkEvent[] { const result = this.events; this.events = []; return result; }
  stop():void { this.fail('已关闭');this.events=[]; }
}

// Control messages can span multiple link packets; observe complete messages only.
export class CsmObserver {
  private input: number[] = [];
  feed(bytes: Uint8Array): number[] {
    return this.feedMessages(bytes).map((message: CsmMessage): number => message.id);
  }
  feedMessages(bytes: Uint8Array): CsmMessage[] {
    const messages: CsmMessage[] = [];
    for (let i = 0; i < bytes.length; i++) {
      if (this.input.length >= 65535) { throw new Error('CSM buffer exceeded'); }
      this.input.push(bytes[i]);
      while (this.input.length >= 6) {
        if (this.input[0] !== 64 || this.input[1] !== 64) { this.input.shift(); continue; }
        const length = this.input[2] * 256 + this.input[3];
        if (length < 6) { this.input.shift(); continue; }
        if (this.input.length < length) { break; }
        if (messages.length >= 256) { throw new Error('CSM message queue exceeded'); }
        messages.push(new CsmMessage(this.input[4] * 256 + this.input[5], new Uint8Array(this.input.slice(6, length))));
        this.input.splice(0, length);
      }
    }
    return messages;
  }
}

export class CsmMessage {
  id: number;
  body: Uint8Array;
  constructor(id: number, body: Uint8Array) { this.id = id; this.body = body; }
}
