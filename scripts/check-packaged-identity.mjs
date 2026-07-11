import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const [descriptorArgument, expectedArgument] = process.argv.slice(2)
if (!descriptorArgument || !expectedArgument) {
  throw new Error('Usage: check-packaged-identity.mjs <descriptor.json> <expected.json>')
}
const descriptor = JSON.parse(await readFile(resolve(descriptorArgument), 'utf8'))
const expected = JSON.parse(await readFile(resolve(expectedArgument), 'utf8'))
for (const [key, value] of Object.entries(expected)) {
  if (descriptor[key] !== value) {
    throw new Error(
      `Packaged identity mismatch for ${key}: expected ${JSON.stringify(value)}, ` +
      `received ${JSON.stringify(descriptor[key])}`
    )
  }
}
console.log(`Packaged identity verified: ${descriptor.displayName} (${descriptor.appId}).`)
