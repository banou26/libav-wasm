#include <emscripten.h>
#include <emscripten/val.h>
#include <emscripten/bind.h>
#include <vector>
#include <sstream>
#include <string>
#include <cstring>
#include <numeric>
#include <algorithm>
#include <set>

extern "C" {
  #include <libavformat/avio.h>
  #include <libavcodec/avcodec.h>
  #include <libavcodec/bsf.h>
  #include <libavformat/avformat.h>
  #include <libswscale/swscale.h>
  #include <libavutil/pixdesc.h>
  #include <libavutil/audio_fifo.h>
  #include <libswresample/swresample.h>
}

using namespace emscripten;
using namespace std;

// Under JSPI a method that suspends has to be bound with the async policy, or embind hands back a plain
// export and the first `.await()` traps with "trying to suspend without WebAssembly.promising". It cannot
// be unconditional: libembind asserts `!isAsync` whenever JSPI is off, so the Asyncify build would refuse
// to start. `make` builds both, and the JSPI target defines LIBAV_JSPI. See the Makefile.
#ifdef LIBAV_JSPI
#define SUSPENDS , emscripten::async()
#else
#define SUSPENDS
#endif

static inline std::string ffmpegErrStr(int errnum) {
  char buf[AV_ERROR_MAX_STRING_SIZE] = {0};
  av_strerror(errnum, buf, sizeof(buf));
  return std::string(buf);
}

/**
 * Which codecs survive to the output, and in what form.
 *
 * The output is always fragmented mp4 for MediaSource, so a stream is only worth keeping when mp4 can
 * carry it AND a browser can decode it AND we can name it in a `codecs=` string. All three matter: a
 * track the muxer accepts but we cannot name produces an mp4 that MediaSource refuses outright, which is
 * strictly worse than not muxing it at all.
 *
 * This is deliberately an allow-list rather than a deny-list. avformat_query_codec answers the first
 * question only, and answers it for the muxer in general: it says yes to ac3, whose mp4 sample entry is
 * filled from the first packet, so empty_moov cannot write a header before one arrives and the write
 * fails with "Cannot write moov atom before AC3 packets". Enumerating what works is the only check that
 * covers all three questions at once.
 *
 * Video has no list here on purpose. parse_video_mime_type's switch is the list: a codec it cannot name
 * is a codec that cannot reach a browser, and a second list beside it would only be something to disagree
 * with.
 */
static inline const char* audio_passthrough_name(AVCodecID codec_id) {
  switch (codec_id) {
    case AV_CODEC_ID_AAC:  return "aac";
    case AV_CODEC_ID_OPUS: return "opus";
    case AV_CODEC_ID_FLAC: return "flac";
    case AV_CODEC_ID_AC3:  return "ac3";
    case AV_CODEC_ID_EAC3: return "eac3";
    default:               return nullptr;
  }
}



typedef struct MediaInfo {
  std::string formatName;
  std::string mimeType;
  double duration;
  std::string video_mime_type;
  std::string audio_mime_type;
} MediaInfo;

typedef struct IOInfo {
  MediaInfo input;
  MediaInfo output;
} IOInfo;

typedef struct Attachment {
  std::string filename;
  std::string mimetype;
  size_t size;
  size_t ptr;
} Attachment;

typedef struct SubtitleFragment {
  int streamIndex;
  bool isHeader;
  std::string data;
  std::string language;
  std::string title;
  long start;
  long end;
} SubtitleFragment;

typedef struct AudioStream {
  int streamIndex;
  std::string language;
  std::string title;
} AudioStream;

typedef struct Index {
  int index;
  double timestamp;
  double pos;
} Index;

typedef struct Chapter {
  int index;
  float start;
  float end;
  std::string title;
} Chapter;

typedef struct InitResult {
  emscripten::val data;
  std::vector<Attachment> attachments;
  std::vector<SubtitleFragment> subtitles;
  std::vector<AudioStream> audio_streams;
  IOInfo info;
  std::vector<uint8_t> attachments_data;
  std::vector<Index> indexes;
  std::vector<Chapter> chapters;
  std::vector<uint8_t> video_extradata;
} InitResult;

typedef struct ReadResult {
  emscripten::val data;
  std::vector<SubtitleFragment> subtitles;
  double offset;
  double pts;
  double duration;
  bool cancelled;
  bool finished;
} ReadResult;

typedef struct ThumbnailReadResult {
  emscripten::val data;
  double offset;
  double pts;
  double duration;
  bool cancelled;
} ThumbnailReadResult;

// everything the thumbnail path needs from a file, none of which involves an output muxer
typedef struct ThumbnailInitResult {
  double duration;
  std::string video_mime_type;
  std::vector<uint8_t> video_extradata;
  std::vector<Index> indexes;
} ThumbnailInitResult;

// `data` is tightly packed RGBA at width * height * 4, ready for an ImageData with no further conversion
typedef struct ThumbnailDecodeResult {
  emscripten::val data;
  int width;
  int height;
  double pts;
  double duration;
  bool cancelled;
} ThumbnailDecodeResult;

class Remuxer {
public:
  AVIOContext* input_avio_context = nullptr;
  AVIOContext* output_avio_context = nullptr;
  AVFormatContext* output_format_context = nullptr;
  AVFormatContext* input_format_context = nullptr;

  const AVCodec *audio_avc = nullptr;
  AVStream *audio_avs = nullptr;
  AVCodecContext *audio_avcc = nullptr;
  int audio_index = -1;

  // decoding video happens only for thumbnails, so all of this is built on the first decode_keyframe call
  const AVCodec *video_decoder_avc = nullptr;
  AVCodecContext *video_decoder_avcc = nullptr;
  SwsContext *thumbnail_sws = nullptr;
  int thumbnail_sws_source_width = 0;
  int thumbnail_sws_source_height = 0;
  AVPixelFormat thumbnail_sws_source_format = AV_PIX_FMT_NONE;
  int thumbnail_sws_width = 0;
  int thumbnail_sws_height = 0;
  std::vector<uint8_t> thumbnail_vector;

  // only ever aac_adtstoasc, and only for an input that hands over ADTS; null the rest of the time
  AVBSFContext *audio_bsf = nullptr;

  const AVCodec *audio_decoder_avc = nullptr;
  AVCodecContext *audio_decoder_avcc = nullptr;
  AVFrame *audio_input_frame = nullptr;
  AVFrame *audio_output_frame = nullptr;
  bool needs_audio_transcoding = false;

  // A decoder's output format is its own business: pcm arrives packed 16 bit, wavpack planar 16, truehd
  // packed 32, vorbis planar float, and every one of them at whatever frame size that codec uses. The aac
  // encoder takes planar float at exactly 1024 samples. The resampler converts the format, the layout and
  // the rate; the fifo regroups the frame size. Between them there is no arithmetic left to get wrong.
  SwrContext *audio_resampler = nullptr;
  AVAudioFifo *audio_fifo = nullptr;
  // what the resampler was last configured to accept, so a frame that does not match rebuilds it
  int resampler_in_format = AV_SAMPLE_FMT_NONE;
  int resampler_in_rate = 0;
  AVChannelLayout resampler_in_layout = {};
  // standard AAC frame; codecpar->frame_size and audio_output_frame->nb_samples both follow this
  int aac_frame_size = 1024;
  int64_t next_audio_pts = 0;
  bool audio_pts_initialized = false;

  int64_t last_video_dts = AV_NOPTS_VALUE;
  int64_t last_audio_dts = AV_NOPTS_VALUE;
  bool after_seek = false;

  int64_t currentOffset = 0;
  int64_t input_length = 0;

  int buffer_size;
  int video_stream_index = -1;
  int number_of_streams = 0;
  // input stream index -> output stream index; -1 excludes the stream from the mp4 output (subtitles, attachments, non-selected audio) and drops its packets
  int* streams_list = nullptr;

  double prev_duration = 0;
  double prev_pts = 0;
  int64_t prev_pos = 0;
  // prev_* only describe a real fragment once a second keyframe has gone by; until then they are the zero
  // reset_fragment left behind, which is indistinguishable from the start of the file
  int keyframes_since_reset = 0;
  // AV_TIME_BASE units. mpegts timestamps start wherever the broadcast's clock happened to be, commonly a
  // second or so in and legitimately anywhere at all, so every timestamp leaving this class is reported
  // relative to the video stream's own start. Matroska and mp4 already start at zero, where this is 0 and
  // changes nothing.
  int64_t start_time_offset = 0;
  // Worked out once, on the first open, and kept. A seek tears the input down and reopens it, and lavf is
  // free to report a different start_time having probed from a different position: re-deriving it there
  // shifts every timestamp the caller has already been given, and can report them as negative.
  bool start_time_offset_known = false;
  double duration = 0;
  double pts = 0;
  int64_t pos = 0;

  /**
   * How much media one output fragment may cover, in seconds.
   *
   * With frag_keyframe a fragment WAS a GOP, so a file whose keyframes are ten seconds apart made a
   * seek wait through ten seconds of muxing to get anything back, however little of it was wanted.
   *
   * Measured over twelve seeks of a 1080p HEVC file whose keyframes average 2.84s apart, against the
   * same file at GOP fragments: 258ms median and 288ms mean before, 227ms and 264ms after. A file
   * already keyframed every two seconds barely moves, 191ms to 179ms, which is the point: this
   * removes the overshoot past what a seek needs, and a short GOP never had any.
   *
   * The rest of a seek is not overshoot and this cannot touch it. A seek has to mux from the keyframe
   * to the target plus the runway the caller builds, and at roughly 33ms per second of media that is
   * most of what remains.
   *
   * Not smaller than one second without a reason: every fragment carries a moof header and the pump
   * reads one per call, so halving this doubles the round trips. 0.5s measured no better.
   */
  static constexpr double FRAGMENT_SECONDS = 1.0;

  /*
   * The fragment being written, tracked separately from the keyframe bookkeeping above.
   *
   * frag_custom hands the decision of where a fragment ends to this class, so a fragment is no longer
   * a GOP and prev_pts/prev_duration can no longer describe one: within a single GOP they would
   * report the same pts for every fragment in it, which reads to the caller as a stream that never
   * advances.
   */
  bool frag_open = false;
  double frag_pts = 0;
  int64_t frag_pos = 0;
  double frag_seconds = 0;

  /**
   * How far past a seek target fragments are cut on LENGTH rather than on keyframes, in seconds.
   *
   * Cutting everywhere costs more than it saves. Measured over 60s of continuous reading, one second
   * fragments took 58 worker round trips and 1705ms where GOP fragments took 13 and 1489ms, so
   * ordinary playback pays 14% for a saving only a seek collects. Outside this window the muxer goes
   * back to a fragment per GOP, which is what playback wants.
   *
   * Wide enough to cover what a seek actually reads: the distance back to the keyframe plus the
   * runway the caller builds before it moves the playhead.
   */
  static constexpr double SEEK_FRAGMENT_WINDOW = 12.0;
  /** Media time up to which the window above applies, or negative when no seek is being served. */
  double cut_on_length_until = -1;

  /* The fragment closed during this read, which is the one being reported. */
  bool frag_closed = false;
  double closed_pts = 0;
  int64_t closed_pos = 0;
  double closed_seconds = 0;

  std::string video_mime_type;
  std::string audio_mime_type;

