import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { parseSums, provision, decode } from '../lib/cli/provision.js'

const SUMS = [
  'aaaa000000000000000000000000000000000000000000000000000000000000 *other.tar.gz',
  '6bc2cde3930ad088b3bb46fa45279e96d25bc3810f209850ecbe4722711874f9 *ubuntu-base-24.04.3-base-amd64.tar.gz',
].join(String.fromCharCode(10))

function harness(overrides = {}) {
  const calls = []
  const dir = mkdtempSync(join(tmpdir(), 'dsh-cursor-prov-'))
  const run = overrides.run ?? ((args) => {
    calls.push(args.join(' '))
    if (args.includes('-l')) return { ok: true, stdout: Buffer.from('', 'utf8'), stderr: Buffer.alloc(0) }
    return { ok: true, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }
  })
  const download = overrides.download ?? (async (url, dest) => {
    writeFileSync(dest, 'rootfs')
    return { sha256: '6bc2cde3930ad088b3bb46fa45279e96d25bc3810f209850ecbe4722711874f9', bytes: 6 }
  })
  return { dir, calls, run, download }
}

test('parseSums finds the exact file and ignores others', () => {
  assert.match(parseSums(SUMS, 'ubuntu-base-24.04.3-base-amd64.tar.gz'), /^6bc2cde/)
  assert.equal(parseSums(SUMS, 'missing.tar.gz'), null)
})

test('an existing distro short-circuits before any download', async () => {
  const h = harness({ run: (args) => ({ ok: true, stdout: Buffer.from('dsh-cursor\n'), stderr: Buffer.alloc(0) }) })
  const result = await provision({ distro: 'dsh-cursor', installDir: h.dir, run: h.run, download: h.download, readText: async () => SUMS })
  assert.equal(result.status, 'exists')
})

test('a checksum mismatch aborts before the import', async () => {
  const h = harness({ download: async (url, dest) => { writeFileSync(dest, 'bad'); return { sha256: 'f'.repeat(64), bytes: 3 } } })
  await assert.rejects(
    provision({ distro: 'dsh-cursor', installDir: h.dir, run: h.run, download: h.download, readText: async () => SUMS }),
    /checksum mismatch/,
  )
  assert.equal(h.calls.some((c) => c.includes('--import')), false)
})

test('a failed import removes the half-built directory', async () => {
  const h = harness({
    run: (args) => {
      if (args.includes('-l')) return { ok: true, stdout: Buffer.from(''), stderr: Buffer.alloc(0) }
      if (args.includes('--import')) return { ok: false, stdout: Buffer.alloc(0), stderr: Buffer.from('boom') }
      return { ok: true, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }
    },
  })
  await assert.rejects(
    provision({ distro: 'dsh-cursor', installDir: h.dir, run: h.run, download: h.download, readText: async () => SUMS }),
    /wsl --import failed: boom/,
  )
  assert.equal(existsSync(h.dir), false, 'the import target is rolled back')
})

test('the happy path imports then installs curl and the CLI, in that order', async () => {
  const h = harness()
  const result = await provision({ distro: 'dsh-cursor', installDir: h.dir, run: h.run, download: h.download, readText: async () => SUMS })
  assert.equal(result.status, 'ready')
  // `bash -lc` also contains '-l', so filter on the listing command itself.
  const steps = h.calls.filter((c) => !c.includes('wsl.exe -l -q'))
  assert.match(steps[0], /--import dsh-cursor/)
  assert.match(steps[1], /apt-get install.*curl/)
  assert.match(steps[2], /cursor\.com\/install/)
  rmSync(h.dir, { recursive: true, force: true })
})

test('UTF-16 and UTF-8 output both decode', () => {
  const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('Ubuntu\n', 'utf16le')])
  assert.equal(decode(utf16), 'Ubuntu\n')
  assert.equal(decode(Buffer.from('plain', 'utf8')), 'plain')
})
