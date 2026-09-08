// Every test here exists because a real bug got through without it. The fixtures are synthesized, so the
// suite needs no committed media and no one else's content; see scripts/fixtures.mjs.

import { expect, test } from '@playwright/test'

import { ensureFixtures, localFixtures, secondFromRed } from '../scripts/fixtures.mjs'

const LARGE = process.env.LIBAV_LARGE_FIXTURE === '1'

test.beforeAll(async () => {
  await ensureFixtures({ large: LARGE })
})

/** the `no-jspi` project runs this whole file a second time against the Asyncify build; see the config */
const withoutJSPI = () => test.info().project.name === 'no-jspi'

const open = async (page) => {
  await page.goto(withoutJSPI() ? '/?nojspi=1' : '/')
  await page.waitForFunction(() => window.harnessReady === true, null, { timeout: 60_000 })
}

/** the fixture's centre pixel encodes the second it came from, so a thumbnail can be checked, not just counted */
const expectFrameAt = (shot, requested, gopSeconds = 2) => {
  expect(shot.error, `readKeyframe(${requested}) failed: ${shot.error}`).toBeUndefined()
  const decoded = secondFromRed(shot.r)
  expect(decoded, `keyframe for t=${requested} decoded as second ${decoded}`).toBeGreaterThanOrEqual(requested - gopSeconds - 1)
  expect(decoded, `keyframe for t=${requested} decoded as second ${decoded}`).toBeLessThanOrEqual(requested + 1)
}

test.describe('remuxing', () => {
  test('a baseline file remuxes into playable fragmented mp4', async ({ page }) => {
    await open(page)
    const result = await page.evaluate(() => window.harness.remux('h264-aac.mkv'))

    expect(result.videoMimeType).toMatch(/^avc1\./)
    expect(result.audioMimeType).toMatch(/^mp4a\./)
    expect(result.duration).toBeGreaterThan(55)
    expect(result.segments.length).toBeGreaterThan(0)
    expect(result.segments[0].bytes).toBeGreaterThan(0)
    // pts must advance, or the player stalls on a repeated segment
    for (let i = 1; i < result.segments.length; i++) {
      expect(result.segments[i].pts).toBeGreaterThan(result.segments[i - 1].pts)
    }
  })

  /*
   * Fragments are cut on LENGTH while a seek is being served, and on keyframes the rest of the time.
   *
   * Before this a fragment WAS a GOP, so a seek could hand nothing back until a whole GOP had been
   * muxed. On a file with ten second keyframes that is ten seconds of muxing for a seek that wanted a
   * fraction of it.
   *
   * The two halves have to be asserted TOGETHER. On the fixtures every fragment used to be 2.00s, so
   * "early fragments are short" alone is what separates the two builds, and "late fragments are whole
   * GOPs again" alone passes on either. Cutting everywhere would cost ordinary playback 14% in round
   * trips for a saving only a seek collects, which is what the second half guards.
   */
  test('a seek is served in short fragments, and playback goes back to whole GOPs', async ({ page }) => {
    await open(page)
    const result = await page.evaluate(() =>
      window.harness.seek('h264-aac.mkv', [20], { reads: 24 }))
    const step = result.steps[0]
    const all = [step, ...step.after]
    expect(all.length, 'not enough fragments to judge').toBeGreaterThan(14)

    const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length
    const early = mean(all.slice(0, 6).map((f) => f.duration))
    const late = mean(all.slice(-6).map((f) => f.duration))

    // the fixtures are encoded with a 2s GOP, so anything near 2 means fragments are still whole GOPs
    expect(early, `fragments right after a seek averaged ${early.toFixed(2)}s, the GOP is 2s`).toBeLessThan(1.4)
    expect(late, `fragments stayed short outside the window, at ${late.toFixed(2)}s`).toBeGreaterThan(1.8)

    // pts advances across every fragment, which is what cutting inside a GOP is most likely to break
    for (let i = 1; i < all.length; i++) {
      expect(all[i].pts, `fragment ${i} did not advance`).toBeGreaterThan(all[i - 1].pts)
    }
  })

  test('MediaSource accepts the output', async ({ page }) => {
    await open(page)
    const result = await page.evaluate(() => window.harness.playable('h264-aac.mkv'))
    expect(result.supported).toBe(true)
    expect(typeof result.buffered, `MSE rejected the bytes: ${JSON.stringify(result.buffered)}`).toBe('number')
    expect(result.buffered).toBeGreaterThan(0)
  })

  // ac3 made avformat_write_header fail, and with no exception support that killed the whole module
  test('ac3 audio transcodes instead of aborting the module', async ({ page }) => {
    await open(page)
    const result = await page.evaluate(() => window.harness.remux('h264-ac3.mkv'))
    expect(result.audioMimeType).toBe('mp4a.40.2')
    expect(result.segments[0].bytes).toBeGreaterThan(0)
  })

  test('eac3 audio transcodes too', async ({ page }) => {
    await open(page)
    const result = await page.evaluate(() => window.harness.remux('h264-eac3.mkv'))
    expect(result.audioMimeType).toBe('mp4a.40.2')
    expect(result.segments[0].bytes).toBeGreaterThan(0)
  })

  // truehd hits the same "cannot write moov before packets" refusal as ac3, and this ffmpeg build turns
  // out to carry a decoder for it, so it transcodes too. What matters is that it never aborts the module.
  test('truehd transcodes rather than aborting the module', async ({ page }) => {
    await open(page)
    const result = await page.evaluate(() => window.harness.remux('h264-truehd.mkv'))
    expect(result.videoMimeType).toMatch(/^avc1\./)
    expect(result.audioMimeType).toBe('mp4a.40.2')
    expect(result.segments[0].bytes).toBeGreaterThan(0)
  })

  test('subtitle tracks come back without breaking the muxed output', async ({ page }) => {
    await open(page)
    const result = await page.evaluate(() => window.harness.remux('h264-aac-subs.mkv'))
    expect(result.subtitleCount).toBeGreaterThan(0)
    expect(result.segments[0].bytes).toBeGreaterThan(0)
  })
})

