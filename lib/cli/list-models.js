import { execFile } from 'node:child_process'

/**
 * `cursor-agent --list-models` prints `<id> - <Name>` lines under a header.
 * This is the portable live source: macOS and Linux have the CLI natively, so a
 * user there never needs the sealed token to see their full model set.
 */
export function parseModelList(text) {
  const models = []
  const seen = new Set()
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || /^available models/i.test(line)) continue
    const match = /^(?:[-*]\s+)?([A-Za-z0-9][A-Za-z0-9._-]*)\s+-\s+(.+)$/.exec(line)
    if (!match) continue
    // The CLI calls the default model `auto`; the account API calls it `default`.
    const id = match[1] === 'auto' ? 'default' : match[1]
    if (seen.has(id)) continue
    seen.add(id)
    models.push({ id, name: match[2].trim() })
  }
  return models
}

/** Where the CLI lives on this platform. Windows reaches it through WSL. */
export function listModelsPlan(options = {}) {
  const platform = options.platform ?? process.platform
  const command = options.command ?? 'cursor-agent'
  if (platform === 'win32') {
    return {
      file: 'wsl.exe',
      args: ['-d', options.distro ?? 'dsh-cursor', '-u', 'root', '--', options.binary ?? '/root/.local/bin/cursor-agent', '--list-models'],
    }
  }
  return { file: command, args: ['--list-models'] }
}

/** Ask the CLI for this account's models; empty when the CLI is absent or signed out. */
export function readModelsFromCli(options = {}) {
  const plan = listModelsPlan(options)
  return new Promise((resolve) => {
    execFile(plan.file, plan.args, { encoding: 'buffer', timeout: options.timeoutMs ?? 30_000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
      if (error) {
        resolve({ ok: false, models: [], detail: String(error.message).slice(0, 160) })
        return
      }
      const models = parseModelList(decode(stdout))
      resolve({ ok: models.length > 0, models, detail: models.length > 0 ? `${models.length} models` : 'no model lines' })
    })
  })
}

function decode(buffer) {
  if (!buffer) return ''
  if (buffer[0] === 0xff && buffer[1] === 0xfe) return buffer.subarray(2).toString('utf16le')
  const utf8 = buffer.toString('utf8')
  return utf8.includes(String.fromCharCode(0)) ? buffer.toString('utf16le') : utf8
}