  bool initializing = false;
  bool first_initialization_done = false;
  // whether av_write_trailer has already run against the CURRENT output context
  bool output_finalized = false;
  /**
   * The probe reads the first open made, replayed to every reopen so a seek costs no JS reads.
   *
   * Keyed by offset, not by call order. A reopen does not always ask for the same sequence: the
   * bitstream filter probe reads until it finds a frame, so one extra or one fewer read shifts a
   * positional replay onto another range's bytes with nothing anywhere to detect it. An offset that
   * was never cached falls through to a real read instead of being answered wrongly.
   */
  struct CachedRead {
    int64_t offset;
    std::string bytes;
  };
  std::vector<CachedRead> init_vector;
  std::vector<uint8_t> write_vector;
  std::vector<Attachment> attachments;
  std::vector<SubtitleFragment> subtitles;
  std::vector<AudioStream> audio_streams;
  int selected_audio_index = -1;

  emscripten::val resolved_promise = val::undefined();
  emscripten::val read_data_function = val::undefined();

  AVPacket* packet = nullptr;
  bool wrote = false;

  /** names from `audio_passthrough_name` that the caller's browser will accept in an mp4 */
  std::set<std::string> browser_audio_codecs;
  /** set between write_header and the delayed moov reaching avio_write */
  bool header_pending = false;

  /** audio reaches the browser untouched only if the muxer can carry it AND the browser can decode it */
  bool audio_passthrough_ok(AVCodecID codec_id) const {
    const char* name = audio_passthrough_name(codec_id);
    return name && browser_audio_codecs.count(name) > 0;
  }

  // Everything else audio, from dts through vorbis, mp3, wma and raw pcm, re-encodes to aac rather than
  // being dropped. Video has no equivalent: re-encoding it is far too expensive to do live.
  bool needs_transcoding_to_aac(AVCodecID codec_id) const {
    return !audio_passthrough_ok(codec_id)
      && avcodec_find_decoder(codec_id) != nullptr
      && avcodec_find_encoder(AV_CODEC_ID_AAC) != nullptr;
  }

  /** ac3 and eac3 fill their mp4 sample entry from the first packet, so the moov cannot be written yet */
  bool needs_delayed_moov() const {
    if (!output_format_context) return false;
    for (unsigned int i = 0; i < output_format_context->nb_streams; i++) {
      const AVCodecID id = output_format_context->streams[i]->codecpar->codec_id;
      if (id == AV_CODEC_ID_AC3 || id == AV_CODEC_ID_EAC3) return true;
    }
    return false;
  }

  Remuxer(emscripten::val options) {
    resolved_promise = options["resolvedPromise"];
    input_length = options["length"].as<double>();
    buffer_size = options["bufferSize"].as<int>();
    selected_audio_index = options["audioStreamIndex"].isUndefined() ? -1 : options["audioStreamIndex"].as<int>();
    /*
     * No list means the set every build passed through before the browser was asked.
     *
     * The fallback NARROWS rather than widens: handing a browser a codec it cannot decode fails as silent
     * audio rather than as an error, which is far worse than a transcode that was not needed.
     */
    emscripten::val codecs = options["audioCodecs"];
    if (codecs.isUndefined() || codecs.isNull()) {
      browser_audio_codecs = { "aac", "opus", "flac" };
    } else {
      const int count = codecs["length"].as<int>();
      for (int i = 0; i < count; i++) browser_audio_codecs.insert(codecs[i].as<std::string>());
    }
    needs_audio_transcoding = false;
    next_audio_pts = 0;
    audio_pts_initialized = false;
  }

  ~Remuxer() {
    destroy();
  }

  // Takes effect on the next seek, which rebuilds the stream mapping.
  void set_audio_stream_index(int index) {
    selected_audio_index = index;
  }

  // std::to_string is decimal, which matched only while the value stayed below 10. Main profile's
  // compatibility flags reverse to 6, so every ordinary hevc file hid this; a RExt stream reverses to 0x10
  // and was named hev1.4.16 instead of hev1.4.10, which no browser matches against its own decoder list.
  auto decimalToHex(int d, int padding) {
    char buffer[16];
    snprintf(buffer, sizeof(buffer), "%x", d);
    std::string hex = buffer;
    while ((int)hex.length() < padding) {
      hex = "0" + hex;
    }
    return hex;
  }

  /**
   * Whether the mp4 output can carry this audio at all.
   *
   * Handed a codec it cannot write, avformat_write_header fails, and an audio track the muxer will not take
   * is dropped from the output instead: the file then plays video only, which is worth far more than it not
   * playing at all. Almost nothing reaches this now that everything with a decoder re-encodes to aac; it is
   * the codecs this build carries no decoder for that end up here.
   */
  bool output_accepts_audio(AVCodecID codec_id) {
    return audio_passthrough_ok(codec_id) || needs_transcoding_to_aac(codec_id);
  }

  std::string parse_mp4a_mime_type(AVCodecParameters* in_codecpar) {
    switch (in_codecpar->profile) {
      case FF_PROFILE_AAC_LOW:  return "mp4a.40.2";   // AAC-LC
      case FF_PROFILE_AAC_HE:   return "mp4a.40.5";   // HE-AAC / AAC+ (SBR)
      case FF_PROFILE_AAC_HE_V2:return "mp4a.40.29";  // HE-AAC v2 (SBR+PS)
      case FF_PROFILE_AAC_LD:   return "mp4a.40.23";  // AAC-LD
      case FF_PROFILE_AAC_ELD:  return "mp4a.40.39";  // AAC-ELD
      // AAC-LC, rather than a string no browser accepts. A profile lavf could not work out is not a
      // reason to make the whole file unplayable, and it is what all but a rounding error of files carry.
      default:                  return "mp4a.40.2";
    }
  }

  /**
   * The name a browser knows this audio by, in a `codecs=` string.
   *
   * Only reached for the passthrough codecs: anything transcoded is aac by definition and is named at the
   * point the transcode is decided, since its input profile says nothing about the output.
   */
  std::string parse_audio_mime_type(AVCodecParameters* in_codecpar) {
    switch (in_codecpar->codec_id) {
      case AV_CODEC_ID_AAC:  return parse_mp4a_mime_type(in_codecpar);
      case AV_CODEC_ID_OPUS: return "opus";
      case AV_CODEC_ID_FLAC: return "flac";
      case AV_CODEC_ID_EAC3: return "ec-3";
      case AV_CODEC_ID_AC3:  return "ac-3";
      default:               return "";
    }
  }

  /**
   * The start of the first NAL of `nal_type` in Annex-B extradata, or nullptr.
   *
   * mp4 stores h264/hevc parameter sets as a length-prefixed avcC/hvcC record, which is what
   * extradata[0] == 1 marks. Every other container stores them as raw Annex-B: start code, NAL, start
   * code, NAL. movenc converts that form itself when muxing, but the codec string has to be built before
   * the first packet is written, so the profile and level get read out of the SPS directly.
   */
  const uint8_t* find_annexb_nal(const uint8_t* data, int size, int nal_type, bool is_hevc, int* out_size) {
    for (int i = 0; i + 3 < size; i++) {
      if (data[i] != 0 || data[i + 1] != 0) continue;
      int start;
      if (data[i + 2] == 1) start = i + 3;
      else if (data[i + 2] == 0 && i + 4 < size && data[i + 3] == 1) start = i + 4;
      else continue;

      int type = is_hevc ? ((data[start] >> 1) & 0x3F) : (data[start] & 0x1F);
      if (type != nal_type) continue;

      // the payload runs to the next start code, or to the end
      int end = size;
      for (int j = start; j + 2 < size; j++) {
        if (data[j] == 0 && data[j + 1] == 0 && (data[j + 2] == 1 || (data[j + 2] == 0 && j + 3 < size && data[j + 3] == 1))) {
          end = j;
          break;
        }
      }
      *out_size = end - start;
      return data + start;
    }
    return nullptr;
  }

  /**
   * Annex-B payload with emulation prevention bytes removed.
   *
   * A NAL cannot contain 00 00 00/01/02/03, so an encoder writing three zero bytes inserts 00 00 03 and
   * the reader drops the 03. The hevc profile_tier_level is mostly reserved zeros, so this fires on real
   * streams routinely rather than as an edge case: skipping it shifts general_level_idc by a byte.
   */
  std::vector<uint8_t> strip_emulation_prevention(const uint8_t* data, int size, int limit) {
    std::vector<uint8_t> out;
    out.reserve(limit);
    int zeros = 0;
    for (int i = 0; i < size && (int)out.size() < limit; i++) {
      if (zeros == 2 && data[i] == 3) { zeros = 0; continue; }
      zeros = data[i] == 0 ? zeros + 1 : 0;
      out.push_back(data[i]);
    }
    return out;
  }

  std::string parse_h264_mime_type(AVCodecParameters *in_codecpar) {
    auto extradata = in_codecpar->extradata;
    auto extradata_size = in_codecpar->extradata_size;
    char mime_type[50];

    if (!extradata || extradata_size < 4) {
      printf("Invalid extradata.\n");
      return "";
    }

    uint8_t profile, constraints, level;

    if (extradata[0] == 1) {
      // https://github.com/gpac/mp4box.js/blob/a8f4cd883b8221bedef1da8c6d5979c2ab9632a8/src/parsing/avcC.js#L6
      profile = extradata[1];
      constraints = extradata[2];
      level = extradata[3];
    } else {
      int sps_size = 0;
      const uint8_t* sps = find_annexb_nal(extradata, extradata_size, 7, false, &sps_size);
      if (!sps || sps_size < 4) {
        printf("No h264 SPS in Annex-B extradata.\n");
        return "";
      }
      // profile_idc, constraint flags and level_idc are the three bytes straight after the NAL header, so
      // no emulation prevention can have intervened yet
      profile = sps[1];
      constraints = sps[2];
      level = sps[3];
    }

    sprintf(mime_type, "avc1.%02x%02x%02x", profile, constraints, level);
    return mime_type;
  }

  std::string parse_h265_mime_type(AVCodecParameters *in_codecpar) {
    auto extradata = in_codecpar->extradata;
    auto extradata_size = in_codecpar->extradata_size;
    char mime_type[50];

    if (!extradata || extradata_size < 13) {
      printf("Invalid extradata.\n");
      return "";
    }

    // profile_tier_level occupies hvcC bytes 1..12, and in an Annex-B SPS it occupies the twelve bytes
    // straight after sps_video_parameter_set_id/max_sub_layers/temporal_id_nesting. Same fields, same
    // order, so one parser reads both once the Annex-B copy is lined up at the same offset.
    std::vector<uint8_t> annexb;
    if (extradata[0] != 1) {
      int sps_size = 0;
      const uint8_t* sps = find_annexb_nal(extradata, extradata_size, 33, true, &sps_size);
      if (!sps || sps_size < 15) {
        printf("No hevc SPS in Annex-B extradata.\n");
        return "";
      }
      // 2 byte NAL header, then one byte of ids; that ids byte lands where hvcC keeps configurationVersion,
      // which this parser reads only to tell the two forms apart and never again
      annexb = strip_emulation_prevention(sps + 2, sps_size - 2, 13);
      if (annexb.size() < 13) {
        printf("Truncated hevc SPS.\n");
        return "";
      }
      extradata = annexb.data();
      extradata_size = annexb.size();
    }

    // https://github.com/gpac/mp4box.js/blob/a8f4cd883b8221bedef1da8c6d5979c2ab9632a8/src/parsing/hvcC.js
    // https://github.com/gpac/mp4box.js/blob/a8f4cd883b8221bedef1da8c6d5979c2ab9632a8/src/box-codecs.js#L106
    // https://github.com/paulhiggs/codec-string/blob/ab2e7869f1d9207b24cfd29031b79d7abf164a5e/src/decode-hevc.js
    uint8_t multi = extradata[1];
    uint8_t general_profile_space = multi >> 6;
    uint8_t general_tier_flag = (multi & 0x20) >> 5;
    uint8_t general_profile_idc = (multi & 0x1F);
    uint32_t general_profile_compatibility_flags = extradata[2] << 24 | extradata[3] << 16 | extradata[4] << 8 | extradata[5];
    uint8_t general_constraint_indicator_flags = extradata[6];
    uint8_t general_level_idc = extradata[12];

    auto general_profile_space_str =
      general_profile_space == 0 ? "" :
      general_profile_space == 1 ? "A" :
      general_profile_space == 2 ? "B" :
      "C";

    uint8_t reversed = 0;
    for (int i=0; i<32; i++) {
      reversed |= general_profile_compatibility_flags & 1;
      if (i==31) break;
      reversed <<= 1;
      general_profile_compatibility_flags >>=1;
    }
    uint8_t general_profile_compatibility_reversed = reversed;

    auto general_tier_flag_str =
      general_tier_flag == 0
        ? "L"
        : "H";

    sprintf(
      mime_type, "hev1.%s%d.%s.%s%d.%02x",
      general_profile_space_str,
      general_profile_idc,
      decimalToHex(general_profile_compatibility_reversed, 0).c_str(),
      general_tier_flag_str,
      general_level_idc,
      general_constraint_indicator_flags
    );
    return mime_type;
  }