// One case per REASON a container used to fail, not one per extension. Every one of these produced either
// a module-killing throw or an mp4 with a codec nothing could name, which MediaSource rejects outright.
test.describe('containers', () => {
  const CASES = [
    { name: 'h264-aac.avi', video: /^avc1\./, audio: 'mp4a.40.2', why: "avi's own h264 fourcc reached the mp4 muxer" },
    { name: 'h264-aac.ts', video: /^avc1\./, audio: 'mp4a.40.2', why: 'mpegts hands over Annex-B video and ADTS audio' },
    // exact, for the two the library works out for itself rather than copying from the file. Chrome takes
    // any syntactically valid level, so a regexp here would pass just as happily on a wrong one: 320x240
    // at 10fps is level 2.0 by the table in the vp9 spec, and svt-av1 writes seq_level_idx 0 at 8 bit.
    { name: 'vp9-opus.webm', video: /^vp09\.00\.20\.08$/, audio: 'opus', why: 'vp9 stores no level anywhere, so it is derived' },
    { name: 'av1-opus.webm', video: /^av01\.0\.00M\.08$/, audio: 'opus', why: 'av1 keeps everything in its configuration record' },
    { name: 'cover-art.mp4', video: /^avc1\./, audio: 'mp4a.40.2', why: 'a poster is a video stream lavf will hand over too' },
    { name: 'audio-first.mkv', video: /^avc1\./, audio: 'mp4a.40.2', why: 'the input and output stream numbering disagree' },
    { name: 'two-video.mkv', video: /^avc1\./, audio: 'mp4a.40.2', why: 'a trailing mjpeg preview track must not win' },
    // the aac encoder takes planar float at 1024 samples and nothing else. pcm decodes packed, 16 bit and
    // with no channel layout at all; a wavpack frame is 22050 samples. Both used to be dropped outright,
    // and admitting them without converting first read integers as floats and ran off the end of a buffer.
    { name: 'h264-pcm.mkv', video: /^avc1\./, audio: 'mp4a.40.2', why: 'pcm decodes packed, at 16 bit, with no layout' },
    { name: 'h264-wavpack.mkv', video: /^avc1\./, audio: 'mp4a.40.2', why: 'a wavpack frame is 22050 samples' },
    { name: 'h264-flac.mkv', video: /^avc1\./, audio: 'flac', why: 'flac passes through mp4 untouched' },
    { name: 'h264-vorbis.mkv', video: /^avc1\./, audio: 'mp4a.40.2', why: 'mp4 cannot carry vorbis, so it re-encodes' },
  ]

  for (const { name, video, audio, why } of CASES) {
    test(`${name} plays, because ${why}`, async ({ page }) => {
      await open(page)
      const result = await page.evaluate((n) => window.harness.playable(n), name)

      expect(result.videoMimeType, `${name} produced no usable video codec string`).toMatch(video)
      expect(result.audioMimeType, `${name} produced no usable audio codec string`).toBe(audio)
      expect(result.supported, `MediaSource does not support ${result.mime}`).toBe(true)
      // the codec string being well formed proves nothing about the bytes: an mp4 whose tracks and
      // codecs= disagree is accepted by isTypeSupported and rejected by appendBuffer
      expect(typeof result.buffered, `MSE rejected the bytes: ${JSON.stringify(result.buffered)}`).toBe('number')
      expect(result.buffered).toBeGreaterThan(0)
    })
  }

  /**
   * The same encode in two containers must be named identically.
   *
   * mp4 keeps h264 and hevc parameter sets in a length-prefixed avcC/hvcC record; every other container
   * keeps them as raw Annex-B, which is a different layout behind a start code, and for hevc it is one
   * that also carries emulation prevention bytes through the middle of the profile_tier_level. Comparing
   * the two forms of one stream pins the Annex-B reader to the record reader, and needs no codec support
   * from the browser running the suite: this machine's Chrome decodes no hevc at all, so an assertion
   * about MediaSource would prove nothing here even when the parse is perfect.
   */
  const PAIRS = [
    { annexb: 'h264-aac.ts', record: 'h264-aac.mkv', prefix: 'avc1.' },
    { annexb: 'hevc-aac.ts', record: 'hevc-aac.mkv', prefix: 'hev1.' },
  ]

  for (const { annexb, record, prefix } of PAIRS) {
    test(`${annexb} and ${record} describe the same stream identically`, async ({ page }) => {
      await open(page)
      const fromAnnexB = await page.evaluate((n) => window.harness.remux(n), annexb)
      const fromRecord = await page.evaluate((n) => window.harness.remux(n), record)

      expect(fromRecord.videoMimeType).toMatch(new RegExp(`^${prefix.replace('.', '\\.')}`))
      expect(fromAnnexB.videoMimeType, `${annexb} read out of Annex-B`).toBe(fromRecord.videoMimeType)
    })
  }

  /**
   * The hevc profile-compatibility field is hex, and printed with the wrong base it silently agreed.
   *
   * Main reverses to 6 and Main 10 to 4, so every ordinary hevc file printed the same digits either way
   * and nothing noticed that the printf was decimal. RExt reverses to 0x10, which decimal renders as 16:
   * a codec string a browser matches against nothing. Only the compatibility field is asserted, since the
   * constraint byte after it is the encoder's business and moves between x265 releases.
   */
  test('an hevc profile whose compatibility flags exceed 9 is named in hex', async ({ page }) => {
    await open(page)
    const result = await page.evaluate(() => window.harness.remux('hevc-rext.mkv'))
    expect(result.videoMimeType).toMatch(/^hev1\.4\.10\./)
  })

  // theora has no mp4 mapping and no browser decodes it, so this one cannot be made to play. What it must
  // not do is take the module down, or hand back a pointer where a reason belongs.
  test('a video codec that cannot reach a browser says so', async ({ page }) => {
    await open(page)
    const message = await page.evaluate(() =>
      window.harness.remux('theora-vorbis.ogv').then(() => 'no error at all', (error) => String(error))
    )
    expect(message).toContain('No playable video track')
  })

  // A poster is a video stream as far as lavf is concerned, and it comes last, so taking the last video
  // stream found makes every seek and every thumbnail read one still forever. The same silent wrongness
  // the hevc thumbnail test exists for, reached from a different direction.
  test('a cover image is not mistaken for the video track', async ({ page }) => {
    await open(page)
    const times = [4, 12]
    const result = await page.evaluate((t) => window.harness.thumbnails('cover-art.mp4', t), times)

    for (const shot of result.shots) expectFrameAt(shot, shot.t)
    expect(new Set(result.shots.map(s => secondFromRed(s.r))).size).toBe(times.length)
  })

  // Same clock, through the other entry point. readKeyframe seeks on its own and decodes the frame, so
  // the fixture's colour says outright which second came back: a seek that never converts the target back
  // into the input's clock hands over second 0 for every timestamp asked for.
  test('thumbnails land on the right second when the clock does not start at zero', async ({ page }) => {
    await open(page)
    const times = [4, 10, 16]
    const result = await page.evaluate((t) => window.harness.thumbnails('h264-aac.ts', t), times)

    for (const shot of result.shots) expectFrameAt(shot, shot.t)
    expect(new Set(result.shots.map(s => secondFromRed(s.r))).size).toBe(times.length)
  })

  // a file the muxer refuses is exactly when a thumbnail matters most, and the thumbnail path shares none
  // of the muxer's limits: it decodes in wasm and hands back pixels
  test('thumbnails still work for a file that cannot be remuxed', async ({ page }) => {
    await open(page)
    const result = await page.evaluate(() => window.harness.thumbnails('theora-vorbis.ogv', [2, 6]))
    for (const shot of result.shots) expectFrameAt(shot, shot.t)
  })
})

