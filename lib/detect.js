import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { homedir } from 'node:os'

/**
 * Locate a local Cursor installation and its user-data directory.
 *
 * The plugin is a no-op when this returns `installed: false`, so detection has
 * to cover the layouts Cursor actually ships: the default per-user install, a
 * custom install root reached through the `cursor` shim on PATH, and the
 * macOS/Linux equivalents.
 */
export function detectCursor(options = {}) {
  const platform = options.platform ?? process.platform
  const env = options.env ?? process.env
  const home = options.home ?? homedir()
  const exists = options.exists ?? existsSync
  const readText = options.readText ?? ((path) => readFileSync(path, 'utf8'))

  const evidence = []
  const installDirs = []
  const executable = []

  const candidates = installCandidates(platform, env, home)
  for (const candidate of candidates) {
    if (!candidate) continue
    if (exists(candidate)) {
      executable.push(candidate)
      installDirs.push(candidate.includes('Cursor.app') ? candidate.slice(0, candidate.indexOf('.app') + 4) : dirname(candidate))
      evidence.push(`install:${candidate}`)
    }
  }

  const cli = findOnPath('cursor', platform, env, exists)
  if (cli) {
    evidence.push(`cli:${cli}`)
    installDirs.push(cliInstallRoot(cli))
  }

  const dataDir = dataDirFor(platform, env, home)
  const dbPath = join(dataDir, 'User', 'globalStorage', 'state.vscdb')
  const hasDb = exists(dbPath)
  if (hasDb) evidence.push(`state:${dbPath}`)

  const cliConfig = join(home, '.cursor', 'cli-config.json')
  const hasCliConfig = exists(cliConfig)
  if (hasCliConfig) evidence.push(`cli-config:${cliConfig}`)

  const installed = executable.length > 0 || hasDb || hasCliConfig || cli !== null
  // A root derived from a shim on PATH is authoritative even when the caller
  // only knows about the shim itself.
  const installDir = firstExisting(installDirs, exists) ?? installDirs.find(Boolean) ?? null

  return {
    installed,
    platform,
    executable: executable[0] ?? null,
    cli,
    installDir,
    dataDir,
    dbPath: hasDb ? dbPath : null,
    cliConfig: hasCliConfig ? cliConfig : null,
    version: readVersion(installDir, exists, readText),
    evidence,
  }
}

function installCandidates(platform, env, home) {
  if (platform === 'win32') {
    const local = env.LOCALAPPDATA
    return [
      local && join(local, 'Programs', 'cursor', 'Cursor.exe'),
      local && join(local, 'Programs', 'Cursor', 'Cursor.exe'),
      local && join(local, 'Cursor', 'Cursor.exe'),
      env.ProgramFiles && join(env.ProgramFiles, 'Cursor', 'Cursor.exe'),
    ].filter(Boolean)
  }
  if (platform === 'darwin') {
    return [
      '/Applications/Cursor.app/Contents/MacOS/Cursor',
      join(home, 'Applications', 'Cursor.app', 'Contents', 'MacOS', 'Cursor'),
    ]
  }
  return [
    '/usr/share/cursor/cursor',
    '/opt/cursor/cursor',
    '/usr/bin/cursor',
    join(home, '.local', 'share', 'cursor', 'cursor'),
  ]
}

function dataDirFor(platform, env, home) {
  if (platform === 'win32') return join(env.APPDATA ?? join(home, 'AppData', 'Roaming'), 'Cursor')
  if (platform === 'darwin') return join(home, 'Library', 'Application Support', 'Cursor')
  return join(env.XDG_CONFIG_HOME ?? join(home, '.config'), 'Cursor')
}

/** Resolve `cursor`/`cursor.cmd` from PATH without spawning a process. */
export function findOnPath(name, platform = process.platform, env = process.env, exists = existsSync) {
  const raw = env.PATH ?? env.Path ?? ''
  const separator = platform === 'win32' ? ';' : ':'
  const extensions = platform === 'win32'
    ? ['', ...(env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)]
    : ['']
  for (const dir of raw.split(separator)) {
    if (!dir) continue
    for (const extension of extensions) {
      const candidate = join(dir, `${name}${extension}`)
      if (exists(candidate)) return candidate
    }
  }
  return null
}

/** `<root>/resources/app/bin/cursor.cmd` -> `<root>` */
function cliInstallRoot(cliPath) {
  const index = cliPath.replace(/\\/g, "/").lastIndexOf("/resources/app/")
  return index === -1 ? dirname(cliPath) : resolve(cliPath.slice(0, index))
}

function firstExisting(values, exists) {
  for (const value of values) if (value && exists(value)) return value
  return null
}

function readVersion(installDir, exists, readText) {
  if (!installDir) return null
  for (const candidate of [
    join(installDir, 'resources', 'app', 'package.json'),
    join(installDir, 'Contents', 'Resources', 'app', 'package.json'),
  ]) {
    try {
      if (!exists(candidate)) continue
      const parsed = JSON.parse(readText(candidate))
      if (typeof parsed?.version === 'string') return parsed.version
    } catch {
      /* an unreadable manifest is not evidence of anything */
    }
  }
  return null
}