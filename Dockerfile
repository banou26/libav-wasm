FROM emscripten/emsdk:4.0.3 as build

# ARG LASS_VERSION=0.16.0
ARG X264_VERSION=20191217-2245-stable
ARG FFMPEG_VERSION=7.1

ARG PREFIX=/opt/ffmpeg
ARG MAKEFLAGS="-j4"

RUN apt-get update && apt-get install -y autoconf libtool build-essential

# Make sure Emscripten's tools are used instead of 'llvm-*'.
ENV CC=emcc \
    CXX=em++ \
    AR=emar \
    NM=emnm \
    RANLIB=emranlib

# libx264
RUN cd /tmp && \
  wget https://download.videolan.org/pub/videolan/x264/snapshots/x264-snapshot-${X264_VERSION}.tar.bz2 && \
  tar xvfj x264-snapshot-${X264_VERSION}.tar.bz2

RUN cd /tmp/x264-snapshot-${X264_VERSION} && \
  emconfigure ./configure \
  --prefix=${PREFIX} \
  --host=i686-gnu \
  --enable-static \
  --disable-cli \
  --disable-asm \
  --extra-cflags="-s USE_PTHREADS=1"

RUN cd /tmp/x264-snapshot-${X264_VERSION} && \
  emmake make && emmake make install

# Get ffmpeg source.
RUN cd /tmp/ && \
  wget http://ffmpeg.org/releases/ffmpeg-${FFMPEG_VERSION}.tar.gz && \
  tar zxf ffmpeg-${FFMPEG_VERSION}.tar.gz && rm ffmpeg-${FFMPEG_VERSION}.tar.gz

COPY ./patches/ /tmp/patches/
RUN cd /tmp/ffmpeg-${FFMPEG_VERSION} && \
  for patch in /tmp/patches/*.patch; do patch -p1 < "$patch" || exit 1; done

ARG CFLAGS="-s USE_PTHREADS=1 -O3 -I${PREFIX}/include"
ARG LDFLAGS="$CFLAGS -L${PREFIX}/lib -s INITIAL_MEMORY=1GB"

ARG CACHE_BUST

# Compile ffmpeg with native AAC encoder support
# Note: We need to be careful with --disable-all flag
RUN cd /tmp/ffmpeg-${FFMPEG_VERSION} && \
  emconfigure ./configure \
  --prefix=${PREFIX} \
  --target-os=none \
  --arch=x86_32 \
  --enable-cross-compile \
  --disable-x86asm \
  --disable-inline-asm \
  --disable-stripping \
  --disable-programs \
  --disable-doc \
  --disable-debug \
  --disable-autodetect \
  --disable-network \
  --enable-small \
  --enable-avcodec \
  --enable-avformat \
  --enable-avfilter \
  --enable-avdevice \
  --enable-avutil \
  --enable-swresample \
  --enable-swscale \
  --enable-postproc \
  --enable-demuxer=matroska,mov \
  --enable-muxer=mp4,mov \
  --enable-decoder=h264,hevc,aac,mp3,pcm_s16le,pcm_s16be,pcm_s24le,pcm_s24be,pcm_s32le,pcm_s32be,pcm_f32le,pcm_f32be,eac3,ac3,subrip,webvtt,movtext,text \
  --enable-encoder=aac,pcm_s16le,pcm_s24le,pcm_s32le,pcm_f32le \
  --enable-parser=aac,h264,hevc,ac3 \
  --enable-filter=aresample,aformat,anull,atempo,volume \
  --enable-bsf=aac_adtstoasc,h264_mp4toannexb,hevc_mp4toannexb \
  --enable-protocol=file \
  --extra-cflags="$CFLAGS" \
  --extra-cxxflags="$CFLAGS" \
  --extra-ldflags="$LDFLAGS" \
  --nm="llvm-nm -g" \
  --ar=emar \
  --as=llvm-as \
  --cc="${CC}" \
  --cxx="${CXX}" \
  --ranlib="${RANLIB}" \
  --objcc=emcc \
  --dep-cc=emcc

RUN cd /tmp/ffmpeg-${FFMPEG_VERSION} && \
  emmake make -j4 && \
  emmake make install

# the image is the toolchain only: `npm run make-docker` mounts the repo here and runs make
WORKDIR /build
