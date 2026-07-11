import { createWriteStream, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'

export async function downloadQrImage(qrImageUrl, intent, options = {}) {
  if (!qrImageUrl) {
    throw new Error('Cannot download Denaria QR: qrImageUrl is missing')
  }

  const directory = resolve(options.directory || process.env.DENARIA_AGENT_QR_DIR || join(homedir(), '.denaria-agent', 'qr'))
  mkdirSync(directory, { recursive: true })

  const filename = buildQrFilename(intent)
  const outputPath = join(directory, filename)

  const response = await fetch(qrImageUrl)
  if (!response.ok || !response.body) {
    throw new Error(`Cannot download Denaria QR image: HTTP ${response.status}`)
  }

  await pipeline(Readable.fromWeb(response.body), createWriteStream(outputPath))
  return outputPath
}

export function markdownImagePath(filePath) {
  const normalized = filePath.replace(/\\/g, '/')
  return /^[A-Za-z]:\//.test(normalized) ? `/${normalized}` : normalized
}

function buildQrFilename(intent) {
  const market = safePart(intent.marketId || 'market')
  const side = safePart(intent.side || 'side')
  const collateral = safePart(intent.collateralAmount || 'amount')
  const asset = safePart(intent.collateralAsset || 'USDC')
  const leverage = safePart(`${intent.leverage || 'x'}x`)
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  return `denaria-${market}-${side}-${collateral}-${asset}-${leverage}-${stamp}-qr.png`.toLowerCase()
}

function safePart(value) {
  return String(value).replace(/[^a-z0-9-]+/gi, '-').replace(/^-+|-+$/g, '')
}