test.describe('seeking', () => {
  test('seeks land on the requested position, forwards and backwards', async ({ page }) => {
    await open(page)
    const { steps } = await page.evaluate(() => window.harness.seek('h264-aac.mkv', [30, 10, 45, 30]))

    for (const step of steps) {
      expect(Math.abs(step.pts - step.target), `seek(${step.target}) landed at ${step.pts}`).toBeLessThanOrEqual(3)
    }
    // returning to a visited point must reproduce it, or the rebuild is not deterministic
    const first = steps.find(s => s.target === 30)
    const again = steps.filter(s => s.target === 30).at(-1)
    expect(again.bytes).toBe(first.bytes)
    expect(again.pts).toBe(first.pts)
  })

  /**
   * mpegts starts its clock wherever the broadcast's happened to be, roughly 1.4s into this fixture and
   * legitimately anywhere at all in a real one, and it carries no index to seek by either. Both showed up
   * as a seek to 12s reporting 0: no second keyframe arrived before the first fragment flushed, so the
   * result carried the zero the fragment was reset to, and once that was fixed it reported 13.42.
   */
  test('seeking is correct in a container whose clock does not start at zero', async ({ page }) => {
    await open(page)
    const { steps } = await page.evaluate(() => window.harness.seek('h264-aac.ts', [12, 4, 16]))
    expect(new Set(steps.map(s => s.bytes)).size, 'every seek returned the same bytes').toBe(steps.length)
    for (const step of steps) {
      // at or before the target, never after: a seek lands on the keyframe at or before what was asked
      // for, so anything later is the file's own clock leaking into the output rather than a rounding
      // difference. Any tolerance wide enough for the keyframe interval also hides that offset.
      expect(step.pts, `seek(${step.target}) landed at ${step.pts}, past the target`).toBeLessThanOrEqual(step.target + 0.001)
      expect(step.target - step.pts, `seek(${step.target}) landed at ${step.pts}`).toBeLessThanOrEqual(3)
    }
    expect(new Set(steps.map(s => s.pts)).size, 'every seek landed in the same place').toBe(steps.length)
  })

  /**
   * The same target, twice, must answer the same.
   *
   * A seek tears the input down and opens it again, and how much lavf probes on that second open depends
   * on the read size, so it can settle on a different start_time than the first open did. Deriving the
   * content offset from it each time then moves the whole reported timeline underneath a caller who has
   * already been told where it is: the second seek to 8s reported 0 for an mpegts whose video starts
   * later than its audio, and 9.8 for one where it does not. The offset is a property of the file.
   */
  test('seeking twice to the same place answers the same, whatever the read size', async ({ page }) => {
    await open(page)
    const { steps } = await page.evaluate(() => window.harness.seek('h264-aac.ts', [8, 8], { bufferSize: 65_536 }))

    const [first, again] = steps
    expect(again.pts, `seek(8) gave ${first.pts} then ${again.pts}`).toBe(first.pts)
    expect(again.bytes).toBe(first.bytes)
    expect(Math.abs(first.pts - 8)).toBeLessThanOrEqual(3)
  })

  // mov timescales are not 1/1000, which is the only reason an unrescaled millisecond value ever worked
  test('seeking is correct in a container whose time base is not 1/1000', async ({ page }) => {
    await open(page)
    const { steps } = await page.evaluate(() => window.harness.seek('h264-aac.mp4', [10, 20]))
    for (const step of steps) {
      expect(Math.abs(step.pts - step.target), `seek(${step.target}) landed at ${step.pts}`).toBeLessThanOrEqual(3)
    }
  })
})