  /**
   * vp09.PP.LL.DD: profile, level, bit depth.
   *
   * The level is the one field no container hands over. Matroska stores none, so codecpar->level comes back
   * unset, and vp9 carries no in-band sequence header to read one out of either. It is instead a function
   * of the picture size and rate, which is what this table encodes, straight from the VP9 spec's level
   * definitions. A level that overstates the stream is harmless, since a decoder at level N handles
   * everything below it; a level Chrome does not recognise as a level at all is not, so this rounds up to
   * a real one rather than computing a plausible number.
   */
  std::string parse_vp9_mime_type(AVCodecParameters* in_codecpar, AVRational frame_rate) {
    struct VP9Level { int level; int64_t sample_rate; int64_t picture_size; int dimension; };
    static const VP9Level levels[] = {
      { 10,        829440,    36864,   512 },
      { 11,       2764800,    73728,   768 },
      { 20,       4608000,   122880,   960 },
      { 21,       9216000,   245760,  1344 },
      { 30,      20736000,   552960,  2048 },
      { 31,      36864000,   983040,  2752 },
      { 40,      83558400,  2228224,  4160 },
      { 41,     160432128,  2228224,  4160 },
      { 50,     311951360,  8912896,  8384 },
      { 51,     588251136,  8912896,  8384 },
      { 52,    1176502272,  8912896,  8384 },
      { 60,    1176502272, 35651584, 16832 },
      { 61,    2353004544, 35651584, 16832 },
      { 62,    4706009088, 35651584, 16832 },
    };

    int width = in_codecpar->width > 0 ? in_codecpar->width : 1920;
    int height = in_codecpar->height > 0 ? in_codecpar->height : 1080;
    double fps = frame_rate.den > 0 ? av_q2d(frame_rate) : 30.0;
    if (fps <= 0 || fps > 1000) fps = 30.0;

    int64_t picture_size = (int64_t)width * height;
    int64_t sample_rate = (int64_t)(picture_size * fps);
    int dimension = width > height ? width : height;

    int level = in_codecpar->level;
    // -99 is lavf's "unset", and matroska sets nothing, so this is the normal path rather than a fallback
    if (level <= 0) {
      level = levels[sizeof(levels) / sizeof(levels[0]) - 1].level;
      for (const auto& candidate : levels) {
        if (candidate.sample_rate >= sample_rate && candidate.picture_size >= picture_size && candidate.dimension >= dimension) {
          level = candidate.level;
          break;
        }
      }
    }

    int bit_depth = 8;
    const AVPixFmtDescriptor* descriptor = av_pix_fmt_desc_get((AVPixelFormat)in_codecpar->format);
    if (descriptor && descriptor->comp[0].depth > 0) bit_depth = descriptor->comp[0].depth;

    int profile = in_codecpar->profile;
    if (profile < 0 || profile > 3) profile = 0;

    char mime_type[50];
    sprintf(mime_type, "vp09.%02d.%02d.%02d", profile, level, bit_depth);
    return mime_type;
  }

  /**
   * av01.P.LLT.DD: profile, level, tier, bit depth.
   *
   * Every field comes out of the AV1CodecConfigurationRecord, which is what both matroska's CodecPrivate
   * and mp4's av1C box hold verbatim, so unlike vp9 there is nothing to derive.
   */
  std::string parse_av1_mime_type(AVCodecParameters* in_codecpar) {
    auto extradata = in_codecpar->extradata;
    if (!extradata || in_codecpar->extradata_size < 4 || (extradata[0] & 0x80) == 0) {
      printf("Invalid av1 configuration record.\n");
      return "";
    }

    uint8_t seq_profile = (extradata[1] >> 5) & 0x07;
    uint8_t seq_level_idx = extradata[1] & 0x1F;
    uint8_t seq_tier = (extradata[2] >> 7) & 0x01;
    uint8_t high_bitdepth = (extradata[2] >> 6) & 0x01;
    uint8_t twelve_bit = (extradata[2] >> 5) & 0x01;

    int bit_depth = seq_profile == 2 && high_bitdepth ? (twelve_bit ? 12 : 10) : (high_bitdepth ? 10 : 8);

    char mime_type[50];
    sprintf(mime_type, "av01.%d.%02d%c.%02d", seq_profile, seq_level_idx, seq_tier ? 'H' : 'M', bit_depth);
    return mime_type;
  }

  int fill_stream_info(AVStream *avs, const AVCodec **avc, AVCodecContext **avcc) {
    *avc = avcodec_find_decoder(avs->codecpar->codec_id);
    if (!*avc) {
        printf("failed to find the codec\n"); return -1;
    }

    *avcc = avcodec_alloc_context3(*avc);
    if (!*avcc) {
        printf("failed to alloc memory for codec context\n"); return -1;
    }

    if (avcodec_parameters_to_context(*avcc, avs->codecpar) < 0) {
        printf("failed to fill codec context\n"); return -1;
    }

    if (avcodec_open2(*avcc, *avc, NULL) < 0) {
        printf("failed to open codec\n"); return -1;
    }
    return 0;
  }

  int prepare_audio_encoder(){
    if (!needs_audio_transcoding) {
        return 0;
    }

    AVStream* output_audio_stream = nullptr;
    for (int i = 0; i < output_format_context->nb_streams; i++) {
        if (output_format_context->streams[i]->codecpar->codec_type == AVMEDIA_TYPE_AUDIO) {
            output_audio_stream = output_format_context->streams[i];
            break;
        }
    }

    if (!output_audio_stream) {
        printf("No audio output stream found\n");
        return -1;
    }

    audio_avc = avcodec_find_encoder_by_name("aac");
    if (!audio_avc) {
        printf("could not find AAC encoder\n");
        return -1;
    }

    audio_avcc = avcodec_alloc_context3(audio_avc);
    if (!audio_avcc) {
        printf("could not allocate memory for codec context\n");
        return -1;
    }

    int input_channels = audio_decoder_avcc->ch_layout.nb_channels;
    if (input_channels > 2) input_channels = 2;
    if (input_channels < 1) input_channels = 2;
    int sample_rate = encoder_sample_rate(audio_decoder_avcc->sample_rate);

    av_channel_layout_default(&audio_avcc->ch_layout, input_channels);
    audio_avcc->sample_rate = sample_rate;
    // the AAC encoder takes float planar input only
    audio_avcc->sample_fmt = AV_SAMPLE_FMT_FLTP;
    audio_avcc->bit_rate = 196000;
    audio_avcc->time_base = (AVRational){1, sample_rate};
    audio_avcc->strict_std_compliance = FF_COMPLIANCE_EXPERIMENTAL;

    if (avcodec_open2(audio_avcc, audio_avc, NULL) < 0) {
        printf("could not open AAC encoder\n");
        return -1;
    }

    avcodec_parameters_from_context(output_audio_stream->codecpar, audio_avcc);
    output_audio_stream->time_base = audio_avcc->time_base;

    // required by the mp4 muxer, avcodec_parameters_from_context does not set it
    output_audio_stream->codecpar->frame_size = aac_frame_size;

    audio_output_frame->format = audio_avcc->sample_fmt;
    audio_output_frame->ch_layout = audio_avcc->ch_layout;
    audio_output_frame->sample_rate = audio_avcc->sample_rate;
    audio_output_frame->nb_samples = aac_frame_size;

    if (av_frame_get_buffer(audio_output_frame, 0) < 0) {
        printf("Could not allocate audio output frame buffer\n");
        return -1;
    }

    audio_fifo = av_audio_fifo_alloc(audio_avcc->sample_fmt, audio_avcc->ch_layout.nb_channels, aac_frame_size * 4);
    if (!audio_fifo) {
        printf("could not allocate the audio fifo\n");
        return -1;
    }

    return 0;
  }

  /**
   * The nearest rate the aac encoder actually supports.
   *
   * avcodec_open2 refuses a rate outside the encoder's list, and a codec is free to use one: 37800 and
   * 18900 turn up in LPCM off optical media. Refusing to open left the transcode flag set with no encoder
   * behind it, so resampling to a rate that opens is the difference between audio and a null dereference.
   */
  int encoder_sample_rate(int rate) {
    if (rate <= 0) return 48000;
    const int* supported = audio_avc ? audio_avc->supported_samplerates : nullptr;
    if (!supported) return rate;

    int best = 0;
    for (int i = 0; supported[i]; i++) {
      if (supported[i] == rate) return rate;
      if (!best || abs(supported[i] - rate) < abs(best - rate)) best = supported[i];
    }
    return best ? best : rate;
  }

  int send_audio_frame_to_encoder(AVFrame *frame, AVStream *out_stream) {
    AVPacket *output_packet = av_packet_alloc();
    if (!output_packet) {
        printf("could not allocate memory for output packet\n");
        return -1;
    }

    int response = avcodec_send_frame(audio_avcc, frame);

    while (response >= 0) {
      response = avcodec_receive_packet(audio_avcc, output_packet);
      if (response == AVERROR(EAGAIN) || response == AVERROR_EOF) {
        break;
      } else if (response < 0) {
        printf("Error while receiving packet from encoder: %s\n", av_err2str(response));
        av_packet_free(&output_packet);
        return -1;
      }

      output_packet->stream_index = streams_list[audio_index];
      av_packet_rescale_ts(output_packet, audio_avcc->time_base, out_stream->time_base);

      response = av_interleaved_write_frame(output_format_context, output_packet);
      if (response != 0) {
          printf("Error %d while writing encoded packet: %s\n", response, av_err2str(response));
          av_packet_free(&output_packet);
          return -1;
      }
      av_packet_unref(output_packet);
    }
    av_packet_free(&output_packet);
    return 0;
  }

