import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

const files = [
  'bin/denaria-agent-pack.js',
  ...readdirSync('src')
    .filter((file) => file.endsWith('.js'))
    .map((file) => join('src', file)),
]

for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], {
    cwd: process.cwd(),
    stdio: 'inherit',
  })
  if (result.status !== 0) {
    process.exit(result.status ?? 1)
  }
}
