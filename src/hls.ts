import type { MakeTransmuxerOptions } from './index'
import { makeRemuxer } from './index'

export type HlsSegmentInfo = {
  index: number
  /** Segment duration in seconds */
  duration: number
  /** Segment start time in seconds */
  timestamp: number
}

export type HlsInitResult = {
  /** Media info (codecs, duration, etc.) */
  info: {
    input: { audioMimeType: string; duration: number; formatName: string; mimeType: string; videoMimeType: string }
    output: { audioMimeType: string; duration: number; formatName: string; mimeType: string; videoMimeType: string }
  }
  /** fMP4 init segment (moov box) as ArrayBuffer */
  initSegment: ArrayBuffer
  /** Complete m3u8 playlist content */
  playlist: string
  /** Playlist as a blob URL, ready to pass to video.js / hls.js */
  playlistUrl: string
  /** Segment info derived from keyframe index */
  segments: HlsSegmentInfo[]
  /** Attachments (fonts, etc.) */
  attachments: { filename: string; mimetype: string; data: ArrayBuffer }[]
  /** Subtitle headers */
  subtitles: any[]
  /** Chapter list */
  chapters: { index: number; start: number; end: number; title: string }[]
  /**
   * Custom hls.js fragment loader class.
   * Pass this to hls.js config to enable lazy segment loading:
   * ```js
   * new Hls({ fLoader: initResult.fragLoader })
   * ```
   */
  fragLoader: new (config: any) => any
}

export type HlsRemuxerOptions = MakeTransmuxerOptions & {
  /**
   * Base path used in the m3u8 playlist for segment URLs.
   * Segments are referenced as `${segmentBasePath}segment-{index}.m4s`
   * Default: "" (relative URLs)
   */
  segmentBasePath?: string
}

export type HlsRemuxer = {
  /**
   * Initialize the remuxer — probes the input, builds the complete
   * m3u8 playlist from the keyframe index, and returns a custom hls.js
   * loader for lazy segment fetching.
   */
  init: () => Promise<HlsInitResult>

  /**
   * Fetch a specific segment by index. Called automatically by the
   * custom hls.js loader, but can also be called manually.
   * Returns the fMP4 segment data (moof+mdat).
   */
  fetchSegment: (index: number) => Promise<ArrayBuffer>

  /**
   * Clean up and destroy the underlying remuxer.
   */
  destroy: () => Promise<void>
}

/**
 * Creates an HLS remuxer that wraps the existing fMP4 remuxer.
 *
 * On init(), the complete m3u8 playlist is generated from the keyframe
 * index — no need to read all segments first. A custom hls.js fragment
 * loader lazily fetches segments via seek() when the player requests them.
 *
 * Usage with hls.js:
 * ```js
 * const hlsRemuxer = await makeHlsRemuxer({ ...options })
 * const { playlistUrl, initSegment, fragLoader } = await hlsRemuxer.init()
 *
 * const hls = new Hls({ fLoader: fragLoader })
 * hls.loadSource(playlistUrl)
 * hls.attachMedia(videoElement)
 * ```
 *
 * Usage with video.js (via videojs-http-streaming which uses hls.js):
 * ```js
 * const hlsRemuxer = await makeHlsRemuxer({ ...options })
 * const { playlistUrl, fragLoader } = await hlsRemuxer.init()
 *
 * const player = videojs(el, {
 *   html5: {
 *     vhs: { overrideNative: true },
 *     hlsjsConfig: { fLoader: fragLoader }
 *   }
 * })
 * player.src({ src: playlistUrl, type: 'application/x-mpegURL' })
 * ```
 */
