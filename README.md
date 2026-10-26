# libav-wasm

Remuxes a video file into fragmented MP4 in the browser, a fragment at a time, from a `read(offset, size)`
you supply. Nothing is downloaded up front and nothing is written to disk, so it plays a file over HTTP
range requests, out of a torrent, or out of anything else that can answer for a byte range.

ffmpeg 7.1 compiled to wasm with emscripten. [src/test.ts](./src/test.ts) is a working player.

## What it accepts

Any container ffmpeg can demux: mkv, mp4, mov, webm, avi, mpegts, flv, 3gp and the rest. What decides
whether a file plays is the **codec**, not the extension.

| | passes through | re-encoded to aac | not playable |
| --- | --- | --- | --- |
| video | h264, hevc, vp9, av1 | | anything else |
| audio | aac, opus, flac | ac3, eac3, truehd, dts, mp3, vorbis, wma, pcm, … | codecs with no decoder |

Video is never re-encoded, so a codec no browser can decode (mpeg2, mpeg4 part 2, theora, vc1) cannot be
rescued and `init()` rejects saying so. Audio always can be, and is, so a track the mp4 muxer will not
carry never costs you the file. Thumbnails have none of these limits: they decode in wasm and hand back
pixels, so they work on files that cannot be remuxed at all.

Timestamps are reported relative to the start of the content, so a format whose clock starts elsewhere
(mpegts) still lines up with a player's timeline.

## Usage

```ts
import { makeRemuxer } from 'libav-wasm'

const remuxer = await makeRemuxer({
  // where libav.wasm AND libav-jspi.wasm are served from; the worker picks one at runtime
  publicPath: new URL('/dist/', new URL(import.meta.url).origin).toString(),
  workerUrl: new URL('../build/worker.js', import.meta.url).toString(),
  workerOptions: { type: 'module' },
  length: contentLength,
  read: (offset, size) =>
    fetch(VIDEO_URL, { headers: { Range: `bytes=${offset}-${offset + size - 1}` } })
      .then(res => res.arrayBuffer()),
})

// the mp4 init segment, plus every piece of metadata the file carries
const { data, info, indexes, subtitles, attachments, chapters } = await remuxer.init()
const codecs = [info.output.videoMimeType, info.output.audioMimeType].filter(Boolean).join(',')
const mime = `video/mp4; codecs="${codecs}"`

// { data, pts, duration, offset, finished }: data appends straight to a SourceBuffer
const chunk = await remuxer.read()

// rebuilds the muxer and starts again from the keyframe at or before this timestamp
const seeked = await remuxer.seek(90)

await remuxer.destroy()
```

### `read` gives up the buffer it returns

The buffer `read` resolves with is **transferred** to the worker, not copied, so it is detached in your
code once you hand it over. Returning a fresh buffer per read is the normal shape and needs no thought: a
`fetch(...).arrayBuffer()`, a buffer transferred out of another worker, or a `slice` all qualify. Only a
consumer answering out of a cache it keeps has to do anything, and what it has to do is return a copy.

Copying the whole payload across the worker boundary on every read is not cheap: at the default 2.5 MB
buffer a session moves close to a gigabyte, and transferring instead measured 15% off a full remux
(2264.8 ms to 1918.3 ms, 382 reads, medians over 7 alternated rounds). Pass `transferReads: false` to go
back to copying.

Handing back bytes you kept detaches them, and a detached buffer reads as zero bytes, which ffmpeg takes
for EOF: the file would truncate silently at that offset. The first time a read comes back empty before
the end of the file, the library says so on the console.

`makeThumbnailer` opens the same file with no muxer, no encoder and no stream map, for `readKeyframe(t)`
alone. Use it rather than a remuxer: `readKeyframe` seeks backward on the input, which an output muxer
cannot follow, and a thumbnailer has no muxer to damage.

## Building

`npm run build` compiles `src/main.cpp` in Docker (emsdk plus ffmpeg, cached after the first run), bundles
the library and the worker, and emits types. Only the last step re-runs when you touch C++, so the loop is
about 25 seconds.

ffmpeg is built with every patch in [patches/](./patches) applied, each saying at its head what it changes and
why. Adding or editing one rebuilds ffmpeg on the next `npm run build`, which took 99 seconds here.

### Two builds, one source

`make` emits **both** `libav.wasm` and `libav-jspi.wasm`, and the worker picks between them at runtime on
`typeof WebAssembly.Suspending === 'function'`. **Both files have to be reachable at `publicPath`**, since
the choice happens in the browser rather than at build time.

The JSPI build lets the engine switch stacks, so nothing is instrumented: it remuxes the same file in
549.3ms against the Asyncify build's 641.5ms, and its wasm is 2.2 MB smaller. Chrome and Edge have had JSPI
since 137 and Firefox since 153; Safari has none, and iOS is Safari whatever the badge says, which is the
whole reason the Asyncify build still ships.

The Chrome-only suite would exercise JSPI and nothing else, so `tests/no-jspi-worker.js` blanks the
constructor before the worker evaluates and the `without JSPI` tests run the fallback for real. They assert
byte-identical output, not merely "it ran".

## Tests

`npm test` runs a browser suite against fixtures it synthesizes with ffmpeg (and mkvmerge, for a file with
two chapter editions) on first run. Nothing is committed and nothing is anyone's content, so there is no
copyright question and no multi-megabyte blob in git history: what matters for a remuxer is a file's
structure, and every fixture exists because a real bug needed exactly that structure to show up.

Each fixture encodes its own timestamp in the frame's colour, so a decoded thumbnail can be checked back to
the second it came from. Without that the only available assertion is "some bytes came back", which is how
hevc thumbnails silently returned frame one for every timestamp.

Drop real files in `fixtures/local/` to widen coverage. That directory is gitignored, and those tests
assert only what has to hold for any file. `npm run test:large` adds a fixture over 4 GB for the byte
offset tests.

Real Chrome is used rather than Playwright's bundled Chromium, because codec support is a property of the
binary: Chromium reports hevc unsupported where Chrome supports it. Set `LIBAV_CHROME_PATH` if Chrome is
not on `PATH`.

## Intellisense

For C++ autocompletion, clone into the repo root:
`git clone https://github.com/FFmpeg/FFmpeg` and `git clone https://github.com/emscripten-core/emscripten`

## Ideas

- `sourceBuffer.timestampOffset` with always-increasing timestamps, to avoid re-initialising on a backwards seek
- video transcoding, the only thing that would make mpeg2, mpeg4 part 2 and theora playable
- audio codec reference: https://cconcolato.github.io/media-mime-support/#audio_codecs
- `getIndexes()` on the remuxer, re-running the same keyframe walk `init` does, so the index can grow
  as `read()` demuxes. `indexes` is the container's declared index rather than a scan, so a file with
  no Cues comes back with about two entries and no way to tell that apart from a short file. Measured
  on three 38MB matroska files differing only in Cues placement: at the front, 20 entries; at the end,
  the same 20 at the cost of one read at the tail; with no Cues at all, 2. The C++ already has the
  walk in `init` and `initThumbnail`, so the plumbing is small. **Not planned**, on two findings since:
  `seek()` calls `destroy_input()`, so every accumulated entry is discarded on each seek and rebuilt
  from Cues alone; and `Index.index` is the loop counter over the full AVIndexEntry array rather than a
  keyframe ordinal, which matroska inserts into in timestamp order, so it shifts between calls.

<!-- https://www.ffmpeg.org/doxygen/trunk/remuxing_8c-example.html -->
<!-- https://github.com/leandromoreira/ffmpeg-libav-tutorial -->
