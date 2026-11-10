import { z } from 'zod';
import { SignerError } from '../errors.js';
import type { ToolRunner } from './run-tool.js';
import { sealedFileKeyStore } from './sealed-file.js';
import { FILE_STORE_HINT, type KeyStore } from './types.js';

/**
 * The Windows store: the secret sealed by DPAPI for the current Windows user
 * (`ProtectedData.Protect`, scope CurrentUser), through Windows PowerShell,
 * no native module (agent-trading Stage 2 Q57). DPAPI keeps no item, so the
 * sealed blob is a file, `<home>\<slot>.dpapi`, with the sealed-file rules
 * (written once, rotated aside). Only the same user on the same computer opens
 * it; the entropy binds a blob to its slot.
 *
 * Both scripts are constant and read everything from stdin, one line each:
 * the entropy, then the secret or the blob. The secret is never in a process
 * argument, and the script is passed encoded so no quoting is involved.
 */

const PREAMBLE = [
  "$ErrorActionPreference = 'Stop'",
  'Add-Type -AssemblyName System.Security',
  '$entropy = [Text.Encoding]::UTF8.GetBytes([Console]::In.ReadLine())',
  '$scope = [Security.Cryptography.DataProtectionScope]::CurrentUser',
];

export const DPAPI_PROTECT_SCRIPT = [
  ...PREAMBLE,
  '$data = [Text.Encoding]::UTF8.GetBytes([Console]::In.ReadLine())',
  '$sealed = [Security.Cryptography.ProtectedData]::Protect($data, $entropy, $scope)',
  '[Console]::Out.Write([Convert]::ToBase64String($sealed))',
].join('\n');

export const DPAPI_UNPROTECT_SCRIPT = [
  ...PREAMBLE,
  '$data = [Convert]::FromBase64String([Console]::In.ReadLine())',
  '$plain = [Security.Cryptography.ProtectedData]::Unprotect($data, $entropy, $scope)',
  '[Console]::Out.Write([Text.Encoding]::UTF8.GetString($plain))',
].join('\n');

/** Windows PowerShell 5.1, on every Windows since 10: by its full path. */
export function windowsPowerShellPath(systemRoot = process.env.SystemRoot ?? 'C:\\Windows') {
  return `${systemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
}

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

/** Version 1 is the 0.1.0 blob; version 2 adds the clear slot and metadata
 *  (sealed-file.ts). */
const blobSchema = z
  .object({
    version: z.union([z.literal(1), z.literal(2)]),
    env: z.string(),
    slot: z.string().optional(),
    agent: z.unknown().optional(),
    scope: z.literal('CurrentUser'),
    protected: z.string().regex(BASE64),
  })
  .strict();

/** Binds a blob to its slot; the 0.1.0 slot is the Env, so its entropy is unchanged. */
const entropyOf = (slot: string) => `denaria-agent-signer/dpapi/v1/${slot}`;

export function dpapiKeyStore(options: {
  home: string;
  run: ToolRunner;
  powershell: string;
}): KeyStore {
  const runScript = async (script: string, lines: readonly string[]) => {
    try {
      return await options.run(
        options.powershell,
        [
          '-NoLogo',
          '-NoProfile',
          '-NonInteractive',
          '-EncodedCommand',
          Buffer.from(script, 'utf16le').toString('base64'),
        ],
        lines.map((line) => `${line}\n`).join(''),
      );
    } catch {
      throw new SignerError(
        `Windows PowerShell (${options.powershell}) could not be started, so DPAPI cannot protect the key. Try again, or ${FILE_STORE_HINT}.`,
      );
    }
  };

  return sealedFileKeyStore({
    home: options.home,
    extension: 'dpapi',
    describe: (path) => `a file Windows DPAPI protects for this user, ${path}`,
    sealer: {
      async seal(slot, secret) {
        // Never echo PowerShell's output into an error.
        const result = await runScript(DPAPI_PROTECT_SCRIPT, [entropyOf(slot), secret]);
        const sealed = result.stdout.trim();
        if (result.code !== 0 || !BASE64.test(sealed)) {
          throw new SignerError(
            `Windows DPAPI could not protect the key (PowerShell exited with ${result.code ?? 'a signal'}). Try again, or ${FILE_STORE_HINT}.`,
          );
        }
        return { scope: 'CurrentUser', protected: sealed };
      },

      async open(slot, raw, path) {
        let blob: z.infer<typeof blobSchema>;
        try {
          blob = blobSchema.parse(raw);
        } catch {
          throw new SignerError(
            `${path} is not a Denaria Agent Signer key file this version can read. It was left untouched.`,
          );
        }
        const result = await runScript(DPAPI_UNPROTECT_SCRIPT, [entropyOf(slot), blob.protected]);
        if (result.code !== 0 || result.stdout === '') {
          throw new SignerError(
            `Windows DPAPI does not open ${path}: it was protected for another Windows user or computer, or for another Env or key. The file was left untouched.`,
          );
        }
        return result.stdout;
      },
    },
  });
}
