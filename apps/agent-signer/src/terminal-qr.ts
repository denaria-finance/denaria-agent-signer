import qrcode from 'qrcode-generator';

/**
 * The connect link as a QR made of text, for the terminal the agent runs in.
 * The encoder is `qrcode-generator`, as in `apps/agent-service`; its
 * half-block rendering draws two modules per line and paints the light
 * modules, which reads on the usual dark terminal (phone cameras also read
 * the inverted code). Four modules of quiet zone, as the QR spec asks.
 * Error correction L (Q107): the fewest modules, so the fewest characters for
 * the agent to repeat and the largest modules for the camera.
 */
export function terminalQr(link: string): string {
  const code = qrcode(0, 'L');
  code.addData(link, 'Byte');
  code.make();
  return code.createASCII(1, 4);
}
