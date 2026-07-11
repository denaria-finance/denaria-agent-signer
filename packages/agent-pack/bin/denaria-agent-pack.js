#!/usr/bin/env node
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { getCapabilities, prepareHandoff } from '../src/prepare-handoff.js'
import { normalizeIntent } from '../src/normalize-intent.js'
import { startMcpServer } from '../src/mcp-wrapper-server.js'

const command = process.argv[2] || 'help'
const args = parseArgs(process.argv.slice(3))

async function main() {
  if (command === 'mcp') {
    await startMcpServer()
    return
  }

  if (command === 'prepare') {
    const intent = normalizeIntent(args)
    const result = await prepareHandoff(intent)
    console.log(JSON.stringify(result, null, 2))
    return
  }

  if (command === 'capabilities') {
    const result = await getCapabilities()
    console.log(JSON.stringify(result, null, 2))
    return
  }

  if (command === 'normalize') {
    console.log(JSON.stringify(normalizeIntent(args), null, 2))
    return
  }

  if (command === 'setup') {
    printSetup(args.client || args._[0] || 'generic')
    return
  }

  printHelp()
}

function parseArgs(argv) {
  const parsed = { _: [] }
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (!token.startsWith('--')) {
      parsed._.push(token)
      continue
    }
    const key = token.slice(2)
    const next = argv[i + 1]
    if (!next || next.startsWith('--')) {
      parsed[key] = true
      continue
    }
    parsed[key] = next
    i += 1
  }
  return parsed
}

function printSetup(client) {
  if (client === 'codex') {
    console.log(`[mcp_servers.denaria]\ncommand = "npx"\nargs = ["-y", "@denaria/agent-pack", "mcp"]\nstartup_timeout_sec = 20\ntool_timeout_sec = 60\ndefault_tools_approval_mode = "prompt"`)
    return
  }

  if (client === 'claude') {
    console.log(JSON.stringify({
      mcpServers: {
        denaria: {
          command: 'npx',
          args: ['-y', '@denaria/agent-pack', 'mcp'],
        },
      },
    }, null, 2))
    return
  }

  console.log('Configure a stdio MCP server named denaria with command: npx -y @denaria/agent-pack mcp')
}

function printHelp() {
  console.log(`Denaria Agent Pack\n\nCommands:\n  mcp\n  prepare --side long --market BTC --collateral 50 --leverage 3\n  capabilities\n  normalize --side long --market BTC --collateral 50 --leverage 3\n  setup codex|claude|hermes`)
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
