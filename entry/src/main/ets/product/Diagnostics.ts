export function diagnosticReport(phase:string,hotspot:string,logs:string,privateValues:string[]):string {
  let text=logs.slice(-16000);
  const values=privateValues.filter((value:string):boolean=>value.length>0).sort((a:string,b:string):number=>b.length-a.length);
  for(const value of values){text=text.split(value).join('[已隐藏]');}
  text=text.replace(/\b(?:[0-9a-f]{2}:){5}[0-9a-f]{2}\b/gi,'[设备地址]')
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g,'[网络地址]')
    .replace(/\b[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}\b/gi,'[会话标识]');
  return 'DiPlay Harmony 0.13.11\n连接状态：'+phase+'\n热点状态：'+hotspot+'\n音频：实验版本，手机路由与实际出声待验证\n\n'+text;
}

