import { makeRemuxer, makeThumbnailer } from '/build/index.js'

const sourceFor = async (name) => {
  const { length } = await (await fetch(`/size?name=${encodeURIComponent(name)}`)).json()
  const read = async (offset, size) => {
    const res = await fetch(`/media?name=${encodeURIComponent(name)}`, {
      headers: { range: `bytes=${offset}-${offset + size - 1}` },
    })
    return res.arrayBuffer()
  }
  return { length, read }
}

// `?nojspi=1` swaps the DEFAULT worker for the shim that blanks WebAssembly.Suspending, which is how the
// whole suite gets run a second time against the Asyncify build. Chrome has JSPI, so without this every
// test but the three explicit ones would only ever exercise the JSPI build, and the fallback Safari
// actually receives would be the least tested code in the repo.
const DEFAULT_WORKER =
  new URLSearchParams(location.search).get('nojspi') ? '/no-jspi-worker.js' : '/build/worker.js'

const common = (length, read, workerUrl) => ({
  publicPath: '/build/',
  workerUrl: workerUrl ?? DEFAULT_WORKER,
  workerOptions: { type: 'module' },
  length,
  read,
})

/** the centre pixel of a fixture frame encodes the second it came from; see scripts/fixtures.mjs */
const centrePixel = async (png) => {
  const bitmap = await createImageBitmap(new Blob([png], { type: 'image/png' }))
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
  const context = canvas.getContext('2d')
  context.drawImage(bitmap, 0, 0)
  const { data } = context.getImageData(Math.floor(bitmap.width / 2), Math.floor(bitmap.height / 2), 1, 1)
  const size = { width: bitmap.width, height: bitmap.height }
  bitmap.close()
  return { r: data[0], g: data[1], b: data[2], ...size }
}

/** Top-level ISO BMFF fourcc types in order (at most `limit`). */
const topBoxes = (buffer, limit = 8) => {
  if (!buffer?.byteLength) return []
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer)
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const found = []
  for (let at = 0; at + 8 <= view.byteLength && found.length < limit;) {
    const size = view.getUint32(at)
    found.push(String.fromCharCode(...bytes.subarray(at + 4, at + 8)))
    if (size <= 0) break
    at += size
  }
  return found
}

/** Validate that `buffer` is an exact sequence of top-level ISO BMFF boxes with no trailing or truncated bytes. */
const parseTopBoxes = (buffer) => {
  if (!buffer?.byteLength) return { boxes: [], headerBytes: 0, valid: false }
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer)
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const boxes = []
  let headerBytes = 0
  let at = 0
  while (at < view.byteLength) {
    if (at + 8 > view.byteLength) return { boxes, headerBytes, valid: false }
    const size32 = view.getUint32(at)
    let headerLen = 8
    let size = size32
    if (size32 === 1) {
      if (at + 16 > view.byteLength) return { boxes, headerBytes, valid: false }
      const big = view.getBigUint64(at + 8)
      if (big > BigInt(Number.MAX_SAFE_INTEGER)) return { boxes, headerBytes, valid: false }
      size = Number(big)
      headerLen = 16
    }
    if (size < headerLen || at + size > view.byteLength) return { boxes, headerBytes, valid: false }
    const type = String.fromCharCode(...bytes.subarray(at + 4, at + 8))
    if (!/^[\x20-\x7e]{4}$/.test(type)) return { boxes, headerBytes, valid: false }
    boxes.push(type)
    if (type === 'ftyp' || type === 'moov') headerBytes += size
    at += size
  }
  return { boxes, headerBytes, valid: at === view.byteLength }
}

const hexSha256 = async (buffer) => {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer)
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/**
 * Reads fragmented mp4 into `state`: each track's timescale and kind from a moov, how many edit lists it carries, and,
 * when `collect` is set, every sample's presentation time in seconds as the bytes write it, per kind in decode order,
 * the last 8 bytes of the first audio sample as hex, and (when present on `state`) raw audio DTS and durations.
 */
