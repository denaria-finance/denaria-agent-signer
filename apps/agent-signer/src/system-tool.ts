import { realpath, stat } from 'node:fs/promises';
import { SignerError } from './errors.js';

/**
 * The Linux tools the Signer runs, `secret-tool` (the keyring) and
 * `xdg-open` (the QR window), are found in fixed system directories, never
 * through PATH (agent-trading Stage 2 Q149): `npx` puts the `node_modules/.bin`
 * of the working directory and of every folder above it first on PATH, so a
 * project the agent opens could otherwise answer as the keyring. The file must
 * be root's and only root may change it. macOS and Windows already run their
 * tools by full path.
 *
 * The tool gets a fixed PATH and only the variables it needs to reach the
 * user's session, never the Signer's own environment (the file store's
 * passphrase is there).
 */

/** In this order: the distributions' own, then a local install, then NixOS. */
export const SYSTEM_TOOL_DIRS = [
  '/usr/bin',
  '/bin',
  '/usr/local/bin',
  '/run/current-system/sw/bin',
] as const;

/** The PATH a tool runs with: `xdg-open` is a shell script that runs other
 *  tools by name, and GLib searches `/bin:/usr/bin:.` when PATH is unset. */
export const SYSTEM_TOOL_PATH = SYSTEM_TOOL_DIRS.join(':');

/** What `secret-tool` reads to reach the Secret Service: the session bus
 *  (GDBus: `DBUS_SESSION_BUS_ADDRESS`, else `$XDG_RUNTIME_DIR/bus`), the home
 *  (GLib's home directory) and the locale, which GOption needs to read a
 *  non-ASCII Agent name from argv. */
export const SECRET_TOOL_ENV = [
  'HOME',
  'LANG',
  'LC_*',
  'DBUS_SESSION_BUS_ADDRESS',
  'XDG_RUNTIME_DIR',
] as const;

/** What `xdg-open` and the viewer it starts read besides: the display (X11
 *  with its cookie, Wayland), the desktop it picks the opener by
 *  (`KDE_SESSION_VERSION` chooses kde-open on Plasma), the session type a Qt
 *  viewer picks its backend by, and where the MIME and desktop entries are. */
export const XDG_OPEN_ENV = [
  ...SECRET_TOOL_ENV,
  'DISPLAY',
  'WAYLAND_DISPLAY',
  'XAUTHORITY',
  'XDG_CURRENT_DESKTOP',
  'XDG_SESSION_TYPE',
  'KDE_SESSION_VERSION',
  'XDG_DATA_DIRS',
  'XDG_CONFIG_DIRS',
  'XDG_DATA_HOME',
  'XDG_CONFIG_HOME',
] as const;

/** The environment of a tool: the names in `keep` (`LC_*`: every locale
 *  category) that are set in `from`, and the fixed PATH. */
export function systemToolEnv(
  keep: readonly string[],
  from: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { PATH: SYSTEM_TOOL_PATH };
  const locale = keep.includes('LC_*');
  for (const [name, value] of Object.entries(from)) {
    if (value === undefined || name === 'PATH') continue;
    if (keep.includes(name) || (locale && /^LC_[A-Z]+$/.test(name))) env[name] = value;
  }
  return env;
}

/** The two calls of the lookup, injected so it is tested on any system. */
export type SystemToolFs = {
  realpath(path: string): Promise<string>;
  stat(path: string): Promise<{ uid: number; mode: number; isFile(): boolean }>;
};

const nodeFs: SystemToolFs = { realpath: (path) => realpath(path), stat: (path) => stat(path) };

/** A tool found in a fixed directory that the Signer will not run. */
export class UnsafeSystemToolError extends SignerError {
  constructor(
    /** The file checked, and the link that named it when it is not the file. */
    readonly path: string,
    readonly reason: string,
  ) {
    super(
      `The Denaria Agent Signer did not run ${path} because ${reason}: it runs a system tool only when root owns it and neither group nor others can write it.`,
    );
  }
}

const NOT_THERE = new Set(['ENOENT', 'ENOTDIR']);

/**
 * The absolute path of `name` in the first fixed directory that has it, after
 * its links: null when none has it. The first file found must be a regular
 * file root owns that neither group nor others can write, or the lookup fails
 * (UnsafeSystemToolError) instead of trying the next directory.
 */
export async function findSystemTool(
  name: string,
  fs: SystemToolFs = nodeFs,
): Promise<string | null> {
  for (const dir of SYSTEM_TOOL_DIRS) {
    const candidate = `${dir}/${name}`;
    let real: string;
    let file: Awaited<ReturnType<SystemToolFs['stat']>>;
    try {
      real = await fs.realpath(candidate);
    } catch (error) {
      if (NOT_THERE.has((error as NodeJS.ErrnoException).code ?? '')) continue;
      throw new UnsafeSystemToolError(candidate, 'it could not be checked');
    }
    const named = real === candidate ? candidate : `${real} (linked from ${candidate})`;
    try {
      file = await fs.stat(real);
    } catch {
      throw new UnsafeSystemToolError(named, 'it could not be checked');
    }
    if (!file.isFile()) throw new UnsafeSystemToolError(named, 'it is not a regular file');
    if (file.uid !== 0) throw new UnsafeSystemToolError(named, 'root does not own it');
    if ((file.mode & 0o022) !== 0) {
      throw new UnsafeSystemToolError(named, 'group or others can write it');
    }
    return real;
  }
  return null;
}
