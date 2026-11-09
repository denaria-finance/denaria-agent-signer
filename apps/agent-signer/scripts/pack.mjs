// The npm package of the Denaria Agent Signer (ADR-0062 §17): the one built
// file, its README and licence, and a manifest with no dependencies and no
// scripts, so `npx @denaria/agent-signer@<v>` downloads one tarball, installs
// nothing else and runs nothing at install. The repository is the public one
// the package is published from with provenance; npm checks it matches.
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BUNDLE } from './build.mjs';

export { BUNDLE };

/** Where the Signer is published from (owner 2026-11-09, option A). npm's
 *  provenance check compares it, case-sensitive, with the repository that
 *  ran the publish. */
export const PUBLIC_REPOSITORY = 'denaria-finance/denaria-agent-signer';

const signerRoot = fileURLToPath(new URL('..', import.meta.url));

/** The manifest npm publishes, from the build manifest's identity. */
export function publishManifest(buildManifest) {
  return {
    name: buildManifest.name,
    version: buildManifest.version,
    description: buildManifest.description,
    license: 'MIT',
    type: 'module',
    bin: { 'denaria-agent-signer': BUNDLE },
    files: [BUNDLE],
    engines: buildManifest.engines,
    repository: {
      type: 'git',
      url: `git+https://github.com/${PUBLIC_REPOSITORY}.git`,
      directory: 'apps/agent-signer',
    },
    homepage: `https://github.com/${PUBLIC_REPOSITORY}#readme`,
    bugs: { url: `https://github.com/${PUBLIC_REPOSITORY}/issues` },
    keywords: ['denaria', 'mcp', 'mcp-server', 'ai-agent', 'gmx', 'session-key'],
  };
}

/** Writes the package to `outDir`: package.json, README.md, LICENSE and the bundle. */
export async function packSigner({ outDir, readme, license }) {
  const buildManifest = JSON.parse(await readFile(join(signerRoot, 'package.json'), 'utf8'));
  await mkdir(join(outDir, 'dist'), { recursive: true });
  await writeFile(
    join(outDir, 'package.json'),
    `${JSON.stringify(publishManifest(buildManifest), null, 2)}\n`,
  );
  await copyFile(readme, join(outDir, 'README.md'));
  await copyFile(license, join(outDir, 'LICENSE'));
  await copyFile(join(signerRoot, BUNDLE), join(outDir, BUNDLE));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const outDir = process.argv[2];
  if (!outDir) throw new Error('usage: node scripts/pack.mjs <out dir>');
  // In the public repo: its README and licence at the root.
  await packSigner({
    outDir,
    readme: join(signerRoot, '../../README.md'),
    license: join(signerRoot, '../../LICENSE'),
  });
}