test.describe('thumbnails', () => {
  test('each keyframe decodes to the frame that belongs at that timestamp', async ({ page }) => {
    await open(page)
    const times = [8, 20, 40]
    const result = await page.evaluate((t) => window.harness.thumbnails('h264-aac.mkv', t), times)

    expect(result.indexCount).toBeGreaterThan(0)
    for (const shot of result.shots) expectFrameAt(shot, shot.t)
    // distinct frames, which is what a hardware decoder repeating frame one destroyed. Compared on the
    // decoded second rather than byte count: two different flat colours can compress to the same size.
    expect(new Set(result.shots.map(s => secondFromRed(s.r))).size).toBe(times.length)
  })

  // hevc is never offered with prefer-software, so WebCodecs would hand back a hardware decoder that
  // returns the first frame of the file for every timestamp. libav decodes it correctly instead.
  test('hevc keyframes are distinct and correct', async ({ page }) => {
    await open(page)
    const times = [6, 14, 24]
    const result = await page.evaluate((t) => window.harness.thumbnails('hevc10-aac.mkv', t), times)

    for (const shot of result.shots) expectFrameAt(shot, shot.t)
    expect(new Set(result.shots.map(s => secondFromRed(s.r))).size).toBe(times.length)
  })

  test('the thumbnailer opens a file whose audio the muxer refuses', async ({ page }) => {
    await open(page)
    const result = await page.evaluate(() => window.harness.thumbnails('h264-truehd.mkv', [4, 8]))
    for (const shot of result.shots) expectFrameAt(shot, shot.t)
  })

  test('the thumbnailer and the remuxer produce the same frames', async ({ page }) => {
    await open(page)
    const times = [8, 20]
    const viaThumbnailer = await page.evaluate((t) => window.harness.thumbnails('h264-aac.mkv', t), times)
    const viaRemuxer = await page.evaluate((t) => window.harness.thumbnails('h264-aac.mkv', t, { viaRemuxer: true }), times)
    expect(viaThumbnailer.shots.map(s => secondFromRed(s.r))).toEqual(viaRemuxer.shots.map(s => secondFromRed(s.r)))
    expect(viaThumbnailer.shots.map(s => s.bytes)).toEqual(viaRemuxer.shots.map(s => s.bytes))
  })
})