  /**
   * A resampler that accepts this frame, building or rebuilding one if the last does not.
   *
   * Configured from the frame rather than from the decoder context, because the context describes what
   * the container claimed before anything was decoded and the frame describes what actually came out. No
   * fixture here needs the difference, so this is a guard rather than a fix: a stream that changes format
   * partway through rebuilds instead of failing every convert from that point on.
   */
  int ensure_resampler(const AVFrame* frame) {
    if (audio_resampler
        && resampler_in_format == frame->format
        && resampler_in_rate == frame->sample_rate
        && av_channel_layout_compare(&resampler_in_layout, &frame->ch_layout) == 0) {
      return 0;
    }

    swr_free(&audio_resampler);
    av_channel_layout_uninit(&resampler_in_layout);

    if (swr_alloc_set_opts2(
          &audio_resampler,
          &audio_avcc->ch_layout, audio_avcc->sample_fmt, audio_avcc->sample_rate,
          &frame->ch_layout, (AVSampleFormat)frame->format, frame->sample_rate,
          0, nullptr
        ) < 0 || swr_init(audio_resampler) < 0) {
      printf("Could not open the audio resampler\n");
      swr_free(&audio_resampler);
      return -1;
    }

    resampler_in_format = frame->format;
    resampler_in_rate = frame->sample_rate;
    av_channel_layout_copy(&resampler_in_layout, &frame->ch_layout);
    return 0;
  }

  int encode_audio(AVFrame *input_frame, AVStream *out_stream) {
    if (!needs_audio_transcoding || !audio_fifo) {
        return send_audio_frame_to_encoder(input_frame, out_stream);
    }

    // A decoder may hand back a channel count with no layout attached, and raw pcm routinely does.
    // swr_init resolves that to the default layout for the count, after which the resampler's own
    // configuration no longer matches the frames being fed to it and every convert fails with "Input
    // changed". Naming the layout here keeps the two the same.
    if (input_frame->ch_layout.order == AV_CHANNEL_ORDER_UNSPEC) {
        av_channel_layout_default(&input_frame->ch_layout, input_frame->ch_layout.nb_channels);
    }

    if (ensure_resampler(input_frame) < 0) return -1;

    AVFrame* converted = av_frame_alloc();
    if (!converted) return -1;
    av_channel_layout_copy(&converted->ch_layout, &audio_avcc->ch_layout);
    converted->format = audio_avcc->sample_fmt;
    converted->sample_rate = audio_avcc->sample_rate;

    // left at nb_samples 0, so swresample sizes and allocates the destination itself from whatever the
    // decoder handed over plus whatever it is still holding back
    int ret = swr_convert_frame(audio_resampler, converted, input_frame);
    if (ret < 0) {
        printf("Error resampling audio: %s\n", ffmpegErrStr(ret).c_str());
        av_frame_free(&converted);
        return -1;
    }

    if (converted->nb_samples > 0
        && av_audio_fifo_write(audio_fifo, (void**)converted->data, converted->nb_samples) < converted->nb_samples) {
        printf("Could not write to the audio fifo\n");
        av_frame_free(&converted);
        return -1;
    }
    av_frame_free(&converted);

    while (av_audio_fifo_size(audio_fifo) >= aac_frame_size) {
        // the encoder keeps a reference to frames it has been sent, so reusing this one without asking
        // for a private copy would rewrite audio that has not been encoded yet
        if (av_frame_make_writable(audio_output_frame) < 0) return -1;
        if (av_audio_fifo_read(audio_fifo, (void**)audio_output_frame->data, aac_frame_size) < aac_frame_size) {
            printf("Short read from the audio fifo\n");
            return -1;
        }

        audio_output_frame->nb_samples = aac_frame_size;
        audio_output_frame->pts = next_audio_pts;
        // works only because the encoder time_base is {1, sample_rate}, so one sample is one tick; any other time base drifts silently
        next_audio_pts += aac_frame_size;

        if (send_audio_frame_to_encoder(audio_output_frame, out_stream) < 0) {
            return -1;
        }
    }

    return 0;
  }

  int transcode_audio(AVPacket *input_packet, AVStream *out_stream) {
    int response = avcodec_send_packet(audio_decoder_avcc, input_packet);
    if (response < 0) {
        printf("Error while sending packet to decoder: %s\n", av_err2str(response));
        return response;
    }

    while (response >= 0) {
      response = avcodec_receive_frame(audio_decoder_avcc, audio_input_frame);
      if (response == AVERROR(EAGAIN) || response == AVERROR_EOF) {
        break;
      } else if (response < 0) {
        printf("Error while receiving frame from decoder: %s\n", av_err2str(response));
        return response;
      }

      if (response >= 0) {
        if (!audio_pts_initialized && input_packet->pts != AV_NOPTS_VALUE) {
          next_audio_pts = av_rescale_q(input_packet->pts,
                                        input_format_context->streams[audio_index]->time_base,
                                        audio_avcc->time_base);
          audio_pts_initialized = true;
        }
        if (encode_audio(audio_input_frame, out_stream)) return -1;
      }
      av_frame_unref(audio_input_frame);
    }
    return 0;
  }

  int prepare_decoder() {
    if (audio_index < 0) return 0;
    audio_avs = input_format_context->streams[audio_index];

    if (needs_audio_transcoding) {
        if (fill_stream_info(audio_avs, &audio_decoder_avc, &audio_decoder_avcc))
            return -1;

        audio_input_frame = av_frame_alloc();
        if (!audio_input_frame) {
            printf("Could not allocate audio input frame\n");
            return -1;
        }

        audio_output_frame = av_frame_alloc();
        if (!audio_output_frame) {
            printf("Could not allocate audio output frame\n");
            return -1;
        }
    }
    return 0;
  }

  // Returns the requested audioStreamIndex when valid, else the first audio stream.
  int collect_audio_streams() {
    audio_streams.clear();
    audio_index = -1;
    int first_audio = -1;
    int first_usable = -1;
    bool selected_valid = false;
    for (int i = 0; i < input_format_context->nb_streams; i++) {
      AVStream* in_stream = input_format_context->streams[i];
      if (in_stream->codecpar->codec_type != AVMEDIA_TYPE_AUDIO) continue;
      if (first_audio < 0) first_audio = i;
      if (first_usable < 0 && output_accepts_audio(in_stream->codecpar->codec_id)) first_usable = i;
      if (i == selected_audio_index) selected_valid = true;
      AudioStream audio_stream;
      audio_stream.streamIndex = i;
      if (auto lang = av_dict_get(in_stream->metadata, "language", NULL, 0)) audio_stream.language = lang->value;
      if (auto title = av_dict_get(in_stream->metadata, "title", NULL, 0)) audio_stream.title = title->value;
      audio_streams.push_back(audio_stream);
    }
    // Default to the first track that can actually reach the output rather than simply the first track. A
    // file whose first track is a codec this build has no decoder for would otherwise play silent, while a
    // perfectly usable second track sat next to it. An explicit choice is still honoured as made.
    if (selected_valid) return selected_audio_index;
    return first_usable >= 0 ? first_usable : first_audio;
  }

  void init_input(bool skip = false) {
    uint8_t* input_avio_buffer = (uint8_t*)av_malloc(buffer_size);
    // args after the buffer size: 0 = not writing, this = opaque, avio_read = custom read, nullptr = no write, avio_seek = custom seek
    input_avio_context = avio_alloc_context(
      input_avio_buffer,
      buffer_size,
      0,
      this,
      avio_read,
      nullptr,
      avio_seek
    );
    input_format_context = avformat_alloc_context();
    input_format_context->pb = input_avio_context;

    // this branch carries an AVDictionary of analyzeduration/probesize tuning for codec detection during seek, both av_dict_set calls disabled for now; do not collapse it into the else
    if (skip) {
      AVDictionary* opts = nullptr;
      int ret = avformat_open_input(&input_format_context, NULL, nullptr, &opts);
      if (ret < 0) {
        throw std::runtime_error(
          "Could not open input: " + ffmpegErrStr(ret)
        );
      }
    } else {
      int ret = avformat_open_input(&input_format_context, NULL, nullptr, nullptr);
      if (ret < 0) {
        throw std::runtime_error(
          "Could not open input: " + ffmpegErrStr(ret)
        );
      }
    }
  }

  void destroy_input() {
    if (input_avio_context) {
      av_free(input_avio_context->buffer);
      input_avio_context->buffer = nullptr;
      avio_context_free(&input_avio_context);
      input_avio_context = nullptr;
    }
    if (input_format_context) {
      avformat_close_input(&input_format_context);
      input_format_context = nullptr;
    }
  }

  void init_output() {
    // a fresh output context has not been finalized, whatever the previous one had done
    output_finalized = false;
    uint8_t* output_avio_buffer = (uint8_t*)av_malloc(buffer_size);
    // args after the buffer size: 1 = write flag, this = opaque, nullptr = no read, avio_write = custom write, nullptr = no seek
    output_avio_context = avio_alloc_context(
      output_avio_buffer,
      buffer_size,
      1,
      this,
      nullptr,
      avio_write,
      nullptr
    );

    avformat_alloc_output_context2(&output_format_context, NULL, "mp4", NULL);
    output_format_context->pb = output_avio_context;
  }

  void destroy_output() {
    if (output_avio_context) {
      av_free(output_avio_context->buffer);
      output_avio_context->buffer = nullptr;
      avio_context_free(&output_avio_context);
      output_avio_context = nullptr;
    }
    if (output_format_context) {
      avformat_free_context(output_format_context);
      output_format_context = nullptr;
    }
  }

  // input-only discovery, shared by both init_streams branches and by the thumbnail path, which has no output
  void find_video_stream() {
    int ret = avformat_find_stream_info(input_format_context, nullptr);
    if (ret < 0) {
      throw std::runtime_error(
        "Could not find stream info: " + ffmpegErrStr(ret)
      );
    }

    number_of_streams = input_format_context->nb_streams;
    video_stream_index = -1;
    video_mime_type.clear();

    // The first stream that can actually be muxed wins, and a file with none still keeps a video stream
    // for the thumbnail path to decode. Taking whichever came last meant one trailing mjpeg preview track
    // decided the whole file was unplayable, and a cover image is a video stream to lavf as well: picking
    // one makes every seek and every thumbnail read from a single still.
    int fallback = -1;
    for (int i = 0; i < number_of_streams; i++) {
      AVStream* in_stream = input_format_context->streams[i];
      AVCodecParameters* in_codecpar = in_stream->codecpar;
      if (in_codecpar->codec_type != AVMEDIA_TYPE_VIDEO) continue;
      if (in_stream->disposition & AV_DISPOSITION_ATTACHED_PIC) continue;
      if (fallback < 0) fallback = i;

      std::string mime = parse_video_mime_type(in_stream);
      if (mime.empty()) continue;
      video_stream_index = i;
      video_mime_type = mime;
      break;
    }
    if (video_stream_index < 0) video_stream_index = fallback;

    if (!start_time_offset_known && video_stream_index >= 0) {
      AVStream* chosen = input_format_context->streams[video_stream_index];
      start_time_offset = chosen->start_time != AV_NOPTS_VALUE && chosen->start_time > 0
        ? av_rescale_q(chosen->start_time, chosen->time_base, AV_TIME_BASE_Q)
        : 0;
      start_time_offset_known = true;
    }
  }

  int64_t offset_in(AVRational time_base) {
    return start_time_offset ? av_rescale_q(start_time_offset, AV_TIME_BASE_Q, time_base) : 0;
  }

  // a timestamp read straight off a packet or an index entry, as seconds from the start of the content
  double content_seconds(int64_t timestamp, AVRational time_base) {
    return (timestamp - offset_in(time_base)) * av_q2d(time_base);
  }

  std::string parse_video_mime_type(AVStream* in_stream) {
    AVCodecParameters* in_codecpar = in_stream->codecpar;
    switch (in_codecpar->codec_id) {
      case AV_CODEC_ID_H264: return parse_h264_mime_type(in_codecpar);
      case AV_CODEC_ID_HEVC: return parse_h265_mime_type(in_codecpar);
      case AV_CODEC_ID_VP9:  return parse_vp9_mime_type(in_codecpar, in_stream->avg_frame_rate);
      case AV_CODEC_ID_AV1:  return parse_av1_mime_type(in_codecpar);
      default:               return "";
    }
  }

