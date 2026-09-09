// Test media, synthesized rather than committed. Nothing here is anyone's content, so there is no
// copyright question and no multi-megabyte blob in git history. What matters for a remuxer is a file's
// STRUCTURE, and every fixture below exists because a real bug needed exactly that structure to show up.
//
// The trick that makes decoded frames assertable: each frame's colour is a function of its timestamp, so
// a thumbnail can be checked back to the second it came from. Without it the only available assertion is
// "some bytes came back", which is how hevc thumbnails silently returned frame one for every timestamp.

import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile, readdir, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const run = promisify(execFile)

export const FIXTURE_DIR = fileURLToPath(new URL('../fixtures/', import.meta.url))

/** red channel carries the second, in steps of 4 so h264 on a flat colour cannot blur two seconds together */
export const SECOND_STEP = 4
export const secondFromRed = (red) => Math.round(red / SECOND_STEP)

const WIDTH = 320
const HEIGHT = 240
const FPS = 10
/** keyframe every 2s, so a 60s fixture has 30 of them to seek between */
const GOP = FPS * 2

const colourByTime = `geq=r='mod(floor(T)*${SECOND_STEP},256)':g='mod(floor(T)*16,256)':b='mod(floor(T)*64,256)'`

/** ffmpeg wants every input before any output option, so the two halves are kept apart deliberately */
const inputs = (size = `${WIDTH}x${HEIGHT}`, fps = FPS) => [
  '-f', 'lavfi', '-i', `color=c=black:s=${size}:r=${fps}`,
  '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
]

const encode = (gop = GOP) => [
  '-filter:v', colourByTime,
  '-g', String(gop), '-keyint_min', String(gop), '-sc_threshold', '0',
]

/**
 * Each entry names the bug it exists to catch. `strict` is for encoders ffmpeg marks experimental.
 */
