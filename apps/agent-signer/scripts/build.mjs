// Builds the Denaria Agent Signer as ONE file (ADR-0062 §2, agent-trading
// Stage 2 Q56): every dependency inside, Node builtins only outside, so
// running it installs nothing and runs no postinstall.
//
// Reproducible (ADR-0062 §17): the monorepo and the public repo it is
// published from build the same bytes from the same sources and the same
// dependency versions. esbuild names every bundled module by its path, in a
// comment and as the key of a CommonJS wrapper, and pnpm's store directory
// names carry peer suffixes that depend on what else is installed, so those
// paths are cut back to `node_modules/<pkg>`.
import { createHash } from 'node:crypto';
import { chmod, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

export const root = fileURLToPath(new URL('..', import.meta.url));
/** The one file, relative to the Signer's folder. */
export const BUNDLE = 'dist/denaria-agent-signer.mjs';
export const outfile = `${root}${BUNDLE}`;

/** `// ../../node_modules/.pnpm/viem@2.55.1_…/node_modules/viem/_esm/…` →
 *  `// node_modules/viem/_esm/…`, and `"../../node_modules/.pnpm/ajv@8.20.0/
 *  node_modules/ajv/dist/…"(exports)` → `"node_modules/ajv/dist/…"(exports)`;
 *  a hoisted `node_modules/` the same. Only a line's leading comment or
 *  wrapper key: no string the code reads. */
export function normalizeModulePaths(code) {
  return code.replace(
    /^(\s*(?:\/\/ |"))(?:\.\.\/)*node_modules\/(?:\.pnpm\/[^/\s"]+\/node_modules\/)?/gm,
    '$1node_modules/',
  );
}

export async function buildSigner() {
  const result = await build({
    absWorkingDir: root,
    entryPoints: ['src/main.ts'],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    // Readable on purpose: the one file is what a user audits.
    minify: false,
    legalComments: 'eof',
    logLevel: 'warning',
    banner: { js: '#!/usr/bin/env node' },
    metafile: true,
  });
  const code = normalizeModulePaths(await readFile(outfile, 'utf8'));
  await writeFile(outfile, code);
  await chmod(outfile, 0o755);
  return {
    outfile,
    metafile: result.metafile,
    sha256: createHash('sha256').update(code).digest('hex'),
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { sha256 } = await buildSigner();
  process.stdout.write(`dist/denaria-agent-signer.mjs sha256 ${sha256}\n`);
}
