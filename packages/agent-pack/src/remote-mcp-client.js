const DEFAULT_ENDPOINT = 'https://mcp.denaria.finance/mcp'
const PROTOCOL_VERSION = '2025-03-26'

export class RemoteMcpClient {
  constructor(endpoint = DEFAULT_ENDPOINT) {
    this.endpoint = endpoint
    this.sessionId = null
    this.nextId = 1
  }

  async initialize() {
    const response = await this.request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: {
        name: '@denaria/agent-pack',
        version: '0.1.0',
      },
    }, { allowNoSession: true })

    await this.notify('notifications/initialized', {})
    return response
  }

  async listTools() {
    await this.ensureInitialized()
    return this.request('tools/list', {})
  }

  async callTool(name, args = {}) {
    await this.ensureInitialized()
    return this.request('tools/call', { name, arguments: args })
  }

  async ensureInitialized() {
    if (!this.sessionId) {
      await this.initialize()
    }
  }

  async notify(method, params = {}) {
    const headers = this.headers()
    await fetch(this.endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify({ jsonrpc: '2.0', method, params }),
    }).catch(() => null)
  }

  async request(method, params = {}, options = {}) {
    const id = this.nextId++
    const headers = this.headers(options)
    const response = await fetch(this.endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
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
    if (this.sessionId && !options.allowNoSession) {
      headers['mcp-session-id'] = this.sessionId
    }
    return headers
  }
}

async function parseMcpHttpResponse(response) {
  const contentType = response.headers.get('content-type') || ''
  const text = await response.text()

  if (contentType.includes('text/event-stream')) {
    return parseSseJson(text)
  }

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

  const last = dataLines[dataLines.length - 1]
  return JSON.parse(last)
}