  /**
   * Build the input-to-output stream map, and decide what each stream becomes.
   *
   * `skip` is the seek path, which rebuilds the muxer from scratch and so must produce the exact same map,
   * but has no use for attachments, subtitles or chapters: those were handed over once at init and do not
   * change. It is the only difference. The two used to be separate loops, which is how the seek path came
   * to leave audio_mime_type unset for aac while the init path filled it in.
   */
  void init_streams(bool skip = false) {
    find_video_stream();
    av_freep(&streams_list);

    streams_list = (int*)av_calloc(number_of_streams, sizeof(*streams_list));
    if (!streams_list) {
      throw std::runtime_error("Could not allocate streams_list");
    }

    const int effective_audio = collect_audio_streams();

    int out_index = 0;
    for (int i = 0; i < number_of_streams; i++) {
      AVStream* in_stream = input_format_context->streams[i];
      AVCodecParameters* in_codecpar = in_stream->codecpar;
      streams_list[i] = -1;

      if (in_codecpar->codec_type == AVMEDIA_TYPE_ATTACHMENT) {
        if (skip) continue;
        Attachment attachment;

        if (auto fn = av_dict_get(in_stream->metadata, "filename", NULL, 0)) {
          attachment.filename = fn->value;
        }
        if (auto mt = av_dict_get(in_stream->metadata, "mimetype", NULL, 0)) {
          attachment.mimetype = mt->value;
        }

        attachment.size = in_codecpar->extradata_size;
        attachment.ptr = (size_t)malloc(attachment.size);
        std::memcpy((void*)attachment.ptr, in_codecpar->extradata, attachment.size);

        attachments.push_back(attachment);
        continue;
      }

      if (in_codecpar->codec_type == AVMEDIA_TYPE_SUBTITLE) {
        if (skip) continue;
        SubtitleFragment subtitle_fragment = SubtitleFragment();
        subtitle_fragment.streamIndex = i;
        subtitle_fragment.isHeader = true;
        subtitle_fragment.start = 0;
        subtitle_fragment.end = 0;
        AVDictionaryEntry* lang = av_dict_get(in_stream->metadata, "language", NULL, 0);
        if (lang) subtitle_fragment.language = lang->value;
        AVDictionaryEntry* title = av_dict_get(in_stream->metadata, "title", NULL, 0);
        if (title) subtitle_fragment.title = title->value;
        std::string subtitle_data;
        subtitle_data.assign((char*)in_codecpar->extradata, in_codecpar->extradata_size);
        subtitle_fragment.data = subtitle_data;

        subtitles.push_back(subtitle_fragment);
        continue;
      }

      if (in_codecpar->codec_type == AVMEDIA_TYPE_VIDEO) {
        // one video track reaches the output: the one find_video_stream picked, and only if mp4 can carry
        // it and a browser can name it. A cover image or a second angle muxed alongside would each get
        // their own track, and MediaSource takes the first one it finds.
        if (i != video_stream_index || video_mime_type.empty()) continue;
      }

      if (in_codecpar->codec_type == AVMEDIA_TYPE_AUDIO) {
        if (i != effective_audio || !output_accepts_audio(in_codecpar->codec_id)) continue;
        audio_index = i;
        if (needs_transcoding_to_aac(in_codecpar->codec_id)) {
          needs_audio_transcoding = true;
          audio_mime_type = "mp4a.40.2"; // describes the AAC-LC output, not the compressed input
        } else {
          audio_mime_type = parse_audio_mime_type(in_codecpar);
        }
      }

      if (in_codecpar->codec_type != AVMEDIA_TYPE_VIDEO && in_codecpar->codec_type != AVMEDIA_TYPE_AUDIO) {
        continue;
      }

      AVStream* out_stream = avformat_new_stream(output_format_context, nullptr);
      if (!out_stream) {
        throw std::runtime_error("Could not allocate an output stream");
      }

      // transcoded audio is copied as-is on purpose: prepare_audio_encoder runs later in init() and
      // overwrites these with the aac encoder's own parameters
      int cpRet = avcodec_parameters_copy(out_stream->codecpar, in_codecpar);
      if (cpRet < 0) {
        throw std::runtime_error(
          "Could not copy codec parameters: " + ffmpegErrStr(cpRet)
        );
      }

      // The input container's fourcc means nothing to mp4, and movenc rejects the ones it does not
      // recognise rather than substituting its own: AVI's 'H264' tag made every avi file fail with
      // "Could not find tag for codec h264 in stream #0". Zero asks movenc to pick the mp4 tag itself.
      out_stream->codecpar->codec_tag = 0;

      streams_list[i] = out_index++;
    }

    if (video_stream_index < 0 || video_mime_type.empty()) {
      throw std::runtime_error(
        "No playable video track: the file has no video stream, or its codec cannot be carried by mp4"
      );
    }
  }

  void destroy_audio_bsf() {
    if (audio_bsf) av_bsf_free(&audio_bsf);
    audio_bsf = nullptr;
  }

  /**
   * mp4 stores AAC as raw frames plus a single AudioSpecificConfig in the sample entry. mpegts and .aac
   * hand over ADTS instead, which repeats that configuration in a header on every frame and leaves the
   * stream's extradata empty, so movenc refuses the packets outright: "Malformed AAC bitstream detected".
   *
   * aac_adtstoasc converts them, but the sample entry has to be right before the first packet is written,
   * and empty_moov writes the header before any packet exists. So the filter is primed here on a single
   * packet purely to learn the configuration, and the input is rewound before anything is muxed. lavf will
   * not insert this itself: its automatic filtering runs per packet, which is already too late.
   */
  void prepare_audio_bitstream_filter() {
    destroy_audio_bsf();
    if (audio_index < 0 || needs_audio_transcoding || streams_list[audio_index] < 0) return;

    AVStream* in_stream = input_format_context->streams[audio_index];
    AVCodecParameters* in_codecpar = in_stream->codecpar;
    if (in_codecpar->codec_id != AV_CODEC_ID_AAC || in_codecpar->extradata_size > 0) return;

    const AVBitStreamFilter* filter = av_bsf_get_by_name("aac_adtstoasc");
    if (!filter || av_bsf_alloc(filter, &audio_bsf) < 0) {
      destroy_audio_bsf();
      return;
    }

    audio_bsf->time_base_in = in_stream->time_base;
    if (avcodec_parameters_copy(audio_bsf->par_in, in_codecpar) < 0 || av_bsf_init(audio_bsf) < 0) {
      destroy_audio_bsf();
      return;
    }

    // One audio packet is all the filter needs to work the configuration out. It publishes it as
    // NEW_EXTRADATA side data on the packet it hands back rather than on its own par_out, so that is what
    // this reads; par_out is kept as a fallback because older builds of the filter set it there instead.
    std::vector<uint8_t> config;
    AVPacket* probe = av_packet_alloc();
    AVPacket* filtered = av_packet_alloc();
    for (int reads = 0; probe && filtered && reads < 512 && config.empty(); reads++) {
      if (av_read_frame(input_format_context, probe) < 0) break;
      if (probe->stream_index != audio_index) {
        av_packet_unref(probe);
        continue;
      }
      // send takes the contents and leaves probe blank, which is exactly the state the next read wants
      if (av_bsf_send_packet(audio_bsf, probe) == 0) {
        while (av_bsf_receive_packet(audio_bsf, filtered) == 0) {
          size_t size = 0;
          const uint8_t* side = av_packet_get_side_data(filtered, AV_PKT_DATA_NEW_EXTRADATA, &size);
          if (side && size > 0 && config.empty()) config.assign(side, side + size);
          av_packet_unref(filtered);
        }
      }
      av_packet_unref(probe);
    }
    av_packet_free(&probe);
    av_packet_free(&filtered);

    if (config.empty() && audio_bsf->par_out->extradata_size > 0) {
      config.assign(
        audio_bsf->par_out->extradata,
        audio_bsf->par_out->extradata + audio_bsf->par_out->extradata_size
      );
    }

    if (!config.empty()) {
      AVCodecParameters* out_codecpar = output_format_context->streams[streams_list[audio_index]]->codecpar;
      uint8_t* copy = (uint8_t*)av_mallocz(config.size() + AV_INPUT_BUFFER_PADDING_SIZE);
      if (copy) {
        std::memcpy(copy, config.data(), config.size());
        av_freep(&out_codecpar->extradata);
        out_codecpar->extradata = copy;
        out_codecpar->extradata_size = (int)config.size();
      }
    }

    // The filter keeps nothing across packets except the fact that it has already reported the
    // configuration once, so it carries straight on from a clean queue; only the packets it consumed
    // above have to be read a second time.
    av_bsf_flush(audio_bsf);
    av_seek_frame(input_format_context, -1, 0, AVSEEK_FLAG_BACKWARD);
  }

  // aac_adtstoasc emits exactly one packet for every packet it is given, so this stays a substitution
  bool filter_audio_packet() {
    if (!audio_bsf) return true;
    if (av_bsf_send_packet(audio_bsf, packet) < 0) return false;
    return av_bsf_receive_packet(audio_bsf, packet) == 0;
  }

  void destroy_streams() {
    if (streams_list) {
      av_freep(&streams_list);
      streams_list = nullptr;
    }
  }

  void write_header() {
    AVDictionary* opts = nullptr;
    av_dict_set(&opts, "strict", "experimental", 0);
    av_dict_set(&opts, "c", "copy", 0);
    // frag_custom rather than frag_keyframe: this class closes fragments itself, on FRAGMENT_SECONDS,
    // so a long GOP no longer decides how much muxing a caller waits through. See FRAGMENT_SECONDS.
    /*
     * `delay_moov` is added ONLY for the codecs that cannot go without it.
     *
     * ac3 and eac3 fill their mp4 sample entry from the first packet, so empty_moov on its own fails
     * outright with "Cannot write moov atom before EAC3 packets parsed". delay_moov holds the moov back
     * until that packet has been muxed. Everything else keeps the old flags, and the old bytes, which is
     * why this is conditional rather than always on.
     */
    header_pending = needs_delayed_moov();
    av_dict_set(
      &opts,
      "movflags",
      header_pending
        ? "frag_custom+empty_moov+default_base_moof+delay_moov"
        : "frag_custom+empty_moov+default_base_moof",
      0
    );

    // synchronously drives the custom avio_write, which is how the mp4 init segment lands in write_vector and is returned as result.data
    int ret = avformat_write_header(output_format_context, &opts);
    if (ret < 0) {
      throw std::runtime_error(
        "Could not write header: " + ffmpegErrStr(ret)
      );
    }
  }

  void reset_fragment() {
    prev_duration = 0;
    prev_pts = 0;
    prev_pos = 0;
    keyframes_since_reset = 0;
    duration = 0;
    pts = 0;
    pos = 0;
    frag_open = false;
    frag_pts = 0;
    frag_pos = 0;
    frag_seconds = 0;
    frag_closed = false;
    closed_pts = 0;
    closed_pos = 0;
    closed_seconds = 0;
    cut_on_length_until = -1;
  }

  void clear_attachments() {
    for (auto& attachment : attachments) {
      if (attachment.ptr) {
        free((void*)attachment.ptr);
        attachment.ptr = 0;
      }
    }
    attachments.clear();
  }

