import { spawn } from 'node:child_process'

/**
 * How to reach the Cursor CLI from this process.
 *
 * On Windows the CLI only exists inside WSL, so the plan execs it there with an
 * absolute path: no shell, no PATH lookup, and the prompt still travels on stdin.
 */
export function cliPlan(options = {}) {
  const platform = options.platform ?? process.platform
  const distro = options.distro ?? 'Ubuntu'
  const binary = options.binary ?? '/root/.local/bin/cursor-agent'
  const args = options.args ?? []
  if (platform === 'win32' && options.wsl !== false) {
    return { file: 'wsl.exe', args: ['-d', distro, '-u', 'root', '--', binary, ...args] }
  }
  return { file: options.command ?? 'cursor-agent', args }
}

export function spawnCli(options = {}) {
  const plan = cliPlan(options)
  const child = spawn(plan.file, plan.args, {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    env: { ...process.env, ...(options.env ?? {}) },
  })
  const stderr = []
  child.stderr.on('data', (chunk) => {
    stderr.push(String(chunk))
    if (stderr.length > 40) stderr.shift()
  })
  return {
    child,
    stdin: child.stdin,
    stdout: child.stdout,
    stderr: () => stderr.join('').slice(-800),
    kill: () => {
      try {
        child.kill()
      } catch {
        /* already gone */
      }
    },
  }
}
