#!/usr/bin/env node
import { createWriteStream, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

const MCP_ENDPOINT = process.env.DENARIA_MCP_ENDPOINT || 'https://mcp.denaria.finance/mcp'
const PROTOCOL_VERSION = '2025-03-26'

async function main() {
  const raw = parseArgs(process.argv.slice(2))
  const intent = normalizeIntent(raw)
  const client = new RemoteMcpClient(MCP_ENDPOINT)
  const toolResult = await client.callTool('denaria_prepare_create_position', intent)
  const remote = unwrapToolResult(toolResult)
  const display = extractDisplay(remote)

  if (!display.qrImageUrl) {
    throw new Error('Denaria MCP response did not include qrImageUrl')
  }

  const qrLocalPath = await downloadQrImage(display.qrImageUrl, intent)
  const qrMarkdown = `![Denaria QR](${markdownImagePath(qrLocalPath)})`

  const result = {
    status: 'prepared',
    actionType: 'create_position',
    intent,
    qrLocalPath,
    qrMarkdown,
    qrImageUrl: display.qrImageUrl,
    qrPageUrl: display.qrPageUrl,
    nextStep: display.nextStep || 'Open Denaria App/PWA and scan the QR to review and sign the transaction.',
    summary: display.summaryMarkdown || summarizeIntent(intent),
    officialMcpEndpoint: MCP_ENDPOINT,
    displayInstruction: 'Render qrMarkdown first. Do not use qrImageUrl as the primary image when qrLocalPath is present.',
  }

  console.log(JSON.stringify(result, null, 2))
}

class RemoteMcpClient {
  constructor(endpoint) {
    this.endpoint = endpoint
    this.sessionId = null
    this.nextId = 1
  }

  async initialize() {
    const response = await this.request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'denaria-action-handoff-skill', version: '0.1.0' },
    }, { allowNoSession: true })

    await this.notify('notifications/initialized', {})
    return response
  }

  async callTool(name, args = {}) {
    if (!this.sessionId) await this.initialize()
    return this.request('tools/call', { name, arguments: args })
  }

  async notify(method, params = {}) {
    await fetch(this.endpoint, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ jsonrpc: '2.0', method, params }),
    }).catch(() => null)
  }

  async request(method, params = {}, options = {}) {
    const response = await fetch(this.endpoint, {
      method: 'POST',
      headers: this.headers(options),
      body: JSON.stringify({ jsonrpc: '2.0', id: this.nextId++, method, params }),
    })

    const session = response.headers.get('mcp-session-id')
    if (session) this.sessionId = session

    if (!response.ok) {
      throw new Error(`Denaria MCP ${method} failed with HTTP ${response.status}: ${await response.text()}`)
    }

    const payload = await parseMcpHttpResponse(response)
    if (payload?.error) {
      throw new Error(`Denaria MCP ${method} error: ${JSON.stringify(payload.error)}`)
    }
    return payload?.result ?? payload
  }

  headers(options = {}) {
    const headers = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    }
    if (this.sessionId && !options.allowNoSession) headers['mcp-session-id'] = this.sessionId
    return headers
  }
}

async function parseMcpHttpResponse(response) {
  const contentType = response.headers.get('content-type') || ''
  const text = await response.text()
  if (contentType.includes('text/event-stream')) return parseSseJson(text)
  if (!text.trim()) return null
  return JSON.parse(text)
}

function parseSseJson(text) {
  const dataLines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trim())
    .filter((line) => line && line !== '[DONE]')

  if (dataLines.length === 0) return null
  return JSON.parse(dataLines[dataLines.length - 1])
}

function parseArgs(args) {
  const out = {}
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]
    if (!arg.startsWith('--')) continue
    const key = arg.slice(2)
    const next = args[i + 1]
    if (next && !next.startsWith('--')) {
      out[key] = next
      i += 1
    } else {
      out[key] = true
    }
  }
  return out
}

