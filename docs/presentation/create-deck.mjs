import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {Presentation,PresentationFile} from '@oai/artifact-tool';
const ROOT=path.dirname(fileURLToPath(import.meta.url)),ASSETS=ROOT+'/assets',BUILD=ROOT+'/build';
await fs.mkdir(BUILD,{recursive:true});
const P=Presentation.create({slideSize:{width:1280,height:720}});
const C={bg:'#141218',surface:'#211F26',low:'#1D1B20',high:'#2B2930',text:'#E6E0E9',muted:'#CAC4D0',primary:'#D0BCFF',onPrimary:'#381E72',outline:'#49454F',error:'#F2B8B5',green:'#A8DAB5'};
const manifest=[];let S,M;
function slide(duration){S=P.slides.add();S.background.fill=C.bg;M={slide:manifest.length+1,duration,effects:[]};manifest.push(M);return S;}
function anim(key,start=0.4,effect=10,duration=.6,image=false,extra={}){M.effects.push({key,start,effect,duration,image,...extra});}
function text(key,content,x,y,w,h,size=28,color=C.text,bold=false,start=.4,effect=10){const t=S.shapes.add({name:key,geometry:'textbox',position:{left:x,top:y,width:w,height:h},fill:'none',line:{fill:'none',width:0}});t.text=content;t.text.style={typeface:'Microsoft YaHei',fontSize:size,bold,color,autoFit:'none',wrap:'none',insets:{left:0,right:0,top:0,bottom:0}};if(start!==null)anim(key,start,effect);return t;}
function block(key,x,y,w,h,fill){return S.shapes.add({name:key,geometry:'rect',position:{left:x,top:y,width:w,height:h},fill,line:{fill:'none',width:0}});}
async function image(key,file,x,y,w,h,start=.8,effect=48){const blob=new Uint8Array(await fs.readFile(ASSETS+'/'+file));S.images.add({blob,contentType:file.endsWith('.jpg')?'image/jpeg':'image/png',alt:key,fit:'contain',position:{left:x,top:y,width:w,height:h}});if(start!==null)anim(key,start,effect,.8,true);}
function heading(content,subtitle=''){text('title',content,64,48,1152,76,46,C.text,true,.2,39);if(subtitle)text('subtitle',subtitle,64,130,1148,50,25,C.muted,false,.9);}
function notes(content){S.speakerNotes.textFrame.setText(content+'\n内容依据：DiPlay Harmony 0.12.0 本地 README、开发状态与用户提供的实机截图。\n设计参考：https://github.com/material-components/material-web/blob/main/docs/theming/color.md\n线形图标：Google Material Symbols，Apache-2.0。https://github.com/google/material-design-icons\n');}
// 01: A quiet product opening with actual hardware evidence.
slide(8);block('photo-partition',512,0,768,720,C.low);
await image('brand-icon','product_mark.png',64,58,66,66,.1,48);
text('hero-title','DiPlay\nHarmony',64,186,424,184,68,C.text,true,.65,39);
text('hero-copy','平板上的无线 CarPlay',66,420,430,50,29,C.primary,false,1.45);
text('version','HarmonyOS NEXT\n0.12.0 产品预览版',66,546,410,80,24,C.muted,false,2.3);
await image('hero-device','tablet_mac.png',756,144,320,320,.8,48);text('hero-native','原生 HarmonyOS NEXT',610,508,600,52,30,C.primary,true,2.2);text('hero-source','基于 DiPlay 的独立移植',610,571,600,44,24,C.muted,false,3.0);
notes('DiPlay Harmony 0.12.0 源码与公开说明。关联来源：https://github.com/shihabal3amri/DiPlay/tree/v0.2.12 。当前音频暂不可用，需保持应用前台。本公开版使用源代码图标，不含原始实机照片。');
// 02: Connection roles, explained in two simple flat areas.
slide(10);heading('无线连接','蓝牙建立连接入口，平板热点传输画面与触控');
block('left-field',64,224,552,400,C.low);block('right-field',640,224,576,400,C.surface);
await image('iphone-icon','phone_iphone.png',96,266,108,108,.8,39);text('iphone-label','iPhone',226,282,330,60,40,C.text,true,1.0);
await image('tablet-icon','tablet_mac.png',674,266,112,112,1.4,39);text('tablet-label','鸿蒙平板',814,282,354,60,40,C.text,true,1.6);
await image('bluetooth-icon','bluetooth.png',110,418,60,60,2.0);text('bluetooth-copy','完成系统蓝牙配对',192,431,370,44,27,C.muted,false,2.2);
await image('wifi-icon','wifi.png',692,418,60,60,2.6);text('wifi-copy','开启平板无线热点',774,431,380,44,27,C.muted,false,2.8);
text('connection-detail','应用完成无线引导与加密会话',96,543,496,44,23,C.primary,false,3.6);text('connection-detail2','接收画面，发送触控操作',676,543,500,44,23,C.primary,false,3.8);
notes('DiPlay Harmony 0.12.0 源码与公开说明。关联来源：https://github.com/shihabal3amri/DiPlay/tree/v0.2.12 。当前音频暂不可用，需保持应用前台。本公开版使用源代码图标，不含原始实机照片。');
// 03: Real native app interface.
slide(9);heading('连接入口','热点开启后，从首页连接 iPhone');
text('entry-label','原生鸿蒙应用',64,262,340,60,34,C.primary,true,1.0);
text('entry-copy','连接状态直接可见\n常用入口保持简洁\n配置保存于本机',64,360,350,160,27,C.muted,false,2.0);
await image('entry-screenshot','settings.png',635,255,240,240,.9,48);text('entry-public-1','选择 iPhone',650,520,500,52,31,C.primary,true,2.6);text('entry-public-2','保存配置后连接',650,584,500,48,27,C.muted,false,3.2);
notes('DiPlay Harmony 0.12.0 源码与公开说明。关联来源：https://github.com/shihabal3amri/DiPlay/tree/v0.2.12 。当前音频暂不可用，需保持应用前台。本公开版使用源代码图标，不含原始实机照片。');
// 04: Interaction, using the actual CarPlay dashboard photo.
slide(9);heading('单指触控','在平板上点按和拖动 CarPlay 界面');
await image('touch-photo','phone_iphone.png',280,248,220,220,.8,48);text('touch-public','画面与触控双向连接',128,526,724,62,38,C.primary,true,2.3);text('touch-public-copy','已在原生鸿蒙平板上验证',128,603,724,44,26,C.muted,false,3.1);
await image('touch-icon','touch_app.png',978,258,126,126,1.5,39);
text('touch-label','点按与拖动',934,412,298,64,34,C.primary,true,2.1);
text('touch-copy','操作地图和应用界面\n触点映射到视频坐标',934,497,300,106,25,C.muted,false,2.8);
notes('DiPlay Harmony 0.12.0 源码与公开说明。关联来源：https://github.com/shihabal3amri/DiPlay/tree/v0.2.12 。当前音频暂不可用，需保持应用前台。本公开版使用源代码图标，不含原始实机照片。');
// 05: Pure picture fullscreen.
slide(9);heading('沉浸全屏','CarPlay 全屏只保留画面');
text('fullscreen-copy','隐藏应用工具栏\n隐藏状态栏\n隐藏导航指示条',64,281,360,180,30,C.text,false,1.25,39);
text('fullscreen-note','退出全屏后，应用页面\n仍保持沉浸显示',64,521,362,100,25,C.primary,false,3.2);
await image('fullscreen-photo','fullscreen.png',728,257,228,228,.8,48);text('fullscreen-public','三指下滑唤出控制',576,550,625,54,31,C.primary,true,3.7);
notes('DiPlay Harmony 0.12.0 源码与公开说明。关联来源：https://github.com/shihabal3amri/DiPlay/tree/v0.2.12 。当前音频暂不可用，需保持应用前台。本公开版使用源代码图标，不含原始实机照片。');
// 06: Motion cue for the local triple-finger gesture.
slide(9);heading('三指下滑','需要退出时，再唤出控制面板');
block('gesture-partition',64,226,402,416,C.surface);
text('finger-count','3',112,244,218,244,176,C.primary,true,.9,48);
await image('swipe-icon','swipe_down.png',309,353,118,118,1.4,42);
text('gesture-steps','三根手指同时向下滑动',82,533,360,58,25,C.muted,false,2.15);
text('continue-title','继续全屏',550,265,620,58,40,C.text,true,2.9,39);
text('continue-copy','收起面板，继续使用 CarPlay',550,338,620,44,27,C.muted,false,3.5);
text('return-title','返回应用',550,441,620,58,40,C.text,true,4.5,39);
text('return-copy','返回连接页，保持应用沉浸',550,514,620,44,27,C.muted,false,5.1);
notes('DiPlay Harmony 0.12.0 源码与公开说明。关联来源：https://github.com/shihabal3amri/DiPlay/tree/v0.2.12 。当前音频暂不可用，需保持应用前台。本公开版使用源代码图标，不含原始实机照片。');
// 07: Display declaration, using verified numerical evidence.
slide(10);heading('16:10 屏幕适配','按真实屏幕比例协商 CarPlay 画面');
block('metrics-left',64,226,558,315,C.low);block('metrics-right',646,226,570,315,C.surface);
text('panel-label','平板原生分辨率',94,260,495,50,29,C.muted,false,1.0);
text('panel-value','2560 × 1600',94,337,490,84,56,C.text,true,1.7,48);
text('video-label','CarPlay 视频分辨率',677,260,495,50,29,C.muted,false,2.6);
text('video-value','1280 × 800',677,337,494,84,56,C.primary,true,3.3,48);
text('ratio-copy','相同比例缩放，保持完整画面',94,451,1060,60,31,C.text,false,4.4);
text('ppi-copy','约 344 PPI     物理尺寸约 189 × 118 mm',94,575,1100,50,24,C.muted,false,5.4);
notes('DiPlay Harmony 0.12.0 源码与公开说明。关联来源：https://github.com/shihabal3amri/DiPlay/tree/v0.2.12 。当前音频暂不可用，需保持应用前台。本公开版使用源代码图标，不含原始实机照片。');
// 08: Actual first-use sequence.
slide(12);heading('首次使用','完成一次配置，之后从首页连接');
const steps=[['01','蓝牙配对与热点','在系统中配对 iPhone，并开启平板热点'],['02','保存连接配置','选择 iPhone，填写热点信息、网关和本机蓝牙地址'],['03','返回首页连接','如 iPhone 弹出 CarPlay 确认，请允许']];
for(let i=0;i<steps.length;i++){const y=224+i*140;block('step-field-'+i,64,y,1152,120,i===1?C.surface:C.low);text('step-num-'+i,steps[i][0],94,y+23,110,65,42,C.primary,true,.9+i*1.9,48);text('step-title-'+i,steps[i][1],232,y+14,850,51,32,C.text,true,1.15+i*1.9,39);text('step-body-'+i,steps[i][2],232,y+69,916,43,24,C.muted,false,1.7+i*1.9);}
notes('DiPlay Harmony 0.12.0 源码与公开说明。关联来源：https://github.com/shihabal3amri/DiPlay/tree/v0.2.12 。当前音频暂不可用，需保持应用前台。本公开版使用源代码图标，不含原始实机照片。');
// 09: Settings and reconnection with a real app screenshot.
slide(10);heading('连接配置与恢复','应用保存配置，可选前台断线重试');
await image('about-screenshot','wifi.png',761,257,205,205,.8,48);text('reconnect-public','手动断开 / 后台 / 锁屏',557,510,655,54,27,C.muted,false,4.7);text('reconnect-public2','停止重试，释放会话',557,582,655,54,30,C.primary,true,5.4);
await image('settings-icon','settings.png',68,233,68,68,.9,39);
text('settings-title','配置保存在本机',164,241,344,50,29,C.text,true,1.4);
text('settings-copy','覆盖更新后继续使用',164,310,340,43,25,C.muted,false,2.0);
await image('reconnect-icon','autorenew.png',68,417,68,68,2.6,39);
text('retry-title','可选前台重试',164,426,340,50,29,C.text,true,3.0);
text('retry-copy','最多 3 次\n间隔 2、4、8 秒',164,495,340,93,25,C.muted,false,3.6);
notes('DiPlay Harmony 0.12.0 源码与公开说明。关联来源：https://github.com/shihabal3amri/DiPlay/tree/v0.2.12 。当前音频暂不可用，需保持应用前台。本公开版使用源代码图标，不含原始实机照片。');
// 10: Privacy without inflated guarantees.
slide(10);heading('本机数据管理','密码保存由用户选择');
await image('privacy-icon','verified_user.png',84,243,236,236,.8,48);
text('privacy-main','热点密码默认不持久保存',396,228,798,75,37,C.text,true,1.5,39);
text('privacy-vault','开启“记住热点密码”后\n写入鸿蒙安全资产库',396,340,798,118,30,C.primary,false,2.6);
text('privacy-diagnostics','诊断由用户主动复制\n应用不会自动上传诊断记录',396,510,798,106,27,C.muted,false,4.2);
notes('DiPlay Harmony 0.12.0 源码与公开说明。关联来源：https://github.com/shihabal3amri/DiPlay/tree/v0.2.12 。当前音频暂不可用，需保持应用前台。本公开版使用源代码图标，不含原始实机照片。');
// 11: Clear limitations, visible during autoplay.
slide(12);heading('当前支持与限制','0.12.0 产品预览版');
block('support-field',64,224,548,390,C.low);block('limits-field',636,224,580,390,C.surface);
text('support-heading','已支持',94,256,470,59,36,C.primary,true,.9,39);
text('support-copy','无线画面接收\n单指触控与沉浸全屏\n屏幕比例适配\n配置保存与前台重试',94,342,488,221,27,C.text,false,1.8);
text('limits-heading','使用限制',668,256,500,59,36,C.error,true,3.0,39);
text('audio-limit','音频暂不可用',668,341,500,54,30,C.error,true,3.8);
text('foreground-limit','需保持应用前台\n锁屏或切换应用会断开\n麦克风、通话及 Siri 音频未实现',668,414,505,156,24,C.muted,false,4.5);
text('devices','本次验证：MatePad mini / HarmonyOS 7，iPhone 16 Pro / iOS 27',94,647,1130,42,22,C.muted,false,6.0);
notes('DiPlay Harmony 0.12.0 源码与公开说明。关联来源：https://github.com/shihabal3amri/DiPlay/tree/v0.2.12 。当前音频暂不可用，需保持应用前台。本公开版使用源代码图标，不含原始实机照片。');
// 12: Minimal end frame.
slide(7);await image('end-brand','product_mark.png',92,116,106,106,.3,48);
text('end-title','DiPlay Harmony',92,267,1100,112,72,C.text,true,.85,39);
text('end-copy','让平板成为 CarPlay 显示屏',94,424,1100,74,40,C.primary,false,1.8);
text('end-version','0.12.0 产品预览版',94,558,1100,45,26,C.muted,false,2.7);
text('end-credit','基于 DiPlay 协议研究的鸿蒙移植工程，遵循 GPL-3.0',94,636,1120,42,21,C.muted,false,3.5);
notes('DiPlay Harmony 0.12.0 源码与公开说明。关联来源：https://github.com/shihabal3amri/DiPlay/tree/v0.2.12 。当前音频暂不可用，需保持应用前台。本公开版使用源代码图标，不含原始实机照片。');
await (await PresentationFile.exportPptx(P)).save(BUILD+'/design.pptx');
await fs.writeFile(BUILD+'/animation-plan.json',JSON.stringify(manifest,null,2));
await fs.writeFile(BUILD+'/slides.json',JSON.stringify(P.toProto()));
console.log('12 editable slides exported; target timeline '+manifest.reduce((n,m)=>n+m.duration,0)+' seconds; '+manifest.reduce((n,m)=>n+m.effects.length,0)+' entrance effects');
process.exit(0);
