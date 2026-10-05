// GPL-3.0-only. Wireless bootstrap field layout adapted from DiPlay Iap2Messages.kt.
import { controlMessage, parameter } from './Iap2Control';

export class WirelessSettings {
  ssid: string;
  passphrase: string;
  address: string;
  channel: number;
  security: number;
  constructor(ssid: string, passphrase: string, address: string, channel: number = 0, security: number = 2) {
    if (ssid.trim().length < 1 || ssid.indexOf('\u0000') >= 0 || passphrase.indexOf('\u0000') >= 0) { throw new Error('热点名称不能为空或包含 NUL'); }
    if (security < 0 || security > 4 || !Number.isInteger(security)) { throw new Error('热点安全类型无效'); }
    if (security !== 0 && passphrase.length < 8) { throw new Error('热点密码至少需要 8 个字符'); }
    if (!Number.isInteger(channel) || channel < 0 || channel > 255) { throw new Error('信道应为 0–255；0 表示不提供提示'); }
    const parts = address.split('.');
    if (parts.length !== 4 || parts.some((part: string): boolean => !/^\d{1,3}$/.test(part) || Number(part) > 255)) {
      throw new Error('填写 iPhone Wi-Fi 详情中的路由器 IPv4 地址');
    }
    this.ssid = ssid; this.passphrase = passphrase; this.address = address; this.channel = channel; this.security = security;
  }
}

export function joinParameters(fields: Uint8Array[]): Uint8Array {
  let length = 0; for (let i = 0; i < fields.length; i++) { length += fields[i].length; }
  const result = new Uint8Array(length); let offset = 0;
  for (let i = 0; i < fields.length; i++) { result.set(fields[i],offset); offset += fields[i].length; }
  return result;
}

export function wifiConfiguration(settings: WirelessSettings, encode: (text: string) => Uint8Array): Uint8Array {
  return controlMessage(0x5703,[parameter(1,encode(settings.ssid+'\u0000')),parameter(2,encode(settings.passphrase+'\u0000')),
    parameter(3,new Uint8Array([settings.security])),parameter(4,new Uint8Array([settings.channel]))]);
}

export function startWirelessSession(settings: WirelessSettings, deviceIdentifier: string, publicKey: string,
  encode: (text: string) => Uint8Array): Uint8Array {
  if (!/^[0-9a-f]{64}$/i.test(publicKey)) { throw new Error('Expected Ed25519 public key'); }
  // iAP2 parameter 3 is the receiver deviceID used by /info and Bonjour, not pairing pi.
  if (!/^([0-9a-f]{2}:){5}[0-9a-f]{2}$/i.test(deviceIdentifier)) { throw new Error('Expected receiver device MAC'); }
  const wifi = joinParameters([parameter(0,encode(settings.ssid+'\u0000')),parameter(1,encode(settings.passphrase+'\u0000')),
    parameter(2,new Uint8Array([settings.channel])),parameter(3,encode(settings.address+'\u0000')),
    parameter(4,new Uint8Array([settings.security]))]);
  return controlMessage(0x4301,[parameter(1,wifi),parameter(2,new Uint8Array([0,0,27,88])),
    parameter(3,encode(deviceIdentifier+'\u0000')),parameter(4,encode(publicKey+'\u0000')),parameter(5,encode('950.7.1\u0000'))]);
}

export function wirelessComponent(ssid: string, encode: (text: string) => Uint8Array): Uint8Array {
  return parameter(24,joinParameters([parameter(0,new Uint8Array([0,1])),parameter(1,encode(ssid+'\u0000')),
    parameter(2,new Uint8Array(0)),parameter(3,new Uint8Array([0,1])),parameter(4,new Uint8Array(0)),parameter(5,new Uint8Array(0))]));
}