const readMp4 = (state, buffer, collect) => {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer)
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const fourcc = (at) => String.fromCharCode(...bytes.subarray(at, at + 4))
  const children = (start, end) => {
    const found = []
    for (let at = start; at + 8 <= end;) {
      const size = view.getUint32(at)
      if (size < 8) break
      found.push({ type: fourcc(at + 4), start: at + 8, end: at + size })
      at += size
    }
    return found
  }
  const child = (box, type) => children(box.start, box.end).find((b) => b.type === type)
  const flagsOf = (box) => view.getUint32(box.start) & 0xffffff
  for (const top of children(0, bytes.byteLength)) {
    if (top.type === 'moov') {
      const mvex = child(top, 'mvex')
      for (const trex of mvex ? children(mvex.start, mvex.end).filter((b) => b.type === 'trex') : []) {
        const id = view.getUint32(trex.start + 4)
        state.defaults.set(id, { duration: view.getUint32(trex.start + 12), size: view.getUint32(trex.start + 16) })
      }
      for (const trak of children(top.start, top.end).filter((b) => b.type === 'trak')) {
        const tkhd = child(trak, 'tkhd'), mdia = child(trak, 'mdia'), mdhd = child(mdia, 'mdhd')
        const id = view.getUint32(tkhd.start + (bytes[tkhd.start] ? 20 : 12))
        const timescale = view.getUint32(mdhd.start + (bytes[mdhd.start] ? 20 : 12))
        const kind = fourcc(child(mdia, 'hdlr').start + 8) === 'vide' ? 'video' : 'audio'
        state.tracks.set(id, { timescale, kind })
        if (child(trak, 'edts')) state.editLists++
      }
    }
    if (top.type !== 'moof' || !collect) continue
    for (const traf of children(top.start, top.end).filter((b) => b.type === 'traf')) {
      const tfhd = child(traf, 'tfhd'), tfdt = child(traf, 'tfdt')
      const id = view.getUint32(tfhd.start + 4), track = state.tracks.get(id), tfhdFlags = flagsOf(tfhd)
      let at = tfhd.start + 8 + (tfhdFlags & 0x01 ? 8 : 0) + (tfhdFlags & 0x02 ? 4 : 0)
      const defaultDuration = tfhdFlags & 0x08 ? view.getUint32(at) : state.defaults.get(id).duration
      if (tfhdFlags & 0x08) at += 4
      const defaultSize = tfhdFlags & 0x10 ? view.getUint32(at) : state.defaults.get(id).size
      let dts = bytes[tfdt.start] ? Number(view.getBigUint64(tfdt.start + 4)) : view.getUint32(tfdt.start + 4)
      const fragment = track.kind === 'video' ? [] : null
      for (const trun of children(traf.start, traf.end).filter((b) => b.type === 'trun')) {
        const flags = flagsOf(trun), signed = bytes[trun.start] === 1, count = view.getUint32(trun.start + 4)
        // default-base-is-moof: a run's data offset counts from the first byte of its moof
        let data = top.start - 8 + (flags & 0x01 ? view.getInt32(trun.start + 8) : 0)
        at = trun.start + 8 + (flags & 0x01 ? 4 : 0) + (flags & 0x04 ? 4 : 0)
        for (let i = 0; i < count; i++) {
          let duration = defaultDuration, size = defaultSize, composition = 0
          if (flags & 0x100) { duration = view.getUint32(at); at += 4 }
          if (flags & 0x200) { size = view.getUint32(at); at += 4 }
          if (flags & 0x400) at += 4
          if (flags & 0x800) { composition = signed ? view.getInt32(at) : view.getUint32(at); at += 4 }
          const pts = (dts + composition) / track.timescale
          state.samples[track.kind].push(pts)
          if (track.kind === 'audio') {
            state.audioDts?.push(dts)
            state.audioDurations?.push(duration)
          }
          fragment?.push(pts)
          if (track.kind === 'audio' && state.audioStart === undefined) {
            state.audioStart = [...bytes.subarray(data + size - 8, data + size)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
          }
          data += size
          dts += duration
        }
      }
      if (fragment?.length) state.videoFragments.push(fragment)
    }
  }
}

