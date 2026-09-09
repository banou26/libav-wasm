import PQueue from 'p-queue'
import type { Resolvers } from './worker'
import type { SubtitleFragment } from './worker'

import { expose, transfer } from 'osra'
export * from './utils'

/**
 * The codecs a browser might take in an mp4, and the string to ask about each one by.
 *
 * `MediaSource.isTypeSupported` is the oracle, and `canPlayType` is NOT a substitute: Chrome answers
 * "probably" for mp3 in mp4 and then refuses the same type in MediaSource, so trusting the element would
 * pass through audio that never decodes.
 */
const AUDIO_PROBES: readonly (readonly [string, string])[] = [
  ['aac', 'audio/mp4; codecs="mp4a.40.2"'],
  ['opus', 'audio/mp4; codecs="opus"'],
  ['flac', 'audio/mp4; codecs="flac"'],
  ['ac3', 'audio/mp4; codecs="ac-3"'],
  ['eac3', 'audio/mp4; codecs="ec-3"'],
]

/** what every build passed through before the browser was asked, and the answer when it cannot be */
const DEFAULT_AUDIO_CODECS = ['aac', 'opus', 'flac']

/**
 * Which audio codecs this browser will accept in an mp4, asked rather than assumed.
 *
 * Transcoding costs the majority of a seek on the files that need it, and it exists only because a
 * browser will not take the codec. That answer is not fixed: the same Chrome takes ec-3 on Windows and
 * refuses it on Linux, so a hardcoded list transcodes for everyone to satisfy the strictest browser.
 *
 * Narrows rather than widens on any doubt. A browser handed a codec it cannot decode fails as silent
 * audio, not as an error, which is far worse than a transcode that was not needed.
 */
export const supportedAudioCodecs = (): string[] => {
  const mediaSource = (globalThis as { MediaSource?: typeof MediaSource }).MediaSource
  if (typeof mediaSource?.isTypeSupported !== 'function') return [...DEFAULT_AUDIO_CODECS]
  const supported = AUDIO_PROBES
    .filter(([, type]) => { try { return mediaSource.isTypeSupported(type) } catch { return false } })
    .map(([name]) => name)
  // a browser that says no to aac is answering wrong, not describing itself
  return supported.includes('aac') ? supported : [...DEFAULT_AUDIO_CODECS]
}

export type MakeTransmuxerOptions = {
  /** Path that will be used to locate the .wasm file imported from the worker */
  publicPath: string
  /** Path that will be used to locate the javascript worker file */
  workerUrl: string
  workerOptions?: WorkerOptions
  read: (offset: number, size: number) => Promise<ArrayBuffer>
  length: number
  /** how much the demuxer reads ahead; defaults to 2.5 MB for a remuxer and 1 MB for a thumbnailer */
  bufferSize?: number
  /** Input stream index of the audio track to mux; defaults to the first audio stream */
  audioStreamIndex?: number
  /**
   * Set false to copy each read across to the worker instead of handing it over. Defaults to true.
   *
   * `read` gives up ownership of the buffer it returns: it is DETACHED once handed over, so a consumer
   * answering out of its own cache has to return a copy rather than the bytes it keeps. That is the
   * normal shape already (a fetch, a worker transfer, a slice all produce a fresh buffer), and moving
   * rather than cloning measured 15% off a session, since the whole payload crosses the hop every read.
   */
  transferReads?: boolean
  /**
   * Audio codecs to pass through instead of re-encoding, by the names `supportedAudioCodecs` returns.
   * Defaults to asking this browser. Pass a narrower list to override, never a wider one than the
   * playback target can decode.
   */
  audioCodecs?: string[]
}

const abortSignalToPromise = (abortSignal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (abortSignal.aborted) {
      return reject()
    }
    abortSignal.addEventListener('abort', () => {
      reject()
    })
  })

/**
 * The worker, the wasm instance and the serialized task queue that both public entry points share.
 *
 * Split out because a thumbnailer and a remuxer need identical plumbing and nothing else in common: only
 * which wasm entry point they open the file with, and which calls they then expose.
 */
