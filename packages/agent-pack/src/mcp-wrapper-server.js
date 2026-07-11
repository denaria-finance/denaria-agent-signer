import { readFile } from 'node:fs/promises'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { getCapabilities, prepareHandoff } from './prepare-handoff.js'

const prepareInputSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    marketId: {
      type: 'string',
      description: 'Canonical market id. Use BTC-USD for BTC requests.',
    },
    market: {
      type: 'string',
      description: 'Market alias, for example BTC.',
    },
    side: {
      type: 'string',
      enum: ['long', 'short'],
    },
    collateralAsset: {
      type: 'string',
      default: 'USDC',
    },
    collateralAmount: {
      type: 'string',
      description: 'Collateral amount, for example 50.',
    },
    collateral: {
      type: 'string',
      description: 'Collateral amount alias, for example 50.',
    },
    leverage: {
      type: 'string',
      description: 'Leverage, for example 3 or 3x.',
    },
  },
  required: ['side', 'leverage'],
  anyOf: [
    { required: ['marketId'] },
    { required: ['market'] },
  ],
}

export async function startMcpServer() {
  const server = new Server(
    {
      name: 'denaria-agent-pack',
      version: '0.1.0',
    },
    {
      capabilities: {
        tools: {},
      },
    },
  )

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'denaria_get_capabilities',
        description: 'Discover Denaria Action Handoff capabilities from the official Denaria MCP endpoint.',
        inputSchema: {
          type: 'object',
          additionalProperties: false,
          properties: {},
        },
      },
      {
        name: 'denaria_prepare_handoff',
        description: 'Prepare an unsigned Denaria App/PWA handoff, download the QR PNG to the user device, and return qrLocalPath, qrMarkdown, qrImageUrl, qrPageUrl, and nextStep. Use this for Denaria position requests.',
        inputSchema: prepareInputSchema,
      },
    ],
  }))

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args = {} } = request.params

    if (name === 'denaria_get_capabilities') {
      const result = await getCapabilities()
      return asToolResult(result)
    }

    if (name === 'denaria_prepare_handoff') {
      const result = await prepareHandoff(args)
      return await asToolResult(result)
    }

    throw new Error(`Unknown Denaria tool: ${name}`)
  })

  const transport = new StdioServerTransport()
  await server.connect(transport)
}

async function asToolResult(result) {
  const content = []

  if (result?.qrLocalPath) {
    content.push({
      type: 'text',
      text: [
        'DENARIA_AGENT_PACK_DISPLAY_INSTRUCTION: render the local QR image first. Do not use qrImageUrl as the primary image when qrLocalPath or qrMarkdown is present.',
        result.qrMarkdown ? `QR Markdown: ${result.qrMarkdown}` : null,
        result.nextStep ? `Next step: ${result.nextStep}` : null,
      ].filter(Boolean).join('\n'),
    })

    const qrPng = await readFile(result.qrLocalPath)
    content.push({
      type: 'image',
      data: qrPng.toString('base64'),
      mimeType: 'image/png',
    })
  }

  content.push({
    type: 'text',
    text: JSON.stringify(result, null, 2),
  })

  return {
    content,
    structuredContent: result,
  }
}