// Two builds of the same source ship side by side: JSPI where the engine can switch stacks, Asyncify
// everywhere else. Chrome runs the suite, so every other test above exercises the JSPI build only, and
// without this one the Asyncify build could rot unnoticed until a Safari user hit it.
test.describe('without JSPI', () => {
  const workerUrl = '/no-jspi-worker.js'

  // in the no-jspi project the default worker is ALREADY the shim, so these would compare the fallback
  // against itself and pass without proving anything
  test.skip(() => withoutJSPI(), 'the no-jspi project runs the whole file on the fallback already')

  test('the Asyncify build produces the same bytes as the JSPI build', async ({ page }) => {
    await open(page)
    const jspi = await page.evaluate(() => window.harness.remux('h264-aac.mkv'))
    const asyncify = await page.evaluate((url) => window.harness.remux('h264-aac.mkv', { workerUrl: url }), workerUrl)

    expect(asyncify.videoMimeType).toBe(jspi.videoMimeType)
    expect(asyncify.audioMimeType).toBe(jspi.audioMimeType)
    expect(asyncify.initBytes).toBe(jspi.initBytes)
    expect(asyncify.segments.map((s) => s.bytes)).toEqual(jspi.segments.map((s) => s.bytes))
  })

  // the fallback has its own exception path: -fexceptions throws a pointer where -fwasm-exceptions throws
  // a WebAssembly.Exception, and reading the message back is a different call in each
  test('a failure still reports its reason on the fallback', async ({ page }) => {
    await open(page)
    const message = await page.evaluate((url) =>
      window.harness.remux('theora-vorbis.ogv', { workerUrl: url }).then(() => 'no error at all', (error) => String(error)),
    workerUrl)
    expect(message).toContain('No playable video track')
  })

  // seeking is the deepest suspend path: it tears the input and output contexts down and rebuilds them,
  // so it unwinds repeatedly through the whole of avformat
  test('seeking works on the fallback too', async ({ page }) => {
    await open(page)
    const jspi = await page.evaluate(() => window.harness.seek('h264-aac.mkv', [10, 4]))
    const asyncify = await page.evaluate((url) => window.harness.seek('h264-aac.mkv', [10, 4], { workerUrl: url }), workerUrl)
    expect(asyncify.steps.map((s) => s.pts)).toEqual(jspi.steps.map((s) => s.pts))
    expect(asyncify.steps.every((s) => s.bytes > 0)).toBe(true)
  })
})

