import { execFileSync } from 'node:child_process'

/**
 * What a new machine needs before the print backend can serve a turn.
 *
 * Three of the four steps can be done by the plugin or by one command; only the
 * WSL optional feature itself needs an administrator and a reboot, because
 * Windows does not expose it to user code.
 */
export function createBootstrap(options = {}) {
  const distro = options.distro ?? 'Ubuntu'
  const binary = options.binary ?? '/root/.local/bin/cursor-agent'
  const run = options.run ?? defaultRun
  return { probe: () => probe({ distro, binary, run }) }
}

export async function probe({ distro, binary, run }) {
  const steps = []

  const wsl = run(['wsl.exe', '--version'], 15_000)
  steps.push({
    id: 'wsl',
    ok: wsl.ok,
    detail: wsl.ok ? firstLine(wsl.stdout) : 'WSL is not available',
    fix: 'run as administrator: wsl --install --no-distribution   (needs a reboot)',
  })

  if (!wsl.ok) return { ok: false, steps, distro, binary }

  const list = run(['wsl.exe', '-l', '-q'], 20_000)
  const names = list.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  const present = names.some((name) => name.toLowerCase() === distro.toLowerCase())
  steps.push({
    id: 'distro',
    ok: present,
    detail: present ? `found ${distro}` : `no ${distro}; installed: ${names.join(', ') || '(none)'}`,
    fix: `wsl --install -d ${distro} --no-launch   (no administrator needed once WSL exists)`,
  })
  if (!present) return { ok: false, steps, distro, binary }

  const version = run(['wsl.exe', '-d', distro, '-u', 'root', '--', binary, '--version'], 30_000)
  steps.push({
    id: 'cli',
    ok: version.ok,
    detail: version.ok ? firstLine(version.stdout) : 'cursor-agent is not installed in the distro',
    fix: `wsl -d ${distro} -u root -- bash -lc 'curl -fsS https://cursor.com/install | bash'`,
  })
  if (!version.ok) return { ok: false, steps, distro, binary }

  const about = run(['wsl.exe', '-d', distro, '-u', 'root', '--', binary, 'about'], 30_000)
  const loggedIn = /User Email\s+\S+@/.test(about.stdout) && !/Not logged in/i.test(about.stdout)
  steps.push({
    id: 'login',
    ok: loggedIn,
    detail: loggedIn ? firstMatch(about.stdout, /User Email\s+(.+)/) : 'not signed in',
    fix: `wsl -d ${distro} -u root -- bash -lc 'NO_OPEN_BROWSER=1 cursor-agent login'   (open the printed URL)`,
  })

  return { ok: steps.every((step) => step.ok), steps, distro, binary }
}

/** One line for the log: either ready, or the first thing to fix. */
export function describe(result) {
  if (result.ok) return `cursor CLI ready: ${result.steps.map((step) => step.detail).join(' | ')}`
  const blocking = result.steps.find((step) => !step.ok)
  return `cursor CLI not ready (${blocking.id}: ${blocking.detail}) — fix: ${blocking.fix}`
}

function defaultRun(args, timeout) {
  try {
    const raw = execFileSync(args[0], args.slice(1), {
      encoding: 'buffer',
      timeout,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    return { ok: true, stdout: decode(raw) }
  } catch (error) {
    return { ok: false, stdout: String(error?.stdout ?? '') }
  }
}

/** wsl.exe answers in UTF-16LE; distro commands answer in UTF-8. */
export function decode(buffer) {
  if (!buffer || buffer.length === 0) return ''
  if (buffer[0] === 0xff && buffer[1] === 0xfe) return buffer.subarray(2).toString('utf16le')
  const utf8 = buffer.toString('utf8')
  if (utf8.includes(String.fromCharCode(0))) return buffer.toString('utf16le')
  return utf8.replace(/^﻿/, '')
}

function firstLine(text) {
  return String(text ?? '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean)[0] ?? ''
}

function firstMatch(text, pattern) {
  return pattern.exec(String(text ?? ''))?.[1]?.trim() ?? ''
}
