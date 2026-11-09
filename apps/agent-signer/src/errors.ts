/**
 * An error whose message is written for the user and safe to show in a tool
 * answer: it never carries key material. Anything else that throws is
 * reported without its message.
 */
export class SignerError extends Error {
  override readonly name = 'SignerError';
}
