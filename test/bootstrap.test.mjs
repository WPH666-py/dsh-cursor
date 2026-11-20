import assert from 'node:assert/strict'
import test from 'node:test'
import { createBootstrap, decode, describe } from '../lib/cli/bootstrap.js'

/** A scripted runner: each command prefix maps to a canned answer. */
function runner(table) {
  return (args) => {
    const key = args.join(' ')
    for (const [needle, answer] of table) {
      if (key.includes(needle)) return typeof answer === 'function' ? answer(key) : { ok: true, stdout: answer }
    }
    return { ok: false, stdout: '' }
  }
}

const READY = [
  ['--version', 'WSL 3.0.5'],
  ['-l -q', 'Ubuntu\n'],
  ['--version', '2026.11.19'],
  ['about', 'User Email           a@b.c\n'],
]

test('a complete machine reports ready', async () => {
  const result = await createBootstrap({ run: runner([
    ['wsl.exe --version', 'WSL 3.0.5'],
    ['wsl.exe -l -q', 'Ubuntu\n'],
    ['cursor-agent --version', '2026.11.19'],
    ['cursor-agent about', 'User Email           a@b.c'],
  ]) }).probe()
  assert.equal(result.ok, true)
  assert.deepEqual(result.steps.map((s) => s.id), ['wsl', 'distro', 'cli', 'login'])
})

test('a missing distro stops the chain with the install command', async () => {
  const result = await createBootstrap({ run: runner([
    ['wsl.exe --version', 'WSL 3.0.5'],
    ['wsl.exe -l -q', 'Debian\n'],
  ]) }).probe()
  assert.equal(result.ok, false)
  const distro = result.steps.find((s) => s.id === 'distro')
  assert.match(distro.fix, /--install -d Ubuntu --no-launch/)
  assert.equal(result.steps.length, 2, 'later steps are not attempted')
})

test('a signed-out CLI points at the login command', async () => {
  const result = await createBootstrap({ run: runner([
    ['wsl.exe --version', 'WSL 3.0.5'],
    ['wsl.exe -l -q', 'Ubuntu\n'],
    ['cursor-agent --version', '2026'],
    ['cursor-agent about', 'User Email  Not logged in'],
  ]) }).probe()
  assert.equal(result.ok, false)
  assert.match(result.steps.at(-1).fix, /cursor-agent login/)
})

test('describe names the first blocking step', async () => {
  const result = await createBootstrap({ run: () => ({ ok: false, stdout: '' }) }).probe()
  assert.match(describe(result), /wsl/)
  assert.match(describe(result), /wsl --install --no-distribution/)
})

test('UTF-16 wsl output decodes', () => {
  const buffer = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('Ubuntu\n', 'utf16le')])
  assert.equal(decode(buffer), 'Ubuntu\n')
  assert.equal(decode(Buffer.from('plain', 'utf8')), 'plain')
})
