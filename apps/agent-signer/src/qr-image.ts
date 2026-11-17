import { deflateSync } from 'node:zlib';
import qrcode from 'qrcode-generator';

/**
 * The connect link as a QR image, made on this computer (agent-trading
 * Stage 2 Q107): `connect` returns it as an MCP image, and `qr: "window"`
 * opens it in the system's viewer. Never a hosted image: the link's fragment
 * carries the key and stays off every server (ADR-0062 §10, Q58).
 *
 * The encoder is `qrcode-generator`, as for the text QR; the PNG writer is
 * the one of `apps/agent-service/src/qr.ts` (an 8-bit greyscale PNG is a
 * header, one IDAT of unfiltered rows and an IEND), with its own CRC-32 so it
 * runs on every Node 22 (`zlib.crc32` came in 22.2). Error correction L: the
 * code is shown, not printed, so the smallest version reads best.
 */

/** Fixed canvas, in pixels. */
export const QR_IMAGE_SIZE = 512;
/** Quiet zone, in modules, as the QR specification asks. */
export const QR_QUIET_MODULES = 4;
/** Longest link encoded; a connect or renew link is far below it. */
export const QR_MAX_PAYLOAD_LENGTH = 1024;

const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = (CRC_TABLE[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typed = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(typed), 0);
  return Buffer.concat([length, typed, checksum]);
}

function greyscalePng(pixels: Uint8Array, size: number): Uint8Array {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header.writeUInt8(8, 8); // bit depth
  header.writeUInt8(0, 9); // greyscale
  const raw = Buffer.alloc((size + 1) * size);
  for (let row = 0; row < size; row++) {
    // Each scanline starts with filter type 0 (None), already zero.
    Buffer.from(pixels.subarray(row * size, (row + 1) * size)).copy(raw, row * (size + 1) + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** The link as a black-on-white QR PNG of `QR_IMAGE_SIZE`² pixels. */
export function qrPng(link: string): Uint8Array {
  if (link.length === 0 || link.length > QR_MAX_PAYLOAD_LENGTH) {
    throw new RangeError('QR payload is out of bounds');
  }
  if (!/^[\x20-\x7e]+$/.test(link)) throw new RangeError('QR payload must be printable ASCII');
  const code = qrcode(0, 'L');
  code.addData(link, 'Byte');
  code.make();
  const modules = code.getModuleCount();
  const span = modules + QR_QUIET_MODULES * 2;
  const scale = Math.floor(QR_IMAGE_SIZE / span);
  if (scale < 1) throw new RangeError('QR payload does not fit the canvas');
  const origin = Math.floor((QR_IMAGE_SIZE - span * scale) / 2) + QR_QUIET_MODULES * scale;
  const pixels = new Uint8Array(QR_IMAGE_SIZE * QR_IMAGE_SIZE).fill(0xff);
  for (let row = 0; row < modules; row++) {
    for (let column = 0; column < modules; column++) {
      if (!code.isDark(row, column)) continue;
      const left = origin + column * scale;
      for (let y = origin + row * scale; y < origin + (row + 1) * scale; y++) {
        pixels.fill(0x00, y * QR_IMAGE_SIZE + left, y * QR_IMAGE_SIZE + left + scale);
      }
    }
  }
  return greyscalePng(pixels, QR_IMAGE_SIZE);
}