export const makeHlsRemuxer = async (options: HlsRemuxerOptions): Promise<HlsRemuxer> => {
  const { segmentBasePath = '', ...remuxerOptions } = options
  const remuxer = await makeRemuxer(remuxerOptions)

  let segmentInfos: HlsSegmentInfo[] = []
  let initSegmentData: ArrayBuffer | null = null
  let playlistBlobUrl: string | null = null
  let initSegmentBlobUrl: string | null = null

  // Cache fetched segments so repeated requests don't re-seek
  const segmentCache = new Map<number, ArrayBuffer>()

  const buildPlaylist = (
    segments: HlsSegmentInfo[],
    initSegUrl: string
  ): string => {
    const maxDuration = Math.ceil(
      segments.reduce((max, s) => Math.max(max, s.duration), 0)
    )

    let m3u8 = '#EXTM3U\n'
    m3u8 += '#EXT-X-VERSION:7\n'
    m3u8 += `#EXT-X-TARGETDURATION:${Math.max(maxDuration, 1)}\n`
    m3u8 += '#EXT-X-MEDIA-SEQUENCE:0\n'
    m3u8 += '#EXT-X-PLAYLIST-TYPE:VOD\n'
    m3u8 += `#EXT-X-MAP:URI="${initSegUrl}"\n`

    for (const segment of segments) {
      m3u8 += `#EXTINF:${segment.duration.toFixed(6)},\n`
      m3u8 += `${segmentBasePath}segment-${segment.index}.m4s\n`
    }

    m3u8 += '#EXT-X-ENDLIST\n'
    return m3u8
  }

  const fetchSegment = async (index: number): Promise<ArrayBuffer> => {
    const cached = segmentCache.get(index)
    if (cached) return cached

    const segmentInfo = segmentInfos[index]
    if (!segmentInfo) {
      throw new Error(`Segment ${index} not found`)
    }

    // Use seek() to jump to this segment's timestamp and get the fMP4 data
    const result = await remuxer.seek(segmentInfo.timestamp)
    segmentCache.set(index, result.data)
    return result.data
  }

  return {
    init: async () => {
      const result = await remuxer.init()
      initSegmentData = result.data

      // Build segment list from keyframe indexes
      const indexes = result.indexes
      const totalDuration = result.info.input.duration

      segmentInfos = indexes.map((kf, i) => {
        const nextTimestamp = i < indexes.length - 1
          ? indexes[i + 1].timestamp
          : totalDuration
        return {
          index: i,
          duration: nextTimestamp - kf.timestamp,
          timestamp: kf.timestamp
        }
      })

      // Create blob URL for init segment so the playlist can reference it
      const initBlob = new Blob([initSegmentData], { type: 'video/mp4' })
      initSegmentBlobUrl = URL.createObjectURL(initBlob)

      // Build the complete playlist upfront
      const playlist = buildPlaylist(segmentInfos, initSegmentBlobUrl)
      const playlistBlob = new Blob([playlist], { type: 'application/x-mpegURL' })
      playlistBlobUrl = URL.createObjectURL(playlistBlob)

      // Build custom hls.js fLoader that intercepts segment requests
      // and fetches them lazily via our remuxer
      const remuxerFetchSegment = fetchSegment
      const segmentInfosRef = segmentInfos

      class FragLoader {
        private context: any
        private config: any
        private callbacks: any
        private stats: any

        constructor(config: any) {
          this.config = config
          this.context = null
          this.callbacks = null
          this.stats = {
            aborted: false,
            loaded: 0,
            total: 0,
            loading: { start: 0, first: 0, end: 0 },
            parsing: { start: 0, end: 0 },
            buffering: { start: 0, first: 0, end: 0 }
          }
        }

        load(context: any, _config: any, callbacks: any) {
          this.context = context
          this.callbacks = callbacks

          const url = context.url as string

          // Parse segment index from the URL pattern "segment-{index}.m4s"
          const match = url.match(/segment-(\d+)\.m4s/)
          if (!match) {
            // Not a segment URL (could be the init segment) — fall through to fetch
            this.loadViaFetch(context, callbacks)
            return
          }

          const segmentIndex = parseInt(match[1], 10)
          if (segmentIndex < 0 || segmentIndex >= segmentInfosRef.length) {
            callbacks.onError(
              { code: 404, text: `Segment ${segmentIndex} out of range` },
              context,
              null,
              this.stats
            )
            return
          }

          this.stats.loading.start = performance.now()

          remuxerFetchSegment(segmentIndex)
            .then((data) => {
              this.stats.loaded = data.byteLength
              this.stats.total = data.byteLength
              this.stats.loading.first = performance.now()
              this.stats.loading.end = performance.now()

              callbacks.onSuccess(
                {
                  url: context.url,
                  data
                },
                this.stats,
                context,
                null
              )
            })
            .catch((err) => {
              callbacks.onError(
                { code: 0, text: err?.message ?? 'Segment fetch failed' },
                context,
                null,
                this.stats
              )
            })
        }

        // Fallback for non-segment URLs (e.g., init segment blob URL)
        private loadViaFetch(context: any, callbacks: any) {
          this.stats.loading.start = performance.now()

          fetch(context.url)
            .then(res => res.arrayBuffer())
            .then((data) => {
              this.stats.loaded = data.byteLength
              this.stats.total = data.byteLength
              this.stats.loading.first = performance.now()
              this.stats.loading.end = performance.now()

              callbacks.onSuccess(
                { url: context.url, data },
                this.stats,
                context,
                null
              )
            })
            .catch((err) => {
              callbacks.onError(
                { code: 0, text: err?.message ?? 'Fetch failed' },
                context,
                null,
                this.stats
              )
            })
        }

        abort() {
          this.stats.aborted = true
        }

        destroy() {}
      }

      return {
        info: result.info,
        initSegment: initSegmentData,
        playlist,
        playlistUrl: playlistBlobUrl,
        segments: segmentInfos,
        attachments: result.attachments,
        subtitles: result.subtitles,
        chapters: result.chapters,
        fragLoader: FragLoader as any
      }
    },

    fetchSegment,

    destroy: async () => {
      if (playlistBlobUrl) URL.revokeObjectURL(playlistBlobUrl)
      if (initSegmentBlobUrl) URL.revokeObjectURL(initSegmentBlobUrl)
      playlistBlobUrl = null
      initSegmentBlobUrl = null
      initSegmentData = null
      segmentInfos = []
      segmentCache.clear()
      await remuxer.destroy()
    }
  }
}