export const FIXTURES = [
  {
    name: 'h264-aac.mkv',
    why: 'baseline remux, thumbnails and seeking',
    seconds: 60,
    inputs: inputs(),
    args: [...encode(), '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '18', '-pix_fmt', 'yuv420p', '-c:a', 'aac'],
  },
  {
    name: 'h264-ac3.mkv',
    why: 'ac3 used to abort the whole module inside avformat_write_header',
    seconds: 30,
    inputs: inputs(),
    args: [...encode(), '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '18', '-pix_fmt', 'yuv420p', '-c:a', 'ac3'],
  },
  {
    name: 'h264-eac3.mkv',
    why: 'the eac3 transcode path that ac3 now shares',
    seconds: 30,
    inputs: inputs(),
    args: [...encode(), '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '18', '-pix_fmt', 'yuv420p', '-c:a', 'eac3'],
  },
  {
    name: 'hevc10-aac.mkv',
    why: 'hevc offers no prefer-software WebCodecs decoder, and a hardware one repeats frame one',
    seconds: 30,
    inputs: inputs(),
    args: [...encode(), '-c:v', 'libx265', '-preset', 'ultrafast', '-x265-params', 'log-level=none', '-crf', '18', '-pix_fmt', 'yuv420p10le', '-c:a', 'aac'],
  },
  {
    name: 'h264-aac.mp4',
    why: 'mov time_base is not 1/1000, which is the only thing that made the unrescaled seek look correct',
    seconds: 30,
    inputs: inputs(),
    args: [...encode(), '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '18', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-video_track_timescale', '90000'],
  },
  {
    name: 'h264-aac-subs.mkv',
    why: 'the subtitle packet path, which leaked one AVPacket per dialogue line',
    seconds: 30,
    subtitles: true,
    inputs: inputs(),
    args: [...encode(), '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '18', '-pix_fmt', 'yuv420p', '-c:a', 'aac'],
  },
  {
    name: 'h264-truehd.mkv',
    why: 'audio the mp4 muxer cannot write must drop to video only, not abort',
    seconds: 10,
    strict: true,
    inputs: inputs(),
    args: [...encode(), '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '18', '-pix_fmt', 'yuv420p', '-c:a', 'truehd'],
  },

  // One per REASON a container used to fail, not one per extension. Nothing here is about the extension:
  // avi and mpegts fail for what they do to h264, webm for codecs nothing knew how to name.
  {
    name: 'h264-aac.avi',
    why: "avi tags h264 with its own fourcc, and the mp4 muxer refuses tags it does not recognise",
    seconds: 20,
    inputs: inputs(),
    args: [...encode(), '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '20', '-pix_fmt', 'yuv420p', '-c:a', 'aac'],
  },
  {
    name: 'h264-aac.ts',
    why: 'mpegts carries Annex-B video and ADTS audio, and mp4 takes neither as-is',
    seconds: 20,
    // A broadcast capture's clock starts wherever the broadcast's did. mpegts already starts ~1.4s in on
    // its own, but that is inside one GOP, so a seek that never converts back to the input's clock still
    // lands on the right keyframe and looks correct. Ten minutes in, it cannot.
    args: [...encode(), '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '20', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-output_ts_offset', '600'],
    inputs: inputs(),
  },
  {
    name: 'hevc-aac.ts',
    why: 'the hevc profile_tier_level has to be read out of an Annex-B SPS, emulation prevention and all',
    seconds: 20,
    inputs: inputs(),
    args: [...encode(), '-c:v', 'libx265', '-preset', 'ultrafast', '-x265-params', 'log-level=none', '-crf', '20', '-pix_fmt', 'yuv420p', '-c:a', 'aac'],
  },
  {
    name: 'hevc-aac.mkv',
    why: 'the hvcC half of the pair: identical stream to hevc-aac.ts, so the two codec strings must match',
    seconds: 20,
    inputs: inputs(),
    args: [...encode(), '-c:v', 'libx265', '-preset', 'ultrafast', '-x265-params', 'log-level=none', '-crf', '20', '-pix_fmt', 'yuv420p', '-c:a', 'aac'],
  },
  {
    name: 'hevc-rext.mkv',
    why: 'the only hevc profile whose compatibility flags exceed 9, where a decimal printf stops matching hex',
    seconds: 5,
    inputs: inputs(),
    args: [...encode(), '-c:v', 'libx265', '-preset', 'ultrafast', '-x265-params', 'log-level=none', '-crf', '20', '-pix_fmt', 'yuv444p', '-c:a', 'aac'],
  },
  {
    name: 'vp9-opus.webm',
    why: 'vp9 stores its level nowhere, so it is derived from the picture size and rate',
    seconds: 20,
    inputs: inputs(),
    args: [...encode(), '-c:v', 'libvpx-vp9', '-deadline', 'realtime', '-cpu-used', '8', '-crf', '40', '-b:v', '0', '-pix_fmt', 'yuv420p', '-c:a', 'libopus'],
  },
  {
    name: 'av1-opus.webm',
    why: 'av1 keeps profile, level, tier and bit depth in its configuration record',
    seconds: 20,
    inputs: inputs(),
    args: [...encode(), '-c:v', 'libsvtav1', '-preset', '12', '-crf', '50', '-pix_fmt', 'yuv420p', '-c:a', 'libopus'],
  },
  {
    name: 'h264-flac.mkv',
    why: 'flac goes into mp4 untouched, but only with strict experimental set',
    seconds: 20,
    inputs: inputs(),
    args: [...encode(), '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '20', '-pix_fmt', 'yuv420p', '-c:a', 'flac'],
  },
  {
    name: 'h264-vorbis.mkv',
    why: 'mp4 cannot carry vorbis at all, so it has to re-encode rather than be dropped',
    seconds: 20,
    inputs: inputs(),
    args: [...encode(), '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '20', '-pix_fmt', 'yuv420p', '-c:a', 'libvorbis'],
  },
  {
    name: 'cover-art.mp4',
    why: 'a poster marked attached_pic is a video stream too, and picking it thumbnails one frame forever',
    seconds: 20,
    cover: true,
    inputs: inputs(),
    // written out rather than reusing encode(), because every option here has to name stream 0: an
    // unqualified -filter:v or -c:v would be applied to the still as well
    args: [
      '-filter:v:0', colourByTime,
      '-g', String(GOP), '-keyint_min', String(GOP), '-sc_threshold', '0',
      '-c:v:0', 'libx264', '-preset', 'ultrafast', '-crf', '20', '-pix_fmt', 'yuv420p', '-c:a', 'aac',
    ],
  },
  {
    name: 'audio-first.mkv',
    why: 'input and output stream numbering only agree while video comes first, and the map has to be applied',
    seconds: 20,
    maps: ['-map', '1:a', '-map', '1:a', '-map', '0:v'],
    inputs: inputs(),
    args: [...encode(), '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '20', '-pix_fmt', 'yuv420p', '-c:a', 'aac'],
  },
  {
    name: 'h264-pcm.mkv',
    why: 'raw pcm decodes packed, at 16 bit, with no channel layout: none of what the aac encoder takes',
    seconds: 10,
    inputs: inputs(),
    args: [...encode(), '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '20', '-pix_fmt', 'yuv420p', '-c:a', 'pcm_s16le'],
  },
  {
    name: 'h264-wavpack.mkv',
    why: 'a wavpack frame is 22050 samples, where the old staging buffer held 8192 and never checked',
    seconds: 10,
    inputs: inputs('320x240', 10),
    args: [...encode(), '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '20', '-pix_fmt', 'yuv420p', '-c:a', 'wavpack'],
  },
  {
    name: 'two-video.mkv',
    why: 'a trailing preview track must not decide the file is unplayable, so the first usable one wins',
    seconds: 10,
    maps: ['-map', '0:v', '-map', '0:v', '-map', '1:a'],
    inputs: inputs(),
    args: [
      '-filter:v:0', colourByTime,
      '-g', String(GOP), '-keyint_min', String(GOP), '-sc_threshold', '0',
      '-c:v:0', 'libx264', '-preset', 'ultrafast', '-crf', '20', '-pix_fmt:v:0', 'yuv420p',
      // mjpeg's formats are the full-range yuvj ones, and an unqualified -pix_fmt reaches BOTH video
      // outputs. Left as yuv420p the encoder refuses to open at all on a stricter ffmpeg than this
      // machine's ("Non full-range YUV is non-standard"), which fails fixture generation and takes
      // every test in the suite with it. Naming the format per stream is the fix; lowering
      // strict_std_compliance would only hide it.
      '-c:v:1', 'mjpeg', '-pix_fmt:v:1', 'yuvj420p', '-c:a', 'aac',
    ],
  },
  {
    name: 'theora-vorbis.ogv',
    why: 'a video codec no browser can play has to say so, not abort or produce an mp4 nothing accepts',
    seconds: 10,
    inputs: inputs(),
    args: [...encode(), '-c:v', 'libtheora', '-q:v', '5', '-pix_fmt', 'yuv420p', '-c:a', 'libvorbis'],
  },
]

/**
 * Over 4 GB, so byte offsets exceed 2^32. Opt in with LIBAV_LARGE_FIXTURE=1.
 *
 * Uncompressed rather than encoded, because the only thing this fixture has to be is BIG: the test reads
 * index positions and never decodes a frame, so it needs no timestamp colour coding. Trying to reach 4 GB
 * by raising an encoder's bitrate does not work, since a flat colour compresses to nothing whatever the
 * target says. Raw yuv420p at 1080p is 3.1 MB per frame, so this is bytes on disk at write speed.
 */
export const LARGE_FIXTURE = {
  name: 'raw-large.mkv',
  why: 'Index::pos was 32 bits, so every keyframe past 4 GB reported a wrapped position',
  seconds: 50,
  inputs: inputs('1920x1080', 30),
  args: ['-c:v', 'rawvideo', '-pix_fmt', 'yuv420p', '-c:a', 'aac'],
}

const SUBTITLE_TRACK = `1
00:00:01,000 --> 00:00:05,000
first line

2
00:00:06,000 --> 00:00:10,000
second line

3
00:00:11,000 --> 00:00:15,000
third line
`

/** the spec decides the bytes, so its hash decides whether a cached fixture is still valid */
const specHash = (fixture) =>
  createHash('sha256').update(JSON.stringify([fixture.inputs, fixture.args, fixture.seconds, fixture.subtitles, fixture.cover, fixture.maps, SECOND_STEP])).digest('hex').slice(0, 16)

const build = async (fixture) => {
  const target = join(FIXTURE_DIR, fixture.name)
  const stampPath = `${target}.spec`
  const hash = specHash(fixture)

  const cached = await readFile(stampPath, 'utf8').catch(() => null)
  if (cached === hash && await stat(target).then(s => s.size > 0, () => false)) return { ...fixture, path: target, cached: true }

  const args = ['-hide_banner', '-loglevel', 'error', '-y', ...fixture.inputs]
  const maps = fixture.maps ? [...fixture.maps] : ['-map', '0:v', '-map', '1:a']
  const extra = []

  if (fixture.subtitles) {
    const subPath = join(FIXTURE_DIR, `${fixture.name}.srt`)
    await writeFile(subPath, SUBTITLE_TRACK)
    args.push('-i', subPath)
    extra.push('-c:s', 'ass')
    maps.push('-map', '2:s')
  }

  if (fixture.cover) {
    const coverPath = join(FIXTURE_DIR, `${fixture.name}.cover.png`)
    await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=red:s=64x64', '-frames:v', '1', coverPath])
    args.push('-i', coverPath)
    extra.push('-c:v:1', 'png', '-disposition:v:1', 'attached_pic')
    maps.push('-map', '2:v')
  }

  args.push(...fixture.args, ...extra, '-t', String(fixture.seconds), ...maps)
  if (fixture.strict) args.push('-strict', '-2')
  args.push(target)

  await run('ffmpeg', args, { maxBuffer: 64 * 1024 * 1024 })
  await writeFile(stampPath, hash)
  return { ...fixture, path: target, cached: false }
}

export const ensureFixtures = async ({ large = false } = {}) => {
  await mkdir(FIXTURE_DIR, { recursive: true })
  const wanted = [...FIXTURES, ...(large ? [LARGE_FIXTURE] : [])]
  const built = []
  for (const fixture of wanted) {
    const result = await build(fixture)
    built.push(result)
  }
  return built
}

/**
 * Whatever the owner dropped in fixtures/local. Real world files never enter git, so this tier is empty in
 * CI and rich on a machine that has actual releases sitting in it.
 */
export const localFixtures = async () => {
  const dir = join(FIXTURE_DIR, 'local')
  const names = await readdir(dir).catch(() => [])
  return names
    .filter(name => /\.(mkv|mp4|m4v|webm|mov|avi|ts|m2ts|flv|3gp|mpg|ogv|wmv)$/i.test(name))
    // the subdirectory belongs in the name: it is what the test server resolves against the fixture root,
    // and without it every local file 404s. Nothing noticed, because an empty directory skips the test.
    .map(name => ({ name: `local/${name}`, path: join(dir, name), local: true }))
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const large = process.env.LIBAV_LARGE_FIXTURE === '1'
  const built = await ensureFixtures({ large })
  for (const fixture of built) {
    const { size } = await stat(fixture.path)
    console.log(`${fixture.cached ? 'cached ' : 'built  '} ${fixture.name.padEnd(22)} ${(size / 1e6).toFixed(1)} MB   ${fixture.why}`)
  }
  const local = await localFixtures()
  console.log(local.length ? `\n${local.length} local fixture(s) in fixtures/local` : '\nno local fixtures (drop real files in fixtures/local to widen coverage)')
}
