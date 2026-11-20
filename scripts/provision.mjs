/** Provision the private distro end to end: download, verify, import, install CLI. */
import { provision } from '../lib/cli/provision.js'

const distro = process.env.DISTRO ?? 'dsh-cursor'
const started = Date.now()
try {
  const result = await provision({ distro, log: (message) => console.log(`[provision] ${message}`) })
  console.log(`done in ${Date.now() - started} ms:`, result)
} catch (error) {
  console.error(`failed after ${Date.now() - started} ms:`, error.message)
  process.exit(1)
}
