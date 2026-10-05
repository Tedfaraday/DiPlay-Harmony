const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process');
const root=path.resolve(__dirname,'..');
const files=fs.readdirSync(path.join(root,'tests')).filter(x=>x.endsWith('.test.cjs')).sort();
let total=0;
for(const file of files){
  const r=cp.spawnSync(process.execPath,[path.join(root,'tests',file)],{encoding:'utf8',env:process.env});
  process.stdout.write(r.stdout||'');process.stderr.write(r.stderr||'');
  if(r.status!==0){process.exit(r.status||1);}
  total+=(r.stdout.match(/^PASS /gm)||[]).length;
}
console.log(`${total} checks passed in ${files.length} test suites`);
