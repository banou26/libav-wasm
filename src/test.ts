import PQueue from 'p-queue'
import { queuedThrottleWithLastCall } from './utils'
import { makeRemuxer } from '.'

const BACKPRESSURE_STREAM_ENABLED = !navigator.userAgent.includes("Firefox")
const BUFFER_SIZE = 2_500_000
const VIDEO_URL = '../video2.mkv'

export default async function saveFile(plaintext: ArrayBuffer, fileName: string, fileType: string) {
  return new Promise((resolve, reject) => {
    const dataView = new DataView(plaintext);
    const blob = new Blob([dataView], { type: fileType });

    // @ts-ignore
    if (navigator.msSaveBlob) {
    // @ts-ignore
      navigator.msSaveBlob(blob, fileName);
    // @ts-ignore
      return resolve();
    } else if (/iPhone|fxios/i.test(navigator.userAgent)) {
      // This method is much slower but createObjectURL is buggy on iOS
      const reader = new FileReader();
      reader.addEventListener('loadend', () => {
        if (reader.error) {
          return reject(reader.error);
        }
        if (reader.result) {
          const a = document.createElement('a');
          // @ts-ignore
          a.href = reader.result;
          a.download = fileName;
          document.body.appendChild(a);
          a.click();
        }
        // @ts-ignore
        resolve();
      });
      reader.readAsDataURL(blob);
    } else {
      const downloadUrl = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = downloadUrl;
      a.download = fileName;
      document.body.appendChild(a);
      a.click();
      URL.revokeObjectURL(downloadUrl);
      setTimeout(resolve, 100);
    }
  });
}



