import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

// This shell layer eats backslashes, so no literal escape appears below.
const BACKSLASH = String.fromCharCode(92)

/**
 * Locate Cursor's own agent-host daemon.
 *
 * The daemon is the official client process: it authenticates and talks to
 * Cursor's backend itself, so a bridge never forges client headers.
 */
export function locateDaemon(options = {}) {
  const env = options.env ?? process.env
  const exists = options.exists ?? existsSync
  const home = options.home ?? homedir()
  const platform = options.platform ?? process.platform

  const override = env.DSH_CURSOR_DAEMON
  if (override && exists(override)) {
    return { entry: override, node: locateNode(env, exists), source: 'env', platform }
  }

  for (const root of installRoots(platform, env, home, exists)) {
    const entry = join(root, 'resources', 'app', 'extensions', 'cursor-agent-host',
      'dist', 'agent-host-daemon', 'dist', 'bin', 'daemon.cjs')
    if (exists(entry)) {
      return { entry, node: locateNode(env, exists, root), source: 'install', installRoot: root, platform }
    }
  }

  const cli = locateCli(env, exists, platform)
  if (cli) return { entry: null, cli, node: locateNode(env, exists), source: 'cli', platform }
  return null
}

/** Cursor ships the node the daemon expects next to the app resources. */
function locateNode(env, exists, installRoot) {
  const candidates = [
    env.DSH_CURSOR_NODE,
    installRoot && join(installRoot, 'resources', 'app', 'resources', 'helpers', 'node.exe'),
    installRoot && join(installRoot, 'resources', 'app', 'resources', 'helpers', 'node'),
  ].filter(Boolean)
  for (const candidate of candidates) if (exists(candidate)) return candidate
  return process.execPath
}

function installRoots(platform, env, home, exists) {
  const roots = []
  if (env.DSH_CURSOR_ROOT) roots.push(env.DSH_CURSOR_ROOT)
  if (platform === 'win32') {
    roots.push(env.LOCALAPPDATA && join(env.LOCALAPPDATA, 'Programs', 'cursor'))
    roots.push(env.LOCALAPPDATA && join(env.LOCALAPPDATA, 'Cursor'))
    for (const dir of (env.PATH ?? '').split(';')) {
      const root = inferRoot(dir)
      if (root) roots.push(root)
    }
  } else if (platform === 'darwin') {
    roots.push('/Applications/Cursor.app/Contents')
    roots.push(join(home, 'Applications', 'Cursor.app', 'Contents'))
  } else {
    roots.push('/usr/share/cursor', '/opt/cursor')
  }
  return roots.filter((root) => root && exists(root))
}

/** `<root>\resources\app\bin` on PATH implies `<root>`. */
function inferRoot(dir) {
  const normalized = dir.split(BACKSLASH).join('/').toLowerCase()
  const index = normalized.lastIndexOf('/resources/app/bin')
  return index === -1 ? null : dir.slice(0, index)
}

/** The headless CLI, when the user installed it separately. */
function locateCli(env, exists, platform) {
  const names = platform === 'win32' ? ['cursor-agent.exe', 'cursor-agent.cmd'] : ['cursor-agent']
  for (const dir of (env.PATH ?? '').split(platform === 'win32' ? ';' : ':')) {
    if (!dir) continue
    for (const name of names) {
      const candidate = join(dir, name)
      if (exists(candidate)) return candidate
    }
  }
  return null
}

/**
 * Named pipes on Windows, unix sockets elsewhere. The daemon takes the address
 * literally, so the bridge owns the naming.
 */
export function listenAddress(options = {}) {
  const platform = options.platform ?? process.platform
  const pid = options.pid ?? process.pid
  if (platform === 'win32') {
    const sep = BACKSLASH
    return `${sep}${sep}.${sep}pipe${sep}dsh-cursor-agent-${pid}`
  }
  return `unix:${join(options.home ?? homedir(), '.dsh-cursor', `agent-${pid}.sock`)}`
}

export function socketPath(address) {
  return address.startsWith('unix:') ? address.slice(5) : address
}
