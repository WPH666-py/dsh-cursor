import { createHash } from 'node:crypto'
import { createWriteStream, existsSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { execFile, execFileSync } from 'node:child_process'

/**
 * The smallest published Ubuntu rootfs, plus the checksum list that signs it.
 * Ubuntu base ships without curl, so provisioning installs it before the CLI.
 */
export const UBUNTU_BASE = {
  url: 'https://cdimage.ubuntu.com/ubuntu-base/releases/24.04/release/ubuntu-base-24.04.3-base-amd64.tar.gz',
  sumsUrl: 'https://cdimage.ubuntu.com/ubuntu-base/releases/24.04/release/SHA256SUMS',
}

/** One `hash *filename` line out of Ubuntu's SHA256SUMS. */
export function parseSums(text, fileName) {
  for (const line of String(text ?? '').split(String.fromCharCode(10))) {
    const match = /^([0-9a-f]{64})\s+\*?(.+)$/.exec(line.trim())
    if (match && match[2].trim() === fileName) return match[1]
  }
  return null
}

/** Stream a URL to disk and hash it as it goes; never holds 30 MB in memory. */
export async function downloadToFile(url, destination, options = {}) {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch
  const response = await fetchImpl(url)
  if (!response.ok) throw new Error(`${url} answered HTTP ${response.status}`)
  const hash = createHash('sha256')
  const sink = createWriteStream(destination)
  let bytes = 0
  for await (const chunk of response.body) {
    const buffer = Buffer.from(chunk)
    bytes += buffer.length
    hash.update(buffer)
    if (!sink.write(buffer)) await new Promise((resolve) => sink.once('drain', resolve))
  }
  await new Promise((resolve, reject) => sink.end((error) => (error ? reject(error) : resolve())))
  return { sha256: hash.digest('hex'), bytes }
}

/**
 * Register a private distro from a verified rootfs and install the CLI inside it.
 *
 * Every failure path removes what it created, so a retry starts clean and the
 * user is never left with a half-imported distro or an orphaned download.
 */
export async function provision(options = {}) {
  const distro = options.distro ?? 'dsh-cursor'
  const rootfs = options.rootfs ?? UBUNTU_BASE
  const installDir = options.installDir ?? join(process.env.USERPROFILE ?? tmpdir(), '.dsh-cursor', 'wsl', distro)
  const run = options.run ?? wslRun
  const download = options.download ?? downloadToFile
  const readText = options.readText ?? (async (url) => (await fetch(url)).text())
  const log = options.log ?? (() => {})

  const listed = await run(['wsl.exe', '-l', '-q'], 20_000)
  const names = decode(listed.stdout).split(/\r?\n/).map((name) => name.trim()).filter(Boolean)
  if (names.some((name) => name.toLowerCase() === distro.toLowerCase())) {
    log(`distro ${distro} already present`)
    return { status: 'exists', distro, installDir }
  }

  const fileName = basename(rootfs.url)
  log('reading checksums')
  const expected = parseSums(await readText(rootfs.sumsUrl), fileName)
  if (!expected) throw new Error(`${rootfs.sumsUrl} lists no checksum for ${fileName}`)

  mkdirSync(installDir, { recursive: true })
  const archive = join(tmpdir(), `dsh-cursor-${distro}-${Date.now()}.tar.gz`)
  log(`downloading ${fileName}`)
  const { sha256, bytes } = await download(rootfs.url, archive)
  if (sha256 !== expected) {
    rmSync(archive, { force: true })
    throw new Error(`checksum mismatch for ${fileName}: expected ${expected}, got ${sha256}`)
  }
  log(`verified ${bytes} bytes`)

  const imported = await run(['wsl.exe', '--import', distro, installDir, archive], 900_000)
  rmSync(archive, { force: true })
  if (!imported.ok) {
    // Roll back the import target; WSL may have created a partial ext4.vhdx.
    rmSync(installDir, { recursive: true, force: true })
    throw new Error(`wsl --import failed: ${decode(imported.stderr).trim().slice(-400)}`)
  }
  log(`imported ${distro}`)

  const base = ['wsl.exe', '-d', distro, '-u', 'root', '--', 'bash', '-lc']
  const deps = await run([...base, 'apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq curl ca-certificates'], 900_000)
  if (!deps.ok) throw new Error(`installing curl failed: ${decode(deps.stderr).trim().slice(-300)}`)

  const cli = await run([...base, 'curl -fsS https://cursor.com/install | bash'], 900_000)
  if (!cli.ok) throw new Error(`cursor-agent install failed: ${decode(cli.stderr).trim().slice(-300)}`)

  return { status: 'ready', distro, installDir, bytes, sha256 }
}

function wslRun(args, timeout) {
  try {
    const stdout = execFileSync(args[0], args.slice(1), {
      encoding: 'buffer',
      timeout,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return { ok: true, stdout, stderr: Buffer.alloc(0) }
  } catch (error) {
    return { ok: false, stdout: Buffer.from(''), stderr: Buffer.from(String(error?.stderr ?? '')) }
  }
}

/**
 * The same runner without blocking: provisioning a distro takes minutes, and the
 * Host must keep serving turns (and its UI) while it runs.
 */
export function wslRunAsync(args, timeout) {
  return new Promise((resolve) => {
    execFile(args[0], args.slice(1), { encoding: 'buffer', timeout, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        resolve({ ok: false, stdout: stdout ?? Buffer.alloc(0), stderr: stderr ?? Buffer.from(String(error.message)) })
        return
      }
      resolve({ ok: true, stdout, stderr: stderr ?? Buffer.alloc(0) })
    })
  })
}

/** wsl.exe speaks UTF-16LE; distro commands speak UTF-8. */
export function decode(buffer) {
  if (!buffer || buffer.length === 0) return ''
  if (buffer[0] === 0xff && buffer[1] === 0xfe) return buffer.subarray(2).toString('utf16le')
  const utf8 = buffer.toString('utf8')
  return utf8.includes(String.fromCharCode(0)) ? buffer.toString('utf16le') : utf8
}