const makeSession = async ({
  publicPath,
  workerUrl,
  workerOptions,
  read,
  length,
  bufferSize,
  audioStreamIndex,
  audioCodecs,
  transferReads = true
}: MakeTransmuxerOptions & { bufferSize: number }) => {
  const worker = new Worker(workerUrl, workerOptions)

  const { makeRemuxer } = await expose<Resolvers>({}, { transport: worker })

  const remuxer = await makeRemuxer({
    publicPath,
    length,
    bufferSize,
    audioStreamIndex,
    audioCodecs: audioCodecs ?? supportedAudioCodecs()
  })

  const queue = new PQueue({ concurrency: 1 })

  /**
   * The one way transferring can go wrong, said out loud instead of left to be debugged.
   *
   * A consumer that answers out of its own cache hands back a buffer we detached on an earlier read, and
   * a detached buffer reports zero bytes. ffmpeg reads zero bytes as EOF, so the file silently truncates
   * at whatever offset that happened rather than failing anywhere near the cause. Zero bytes at or past
   * the end of the file is ordinary EOF and says nothing, so only a short read BEFORE the end is a tell.
   */
  let warnedDetached = false
  const warnIfDetached = (buffer: ArrayBuffer, offset: number) => {
    if (warnedDetached || !transferReads || buffer.byteLength > 0 || offset >= length) return
    warnedDetached = true
    console.warn(
      `libav-wasm: read(${offset}) returned 0 bytes, ${length - offset} bytes before the end of the file. `
      + 'Reads are transferred, so the buffer read() returns is detached in the caller and handing back '
      + 'bytes you keep returns that same detached buffer. Return a copy, or pass transferReads: false.'
    )
  }

  const wasmRead = (abortController: AbortController) => (offset: number, size: number) => {
    if (abortController.signal.aborted) return Promise.resolve({ resolved: new Uint8Array(0).buffer, rejected: true })
    return Promise.race([
      read(Number(offset), Number(size))
        .then(
          buffer => {
            warnIfDetached(buffer, Number(offset))
            const owned = new Uint8Array(buffer).buffer
            return { resolved: transferReads ? transfer(owned) : owned, rejected: false }
          },
          () => ({ resolved: new Uint8Array(0).buffer, rejected: true })
        ),
      abortSignalToPromise(abortController.signal)
        .then(
          () => ({ resolved: new Uint8Array(0).buffer, rejected: true }),
          () => ({ resolved: new Uint8Array(0).buffer, rejected: true })
        )
    ])
  }

  let abortControllers: AbortController[] = []

  const addTask = <T extends (abortController: AbortController) => Promise<any>>(func: T) => {
    const currentAbortControllers = [...abortControllers]
    abortControllers = []
    queue.clear()
    currentAbortControllers.forEach(abortController => abortController.abort())
    const abortController = new AbortController()
    abortControllers = [...abortControllers, abortController]
    return Promise.race([
      queue.add<Awaited<ReturnType<T>>>(
        async () => func(abortController),
        { signal: abortController.signal }
      ),
      abortSignalToPromise(abortController.signal)
        .then(
          () => Promise.reject(new Error('Cancelled')),
          () => Promise.reject(new Error('Cancelled'))
        )
    ])
  }

  const destroy = async () => {
    const currentAbortControllers = [...abortControllers]
    abortControllers = []
    queue.clear()
    currentAbortControllers.forEach(abortController => abortController.abort())
    await remuxer.destroy()
    worker.terminate()
  }

  return { worker, remuxer, wasmRead, addTask, destroy }
}

export const makeRemuxer = async (options: MakeTransmuxerOptions) => {
  const { worker, remuxer, wasmRead, addTask, destroy } = await makeSession({
    ...options,
    bufferSize: options.bufferSize ?? 2_500_000
  })

  return {
    worker,
    init: () => addTask((abortController) => remuxer.init(wasmRead(abortController))),
    destroy,
    seek: (timestamp: number) => addTask((abortController) => remuxer.seek(wasmRead(abortController), timestamp)),
    read: () => addTask((abortController) => remuxer.read(wasmRead(abortController))),
    readKeyframe: (timestamp: number) => addTask((abortController) => remuxer.readKeyframe(wasmRead(abortController), timestamp)),
    /** Takes effect on the next seek */
    setAudioStreamIndex: (index: number) => remuxer.setAudioStreamIndex(index)
  }
}

/**
 * Open a file for thumbnails only. No output muxer, no encoder, no stream map, no header.
 *
 * `readKeyframe` seeks BACKWARD on the input, which an output muxer cannot follow, so a remuxer that also
 * served thumbnails could only be kept correct by never doing both on one instance. There is no muxer here
 * to damage. It also opens files whose audio the muxer refuses outright, which a remuxer cannot.
 */
export const makeThumbnailer = async (options: MakeTransmuxerOptions) => {
  const { worker, remuxer, wasmRead, addTask, destroy } = await makeSession({
    ...options,
    bufferSize: options.bufferSize ?? 1_000_000
  })

  return {
    worker,
    init: () => addTask((abortController) => remuxer.initThumbnail(wasmRead(abortController))),
    readKeyframe: (timestamp: number) => addTask((abortController) => remuxer.readKeyframe(wasmRead(abortController), timestamp)),
    destroy
  }
}