window.harness = {
  /**
   * Where the bytes put each sample, with the init segment's `timestampOffset` added as a SourceBuffer would: from
   * the start of the file, or from a seek to `target`, over that call and `reads` more.
   */
  async timeline(name, { target, reads = 2, audioCodecs } = {}) {
    const { length, read } = await sourceFor(name)
    const remuxer = await makeRemuxer({ ...common(length, read), ...(audioCodecs ? { audioCodecs } : {}) })
    try {
      const init = await remuxer.init()
      const state = { tracks: new Map(), defaults: new Map(), editLists: 0, samples: { video: [], audio: [] }, videoFragments: [] }
      readMp4(state, init.data, target === undefined)
      if (target !== undefined) readMp4(state, (await remuxer.seek(target)).data, true)
      for (let i = 0; i < reads; i++) {
        const chunk = await remuxer.read()
        if (chunk.data?.byteLength) readMp4(state, chunk.data, true)
        if (chunk.finished) break
      }
      const offset = init.timestampOffset ?? 0
      return {
        timestampOffset: init.timestampOffset,
        editLists: state.editLists,
        video: state.samples.video.map((time) => time + offset),
        videoFragments: state.videoFragments.map((fragment) => fragment.map((time) => time + offset)),
        audio: state.samples.audio.map((time) => time + offset),
        audioStart: state.audioStart,
      }
    } finally { await remuxer.destroy() }
  },

  async remux(name, { workerUrl, audioCodecs } = {}) {
    const { length, read } = await sourceFor(name)
    const remuxer = await makeRemuxer({
      ...common(length, read, workerUrl),
      ...(audioCodecs ? { audioCodecs } : {}),
    })
    try {
      const init = await remuxer.init()
      const segments = []
      for (let i = 0; i < 3; i++) {
        const chunk = await remuxer.read()
        segments.push({ bytes: chunk.data?.byteLength ?? 0, pts: chunk.pts, duration: chunk.duration, finished: !!chunk.finished })
        if (chunk.finished) break
      }
      return {
        initBytes: init.data.byteLength,
        videoMimeType: init.info.output.videoMimeType,
        audioMimeType: init.info.output.audioMimeType,
        duration: init.info.input.duration,
        indexCount: init.indexes.length,
        subtitleCount: init.subtitles.length,
        // the first four bytes of each top level box's type, so a test can tell an init segment from media
        initBoxes: topBoxes(init.data),
        segments,
      }
    } finally { await remuxer.destroy() }
  },

  /** every subtitle header from init, and the dialogue lines of the first reads */
  async subtitles(name) {
    const { length, read } = await sourceFor(name)
    const remuxer = await makeRemuxer(common(length, read))
    try {
      const init = await remuxer.init()
      const dialogues = []
      for (let i = 0; i < 20; i++) {
        const chunk = await remuxer.read()
        dialogues.push(...chunk.subtitles.map(({ content, start, end }) => ({ content, start, end })))
        if (chunk.finished) break
      }
      return { headers: init.subtitles.map(({ content, streamIndex }) => ({ content, streamIndex })), dialogues }
    } finally { await remuxer.destroy() }
  },

  async chapters(name) {
    const { length, read } = await sourceFor(name)
    const remuxer = await makeRemuxer(common(length, read))
    try {
      return (await remuxer.init()).chapters
    } finally { await remuxer.destroy() }
  },

  /** feeds the remuxed output to MediaSource, the only assertion that proves the bytes are really playable */
  async playable(name) {
    const { length, read } = await sourceFor(name)
    const remuxer = await makeRemuxer(common(length, read))
    try {
      const init = await remuxer.init()
      const videoMimeType = init.info.output.videoMimeType
      const audioMimeType = init.info.output.audioMimeType
      const codecs = [videoMimeType, audioMimeType].filter(Boolean).join(',')
      const mime = `video/mp4; codecs="${codecs}"`
      const header = init.data instanceof Uint8Array ? init.data : new Uint8Array(init.data)
      const entry = header.findIndex((_, at) => String.fromCharCode(...header.subarray(at, at + 4)) === 'mp4a')
      // the AudioSampleEntry's channelcount, 20 bytes past the box type
      const audioChannels = entry < 0 ? undefined : (header[entry + 20] << 8) | header[entry + 21]
      const detail = { mime, videoMimeType, audioMimeType, audioChannels }
      if (!MediaSource.isTypeSupported(mime)) return { ...detail, supported: false }

      const chunks = []
      for (let i = 0; i < 2; i++) {
        const chunk = await remuxer.read()
        if (chunk.data?.byteLength) chunks.push(chunk.data)
        if (chunk.finished) break
      }

      const buffered = await new Promise((resolve) => {
        const source = new MediaSource()
        const video = document.createElement('video')
        video.src = URL.createObjectURL(source)
        source.addEventListener('sourceopen', async () => {
          try {
            const buffer = source.addSourceBuffer(mime)
            const push = (data) => new Promise((done, fail) => {
              buffer.addEventListener('updateend', done, { once: true })
              buffer.addEventListener('error', () => fail(new Error('appendBuffer failed')), { once: true })
              buffer.appendBuffer(data)
            })
            await push(init.data)
            for (const chunk of chunks) await push(chunk)
            resolve(buffer.buffered.length ? buffer.buffered.end(0) : 0)
          } catch (error) { resolve({ error: String(error).slice(0, 200) }) }
        }, { once: true })
        setTimeout(() => resolve({ error: 'timed out waiting for sourceopen' }), 20_000)
      })
      return { ...detail, supported: true, buffered }
    } finally { await remuxer.destroy() }
  },

  async thumbnails(name, times, { workerUrl, viaRemuxer = false } = {}) {
    const { length, read } = await sourceFor(name)
    const make = viaRemuxer ? makeRemuxer : makeThumbnailer
    const instance = await make(common(length, read, workerUrl))
    try {
      const meta = await instance.init()
      const shots = []
      for (const t of times) {
        try {
          const png = await instance.readKeyframe(t)
          shots.push({ t, bytes: png.byteLength, ...(await centrePixel(png)) })
        } catch (error) {
          shots.push({ t, error: String(error).slice(0, 160) })
        }
      }
      return {
        duration: viaRemuxer ? meta.info.input.duration : meta.duration,
        indexCount: meta.indexes.length,
        shots,
      }
    } finally { await instance.destroy() }
  },

  async seek(name, targets, { bufferSize, workerUrl, reads = 0, audioCodecs } = {}) {
    const { length, read } = await sourceFor(name)
    // where each seek read from, so a test can assert what a seek does NOT have to fetch
    let offsets = null
    const traced = (offset, size) => { if (offsets) offsets.push(offset); return read(offset, size) }
    const remuxer = await makeRemuxer({
      ...common(length, traced, workerUrl),
      ...(bufferSize ? { bufferSize } : {}),
      ...(audioCodecs ? { audioCodecs } : {}),
    })
    try {
      const init = await remuxer.init()
      const initParsed = parseTopBoxes(init.data)
      const steps = []
      for (const target of targets) {
        offsets = []
        const chunk = await remuxer.seek(target)
        // `after` is what shows where fragments stop being cut on length and go back to one per GOP
        const after = []
        for (let i = 0; i < reads; i++) {
          const next = await remuxer.read()
          if (!next?.data?.byteLength) break
          after.push({ pts: next.pts, duration: next.duration })
        }
        const parsed = parseTopBoxes(chunk.data)
        const sha256 = chunk.data?.byteLength ? await hexSha256(chunk.data) : null
        steps.push({
          target, pts: chunk.pts, duration: chunk.duration,
          bytes: chunk.data?.byteLength ?? 0, boxes: topBoxes(chunk.data),
          validBoxes: parsed.valid, sha256,
          after, offsets: offsets.slice(),
        })
      }
      return {
        initBoxes: topBoxes(init.data),
        initBytes: init.data?.byteLength ?? 0,
        initHeaderBytes: initParsed.headerBytes,
        initValidBoxes: initParsed.valid,
        steps,
        length,
      }
    } finally { await remuxer.destroy() }
  },

  /** one read left waiting on the source, a seek that cancels it, then reads until the file ends */
  async cancelledReadThenEnd(name, { bufferSize, target }) {
    const { length, read } = await sourceFor(name)
    let holding = false
    let onHeld
    const held = []
    const gated = (offset, size) => {
      if (!holding) return read(offset, size)
      return new Promise((resolve) => { held.push(() => resolve(read(offset, size))); onHeld?.() })
    }
    const remuxer = await makeRemuxer({ ...common(length, gated), bufferSize })
    try {
      await remuxer.init()
      holding = true
      // a read served from avio's own buffer never reaches the source, so read on until one does
      let waiting
      for (let i = 0; i < 100 && !waiting; i++) {
        const heldNow = new Promise((resolve) => { onHeld = resolve })
        const reading = remuxer.read().then(() => null, (error) => error.message)
        if (await Promise.race([reading.then(() => false), heldNow.then(() => true)])) waiting = reading
      }
      holding = false
      let finished = !!(await remuxer.seek(target)).finished
      const cancelled = await waiting
      let error = null
      for (let i = 0; i < 1000 && !finished; i++) {
        try { finished = !!(await remuxer.read()).finished } catch (failure) { error = failure.message; break }
      }
      held.forEach((release) => release())
      return { cancelled, finished, error }
    } finally { await remuxer.destroy() }
  },

  /**
   * Patches two consecutive audio SimpleBlocks right after the video keyframe in Cluster 1 of a Matroska
   * fixture to share the exact same relative timecode, then compares baseline vs patched remux output
   * (from load or after a seek) and verifies MediaSource accepts the patched stream.
   */
  async duplicateAudioDts(name, { target, reads = 4 } = {}) {
    const res = await fetch(`/media?name=${encodeURIComponent(name)}`)
    const original = new Uint8Array(await res.arrayBuffer())
    const patched = original.slice()

    // Locate the second Matroska Cluster (0x1F 0x43 0xB6 0x75) and duplicate the second audio SimpleBlock's
    // signed 16-bit relative timecode right after the cluster's video keyframe.
    const readVint = (buf, at) => {
      const first = buf[at]
      let len = 1
      while (len <= 8 && !(first & (0x80 >> (len - 1)))) len++
      let val = first & (0xff >> len)
      for (let i = 1; i < len; i++) val = val * 256 + buf[at + i]
      return { val, len }
    }
    const clusters = []
    for (let i = 0; i + 4 < patched.length; i++) {
      if (patched[i] === 0x1f && patched[i + 1] === 0x43 && patched[i + 2] === 0xb6 && patched[i + 3] === 0x75) {
        clusters.push(i)
      }
    }
    if (clusters.length < 2) throw new Error(`expected at least 2 clusters in ${name}`)
    let at = clusters[1] + 4
    const clusterSize = readVint(patched, at)
    at += clusterSize.len
    const clusterEnd = at + clusterSize.val
    let sawVideoKey = false
    let prevAudioTc = null
    let patchedAt = -1
    while (at < clusterEnd) {
      const idByte = patched[at]
      let idLen = 1
      while (idLen <= 4 && !(idByte & (0x80 >> (idLen - 1)))) idLen++
      const isSimpleBlock = idLen === 1 && idByte === 0xa3
      // Turn any Cluster CRC-32 (0xBF) into EBML Void (0xEC) so patching a block keeps byte offsets valid
      if (idLen === 1 && idByte === 0xbf) patched[at] = 0xec
      at += idLen
      const sz = readVint(patched, at)
      const blockStart = at + sz.len
      if (isSimpleBlock) {
        const track = readVint(patched, blockStart)
        const tcOffset = blockStart + track.len
        const flags = patched[tcOffset + 2]
        if (track.val === 1 && (flags & 0x80)) {
          sawVideoKey = true
        } else if (track.val === 2 && sawVideoKey) {
          if (prevAudioTc === null) {
            prevAudioTc = [patched[tcOffset], patched[tcOffset + 1]]
          } else {
            patched[tcOffset] = prevAudioTc[0]
            patched[tcOffset + 1] = prevAudioTc[1]
            patchedAt = tcOffset
            break
          }
        }
      }
      at = blockStart + sz.val
    }
    if (patchedAt < 0) throw new Error(`failed to locate two post-keyframe audio blocks in ${name}`)

    const run = async (bytes, verifyMse) => {
      const read = async (offset, size) => bytes.slice(offset, offset + size).buffer
      const remuxer = await makeRemuxer(common(bytes.byteLength, read))
      try {
        const init = await remuxer.init()
        const state = {
          tracks: new Map(), defaults: new Map(), editLists: 0,
          samples: { video: [], audio: [] }, videoFragments: [],
          audioDts: [], audioDurations: [],
        }
        const chunks = []
        let clampedAudioDts = 0
        let clampedVideoDts = 0
        const recordClamps = (chunk) => {
          clampedAudioDts += chunk.clampedAudioDts ?? 0
          clampedVideoDts += chunk.clampedVideoDts ?? 0
        }
        readMp4(state, init.data, target === undefined)
        if (target !== undefined) {
          const sought = await remuxer.seek(target)
          recordClamps(sought)
          if (sought.data?.byteLength) {
            chunks.push(sought.data)
            readMp4(state, sought.data, true)
          }
        }
        for (let i = 0; i < reads; i++) {
          const chunk = await remuxer.read()
          recordClamps(chunk)
          if (chunk.data?.byteLength) {
            chunks.push(chunk.data)
            readMp4(state, chunk.data, true)
          }
          if (chunk.finished) break
        }
        let nonMonotonicDts = 0
        for (let i = 1; i < state.audioDts.length; i++) {
          if (state.audioDts[i] <= state.audioDts[i - 1]) nonMonotonicDts++
        }
        const zeroDuration = state.audioDurations.filter((d) => d <= 0).length
        let buffered = null
        if (verifyMse) {
          const codecs = [init.info.output.videoMimeType, init.info.output.audioMimeType].filter(Boolean).join(',')
          const mime = `video/mp4; codecs="${codecs}"`
          buffered = await new Promise((resolve) => {
            const source = new MediaSource()
            const video = document.createElement('video')
            video.src = URL.createObjectURL(source)
            source.addEventListener('sourceopen', async () => {
              try {
                const buffer = source.addSourceBuffer(mime)
                const push = (data) => new Promise((done, fail) => {
                  buffer.addEventListener('updateend', done, { once: true })
                  buffer.addEventListener('error', () => fail(new Error('appendBuffer failed')), { once: true })
                  buffer.appendBuffer(data)
                })
                await push(init.data)
                for (const chunk of chunks) await push(chunk)
                resolve(buffer.buffered.length ? buffer.buffered.end(buffer.buffered.length - 1) : 0)
              } catch (error) { resolve({ error: String(error).slice(0, 200) }) }
            }, { once: true })
            setTimeout(() => resolve({ error: 'timed out waiting for sourceopen' }), 20_000)
          })
        }
        return {
          audioCount: state.audioDts.length,
          nonMonotonicDts,
          zeroDuration,
          buffered,
          clampedAudioDts,
          clampedVideoDts,
        }
      } finally { await remuxer.destroy() }
    }

    return {
      patchedAt,
      baseline: await run(original, false),
      patched: await run(patched, true),
    }
  },

  async indexes(name) {
    const { length, read } = await sourceFor(name)
    const thumbnailer = await makeThumbnailer(common(length, read))
    try {
      const meta = await thumbnailer.init()
      const positions = meta.indexes.map(i => i.pos)
      let backwards = 0
      for (let i = 1; i < positions.length; i++) if (positions[i] < positions[i - 1]) backwards++
      return { length, count: positions.length, maxPos: Math.max(...positions), backwards, last: positions.slice(-1)[0] }
    } finally { await thumbnailer.destroy() }
  },
}

window.harnessReady = true
