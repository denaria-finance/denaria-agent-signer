import { type SpawnOptions, spawn } from 'node:child_process';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  findSystemTool,
  type SystemToolFs,
  systemToolEnv,
  UnsafeSystemToolError,
  XDG_OPEN_ENV,
} from './system-tool.js';

/**
 * `connect` with `qr: "window"` (agent-trading Stage 2 Q107): for a client
 * that shows neither the image nor a code block the phone can read, the QR is
 * saved under the Signer's home and opened in the system's image viewer. The
 * file is the user's own, 0600 in a 0700 folder; it is the same link the
 * answer gives, so nothing leaves the computer (ADR-0062 §10, Q58).
 *
 * The viewer is started with an argument array and no shell (a home path
 * with `&` or quotes stays one argument), detached, and not waited for: the
 * answer returns as soon as the viewer has started.
 */

export type QrOpener = (path: string) => Promise<void>;

export type ShownQr =
  | { opened: true; path: string }
  | { opened: false; path: string | null; why: string };

export type QrWindow = (slot: string, png: Uint8Array) => Promise<ShownQr>;

const SLOT = /^[a-z0-9][a-z0-9-]{0,63}$/;

export type OpenerOptions = {
  systemRoot?: string;
  /** Where xdg-open is looked up: the real file system but in tests. */
  fs?: SystemToolFs;
  /** The Signer's environment, from which xdg-open gets what it needs. */
  env?: NodeJS.ProcessEnv;
};

/** How each system opens a file with its default app. Windows: Explorer,
 *  not `start`, which is a `cmd` built-in and would need a shell. Elsewhere
 *  xdg-open from a fixed system directory, with its own environment and
 *  never the Signer's (it holds the file store's passphrase; Q149). */
export async function openerCommand(
  platform: NodeJS.Platform,
  path: string,
  options: OpenerOptions = {},
): Promise<{ file: string; args: string[]; env?: NodeJS.ProcessEnv }> {
  if (platform === 'darwin') return { file: '/usr/bin/open', args: [path] };
  if (platform === 'win32') {
    const systemRoot = options.systemRoot ?? process.env.SystemRoot ?? 'C:\\Windows';
    return { file: `${systemRoot}\\explorer.exe`, args: [path] };
  }
  const file = await findSystemTool('xdg-open', options.fs);
  if (file === null) {
    throw Object.assign(new Error('xdg-open is not installed'), { code: 'ENOENT' });
  }
  return { file, args: [path], env: systemToolEnv(XDG_OPEN_ENV, options.env) };
}

type Spawn = (
  file: string,
  args: readonly string[],
  options: SpawnOptions,
) => {
  once(event: 'spawn', listener: () => void): unknown;
  once(event: 'error', listener: (error: Error) => void): unknown;
  unref(): void;
};

export function systemQrOpener(
  platform: NodeJS.Platform,
  run: Spawn = spawn,
  options: OpenerOptions = {},
): QrOpener {
  return async (path) => {
    const { file, args, env } = await openerCommand(platform, path, options);
    await new Promise<void>((resolve, reject) => {
      const child = run(file, args, {
        detached: true,
        stdio: 'ignore',
        shell: false,
        ...(env === undefined ? {} : { env }),
      });
      child.once('spawn', () => {
        child.unref();
        resolve();
      });
      child.once('error', reject);
    });
  };
}

export function qrWindow(options: { home: string; open: QrOpener }): QrWindow {
  const folder = join(options.home, 'qr');
  return async (slot, png) => {
    if (!SLOT.test(slot)) throw new Error('Invalid key slot');
    const path = join(folder, `${slot}.png`);
    try {
      await mkdir(folder, { recursive: true, mode: 0o700 });
      await writeFile(path, png, { mode: 0o600 });
      // An older file keeps the mode it was made with.
      await chmod(path, 0o600);
    } catch (error) {
      return { opened: false, path: null, why: `the image could not be saved (${codeOf(error)})` };
    }
    try {
      await options.open(path);
      return { opened: true, path };
    } catch (error) {
      if (error instanceof UnsafeSystemToolError) {
        return {
          opened: false,
          path,
          why: `${error.path} was not started because ${error.reason}`,
        };
      }
      return { opened: false, path, why: `no image viewer could be started (${codeOf(error)})` };
    }
  };
}

/** The error's code only: its message may carry anything. */
function codeOf(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return typeof code === 'string' && /^[A-Z0-9_]{1,32}$/.test(code) ? code : 'unexpected error';
}
