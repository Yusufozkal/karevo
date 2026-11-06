'use strict';
// Public installer transport only. No signing material is read or published.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const crypto = require('node:crypto'), { execFileSync } = require('node:child_process');
const repo = 'Yusufozkal/karevo', tag = 'karevo-v3.2.3-preview';
const expected = new Map([
  ['Karevo-3.2.3-Setup.exe', 256 * 1024 * 1024],
  ['Karevo-3.1.3-Android.apk', 64 * 1024 * 1024]
]);
const sha256 = b => crypto.createHash('sha256').update(b).digest('hex');
function check(condition, message) { if (!condition) throw new Error(message); }
function fields(value, names, message) {
  check(value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === names.length && names.every(k => Object.hasOwn(value, k)), message);
}
function gh(args, maxBuffer = 1024 * 1024) { return execFileSync('gh', args, { encoding: null, maxBuffer, stdio: ['ignore', 'pipe', 'pipe'], timeout: 180000 }); }
function api(endpoint, maxBuffer, accept) {
  const args = ['api', `repos/${repo}/${endpoint}`];
  if (accept) args.push('-H', `Accept: ${accept}`);
  return gh(args, maxBuffer);
}
function validatePlan(p) {
  fields(p, ['schema', 'repository', 'releaseId', 'tag', 'assets'], 'Invalid plan fields');
  check(p.schema === 'karevo-preview-upload-v2' && p.repository === repo && Number.isSafeInteger(p.releaseId) && p.releaseId > 0 && p.tag === tag, 'Invalid plan identity');
  check(Array.isArray(p.assets) && p.assets.length === expected.size, 'Exactly the Windows installer and Android APK are required');
  const names = new Set();
  for (const item of p.assets) {
    fields(item, ['fileName', 'bytes', 'sha256', 'chunks'], 'Invalid asset fields');
    check(expected.has(item.fileName) && !names.has(item.fileName), 'Unexpected or duplicate asset filename'); names.add(item.fileName);
    check(Number.isSafeInteger(item.bytes) && item.bytes > 0 && item.bytes <= expected.get(item.fileName) && /^[a-f0-9]{64}$/.test(item.sha256), 'Invalid asset metadata');
    check(Array.isArray(item.chunks) && item.chunks.length > 0 && item.chunks.length <= 32, 'Invalid chunks');
    let total = 0;
    for (const chunk of item.chunks) {
      fields(chunk, ['sha', 'bytes', 'sha256'], 'Invalid chunk fields');
      check(Number.isSafeInteger(chunk.bytes) && chunk.bytes > 0 && chunk.bytes <= 8388608 && /^[a-f0-9]{40}$/.test(chunk.sha) && /^[a-f0-9]{64}$/.test(chunk.sha256), 'Invalid chunk metadata');
      total += chunk.bytes;
    }
    check(total === item.bytes, 'Chunk lengths do not match asset');
  }
  return p;
}
function assetMatches(asset, item) {
  check(asset.name === item.fileName && asset.state === 'uploaded' && asset.size === item.bytes && asset.digest === `sha256:${item.sha256}`, 'Existing or uploaded asset verification failed');
}
function main() {
  check(process.env.GITHUB_REPOSITORY === repo && process.env.GITHUB_REF === 'refs/heads/main', 'Unexpected repository or branch');
  const p = validatePlan(JSON.parse(fs.readFileSync(path.join(__dirname, 'karevo-preview-plan.json'), 'utf8')));
  const release = () => {
    const r = JSON.parse(api(`releases/${p.releaseId}`).toString('utf8'));
    check(r.id === p.releaseId && r.tag_name === tag && r.draft === true && r.prerelease === true, 'Refusing to alter a different or published release');
    check(Array.isArray(r.assets) && r.assets.length <= expected.size && new Set(r.assets.map(a => a.name)).size === r.assets.length, 'Unexpected or duplicate existing assets');
    for (const asset of r.assets) {
      const item = p.assets.find(i => i.fileName === asset.name);
      check(item, 'Unexpected existing release asset'); assetMatches(asset, item);
    }
    return r;
  };
  release();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'karevo-preview-')); fs.chmodSync(tmp, 0o700);
  try {
    for (const item of p.assets) {
      const output = path.join(tmp, item.fileName), fd = fs.openSync(output, 'wx', 0o600), full = crypto.createHash('sha256');
      try {
        for (const [i, chunk] of item.chunks.entries()) {
          const bytes = api(`git/blobs/${chunk.sha}`, 8388608 + 65536, 'application/vnd.github.raw+json');
          const git = crypto.createHash('sha1').update(Buffer.from(`blob ${bytes.length}\0`)).update(bytes).digest('hex');
          check(bytes.length === chunk.bytes && sha256(bytes) === chunk.sha256 && git === chunk.sha, `Chunk ${i + 1} failed verification`);
          fs.writeFileSync(fd, bytes); full.update(bytes); console.log(`Verified ${item.fileName} chunk ${i + 1}/${item.chunks.length}`);
        }
        fs.fsyncSync(fd);
      } finally { fs.closeSync(fd); }
      check(fs.statSync(output).size === item.bytes && full.digest('hex') === item.sha256, 'Reconstructed asset mismatch');
    }
    for (const item of p.assets) {
      const r = release();
      if (!r.assets.some(a => a.name === item.fileName)) {
        const asset = JSON.parse(gh(['api', '--method', 'POST', `https://uploads.github.com/repos/${repo}/releases/${p.releaseId}/assets?name=${encodeURIComponent(item.fileName)}`, '-H', 'Content-Type: application/octet-stream', '--input', path.join(tmp, item.fileName)]).toString('utf8'));
        assetMatches(asset, item);
      }
    }
    const r = release(); check(r.assets.length === expected.size, 'Incomplete final release asset set');
    console.log(JSON.stringify({ releaseId: p.releaseId, tag, verified: true, draft: true, prerelease: true, published: false, assets: p.assets.map(i => i.fileName) }));
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}
if (require.main === module) { try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; } }
module.exports = { validatePlan };
