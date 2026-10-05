// Checks imported material locally; prints neither key nor certificate contents.
const fs=require('node:fs'),crypto=require('node:crypto'),path=require('node:path');
const dir=process.argv[2];
const secret=fs.readFileSync(path.join(dir,'identity.pk8'));
try {
  const key=crypto.createPrivateKey({key:secret,format:'der',type:'pkcs8'});
  if(key.asymmetricKeyType!=='ec'||key.asymmetricKeyDetails.namedCurve!=='prime256v1')throw Error('Expected P-256');
  const publicKey=crypto.createPublicKey(key).export({format:'der',type:'spki'});
  if(!publicKey.equals(fs.readFileSync(path.join(dir,'public-key.der'))))throw Error('Certificate/key mismatch');
  console.log('Experimental P-256 identity matches certificate');
} finally { secret.fill(0); }