  // Leaves the keyframe at or before `timestamp` in `packet`, with pos/pts/duration updated to match.
  // False means there is nothing to hand back: a failed seek, a cancelled read, or EOF.
  bool seek_to_keyframe(double timestamp) {
    AVStream* video_stream = input_format_context->streams[video_stream_index];

    // the caller counts from the start of the content, the input counts from its own clock, and
    // offset_in is the difference. Without it a file whose clock starts at 600s answers every seek with
    // the beginning of the file, since every target asked for is far behind where the content begins.
    int64_t seek_target = offset_in(video_stream->time_base) + av_rescale_q(
      timestamp * AV_TIME_BASE,
      AV_TIME_BASE_Q,
      video_stream->time_base
    );

    if (av_seek_frame(input_format_context, video_stream_index, seek_target, AVSEEK_FLAG_BACKWARD) < 0) {
      return false;
    }

    while (true) {
      packet = av_packet_alloc();
      int ret = av_read_frame(input_format_context, packet);
      if (ret < 0) {
        if (ret == AVERROR_EXIT) return false;
        if (ret == AVERROR_EOF) {
          // deliberately does NOT flush or write a trailer the way the remuxing read() path does. Running
          // off the end while hunting a keyframe says nothing about the output, and finalizing a muxer
          // from here is the one way this path could ever damage a remux. It now only reads.
          av_packet_free(&packet);
          break;
        }
        av_packet_free(&packet);
        break;
      }

      // only the video stream can carry the keyframe, so this needs no output stream map at all
      if (packet->stream_index != video_stream_index) {
        av_packet_free(&packet);
        continue;
      }

      AVStream* in_stream = input_format_context->streams[packet->stream_index];

      bool is_keyframe = packet->flags & AV_PKT_FLAG_KEY;

      duration += packet->duration * av_q2d(in_stream->time_base);

      if (is_keyframe) {
        pos = packet->pos;
        pts = content_seconds(packet->pts, in_stream->time_base);
        duration = packet->duration * av_q2d(in_stream->time_base);
        break;
      } else {
        av_packet_unref(packet);
        av_packet_free(&packet);
        continue;
      }
    }

    // The loop can exit at EOF/error with the packet already freed.
    return packet && packet->data && packet->size > 0;
  }

  bool open_video_decoder() {
    if (video_decoder_avcc) return true;

    AVStream* video_stream = input_format_context->streams[video_stream_index];
    video_decoder_avc = avcodec_find_decoder(video_stream->codecpar->codec_id);
    if (!video_decoder_avc) return false;

    video_decoder_avcc = avcodec_alloc_context3(video_decoder_avc);
    if (!video_decoder_avcc) return false;

    if (avcodec_parameters_to_context(video_decoder_avcc, video_stream->codecpar) < 0
        || avcodec_open2(video_decoder_avcc, video_decoder_avc, nullptr) < 0) {
      avcodec_free_context(&video_decoder_avcc);
      video_decoder_avcc = nullptr;
      return false;
    }
    return true;
  }

  ThumbnailReadResult read_keyframe(emscripten::val read_function, double timestamp) {
    resolved_promise.await();
    read_data_function = read_function;

    write_vector.clear();
    av_packet_free(&packet);

    ThumbnailReadResult result;

    if (!seek_to_keyframe(timestamp)) {
      result.cancelled = true;
      read_data_function = val::undefined();
      return result;
    }

    write_vector.assign(packet->data, packet->data + packet->size);

    emscripten::val js_write_vector = emscripten::val(
      emscripten::typed_memory_view(
        write_vector.size(),
        write_vector.data()
      )
    );

    result.data = js_write_vector;
    result.offset = pos;
    result.pts = pts;
    result.duration = duration;
    result.cancelled = false;

    read_data_function = val::undefined();
    return result;
  }

  /**
   * Decode that keyframe to RGBA here instead of handing the compressed packet out for WebCodecs to decode.
   * The build already carries the h264 and hevc decoders and swscale, so this needs no new dependency, and
   * it is what runs on a browser with no WebCodecs at all (Firefox for Android).
   *
   * Same instance-level caveat as read_keyframe: this seeks BACKWARD on the input, which the output muxer
   * cannot follow, so it must only ever run on a remuxer dedicated to thumbnails. Ripple gives it one by
   * calling makeRemuxer separately, and every call there stands up its own worker and its own Remuxer.
   */
  ThumbnailDecodeResult decode_keyframe(emscripten::val read_function, double timestamp, int out_width, int out_height) {
    resolved_promise.await();
    read_data_function = read_function;

    write_vector.clear();
    av_packet_free(&packet);

    ThumbnailDecodeResult result;
    result.width = 0;
    result.height = 0;
    result.pts = 0;
    result.duration = 0;
    result.cancelled = true;

    if (out_width <= 0 || out_height <= 0 || !seek_to_keyframe(timestamp) || !open_video_decoder()) {
      read_data_function = val::undefined();
      return result;
    }

    // a previous call left the decoder drained, and this one starts from its own seek regardless
    avcodec_flush_buffers(video_decoder_avcc);

    if (avcodec_send_packet(video_decoder_avcc, packet) < 0) {
      read_data_function = val::undefined();
      return result;
    }

    AVFrame* frame = av_frame_alloc();
    if (!frame) {
      read_data_function = val::undefined();
      return result;
    }

    int ret = avcodec_receive_frame(video_decoder_avcc, frame);
    if (ret == AVERROR(EAGAIN)) {
      // a decoder can hold its first frame back until it is told no more packets are coming
      avcodec_send_packet(video_decoder_avcc, nullptr);
      ret = avcodec_receive_frame(video_decoder_avcc, frame);
    }

    if (ret < 0 || frame->width <= 0 || frame->height <= 0) {
      av_frame_free(&frame);
      read_data_function = val::undefined();
      return result;
    }

    AVPixelFormat source_format = (AVPixelFormat)frame->format;
    if (!thumbnail_sws
        || thumbnail_sws_source_width != frame->width
        || thumbnail_sws_source_height != frame->height
        || thumbnail_sws_source_format != source_format
        || thumbnail_sws_width != out_width
        || thumbnail_sws_height != out_height) {
      sws_freeContext(thumbnail_sws);
      thumbnail_sws = sws_getContext(
        frame->width, frame->height, source_format,
        out_width, out_height, AV_PIX_FMT_RGBA,
        SWS_BILINEAR, nullptr, nullptr, nullptr
      );
      thumbnail_sws_source_width = frame->width;
      thumbnail_sws_source_height = frame->height;
      thumbnail_sws_source_format = source_format;
      thumbnail_sws_width = out_width;
      thumbnail_sws_height = out_height;
    }

    if (!thumbnail_sws) {
      av_frame_free(&frame);
      read_data_function = val::undefined();
      return result;
    }

    thumbnail_vector.assign((size_t)out_width * (size_t)out_height * 4, 0);
    uint8_t* destination_data[4] = { thumbnail_vector.data(), nullptr, nullptr, nullptr };
    int destination_linesize[4] = { out_width * 4, 0, 0, 0 };

    sws_scale(thumbnail_sws, frame->data, frame->linesize, 0, frame->height, destination_data, destination_linesize);

    result.data = emscripten::val(
      emscripten::typed_memory_view(
        thumbnail_vector.size(),
        thumbnail_vector.data()
      )
    );
    result.width = out_width;
    result.height = out_height;
    result.pts = pts;
    result.duration = duration;
    result.cancelled = false;

    av_frame_free(&frame);
    read_data_function = val::undefined();
    return result;
  }

  /**
   * Open a file for thumbnails only: no output muxer, no encoder, no stream map, no header.
   *
   * That is not a saving, it is the point. readKeyframe seeks BACKWARD on the input, which an output muxer
   * cannot follow, so a remuxer that also serves thumbnails can only be kept safe by convention. With no
   * muxer to damage, it is safe by construction, and files whose audio the muxer refuses outright still
   * produce thumbnails.
   */
  ThumbnailInitResult init_thumbnail(emscripten::val read_function) {
    read_data_function = read_function;

    init_input();
    find_video_stream();

    if (video_stream_index < 0) {
      throw std::runtime_error("No video stream to take thumbnails from");
    }

    ThumbnailInitResult result;
    result.duration = (double)input_format_context->duration / (double)AV_TIME_BASE;
    result.video_mime_type = video_mime_type;

    // seeking to the start is what makes lavf populate the seeking cues this walks
    av_seek_frame(input_format_context, video_stream_index, 0, AVSEEK_FLAG_BACKWARD);

    AVStream* in_stream = input_format_context->streams[video_stream_index];
    int nb_entries = avformat_index_get_entries_count(in_stream);
    for (int i = 0; i < nb_entries; i++) {
      const AVIndexEntry* entry = avformat_index_get_entry(in_stream, i);
      if (entry->flags & AVINDEX_KEYFRAME) {
        Index index;
        index.index = i;
        index.pos = entry->pos;
        index.timestamp = content_seconds(entry->timestamp, in_stream->time_base);
        result.indexes.push_back(index);
      }
    }

    AVCodecParameters* in_codecpar = in_stream->codecpar;
    if (in_codecpar->extradata && in_codecpar->extradata_size > 0) {
      result.video_extradata.assign(
        in_codecpar->extradata,
        in_codecpar->extradata + in_codecpar->extradata_size
      );
    }

    read_data_function = val::undefined();
    return result;
  }

  InitResult init(emscripten::val read_function) {
    read_data_function = read_function;

    reset_fragment();
    write_vector.clear();
    clear_attachments();
    subtitles.clear();
    video_mime_type.clear();
    audio_mime_type.clear();

    initializing = true;
    init_input();
    init_output();
    init_streams();
    prepare_decoder();
    prepare_audio_encoder();
    prepare_audio_bitstream_filter();
    write_header();
    initializing = false;
    first_initialization_done = true;

    IOInfo infoObj;
    infoObj.input.formatName  = input_format_context->iformat->name ? input_format_context->iformat->name : "";
    infoObj.input.mimeType    = input_format_context->iformat->mime_type ? input_format_context->iformat->mime_type : "";
    infoObj.input.duration    = (double)input_format_context->duration / (double)AV_TIME_BASE;
    infoObj.input.video_mime_type = video_mime_type;
    infoObj.input.audio_mime_type = audio_mime_type;

    infoObj.output.formatName = output_format_context->oformat->name ? output_format_context->oformat->name : "";
    infoObj.output.mimeType   = output_format_context->oformat->mime_type ? output_format_context->oformat->mime_type : "";
    infoObj.output.duration   = 0.0;
    infoObj.output.video_mime_type = video_mime_type;
    infoObj.output.audio_mime_type = audio_mime_type;

    InitResult result;
    emscripten::val js_write_vector = emscripten::val(
      emscripten::typed_memory_view(
        write_vector.size(),
        write_vector.data()
      )
    );

    result.data = js_write_vector;
    result.attachments = attachments;
    result.subtitles = subtitles;
    result.audio_streams = audio_streams;
    result.info = infoObj;

    for (int i = 0; i < input_format_context->nb_chapters; i++) {
      AVChapter *av_chapter = input_format_context->chapters[i];
      int64_t start_time = av_chapter->start * av_chapter->time_base.num / av_chapter->time_base.den;
      int64_t end_time = av_chapter->end * av_chapter->time_base.num / av_chapter->time_base.den;
      Chapter chapter;
      chapter.index = i;
      chapter.start = start_time;
      chapter.end = end_time;
      AVDictionaryEntry *capter_entry = NULL;
      capter_entry = av_dict_get(av_chapter->metadata, "title", NULL, 0);
      if (capter_entry) {
        chapter.title = capter_entry->value;
      }
      result.chapters.push_back(chapter);
    }

    // this is needed to load the seeking cues / indexes
    int ret = av_seek_frame(input_format_context, video_stream_index, 0, AVSEEK_FLAG_BACKWARD);

    AVStream* in_stream = input_format_context->streams[video_stream_index];
    AVCodecParameters* in_codecpar = in_stream->codecpar;
    int nb_entries = avformat_index_get_entries_count(in_stream);
    for (int i = 0; i < nb_entries; i++) {
      const AVIndexEntry* entry = avformat_index_get_entry(in_stream, i);
      if (entry->flags & AVINDEX_KEYFRAME) {
        Index index;
        index.index = i;
        index.pos = entry->pos;
        index.timestamp = content_seconds(entry->timestamp, in_stream->time_base);
        result.indexes.push_back(index);
      }
    }

    if (in_codecpar->extradata && in_codecpar->extradata_size > 0) {
      result.video_extradata.assign(
        in_codecpar->extradata,
        in_codecpar->extradata + in_codecpar->extradata_size
      );
    }

    /*
     * A delayed moov means there is nothing to hand back yet, so one read is done here to produce it.
     *
     * Placed AFTER the index walk on purpose: that walk seeks the input back to zero, so the packets this
     * consumes are the ones the caller's first `read` would have taken anyway, rather than a set that
     * would then be muxed a second time.
     */
    if (header_pending) {
      std::vector<SubtitleFragment> header_subtitles = subtitles;
      read(read_function);
      // read() cleared `subtitles` and refilled it from the fragment, so the stream headers collected in
      // init_streams have to go back in front of them
      header_subtitles.insert(header_subtitles.end(), subtitles.begin(), subtitles.end());
      result.subtitles = header_subtitles;
      // reassigned because read() may have reallocated write_vector, leaving the earlier view dangling
      result.data = emscripten::val(
        emscripten::typed_memory_view(write_vector.size(), write_vector.data())
      );
    }

    read_data_function = val::undefined();
    wrote = false;

    return result;
  }

