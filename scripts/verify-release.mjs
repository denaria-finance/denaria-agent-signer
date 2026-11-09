// Checks that this repository builds the very file Denaria built and reviewed
// (RELEASE.json, written by the export from Denaria's monorepo): the same
// sha256, the same version in RELEASE.json, the Signer's package.json, the
// file's own --version and, for a release, the tag. The release workflow runs
// it after the build and before anything is published; any difference stops
// the release.
//
//   node scripts/verify-release.mjs [v<version>]
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const release = JSON.parse(await readFile(`${root}RELEASE.json`, 'utf8'));
const manifest = JSON.parse(await readFile(`${root}apps/agent-signer/package.json`, 'utf8'));
const bundle = await readFile(`${root}${release.bundle}`);

const problems = [];
const sha256 = createHash('sha256').update(bundle).digest('hex');
if (sha256 !== release.sha256) {
  problems.push(`the build is ${sha256}, RELEASE.json says ${release.sha256}`);
}
if (manifest.version !== release.version) {
  problems.push(`apps/agent-signer is ${manifest.version}, RELEASE.json says ${release.version}`);
}
const printed = execFileSync(process.execPath, [`${root}${release.bundle}`, '--version'])
  .toString()
  .trim();
if (printed !== release.version) {
  problems.push(`the file says it is ${printed}, RELEASE.json says ${release.version}`);
}
const tag = process.argv[2];
if (tag !== undefined && tag !== `v${release.version}`) {
  problems.push(`the tag is ${tag}, the release is v${release.version}`);
}

if (problems.length > 0) {
  process.stderr.write(`Not the release Denaria built:\n- ${problems.join('\n- ')}\n`);
  process.exit(1);
}
process.stdout.write(`${release.package}@${release.version} sha256 ${sha256}: verified\n`);