fetch(VIDEO_URL, { headers: { Range: `bytes=0-1` } })
  .then(async ({ headers, body }) => {
    if (!body) throw new Error('no body')
    const contentRangeContentLength = headers.get('Content-Range')?.split('/').at(1)
    const contentLength =
      contentRangeContentLength
        ? Number(contentRangeContentLength)
        : Number(headers.get('Content-Length'))

    const _workerUrl = new URL('../build/worker.js', import.meta.url).toString()
    const blob = new Blob([`importScripts(${JSON.stringify(_workerUrl)})`], { type: 'application/javascript' })
    const workerUrl = URL.createObjectURL(blob)

    const remuxer = await makeRemuxer({
      publicPath: new URL('/dist/', new URL(import.meta.url).origin).toString(),
      workerUrl,
      bufferSize: BUFFER_SIZE,
      length: contentLength,
      read: (offset, size) => {
        if (offset >= contentLength) return Promise.resolve(new Uint8Array(0).buffer)
        return (
          fetch(VIDEO_URL, { headers: { Range: `bytes=${offset}-${Math.min(offset + size, contentLength) - 1}` } })
            .then(res => res.arrayBuffer())
        )
      }
    })

    const header = await remuxer.init()

    const video = document.createElement('video')
    video.width = 1440

    const seconds = document.createElement('div')
    video.controls = true
    video.volume = 0
    video.addEventListener('error', ev => {
      // @ts-expect-error
      console.error(ev.target?.error)
    })
    document.body.appendChild(video)
    document.body.appendChild(seconds)

    const mediaSource = new MediaSource()
    video.src = URL.createObjectURL(mediaSource)

    const sourceBuffer: SourceBuffer =
      await new Promise(resolve =>
        mediaSource.addEventListener(
          'sourceopen',
          () => {
            const sourceBuffer = mediaSource.addSourceBuffer(`video/mp4; codecs="${[header.info.output.videoMimeType, header.info.output.audioMimeType].filter(Boolean).join(',')}"`)
            mediaSource.duration = header.info.input.duration
            sourceBuffer.mode = 'segments'
            sourceBuffer.timestampOffset = header.timestampOffset
            resolve(sourceBuffer)
          },
          { once: true }
        )
      )

    const setupListeners = (resolve: (value: Event) => void, reject: (reason: Event) => void) => {
      const updateEndListener = (ev: Event) => {
        resolve(ev)
        unregisterListeners()
      }
      const abortListener = (ev: Event) => {
        resolve(ev)
        unregisterListeners()
      }
      const errorListener = (ev: Event) => {
        console.error(ev)
        reject(ev)
        unregisterListeners()
      }
      const unregisterListeners = () => {
        sourceBuffer.removeEventListener('updateend', updateEndListener)
        sourceBuffer.removeEventListener('abort', abortListener)
        sourceBuffer.removeEventListener('error', errorListener)
      }
      sourceBuffer.addEventListener('updateend', updateEndListener, { once: true })
      sourceBuffer.addEventListener('abort', abortListener, { once: true })
      sourceBuffer.addEventListener('error', errorListener, { once: true })
    }

    const queue = new PQueue({ concurrency: 1 })

    const appendBuffer = (buffer: ArrayBuffer) =>
      queue.add(() =>
        new Promise<Event>((resolve, reject) => {
          setupListeners(resolve, reject)
          sourceBuffer.appendBuffer(buffer)
        })
      )

    const unbufferRange = async (start: number, end: number) =>
      queue.add(() =>
        new Promise((resolve, reject) => {
          setupListeners(resolve, reject)
          sourceBuffer.remove(start, end)
        })
      )

    await appendBuffer(header.data)

    const getTimeRanges = () =>
      Array(sourceBuffer.buffered.length)
        .fill(undefined)
        .map((_, index) => ({
          index,
          start: sourceBuffer.buffered.start(index),
          end: sourceBuffer.buffered.end(index)
        }))

    const MIN_TIME = -30
    const MAX_TIME = 75
    const BUFFER_TO = 60

    const unbuffer = async () => {
      const minTime = video.currentTime + MIN_TIME
      const maxTime = video.currentTime + MAX_TIME
      const bufferedRanges = getTimeRanges()
      for (const { start, end } of bufferedRanges) {
        if (start < minTime) {
          await unbufferRange(
            start,
            minTime
          )
        }
        if (end > maxTime) {
          await unbufferRange(
            maxTime,
            end
          )
        }
      }
    }

    let currentSeeks: { currentTime: number }[] = []
    let lastSeekedPosition = 0

    const loadMore = queuedThrottleWithLastCall(100, async () => {
      if (currentSeeks.length) return
      const { currentTime } = video
      const bufferedRanges = getTimeRanges()
      const timeRange = bufferedRanges.find(({ start, end }) => start <= currentTime && currentTime <= end)
      if (!timeRange) {
        return
      }
      const end = timeRange.end
      const maxTime = video.currentTime + BUFFER_TO
      if (end >= maxTime) {
        return
      }
      try {
        const res = await remuxer.read()
        await appendBuffer(res.data)
        await unbuffer()
      } catch (err: any) {
        if (err.message === 'Cancelled') return
        console.error(err)
      }
    })
    setInterval(loadMore, 100)

    video.addEventListener('seeking', async () => {
      const { currentTime } = video
      const bufferedRanges = getTimeRanges()
      const timeRange = bufferedRanges.find(({ start, end }) => start <= currentTime && currentTime <= end)
      // already buffered and forward of the last seek, playback can just keep reading, no remuxer seek needed
      if (timeRange && currentTime >= lastSeekedPosition) {
        return
      }
      const seekObject = { currentTime }
      currentSeeks = [...currentSeeks, seekObject]
      lastSeekedPosition = currentTime
      try {
        const res =
          await remuxer
            .seek(currentTime)
            .finally(() => {
              currentSeeks = currentSeeks.filter(seekObj => seekObj !== seekObject)
            })
        await appendBuffer(res.data)
      } catch (err: any) {
        if (err.message === 'Cancelled') return
        console.error(err)
      }
      await unbuffer()
    })

    await appendBuffer(
      (await remuxer.read()).data
    )

    fetch(VIDEO_URL, { headers: { Range: `bytes=0-1` } })
      .then(async ({ headers, body }) => {
        if (!body) throw new Error('no body')
        const contentRangeContentLength = headers.get('Content-Range')?.split('/').at(1)
        const contentLength =
          contentRangeContentLength
            ? Number(contentRangeContentLength)
            : Number(headers.get('Content-Length'))

        const _workerUrl = new URL('../build/worker.js', import.meta.url).toString()
        const blob = new Blob([`importScripts(${JSON.stringify(_workerUrl)})`], { type: 'application/javascript' })
        const workerUrl = URL.createObjectURL(blob)

        const remuxer = await makeRemuxer({
          publicPath: new URL('/dist/', new URL(import.meta.url).origin).toString(),
          workerUrl,
          bufferSize: BUFFER_SIZE,
          length: contentLength,
          read: (offset, size) => {
            if (offset >= contentLength) return Promise.resolve(new Uint8Array(0).buffer)
            return (
              fetch(VIDEO_URL, { headers: { Range: `bytes=${offset}-${Math.min(offset + size, contentLength) - 1}` } })
                .then(res => res.arrayBuffer())
            )
          }
        })

        const header = await remuxer.init()

        const thumbnailContainer = document.createElement('div')
        document.body.appendChild(thumbnailContainer)
        thumbnailContainer.style.display = 'flex'
        thumbnailContainer.style.flexWrap = 'wrap'
        thumbnailContainer.style.gap = '10px'

        const canvas = document.createElement('canvas')
        const context = canvas.getContext('2d')
        if (!context) throw new Error('OffscreenCanvas not supported')

        const thumbnails = []
        const createNewThumbnail = async (index: number) => {
          const currentIndex = header.indexes.at(index)
          if (!currentIndex) return

          const arrayBuffer = await remuxer.readKeyframe(currentIndex.timestamp)
          const thumbnailBlob = new Blob([arrayBuffer], { type: 'image/png' })

          const img = document.createElement('img')
          img.src = window.URL.createObjectURL(thumbnailBlob)
          thumbnailContainer.appendChild(img)
          thumbnails.push(img)
        }

        while (true) {
          await createNewThumbnail(thumbnails.length)
          if (thumbnails.length >= header.indexes.length) break
        }
      })
  })