test.describe('without WebCodecs', () => {
  const workerUrl = '/no-webcodecs-worker.js'

  // building a VideoDecoder eagerly in makeRemuxer took PLAYBACK down on Firefox for Android, for a
  // thumbnail feature playback never used
  test('playback is unaffected when WebCodecs is missing', async ({ page }) => {
    await open(page)
    const withCodecs = await page.evaluate(() => window.harness.remux('h264-aac.mkv'))
    const without = await page.evaluate((url) => window.harness.remux('h264-aac.mkv', { workerUrl: url }), workerUrl)

    expect(without.initBytes).toBe(withCodecs.initBytes)
    expect(without.segments.map(s => s.bytes)).toEqual(withCodecs.segments.map(s => s.bytes))
  })

  test('thumbnails still decode, in wasm', async ({ page }) => {
    await open(page)
    const times = [8, 20]
    const result = await page.evaluate(
      ([t, url]) => window.harness.thumbnails('h264-aac.mkv', t, { workerUrl: url }),
      [times, workerUrl],
    )
    for (const shot of result.shots) expectFrameAt(shot, shot.t)
  })
})

test.describe('byte offsets', () => {
  test('index positions increase and stay inside the file', async ({ page }) => {
    await open(page)
    const result = await page.evaluate(() => window.harness.indexes('h264-aac.mkv'))
    expect(result.backwards).toBe(0)
    expect(result.maxPos).toBeLessThanOrEqual(result.length)
  })

  // Index::pos was 32 bits, so every keyframe past 4 GB reported a position about 4 GB too low
  test('positions do not wrap above 4 GB', async ({ page }) => {
    test.skip(!LARGE, 'set LIBAV_LARGE_FIXTURE=1 to build the >4 GB fixture')
    test.setTimeout(300_000)
    await open(page)
    const result = await page.evaluate(() => window.harness.indexes('raw-large.mkv'))

    expect(result.length).toBeGreaterThan(2 ** 32)
    expect(result.backwards).toBe(0)
    expect(result.maxPos).toBeGreaterThan(2 ** 32)
    expect(result.maxPos).toBeLessThanOrEqual(result.length)
  })
})

// Whatever real files the owner dropped in fixtures/local. Empty in CI, and never committed, so wild
// coverage costs nothing in the repo. These assert only what must hold for ANY file.
test.describe('local files', () => {
  test('every local fixture opens, remuxes and thumbnails', async ({ page }) => {
    const local = await localFixtures()
    test.skip(local.length === 0, 'drop real files in fixtures/local to run this')
    test.setTimeout(120_000 * local.length)
    await open(page)

    for (const fixture of local) {
      const remuxed = await page.evaluate((name) => window.harness.remux(name), fixture.name)
      expect(remuxed.videoMimeType, `${fixture.name} produced no video codec`).toBeTruthy()
      expect(remuxed.segments[0].bytes, `${fixture.name} produced no data`).toBeGreaterThan(0)

      const indexes = await page.evaluate((name) => window.harness.indexes(name), fixture.name)
      expect(indexes.backwards, `${fixture.name} index positions went backwards`).toBe(0)
      expect(indexes.maxPos, `${fixture.name} index position past end of file`).toBeLessThanOrEqual(indexes.length)
    }
  })
})
