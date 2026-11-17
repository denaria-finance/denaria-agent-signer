import { lstat, mkdir, open } from 'node:fs/promises';
import { join } from 'node:path';
import { SignerError } from '../errors.js';

/**
 * Which rotation of a slot a `replace` claims (agent-trading Stage 2 Q125):
 * the one away from the key the caller loaded, named by that key's
 * fingerprint (`XXXX-XXXX`). Every Signer process that found the same key
 * revoked asks for the same name, and only one creates it, so one new key
 * replaces it. Attempt 0 first; the next attempt only after the key the
 * claim before it promised did not appear (its Signer stopped half-way).
 */
export type RotationClaim = { from: string; attempt: number };

/** Claims of one old key a connect tries before it gives up. */
export const MAX_ROTATION_ATTEMPTS = 8;

const FINGERPRINT = /^[0-9A-Z]{4}-[0-9A-Z]{4}$/;

/** `<item>.replaced-<fingerprint>`, then `.1`, `.2`… for a later attempt.
 *  `item` is the slot's own file name, or the slot and the keyring's kind. */
export function rotationClaimName(item: string, claim: RotationClaim): string {
  if (
    !FINGERPRINT.test(claim.from) ||
    !Number.isInteger(claim.attempt) ||
    claim.attempt < 0 ||
    claim.attempt >= MAX_ROTATION_ATTEMPTS
  ) {
    throw new Error('Invalid rotation claim');
  }
  return `${item}.replaced-${claim.from}${claim.attempt === 0 ? '' : `.${claim.attempt}`}`;
}

/**
 * Claims a rotation with an empty file in the Signer's home, created
 * exclusively: true when this call made it, false when another process had.
 * The home and not the agent index, which can be deleted and rebuilt: a claim
 * lost with it would let a Signer that loaded the old key rotate it again.
 * An exclusive create is atomic on every file system the Signer runs on
 * (NTFS included) and leaves nothing to expire.
 */
export async function claimRotation(
  home: string,
  item: string,
  claim: RotationClaim,
): Promise<boolean> {
  const path = join(home, rotationClaimName(item, claim));
  await mkdir(home, { recursive: true, mode: 0o700 });
  try {
    await (await open(path, 'wx', 0o600)).close();
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw error;
  }
}

/**
 * When a rotation was claimed (Q135), in milliseconds since the epoch, or
 * null when no one claimed it. The inode's change time: a marker's creation,
 * or the moment the file store's hard link was made (its modification time is
 * the old key file's own).
 */
export async function rotationClaimTime(
  home: string,
  item: string,
  claim: RotationClaim,
): Promise<number | null> {
  try {
    return (await lstat(join(home, rotationClaimName(item, claim)))).ctimeMs;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

/** `claimRotation` for a keyring store, whose claim is only this marker: a
 *  claim that cannot be written replaces nothing. */
export async function claimKeyringRotation(
  home: string,
  item: string,
  claim: RotationClaim,
): Promise<boolean> {
  try {
    return await claimRotation(home, item, claim);
  } catch {
    throw new SignerError(
      `The rotation of the key could not be recorded in ${home}, so the key was not replaced. Try again.`,
    );
  }
}
