import { spawn } from 'node:child_process'

/**
 * Keeps the WSL VM resident so a turn pays process start instead of VM boot.
 *
 * Measured on the reference machine: 8.8 s cold, 381 ms warm. WSL keeps a
 * distro alive only while work is running, so one idle process is enough to
 * hold the VM up between turns.
 */
export class WslKeeper {
  constructor(options = {}) {
    this.distro = options.distro ?? 'Ubuntu'
    this.log = options.log ?? (() => {})
    this.child = null
  }

  get alive() {
    return this.child !== null && this.child.exitCode === null
  }

  start() {
    if (this.alive) return this
    this.child = spawn('wsl.exe', ['-d', this.distro, '-u', 'root', '--', 'sleep', 'infinity'], {
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true,
    })
    this.child.stderr.on('data', (chunk) => this.log(`warm: ${String(chunk).trim().slice(0, 160)}`))
    this.child.on('exit', () => {
      this.child = null
    })
    return this
  }

  stop() {
    if (!this.child) return
    try {
      this.child.kill()
    } catch {
      /* already gone */
    }
    this.child = null
  }
}
