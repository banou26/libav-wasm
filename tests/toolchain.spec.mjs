// vite-plus bundles its own vitest and ships vite as vite-plus-core, and its docs require a project to pin
// both to the same release ("Updating the Vitest Pin" at viteplus.dev). A pin left behind on a vite-plus
// bump keeps installing the previous runner. This repo had no vitest pin at all and carried the vulnerable
// vitest 4.1.10 (GHSA-82fw-gwwq-j7x9) under vite-plus 0.2.4 until 2026-09-24. Reads the manifest and the
// lockfile only, so it holds for what a fresh `npm ci` installs, not for whatever sits in node_modules.

import { readFileSync } from 'node:fs'

import { expect, test } from '@playwright/test'

const read = (name) => JSON.parse(readFileSync(new URL(`../${name}`, import.meta.url), 'utf8'))
const manifest = read('package.json')
const lock = read('package-lock.json')

const installed = (pattern) => Object.entries(lock.packages).filter(([path]) => pattern.test(path))

test.describe('the vite-plus toolchain is pinned as one release', () => {
  // no page is opened, so the second project would only repeat the same file reads
  test.beforeEach(() => test.skip(test.info().project.name === 'no-jspi', 'one project is enough'))

  const vitePlus = lock.packages['node_modules/vite-plus']
  const core = `npm:@voidzero-dev/vite-plus-core@${vitePlus.version}`

  test('the vite alias names the core of the installed vite-plus, everywhere npm reads it', () => {
    expect(manifest.devDependencies['vite-plus']).toBe(vitePlus.version)
    expect(manifest.devDependencies.vite).toBe(core)
    expect(manifest.overrides.vite).toBe(core)
    const vites = installed(/(^|\/)node_modules\/vite$/).map(([, e]) => `${e.name}@${e.version}`)
    expect(vites).toEqual([`@voidzero-dev/vite-plus-core@${vitePlus.version}`])
  })

  test('the vitest pin is the vitest vite-plus itself depends on', () => {
    expect(vitePlus.dependencies?.vitest).toBeDefined()
    expect(manifest.overrides.vitest).toBe(vitePlus.dependencies?.vitest)
  })

  test('one vitest is installed, and every @vitest package is at the pinned version', () => {
    const copies = installed(/(^|\/)node_modules\/(vitest|@vitest\/[^/]+)$/)
    expect(copies.length, 'the scan found no vitest, so it proves nothing').toBeGreaterThan(1)
    const off = copies
      .filter(([, entry]) => entry.version !== manifest.overrides.vitest)
      .map(([path, entry]) => `${path}@${entry.version}`)
    expect(off).toEqual([])
    expect(copies.filter(([path]) => path.endsWith('node_modules/vitest'))).toHaveLength(1)
  })
})
