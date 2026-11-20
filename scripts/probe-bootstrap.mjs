/** Readiness report: WSL, distro, CLI, sign-in — with the exact fix for each gap. */
import { createBootstrap, describe } from '../lib/cli/bootstrap.js'

const result = await createBootstrap({ distro: process.env.WSL_DISTRO ?? 'Ubuntu' }).probe()
console.log(describe(result))
for (const step of result.steps) {
  console.log(` ${step.ok ? 'OK' : '--'} ${step.id.padEnd(7)} ${step.detail}`)
  if (!step.ok) console.log(`    fix: ${step.fix}`)
}
process.exit(result.ok ? 0 : 1)
