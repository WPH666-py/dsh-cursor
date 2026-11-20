import { spawn } from 'node:child_process'

/**
 * Start an ACP agent on stdio.
 *
 * On Windows the official CLI only exists for Linux, so the documented path runs
 * it inside WSL; anywhere else the binary is spawned directly.
 */
export function acpPlan(options = {}) {
  const platform = options.platform ?? process.platform
  const command = options.command ?? 'cursor-agent'
  const args = options.args ?? ['acp']
  if (platform === 'win32' && options.wsl !== false) {
    const distro = options.distro && options.distro !== 'default' ? ['-d', options.distro] : []
    const shell = `${command} ${args.join(' ')}`
    return { file: 'wsl.exe', args: [...distro, '--', 'bash', '-lc', shell], shell: true }
  }
  return { file: command, args, shell: false }
}

export function spawnAcp(options = {}) {
  const plan = acpPlan(options)
  const child = spawn(plan.file, plan.args, {
    cwd: options.cwd,
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
    input: child.stdout,
    output: child.stdin,
    child,
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
