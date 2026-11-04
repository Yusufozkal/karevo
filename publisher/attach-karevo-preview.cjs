'use strict';
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const crypto = require('node:crypto'), { execFileSync } = require('node:child_process');
const repo = 'Yusufozkal/bulten-guncellemeler';
const sha256 = b => crypto.createHash('sha256').update(b).digest('hex');
function check(condition, message) { if (!condition) throw new Error(message); }
function gh(args, maxBuffer=1024*1024) { return execFileSync('gh', args, {encoding:null, maxBuffer, stdio:['ignore','pipe','pipe'],timeout:180000}); }
function api(endpoint, maxBuffer, accept) {
  const args=['api',`repos/${repo}/${endpoint}`];
  if (accept) args.push('-H',`Accept: ${accept}`);
  return gh(args,maxBuffer);
}
function main() {
  check(process.env.GITHUB_REPOSITORY===repo && process.env.GITHUB_REF==='refs/heads/main','Unexpected repository or branch');
  const p=JSON.parse(fs.readFileSync(path.join(__dirname,'karevo-preview-plan.json'),'utf8'));
  check(p.schema==='karevo-preview-upload-v1' && p.repository===repo && Number.isSafeInteger(p.releaseId) && p.releaseId>0,'Invalid plan identity');
  check(p.tag==='karevo-v3.2.2-preview' && p.installer.fileName==='Karevo-3.2.2-Setup.exe','Unexpected tag or filename');
  check(Number.isSafeInteger(p.installer.bytes) && p.installer.bytes>0 && p.installer.bytes<=256*1024*1024 && /^[a-f0-9]{64}$/.test(p.installer.sha256),'Invalid installer metadata');
  check(Array.isArray(p.chunks) && p.chunks.length>0 && p.chunks.length<=32,'Invalid chunks');
  let total=0;
  for(const c of p.chunks) { check(Number.isSafeInteger(c.bytes) && c.bytes>0 && c.bytes<=8388608 && /^[a-f0-9]{40}$/.test(c.sha) && /^[a-f0-9]{64}$/.test(c.sha256),'Invalid chunk metadata'); total+=c.bytes; }
  check(total===p.installer.bytes,'Chunk lengths do not match installer');
  const release=()=>{
    const r=JSON.parse(api(`releases/${p.releaseId}`).toString('utf8'));
    check(r.id===p.releaseId && r.tag_name===p.tag && r.draft===true && r.prerelease===true,'Refusing to alter a different or published release');
    check(Array.isArray(r.assets) && r.assets.length<=1 && r.assets.every(a=>a.name===p.installer.fileName),'Unexpected existing release assets');
    return r;
  };
  release();
  const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'karevo-preview-')); fs.chmodSync(tmp,0o700);
  try {
    const output=path.join(tmp,p.installer.fileName), fd=fs.openSync(output,'wx',0o600), full=crypto.createHash('sha256');
    try { for(const [i,c] of p.chunks.entries()) {
      const bytes=api(`git/blobs/${c.sha}`,8388608+65536,'application/vnd.github.raw+json');
      const git=crypto.createHash('sha1').update(Buffer.from(`blob ${bytes.length}\0`)).update(bytes).digest('hex');
      check(bytes.length===c.bytes && sha256(bytes)===c.sha256 && git===c.sha,`Chunk ${i+1} failed verification`);
      fs.writeFileSync(fd,bytes); full.update(bytes); console.log(`Verified chunk ${i+1}/${p.chunks.length}`);
    } fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    check(fs.statSync(output).size===p.installer.bytes && full.digest('hex')===p.installer.sha256,'Installer mismatch');
    let r=release(), asset=r.assets[0];
    if(!asset) {
      asset=JSON.parse(gh(['api','--method','POST',`https://uploads.github.com/repos/${repo}/releases/${p.releaseId}/assets?name=${encodeURIComponent(p.installer.fileName)}`,'-H','Content-Type: application/octet-stream','--input',output]).toString('utf8'));
    }
    check(asset.name===p.installer.fileName && asset.state==='uploaded' && asset.size===p.installer.bytes && asset.digest===`sha256:${p.installer.sha256}`,'Uploaded asset verification failed');
    r=release(); check(r.assets.length===1 && r.assets[0].digest===`sha256:${p.installer.sha256}`,'Release asset verification failed');
    console.log(JSON.stringify({releaseId:p.releaseId,tag:p.tag,verified:true,draft:true,prerelease:true,published:false}));
  } finally { fs.rmSync(tmp,{recursive:true,force:true}); }
}
try { main(); } catch(error) { console.error(error.message); process.exitCode=1; }