function normalizeIntent(input = {}) {
  const marketId = normalizeMarket(input.marketId || input.market || input.asset || input.assetTicker)
  const side = normalizeSide(input.side)
  const collateralAmount = normalizeAmount(input.collateralAmount || input.collateral || input.amount || input.usdc)
  const collateralAsset = normalizeCollateral(input.collateralAsset || input.assetCollateral || 'USDC')
  const leverage = normalizeLeverage(input.leverage || input.lev)

  const missing = []
  if (!marketId) missing.push('marketId')
  if (!side) missing.push('side')
  if (!collateralAmount) missing.push('collateralAmount')
  if (!leverage) missing.push('leverage')
  if (missing.length > 0) {
    const error = new Error(`Missing required Denaria intent fields: ${missing.join(', ')}`)
    error.code = 'DENARIA_INTENT_INCOMPLETE'
    throw error
  }

  return { marketId, side, collateralAsset, collateralAmount, leverage }
}

function normalizeMarket(value) {
  if (!value) return null
  const text = String(value).trim().toUpperCase()
  if (['BTC', 'BITCOIN', 'BTC-USD'].includes(text)) return 'BTC-USD'
  return text.includes('-') ? text : `${text}-USD`
}

function normalizeSide(value) {
  if (!value) return null
  const text = String(value).trim().toLowerCase()
  if (text.includes('long')) return 'long'
  if (text.includes('short')) return 'short'
  return null
}

function normalizeAmount(value) {
  if (value === undefined || value === null || value === '') return null
  const match = String(value).replace(',', '.').match(/[0-9]+(?:\.[0-9]+)?/)
  return match ? match[0] : null
}

function normalizeCollateral(value) {
  const text = String(value || 'USDC').trim().toUpperCase()
  if (text === 'USD' || text === '$') return 'USDC'
  return text
}

function normalizeLeverage(value) {
  if (value === undefined || value === null || value === '') return null
  const match = String(value).toLowerCase().replace(',', '.').match(/[0-9]+(?:\.[0-9]+)?/)
  return match ? match[0] : null
}

function unwrapToolResult(toolResult) {
  if (toolResult?.structuredContent) return toolResult.structuredContent
  const text = Array.isArray(toolResult?.content)
    ? toolResult.content.find((item) => item.type === 'text')?.text
    : null
  if (text) {
    try { return JSON.parse(text) } catch { return { text } }
  }
  return toolResult
}

function extractDisplay(remote) {
  const result = remote?.result ?? remote?.structuredContent?.result ?? remote
  const clientDisplay = result?.clientDisplay ?? result?.result?.clientDisplay
  const handoff = result?.handoff ?? result?.result?.handoff
  return {
    qrImageUrl: clientDisplay?.qrImageUrl ?? handoff?.qrImageUrl,
    qrPageUrl: clientDisplay?.qrPageUrl ?? handoff?.qrPageUrl,
    nextStep: clientDisplay?.nextStep,
    summaryMarkdown: clientDisplay?.summaryMarkdown,
  }
}

async function downloadQrImage(qrImageUrl, intent) {
  const directory = resolve(process.env.DENARIA_AGENT_QR_DIR || join(homedir(), '.denaria-agent', 'qr'))
  mkdirSync(directory, { recursive: true })
  const outputPath = join(directory, buildQrFilename(intent))

  const response = await fetch(qrImageUrl)
  if (!response.ok || !response.body) {
    throw new Error(`Cannot download Denaria QR image: HTTP ${response.status}`)
  }

  await pipeline(Readable.fromWeb(response.body), createWriteStream(outputPath))
  return outputPath
}

function markdownImagePath(filePath) {
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

function summarizeIntent(intent) {
  return [
    `- Market: ${intent.marketId}`,
    `- Side: ${intent.side}`,
    `- Collateral: ${intent.collateralAmount} ${intent.collateralAsset}`,
    `- Leverage: ${intent.leverage}x`,
  ].join('\n')
}
main().catch((error) => {
  console.error(JSON.stringify({
    status: 'error',
    error: {
      message: error.message,
      code: error.code || 'DENARIA_HANDOFF_FAILED',
    },
  }, null, 2))
  process.exit(1)
})
