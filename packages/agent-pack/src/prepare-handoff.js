import { normalizeIntent } from './normalize-intent.js'
import { downloadQrImage, markdownImagePath } from './download-qr.js'
import { RemoteMcpClient } from './remote-mcp-client.js'

const REMOTE_MCP_ENDPOINT = 'https://mcp.denaria.finance/mcp'

export async function getCapabilities() {
  const client = new RemoteMcpClient(REMOTE_MCP_ENDPOINT)
  const toolResult = await client.callTool('denaria_get_capabilities', {})
  return unwrapToolResult(toolResult)
}

export async function prepareHandoff(rawIntent, options = {}) {
  const intent = normalizeIntent(rawIntent)
  const client = new RemoteMcpClient(REMOTE_MCP_ENDPOINT)
  const toolResult = await client.callTool('denaria_prepare_create_position', intent)
  const remote = unwrapToolResult(toolResult)
  const display = extractDisplay(remote)

  if (!display.qrImageUrl) {
    throw new Error('Denaria MCP response did not include clientDisplay.qrImageUrl')
  }

  const qrLocalPath = await downloadQrImage(display.qrImageUrl, intent, options)
  const qrMarkdown = `![Denaria QR](${markdownImagePath(qrLocalPath)})`

  return {
    status: 'prepared',
    actionType: 'create_position',
    intent,
    qrLocalPath,
    qrMarkdown,
    qrImageUrl: display.qrImageUrl,
    qrPageUrl: display.qrPageUrl,
    nextStep: display.nextStep || 'Open Denaria App/PWA and scan the QR to review and sign.',
    summary: display.summaryMarkdown || summarizeIntent(intent),
    officialMcpEndpoint: REMOTE_MCP_ENDPOINT,
  }
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

function unwrapToolResult(toolResult) {
  if (toolResult?.structuredContent) return toolResult.structuredContent

  const text = Array.isArray(toolResult?.content)
    ? toolResult.content.find((item) => item.type === 'text')?.text
    : null

  if (text) {
    try {
      return JSON.parse(text)
    } catch {
      return { text }
    }
  }

  return toolResult
}

function summarizeIntent(intent) {
  return [
    `- Market: ${intent.marketId}`,
    `- Side: ${intent.side}`,
    `- Collateral: ${intent.collateralAmount} ${intent.collateralAsset}`,
    `- Leverage: ${intent.leverage}x`,
  ].join('\n')
}
