"""Check only the reviewed public snapshot; never print secret values."""
from pathlib import Path
from zipfile import ZipFile
import hashlib,json,re,sys,subprocess
ROOT=Path(__file__).resolve().parent.parent
BAD_EXT={'.p12','.pfx','.pk8','.p7b','.pem','.cer','.der','.profile','.hap','.apk','.log','.mp4','.jpg','.jpeg'}
SKIP={'.git','.cxx','node_modules','oh_modules','.hvigor','.idea','build','work','dist','publication'}
patterns={
 'private-key':re.compile(r'-----BEGIN (?:RSA |EC |OPENSSH |ENCRYPTED )?PRIVATE KEY-----'),
 'github-token':re.compile(r'\b(?:gh[pousr]_[A-Za-z0-9]{25,}|github_pat_[A-Za-z0-9_]{30,})\b'),
 'cloud-key':re.compile(r'\bAKIA[0-9A-Z]{16}\b'),
 'personal-path':re.compile(r'[A-Za-z]:[/\\](?:Users|DataWEIXIN)[/\\]',re.I),
 'messenger-id':re.compile(r'\bwxid_[A-Za-z0-9_]+'),
 'real-signing-config':re.compile(r'"(?:storePassword|keyPassword|storeFile|profile)"\s*:\s*"[^"\n]+"'),
}
APPROVED_UNSIGNED_HAPS={
 'releases/DiPlay-Harmony-0.12.0-unsigned.hap':'2a2652168e65661e22d863b3838e18d4f0c07bd26c229e253aae1f190bd4d399',
}
issues=[];files=[]
if (ROOT/'.git').exists():
 listing=subprocess.run(['git','ls-files','--cached','--others','--exclude-standard','-z'],cwd=ROOT,capture_output=True,check=True).stdout
 candidates=[ROOT/path for path in listing.decode('utf-8').split('\0') if path]
else:
 candidates=list(ROOT.rglob('*'))
for p in candidates:
 rel=p.relative_to(ROOT)
 if any(part in SKIP for part in rel.parts):continue
 if p.is_symlink():issues.append((rel.as_posix(),'symlink'));continue
 if not p.is_file():continue
 files.append(p)
 if rel.as_posix() in APPROVED_UNSIGNED_HAPS:
  if hashlib.sha256(p.read_bytes()).hexdigest()!=APPROVED_UNSIGNED_HAPS[rel.as_posix()]:
   issues.append((rel.as_posix(),'unreviewed-release-package'))
  continue
 if p.suffix.lower() in BAD_EXT or (p.name=='local.properties' or rel.as_posix()=='build-profile.json5'):
  issues.append((rel.as_posix(),'excluded-local-artifact'))
 if p.suffix.lower() in {'.pptx','.ppsx'}:
  manifest=json.loads((ROOT/'docs/presentation/media-manifest.json').read_text())
  approved=set(manifest['sha256'])
  with ZipFile(p) as z:
   for name in z.namelist():
    data=z.read(name)
    if name.startswith('ppt/media/') and hashlib.sha256(data).hexdigest() not in approved:
     issues.append((rel.as_posix()+'!'+name,'unapproved-media'))
    if name.startswith('docProps/thumbnail') or name.startswith('ppt/embeddings/'):
     issues.append((rel.as_posix()+'!'+name,'unapproved-embedded-content'))
    if name.endswith(('.xml','.rels')):
     text=data.decode('utf-8',errors='replace')
     for label,pattern in patterns.items():
      if pattern.search(text):issues.append((rel.as_posix()+'!'+name,label))
     if 'TargetMode="External"' in text and re.search(r'Target="(?:file:|[A-Za-z]:)',text):
      issues.append((rel.as_posix()+'!'+name,'external-local-path'))
     if name=='docProps/core.xml' and re.search(r'<(?:dc:creator|cp:lastModifiedBy)>[^<@]+@',text):
      issues.append((rel.as_posix()+'!'+name,'personal-author-email'))
 elif p.suffix.lower() not in {'.png','.svg'}:
  text=p.read_text(encoding='utf-8',errors='replace')
  for label,pattern in patterns.items():
   # The audit program documents these signatures itself; no secret matches are allowed elsewhere.
   if p.name!='audit-public.py' and pattern.search(text):issues.append((rel.as_posix(),label))
print(json.dumps({'files_checked':len(files),'findings':[{'file':f,'category':c} for f,c in issues]},ensure_ascii=False,indent=2))
sys.exit(1 if issues else 0)