  ReadResult read(emscripten::val read_function) {
    resolved_promise.await();

    read_data_function = read_function;

    write_vector.clear();
    subtitles.clear();
    frag_closed = false;

    bool finished = false;

    while (true) {
      packet = av_packet_alloc();
      int ret = av_read_frame(input_format_context, packet);
      if (ret < 0) {
        if (ret == AVERROR_EXIT) {
          ReadResult cancelled_result;
          cancelled_result.cancelled = true;
          read_data_function = val::undefined();
          return cancelled_result;
        }
        if (ret == AVERROR_EOF) {
          avio_flush(output_format_context->pb);
          // Once, and only once. av_write_trailer frees and NULLs s->priv_data on its way out
          // (lavf mux.c), so a second call reaches movenc with a null MOVMuxContext and dereferences
          // it. Under emcc without SAFE_HEAP that reads as zeros rather than trapping, which clears
          // FF_MOV_FLAG_FRAGMENT and sends the muxer down the non-fragmented branch, emitting a
          // degenerate moov into the output as if it were a media segment. Reachable because seek()
          // ends by calling read(), so a seek that lands at the end finalizes the muxer, and a read
          // that follows finalizes it again.
          if (!output_finalized) {
            av_write_trailer(output_format_context);
            output_finalized = true;
          }
          av_packet_free(&packet);
          finished = true;
          break;
        }
        av_packet_free(&packet);
        break;
      }

      AVStream* in_stream  = input_format_context->streams[packet->stream_index];

      if (const int64_t offset = offset_in(in_stream->time_base)) {
        if (packet->pts != AV_NOPTS_VALUE) packet->pts -= offset;
        if (packet->dts != AV_NOPTS_VALUE) packet->dts -= offset;
      }

      if (in_stream->codecpar->codec_type == AVMEDIA_TYPE_SUBTITLE) {
        SubtitleFragment subtitle_fragment;
        subtitle_fragment.streamIndex = packet->stream_index;
        subtitle_fragment.isHeader = false;
        subtitle_fragment.start = packet->pts;
        subtitle_fragment.end   = subtitle_fragment.start + packet->duration;
        std::string subtitle_data;
        subtitle_data.assign((char*)packet->data, packet->size);
        subtitle_fragment.data = subtitle_data;

        subtitles.push_back(subtitle_fragment);
        av_packet_free(&packet);
        continue;
      }

      if (packet->stream_index >= number_of_streams
          || streams_list[packet->stream_index] < 0) {
        av_packet_free(&packet);
        continue;
      }

      AVStream* out_stream = output_format_context->streams[streams_list[packet->stream_index]];

      // The map is not only for deciding what to keep, it has to be applied to the packet: the muxer reads
      // stream_index off the packet and rejects anything past the end of ITS stream list. This was silent
      // for as long as the two numberings happened to agree, which they do whenever video comes first and
      // only trailing streams are dropped. Hand it a file whose four audio tracks precede the video and
      // every video packet is refused as "Invalid packet stream index: 4", for an mp4 with no video in it.
      packet->stream_index = streams_list[packet->stream_index];

      if (in_stream->codecpar->codec_type == AVMEDIA_TYPE_AUDIO) {
        if (needs_audio_transcoding && needs_transcoding_to_aac(in_stream->codecpar->codec_id)) {
          if (transcode_audio(packet, out_stream) < 0) {
            printf("ERROR: could not transcode audio\n");
          }
        } else if (!filter_audio_packet()) {
          printf("ERROR: could not filter audio packet\n");
        } else {
          av_packet_rescale_ts(packet, in_stream->time_base, out_stream->time_base);

          if (after_seek && packet->dts != AV_NOPTS_VALUE) {
            if (last_audio_dts == AV_NOPTS_VALUE) {
              last_audio_dts = packet->dts;
            } else if (packet->dts < last_audio_dts) {
              // the mp4 muxer rejects non-monotonic dts, so force it forward and clamp pts up to match
              packet->dts = last_audio_dts + 1;
              if (packet->pts != AV_NOPTS_VALUE && packet->pts < packet->dts) {
                packet->pts = packet->dts;
              }
            }
            last_audio_dts = packet->dts;
          }

          if ((ret = av_interleaved_write_frame(output_format_context, packet)) < 0) {
            printf("ERROR: could not write interleaved frame | %s \n", av_err2str(ret));
          }
        }
        av_packet_unref(packet);
        av_packet_free(&packet);
        continue;
      }

      bool is_keyframe = packet->flags & AV_PKT_FLAG_KEY;

      // taken before the rescale, which reinterprets both fields in the output's time base
      const double packet_seconds = packet->duration * av_q2d(in_stream->time_base);
      const int64_t packet_pos = packet->pos;

      duration += packet_seconds;
      av_packet_rescale_ts(packet, in_stream->time_base, out_stream->time_base);

      if (after_seek && packet->dts != AV_NOPTS_VALUE) {
        if (last_video_dts == AV_NOPTS_VALUE) {
          last_video_dts = packet->dts;
        } else if (packet->dts <= last_video_dts) {
          packet->dts = last_video_dts + 1;
          if (packet->pts != AV_NOPTS_VALUE && packet->pts < packet->dts) {
            packet->pts = packet->dts;
          }
        }
        last_video_dts = packet->dts;
      }

      if (packet->pts == AV_NOPTS_VALUE && packet->dts != AV_NOPTS_VALUE) {
        packet->pts = packet->dts;
      }

      if (is_keyframe) {
        keyframes_since_reset++;
        prev_duration = duration;
        prev_pts = pts;
        prev_pos = pos;

        duration = 0;

        pts = packet->pts * av_q2d(out_stream->time_base);
        pos = packet->pos;

        if (after_seek) {
          after_seek = false;
        }
      }

      /*
       * Where one fragment ends and the next begins, decided here rather than by the muxer.
       *
       * A fragment is closed BEFORE the packet that starts the next one is written, which is what
       * lets the closed fragment be reported while the packet in hand belongs to its successor. That
       * ordering is why the keyframe case works at all: a fragment has to START at a keyframe to be
       * decodable on its own, so the keyframe cannot be the packet that ends one.
       *
       * Two reasons to close. A keyframe, which is what frag_keyframe did and what playback wants,
       * and length, but only while serving a seek. See SEEK_FRAGMENT_WINDOW for why length cutting is
       * not worth doing the rest of the time.
       */
      const double packet_pts_seconds = packet->pts * av_q2d(out_stream->time_base);
      const bool cutting_on_length =
        cut_on_length_until >= 0 && packet_pts_seconds < cut_on_length_until;
      const bool close_now =
        frag_open && frag_seconds > 0 &&
        (is_keyframe || (cutting_on_length && frag_seconds >= FRAGMENT_SECONDS));

      if (close_now) {
        closed_pts = frag_pts;
        closed_pos = frag_pos;
        closed_seconds = frag_seconds;
        frag_closed = true;
        // flushes the fragment, which drives avio_write and sets wrote
        av_write_frame(output_format_context, nullptr);
        frag_open = false;
      }

      if (!frag_open) {
        frag_open = true;
        frag_pts = packet_pts_seconds;
        frag_pos = packet_pos;
        frag_seconds = 0;
      }
      frag_seconds += packet_seconds;

      ret = av_interleaved_write_frame(output_format_context, packet);
      if (ret < 0) {
        printf("Error writing frame: %s\n", ffmpegErrStr(ret).c_str());
        break;
      }

      av_packet_free(&packet);

      if (wrote) {
        wrote = false;
        break;
      }
    }

    ReadResult result;
    emscripten::val js_write_vector = emscripten::val(
      emscripten::typed_memory_view(
        write_vector.size(),
        write_vector.data()
      )
    );

    // prev_* describe the fragment before the newest keyframe, which is what a caller wants while the
    // newest one is still being written. Before a second keyframe has gone by they were never assigned, so
    // the newest one is all there is: mpegts flushes its first fragment before a second keyframe arrives
    // where matroska does not, and reporting the reset zero put every seek in a .ts at the start of file.
    result.data = js_write_vector;
    result.subtitles = subtitles;
    /*
     * The fragment this call actually produced.
     *
     * The keyframe based prev_* pair it replaces described the GOP before the newest keyframe, which
     * was the completed fragment only while a fragment WAS a GOP. Cutting on length breaks that:
     * every fragment inside one GOP would report that GOP's pts, and libav-wasm's own suite catches
     * it as "pts must advance, or the player stalls on a repeated segment".
     */
    // the fragment this call closed, or at EOF the one the trailer flushed
    result.offset = frag_closed ? closed_pos : frag_pos;
    result.pts = frag_closed ? closed_pts : frag_pts;
    result.duration = frag_closed ? closed_seconds : frag_seconds;
    frag_closed = false;
    result.cancelled = false;
    result.finished = finished;

    read_data_function = val::undefined();
    return result;
  }

