export class ConnectionProfile {
  schema:number=1;ssid:string='';gateway:string='';localMac:string='';
  phoneAddress:string='';phoneName:string='';security:number=2;channel:number=0;
  rememberPassword:boolean=false;keepAwake:boolean=true;autoFullscreen:boolean=true;autoReconnect:boolean=false;
}
export function decodeProfile(text:string):ConnectionProfile {
  const profile=new ConnectionProfile();if(text.length>8192){return profile;}
  try{
    const input=JSON.parse(text) as ConnectionProfile;if(input.schema!==1){return profile;}
    if(typeof input.ssid==='string'&&input.ssid.length<=128){profile.ssid=input.ssid;}
    if(typeof input.gateway==='string'&&input.gateway.length<=64){profile.gateway=input.gateway;}
    if(typeof input.localMac==='string'&&input.localMac.length<=32){profile.localMac=input.localMac;}
    if(typeof input.phoneAddress==='string'&&input.phoneAddress.length<=32){profile.phoneAddress=input.phoneAddress;}
    if(typeof input.phoneName==='string'&&input.phoneName.length<=128){profile.phoneName=input.phoneName;}
    if([0,2,3,4].includes(input.security)){profile.security=input.security;}
    if(Number.isInteger(input.channel)&&input.channel>=0&&input.channel<=255){profile.channel=input.channel;}
    profile.rememberPassword=input.rememberPassword===true;profile.keepAwake=input.keepAwake!==false;
    profile.autoFullscreen=input.autoFullscreen!==false;profile.autoReconnect=input.autoReconnect===true;
  }catch(_error){}return profile;
}
export function profileIssue(profile:ConnectionProfile,password:string):string {
  if(!/^([0-9a-f]{2}:){5}[0-9a-f]{2}$/i.test(profile.localMac)){return '请填写平板本机蓝牙地址';}
  const parts=profile.gateway.split('.');
  if(parts.length!==4||parts.some((value:string):boolean=>!/^\d{1,3}$/.test(value)||Number(value)>255)||
    Number(parts[0])===0||Number(parts[0])>=224||Number(parts[0])===127){return '请填写平板热点的路由器 IPv4 地址';}
  const first=parts.slice(0,3).join('.');if(first==='169.254.0'||Number(parts[3])===0||Number(parts[3])===255){return '热点地址无效，请检查 iPhone 的 Wi-Fi 详情';}
  let ssidBytes=0;for(let i=0;i<profile.ssid.length;i++){const code=profile.ssid.charCodeAt(i);
    if(code>=0xd800&&code<=0xdbff&&i+1<profile.ssid.length&&profile.ssid.charCodeAt(i+1)>=0xdc00&&profile.ssid.charCodeAt(i+1)<=0xdfff){ssidBytes+=4;i++;}
    else{ssidBytes+=code<128?1:code<2048?2:3;}}
  if(profile.ssid.length<1||profile.ssid.indexOf('\u0000')>=0||ssidBytes>32){return '热点名称须为 1–32 字节';}
  if(![0,2,3,4].includes(profile.security)){return '请选择正确的热点安全类型';}
  if(profile.security!==0&&(password.length<8||password.length>63)){return '热点密码须为 8–63 个字符';}
  if(password.indexOf('\u0000')>=0){return '热点密码包含无效字符';}
  if(!Number.isInteger(profile.channel)||profile.channel<0||profile.channel>255){return '信道须为 0–255；不确定时填写 0';}
  if(!/^([0-9a-f]{2}:){5}[0-9a-f]{2}$/i.test(profile.phoneAddress)){return '请选择已配对的 iPhone';}return '';
}
