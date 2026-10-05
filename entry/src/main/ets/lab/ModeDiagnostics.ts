import { Plist as P } from './Bplist';
// Only bounded numeric protocol fields are exposed, never arbitrary command values.
export function modeSummary(command:P):string{
  const params=command.entries.get('params')??command,modes=params.entries.get('modes')??params;
  const resources=modes.entries.get('resources');if(resources?.kind!=='array'){return '资源状态未提供';}
  const parts:string[]=[];
  for(let i=0;i<Math.min(resources.items.length,4);i++){
    const node=resources.items[i],fields=['resourceID','entity','owner','borrower'],values:string[]=[];
    for(let j=0;j<fields.length;j++){const value=node.entries.get(fields[j]);if(value?.kind==='int'&&value.integer>=BigInt(0)&&value.integer<=BigInt(1000)){values.push(fields[j]+'='+value.integer.toString());}}
    if(values.length>0){parts.push(values.join(','));}
  }
  return parts.length>0?parts.join(';'):'未识别资源数字字段';
}
