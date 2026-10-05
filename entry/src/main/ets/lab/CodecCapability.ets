import native from 'libdiplayvideo.so';
// Decode a known 20 ms mono Opus silence packet without creating an audio renderer.
// A MIME declaration alone does not prove that this device can produce S16LE PCM.
export async function probeOpus(cancelled:()=>boolean):Promise<boolean>{
  let handle=0;
  try{
    if(cancelled()){return false;}handle=native.startAudio(48000,1,'opus');if(handle<=0){return false;}
    if(!native.feedAudio(handle,new Uint8Array([0xf8,0xff,0xfe]).buffer as ArrayBuffer,0)){return false;}
    for(let i=0;i<20;i++){
      if(cancelled()){return false;}const output=native.readAudio(handle);
      if(output){return output.data.byteLength===1920&&output.ptsUs===0;}
      await new Promise<void>((resolve:()=>void):void=>{setTimeout(resolve,50);});
    }return false;
  }catch(_error){return false;}finally{if(handle>0){native.stopAudio(handle);}}
}
