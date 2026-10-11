import { execFileSync } from 'node:child_process'

import { defineConfig, devices } from '@playwright/test'

/**
 * Real Chrome, not Playwright's bundled Chromium.
 *
 * Proprietary codec support is a property of the binary: Chromium reports hevc unsupported at every level
 * where real Chrome reports it supported, so a suite running on Chromium silently cannot test the hevc
 * paths at all. Resolved from PATH rather than pinned, because Playwright's `channel: 'chrome'` only looks
 * in distro locations and finds nothing on NixOS.
 */
const findChrome = () => {
  if (process.env.LIBAV_CHROME_PATH) return process.env.LIBAV_CHROME_PATH
  for (const binary of ['google-chrome-stable', 'google-chrome', 'chromium']) {
    try {
      const path = execFileSync('sh', ['-c', `command -v ${binary}`], { encoding: 'utf8' }).trim()
      if (path) return path
    } catch {}
  }
  return undefined
}

const executablePath = findChrome()

// `--mute-audio` is output only, so it cannot change a result
const chrome = {
  ...devices['Desktop Chrome'],
  ...(executablePath ? {} : { channel: 'chrome' }),
  launchOptions: { executablePath, args: ['--mute-audio'] },
}

export default defineConfig({
  testDir: './tests',
  testMatch: '**/*.spec.mjs',
  fullyParallel: false,
  workers: 1,
  timeout: 120_000,
  reporter: process.env.CI ? 'list' : [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: 'http://127.0.0.1:4599',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'node tests/server.mjs 4599',
    url: 'http://127.0.0.1:4599/build/index.js',
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
  /**
   * The same file twice, once per wasm build.
   *
   * `make` emits an Asyncify build and a JSPI one, and the worker picks between them on
   * WebAssembly.Suspending. Chrome has JSPI, so a single project would exercise that build and leave the
   * Asyncify one, which is what every Safari and iOS user gets, almost entirely untested. The `no-jspi`
   * project loads the harness with `?nojspi=1`, which defaults every remuxer to the shim worker that
   * blanks the constructor before the worker module evaluates.
   */
  projects: [
    {
      name: 'chrome',
      use: chrome,
    },
    {
      name: 'no-jspi',
      use: chrome,
    },
  ],
})
