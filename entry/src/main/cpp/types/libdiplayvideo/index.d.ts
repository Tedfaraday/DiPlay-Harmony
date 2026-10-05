export const start: (surfaceId: string, width: number, height: number) => number;
export const feed: (data: ArrayBuffer, flags: number, ptsUs: number) => boolean;
export const stop: () => void;
export const stats: () => number[];
export interface AudioDecodedChunk {data:ArrayBuffer;ptsUs:number;}
export const startAudio:(sampleRate:number,channels:number,codec?:string)=>number;
export const feedAudio:(handle:number,data:ArrayBuffer,ptsUs:number)=>boolean;
export const readAudio:(handle:number)=>AudioDecodedChunk|undefined;
export const stopAudio:(handle:number)=>void;
export interface DiscoveryDatagram {data:ArrayBuffer;address:string;unicast:boolean;}
export const startDiscovery:(localAddress:string)=>number;
export const sendDiscovery:(handle:number,data:ArrayBuffer,address?:string)=>boolean;
export const readDiscovery:(handle:number)=>DiscoveryDatagram|undefined;
export const stopDiscovery:(handle:number)=>void;