  ReadResult seek(emscripten::val read_function, double timestamp) {
    resolved_promise.await();

    read_data_function = read_function;

    /*
     * The input is NOT reopened. `av_seek_frame` below is what repositions a demuxer, and it needs a live
     * context to do it on.
     *
     * Closing and reopening re-read and re-parsed the container header on every seek, and for matroska
     * that means the cues, which sit at the tail of the file: a measured 583 KB read from the far end of
     * a 1.2 GB file, every time, for an index the still-open context already held. Dropping it took a
     * seek on a passthrough file from 14.2 ms to 10.0 ms, with byte identical output.
     */
    destroy_output();
    // init_streams/prepare_decoder/prepare_audio_encoder below all rebuild these over the live pointers,
    // so without this every seek of a transcoded-audio file leaked two codec contexts and its PCM buffers
    destroy_audio();

    av_packet_free(&packet);

    reset_fragment();
    write_vector.clear();
    clear_attachments();
    subtitles.clear();

    needs_audio_transcoding = false;

    initializing = true;
    init_output();
    init_streams(true);
    prepare_decoder();
    prepare_audio_encoder();
    prepare_audio_bitstream_filter();
    write_header();
    initializing = false;
    write_vector.clear();
    subtitles.clear();
    wrote = false;

    // destroy_audio above freed the resampler and the fifo, and prepare_audio_encoder built new ones, so
    // there is no carried-over audio left to drain; only the clock has to be seeded again from the first
    // packet at the new position
    audio_pts_initialized = false;

    last_video_dts = AV_NOPTS_VALUE;
    last_audio_dts = AV_NOPTS_VALUE;
    after_seek = true;

    // the seconds-to-time_base conversion was previously a bare millisecond value, correct only for matroska
    AVStream* video_stream = input_format_context->streams[video_stream_index];
    // same content-clock to input-clock conversion as seek_to_keyframe; see the note there
    int64_t seek_target = offset_in(video_stream->time_base) + av_rescale_q(
      timestamp * AV_TIME_BASE,
      AV_TIME_BASE_Q,
      video_stream->time_base
    );

    int ret = av_seek_frame(input_format_context, video_stream_index, seek_target, AVSEEK_FLAG_BACKWARD);
    if (ret < 0) {
      printf("ERROR: av_seek_frame: %s\n", ffmpegErrStr(ret).c_str());
      ReadResult cancelled_result;
      cancelled_result.cancelled = true;
      read_data_function = val::undefined();
      return cancelled_result;
    }

    // fragments are cut on length only while the caller is still assembling this seek
    cut_on_length_until = timestamp + SEEK_FRAGMENT_WINDOW;

    ReadResult read_result = read(read_function);
    return read_result;
  }

  // the order matters: audio_buffer's channel count is read back off audio_avcc, so that goes last
  void destroy_audio() {
    destroy_audio_bsf();
    if (audio_input_frame) {
      av_frame_free(&audio_input_frame);
      audio_input_frame = nullptr;
    }
    if (audio_output_frame) {
      av_frame_free(&audio_output_frame);
      audio_output_frame = nullptr;
    }
    if (audio_resampler) {
      swr_free(&audio_resampler);
      audio_resampler = nullptr;
    }
    av_channel_layout_uninit(&resampler_in_layout);
    resampler_in_format = AV_SAMPLE_FMT_NONE;
    resampler_in_rate = 0;
    if (audio_fifo) {
      av_audio_fifo_free(audio_fifo);
      audio_fifo = nullptr;
    }
    if (audio_decoder_avcc) {
      avcodec_free_context(&audio_decoder_avcc);
      audio_decoder_avcc = nullptr;
    }
    if (audio_avcc) {
      avcodec_free_context(&audio_avcc);
      audio_avcc = nullptr;
    }
  }

  void destroy() {
    destroy_streams();
    destroy_input();
    destroy_output();
    destroy_audio();

    if (video_decoder_avcc) {
      avcodec_free_context(&video_decoder_avcc);
      video_decoder_avcc = nullptr;
    }
    if (thumbnail_sws) {
      sws_freeContext(thumbnail_sws);
      thumbnail_sws = nullptr;
    }
  }

private:
  static int avio_read(void* opaque, uint8_t* buf, int buf_size) {
    Remuxer* self = reinterpret_cast<Remuxer*>(opaque);

    int64_t const pos = self->input_format_context->pb->pos;

    if (self->initializing && self->first_initialization_done) {
      for (auto const& entry : self->init_vector) {
        if (entry.offset != pos) continue;
        // Serve at most what was cached. A tail read is short by definition, and both mp4 (moov at the
        // end) and matroska (Cues at the end) take one during init, so copying buf_size out of a short
        // entry read past the string and fed ffmpeg that as file content on every seek.
        int const size = std::min<int>(entry.bytes.size(), buf_size);
        memcpy(buf, entry.bytes.data(), size);
        return size;
      }
      // Not a range the first open asked for: fall through and read it for real.
    }

    std::string buffer;
    emscripten::val result = self->read_data_function(to_string(pos), buf_size).await();

    bool is_rejected = result["rejected"].as<bool>();
    if (is_rejected) {
      return AVERROR_EXIT;
    }

    buffer = result["resolved"].as<std::string>();
    int buffer_size = buffer.size();
    if (buffer_size == 0) {
      return AVERROR_EOF;
    }

    if (self->initializing && !self->first_initialization_done) {
      self->init_vector.push_back({ pos, buffer });
    }

    memcpy(buf, (uint8_t*)buffer.c_str(), buffer_size);

    return buffer_size;
  }

  static int64_t avio_seek(void* opaque, int64_t offset, int whence) {
    Remuxer* self = reinterpret_cast<Remuxer*>(opaque);

    switch (whence) {
      case AVSEEK_SIZE:
        return self->input_length;
      case SEEK_SET:
        self->currentOffset = offset;
        return self->currentOffset;
      case SEEK_CUR:
        self->currentOffset = self->currentOffset + offset;
        return self->currentOffset;
      case SEEK_END:
        self->currentOffset = self->input_length - offset;
        return self->currentOffset;
      default:
        return -1;
    }
  }

  static int avio_write_impl(void* opaque, const uint8_t* buf, int buf_size) {
    Remuxer* self = reinterpret_cast<Remuxer*>(opaque);

    /*
     * A delayed moov arrives here as an ordinary write, and it must NOT end the read that produced it.
     *
     * `wrote` is what breaks the read loop, so counting the header as a fragment returned ftyp+moov on its
     * own and pushed the media a call later, which then merged two fragments into one read. Swallowing
     * exactly the first write after the header lets the read carry on to a real fragment boundary, so a
     * caller still gets one appendable block.
     */
    if (self->header_pending) {
      self->header_pending = false;
    } else {
      self->wrote = true;
    }
    self->write_vector.insert(self->write_vector.end(), buf, buf + buf_size);

    return buf_size;
  }

  #if LIBAVFORMAT_VERSION_MAJOR >= 59
  static int avio_write(void* opaque, const uint8_t* buf, int buf_size) {
  #else
  static int avio_write(void* opaque, uint8_t* buf, int buf_size) {
  #endif
    return avio_write_impl(opaque, buf, buf_size);
  }
};

EMSCRIPTEN_BINDINGS(libav_wasm_simplified) {
  emscripten::register_vector<Attachment>("VectorAttachment");
  emscripten::register_vector<SubtitleFragment>("VectorSubtitleFragment");
  emscripten::register_vector<AudioStream>("VectorAudioStream");
  emscripten::register_vector<Index>("VectorIndex");
  emscripten::register_vector<Chapter>("VectorChapter");
  emscripten::register_vector<uint8_t>("VectorUInt8");
  emscripten::register_vector<emscripten::val>("VectorVal");

  emscripten::value_object<Attachment>("Attachment")
    .field("filename", &Attachment::filename)
    .field("mimetype", &Attachment::mimetype)
    .field("ptr",      &Attachment::ptr)
    .field("size",     &Attachment::size);

  emscripten::value_object<SubtitleFragment>("SubtitleFragment")
    .field("streamIndex", &SubtitleFragment::streamIndex)
    .field("isHeader",    &SubtitleFragment::isHeader)
    .field("data",        &SubtitleFragment::data)
    .field("language",    &SubtitleFragment::language)
    .field("title",       &SubtitleFragment::title)
    .field("start",       &SubtitleFragment::start)
    .field("end",         &SubtitleFragment::end);

  emscripten::value_object<AudioStream>("AudioStream")
    .field("streamIndex", &AudioStream::streamIndex)
    .field("language",    &AudioStream::language)
    .field("title",       &AudioStream::title);

  emscripten::value_object<Chapter>("Chapter")
    .field("index",  &Chapter::index)
    .field("start",  &Chapter::start)
    .field("end",    &Chapter::end)
    .field("title",  &Chapter::title);

  emscripten::value_object<Index>("Index")
    .field("index",  &Index::index)
    .field("timestamp",  &Index::timestamp)
    .field("pos",    &Index::pos);

  emscripten::value_object<MediaInfo>("MediaInfo")
    .field("formatName",      &MediaInfo::formatName)
    .field("mimeType",        &MediaInfo::mimeType)
    .field("duration",        &MediaInfo::duration)
    .field("videoMimeType",   &MediaInfo::video_mime_type)
    .field("audioMimeType",   &MediaInfo::audio_mime_type);

  emscripten::value_object<IOInfo>("IOInfo")
    .field("input",  &IOInfo::input)
    .field("output", &IOInfo::output);

  emscripten::value_object<InitResult>("InitResult")
    .field("data",        &InitResult::data)
    .field("attachments", &InitResult::attachments)
    .field("subtitles",   &InitResult::subtitles)
    .field("audioStreams", &InitResult::audio_streams)
    .field("chapters",    &InitResult::chapters)
    .field("indexes",     &InitResult::indexes)
    .field("info",        &InitResult::info)
    .field("videoExtradata", &InitResult::video_extradata);

  emscripten::value_object<ReadResult>("ReadResult")
    .field("data",      &ReadResult::data)
    .field("subtitles", &ReadResult::subtitles)
    .field("offset",    &ReadResult::offset)
    .field("pts",       &ReadResult::pts)
    .field("duration",  &ReadResult::duration)
    .field("cancelled", &ReadResult::cancelled)
    .field("finished",  &ReadResult::finished);

  emscripten::value_object<ThumbnailReadResult>("ThumbnailReadResult")
    .field("data",      &ThumbnailReadResult::data)
    .field("offset",    &ThumbnailReadResult::offset)
    .field("pts",       &ThumbnailReadResult::pts)
    .field("duration",  &ThumbnailReadResult::duration)
    .field("cancelled", &ThumbnailReadResult::cancelled);

  emscripten::value_object<ThumbnailInitResult>("ThumbnailInitResult")
    .field("duration",       &ThumbnailInitResult::duration)
    .field("videoMimeType",  &ThumbnailInitResult::video_mime_type)
    .field("videoExtradata", &ThumbnailInitResult::video_extradata)
    .field("indexes",        &ThumbnailInitResult::indexes);

  emscripten::value_object<ThumbnailDecodeResult>("ThumbnailDecodeResult")
    .field("data",      &ThumbnailDecodeResult::data)
    .field("width",     &ThumbnailDecodeResult::width)
    .field("height",    &ThumbnailDecodeResult::height)
    .field("pts",       &ThumbnailDecodeResult::pts)
    .field("duration",  &ThumbnailDecodeResult::duration)
    .field("cancelled", &ThumbnailDecodeResult::cancelled);

  emscripten::class_<Remuxer>("Remuxer")
    .constructor<emscripten::val>()
    // every method that reaches the JS read, or awaits resolved_promise, has to be marked
    .function("init",    &Remuxer::init SUSPENDS)
    .function("read",    &Remuxer::read SUSPENDS)
    .function("seek",    &Remuxer::seek SUSPENDS)
    .function("destroy", &Remuxer::destroy)
    .function("initThumbnail", &Remuxer::init_thumbnail SUSPENDS)
    .function("readKeyframe", &Remuxer::read_keyframe SUSPENDS)
    .function("decodeKeyframe", &Remuxer::decode_keyframe SUSPENDS)
    .function("setAudioStreamIndex", &Remuxer::set_audio_stream_index);
}
