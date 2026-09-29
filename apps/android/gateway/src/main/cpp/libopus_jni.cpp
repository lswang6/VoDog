#include <jni.h>
#include <opus.h>

#include <array>
#include <cstdint>
#include <memory>
#include <mutex>
#include <new>
#include <string>
#include <vector>

namespace {
constexpr opus_int32 kSampleRate = 16000;
constexpr int kChannels = 1;
constexpr int kSamplesPerFrame = 320;
constexpr int kBytesPerFrame = kSamplesPerFrame * 2;
// MediaPacketCodec's existing wire contract rejects larger payloads.
constexpr opus_int32 kMaxPacketBytes = 1024;
// S70: deep PLC runs at decoder complexity >= 5 (CMakeLists.txt builds OPUS_DEEP_PLC).
constexpr int kDecoderComplexity = 5;

struct EncoderState {
  explicit EncoderState(OpusEncoder* value) : encoder(value) {}
  ~EncoderState() { opus_encoder_destroy(encoder); }
  OpusEncoder* encoder;
  std::mutex mutex;
};

struct DecoderState {
  explicit DecoderState(OpusDecoder* value) : decoder(value) {}
  ~DecoderState() { opus_decoder_destroy(decoder); }
  OpusDecoder* decoder;
  std::mutex mutex;
};

void Throw(JNIEnv* env, const char* class_name, const std::string& message) {
  jclass type = env->FindClass(class_name);
  if (type != nullptr) env->ThrowNew(type, message.c_str());
}

EncoderState* EncoderStateFromHandle(JNIEnv* env, jlong handle) {
  if (handle == 0) {
    Throw(env, "java/lang/IllegalStateException", "libopus encoder is closed");
    return nullptr;
  }
  return reinterpret_cast<EncoderState*>(handle);
}

DecoderState* DecoderStateFromHandle(JNIEnv* env, jlong handle) {
  if (handle == 0) {
    Throw(env, "java/lang/IllegalStateException", "libopus decoder is closed");
    return nullptr;
  }
  return reinterpret_cast<DecoderState*>(handle);
}

bool ApplyCtl(JNIEnv* env, OpusEncoder* encoder, int request, int value, const char* label) {
  const int status = opus_encoder_ctl(encoder, request, value);
  if (status == OPUS_OK) return true;
  Throw(env, "java/lang/IllegalStateException",
        std::string("libopus ") + label + " failed: " + opus_strerror(status));
  return false;
}
}  // namespace

extern "C" JNIEXPORT jlong JNICALL
Java_org_vodog_gateway_media_LibOpusEncoder_nativeCreate(
    JNIEnv* env, jobject, jint bit_rate, jint expected_loss_percent, jboolean fec_enabled) {
  if (bit_rate < 6000 || bit_rate > 64000 || expected_loss_percent < 10 ||
      expected_loss_percent > 15 || fec_enabled != JNI_TRUE) {
    Throw(env, "java/lang/IllegalArgumentException", "invalid isolated libopus configuration");
    return 0;
  }
  int error = OPUS_OK;
  OpusEncoder* raw = opus_encoder_create(kSampleRate, kChannels, OPUS_APPLICATION_VOIP, &error);
  if (raw == nullptr || error != OPUS_OK) {
    Throw(env, "java/lang/IllegalStateException",
          std::string("libopus create failed: ") + opus_strerror(error));
    return 0;
  }
  std::unique_ptr<EncoderState> state(new (std::nothrow) EncoderState(raw));
  if (!state) {
    opus_encoder_destroy(raw);
    Throw(env, "java/lang/OutOfMemoryError", "cannot allocate libopus encoder state");
    return 0;
  }
  if (!ApplyCtl(env, raw, OPUS_SET_BITRATE_REQUEST, bit_rate, "bitrate CTL") ||
      !ApplyCtl(env, raw, OPUS_SET_INBAND_FEC_REQUEST, 1, "FEC CTL") ||
      !ApplyCtl(env, raw, OPUS_SET_PACKET_LOSS_PERC_REQUEST, expected_loss_percent, "loss CTL") ||
      // S70: speech-tuned SILK, no bits above 8 kHz (both gateways decode at <= 16 kHz), best quality.
      !ApplyCtl(env, raw, OPUS_SET_SIGNAL_REQUEST, OPUS_SIGNAL_VOICE, "signal CTL") ||
      !ApplyCtl(env, raw, OPUS_SET_MAX_BANDWIDTH_REQUEST, OPUS_BANDWIDTH_WIDEBAND, "max bandwidth CTL") ||
      !ApplyCtl(env, raw, OPUS_SET_COMPLEXITY_REQUEST, 10, "complexity CTL")) {
    return 0;
  }
  return reinterpret_cast<jlong>(state.release());
}

extern "C" JNIEXPORT jintArray JNICALL
Java_org_vodog_gateway_media_LibOpusEncoder_nativeReadConfig(
    JNIEnv* env, jobject, jlong handle) {
  EncoderState* state = EncoderStateFromHandle(env, handle);
  if (state == nullptr) return nullptr;
  std::lock_guard<std::mutex> lock(state->mutex);
  std::array<jint, 6> values{};
  const int bitrate_status = opus_encoder_ctl(state->encoder, OPUS_GET_BITRATE(&values[0]));
  const int fec_status = opus_encoder_ctl(state->encoder, OPUS_GET_INBAND_FEC(&values[1]));
  const int loss_status = opus_encoder_ctl(state->encoder, OPUS_GET_PACKET_LOSS_PERC(&values[2]));
  const int signal_status = opus_encoder_ctl(state->encoder, OPUS_GET_SIGNAL(&values[3]));
  const int bandwidth_status = opus_encoder_ctl(state->encoder, OPUS_GET_MAX_BANDWIDTH(&values[4]));
  const int complexity_status = opus_encoder_ctl(state->encoder, OPUS_GET_COMPLEXITY(&values[5]));
  if (bitrate_status != OPUS_OK || fec_status != OPUS_OK || loss_status != OPUS_OK ||
      signal_status != OPUS_OK || bandwidth_status != OPUS_OK || complexity_status != OPUS_OK) {
    Throw(env, "java/lang/IllegalStateException", "libopus CTL readback failed");
    return nullptr;
  }
  jintArray result = env->NewIntArray(values.size());
  if (result != nullptr) env->SetIntArrayRegion(result, 0, values.size(), values.data());
  return result;
}

extern "C" JNIEXPORT jbyteArray JNICALL
Java_org_vodog_gateway_media_LibOpusEncoder_nativeEncode(
    JNIEnv* env, jobject, jlong handle, jbyteArray pcm_array) {
  EncoderState* state = EncoderStateFromHandle(env, handle);
  if (state == nullptr) return nullptr;
  if (pcm_array == nullptr || env->GetArrayLength(pcm_array) != kBytesPerFrame) {
    Throw(env, "java/lang/IllegalArgumentException", "expected exactly 640 PCM16LE bytes");
    return nullptr;
  }
  std::array<jbyte, kBytesPerFrame> bytes{};
  env->GetByteArrayRegion(pcm_array, 0, bytes.size(), bytes.data());
  if (env->ExceptionCheck()) return nullptr;
  std::array<opus_int16, kSamplesPerFrame> samples{};
  for (int index = 0; index < kSamplesPerFrame; ++index) {
    const auto low = static_cast<uint8_t>(bytes[index * 2]);
    const auto high = static_cast<uint8_t>(bytes[index * 2 + 1]);
    samples[index] = static_cast<opus_int16>(low | (static_cast<uint16_t>(high) << 8));
  }
  std::array<unsigned char, kMaxPacketBytes> packet{};
  int encoded_bytes;
  {
    std::lock_guard<std::mutex> lock(state->mutex);
    encoded_bytes = opus_encode(state->encoder, samples.data(), kSamplesPerFrame,
                                packet.data(), packet.size());
  }
  if (encoded_bytes <= 0) {
    Throw(env, "java/lang/IllegalStateException",
          encoded_bytes < 0 ? std::string("libopus encode failed: ") + opus_strerror(encoded_bytes)
                            : "libopus produced an empty packet");
    return nullptr;
  }
  jbyteArray result = env->NewByteArray(encoded_bytes);
  if (result != nullptr) {
    env->SetByteArrayRegion(result, 0, encoded_bytes,
                            reinterpret_cast<const jbyte*>(packet.data()));
  }
  return result;
}

extern "C" JNIEXPORT void JNICALL
Java_org_vodog_gateway_media_LibOpusEncoder_nativeDestroy(
    JNIEnv*, jobject, jlong handle) {
  delete reinterpret_cast<EncoderState*>(handle);
}

extern "C" JNIEXPORT jstring JNICALL
Java_org_vodog_gateway_media_LibOpusEncoder_nativeVersion(
    JNIEnv* env, jobject) {
  return env->NewStringUTF(opus_get_version_string());
}

extern "C" JNIEXPORT jlong JNICALL
Java_org_vodog_gateway_media_LibOpusDecoder_nativeCreate(
    JNIEnv* env, jobject) {
  int error = OPUS_OK;
  OpusDecoder* raw = opus_decoder_create(kSampleRate, kChannels, &error);
  if (raw == nullptr || error != OPUS_OK) {
    Throw(env, "java/lang/IllegalStateException",
          std::string("libopus decoder create failed: ") + opus_strerror(error));
    return 0;
  }
  std::unique_ptr<DecoderState> state(new (std::nothrow) DecoderState(raw));
  if (!state) {
    opus_decoder_destroy(raw);
    Throw(env, "java/lang/OutOfMemoryError", "cannot allocate libopus decoder state");
    return 0;
  }
  const int status = opus_decoder_ctl(raw, OPUS_SET_COMPLEXITY(kDecoderComplexity));
  if (status != OPUS_OK) {
    Throw(env, "java/lang/IllegalStateException",
          std::string("libopus decoder complexity failed: ") + opus_strerror(status));
    return 0;
  }
  return reinterpret_cast<jlong>(state.release());
}

extern "C" JNIEXPORT jbyteArray JNICALL
Java_org_vodog_gateway_media_LibOpusDecoder_nativeDecode(
    JNIEnv* env, jobject, jlong handle, jbyteArray packet_array, jint frame_size,
    jboolean decode_fec) {
  DecoderState* state = DecoderStateFromHandle(env, handle);
  if (state == nullptr) return nullptr;
  const bool packet_missing = packet_array == nullptr;
  if (frame_size < 40 || frame_size > 1920) {
    Throw(env, "java/lang/IllegalArgumentException", "decoder frame capacity must be 40..1920 samples");
    return nullptr;
  }
  const bool bounded_missing_duration = frame_size == 160 || frame_size == kSamplesPerFrame;
  if (packet_missing && (decode_fec == JNI_TRUE || !bounded_missing_duration)) {
    Throw(env, "java/lang/IllegalArgumentException", "PLC requires a null packet and 160 or 320 samples");
    return nullptr;
  }
  if (decode_fec == JNI_TRUE && !bounded_missing_duration) {
    Throw(env, "java/lang/IllegalArgumentException", "FEC attempts require a 160 or 320-sample frame");
    return nullptr;
  }

  std::array<unsigned char, kMaxPacketBytes> packet{};
  jsize packet_size = 0;
  if (!packet_missing) {
    packet_size = env->GetArrayLength(packet_array);
    if (packet_size < 1 || packet_size > kMaxPacketBytes) {
      Throw(env, "java/lang/IllegalArgumentException", "invalid Opus payload size");
      return nullptr;
    }
    env->GetByteArrayRegion(packet_array, 0, packet_size,
                            reinterpret_cast<jbyte*>(packet.data()));
    if (env->ExceptionCheck()) return nullptr;
  }

  std::array<opus_int16, 1920> samples{};
  int decoded_samples;
  {
    std::lock_guard<std::mutex> lock(state->mutex);
    decoded_samples = opus_decode(state->decoder,
                                  packet_missing ? nullptr : packet.data(),
                                  packet_missing ? 0 : static_cast<opus_int32>(packet_size),
                                  samples.data(), frame_size, decode_fec == JNI_TRUE ? 1 : 0);
  }
  if (decoded_samples <= 0) {
    Throw(env, "java/lang/IllegalStateException",
          decoded_samples < 0
              ? std::string("libopus decode failed: ") + opus_strerror(decoded_samples)
              : "libopus produced empty PCM");
    return nullptr;
  }
  std::array<jbyte, 1920 * 2> pcm{};
  for (int index = 0; index < decoded_samples; ++index) {
    const auto bits = static_cast<uint16_t>(samples[index]);
    pcm[index * 2] = static_cast<jbyte>(bits & 0xff);
    pcm[index * 2 + 1] = static_cast<jbyte>((bits >> 8) & 0xff);
  }
  const jsize pcm_size = decoded_samples * 2;
  jbyteArray result = env->NewByteArray(pcm_size);
  if (result != nullptr) env->SetByteArrayRegion(result, 0, pcm_size, pcm.data());
  return result;
}

extern "C" JNIEXPORT jboolean JNICALL
Java_org_vodog_gateway_media_LibOpusDecoder_nativePacketHasLbrr(
    JNIEnv* env, jobject, jbyteArray packet_array) {
  if (packet_array == nullptr) {
    Throw(env, "java/lang/IllegalArgumentException", "Opus payload is required");
    return JNI_FALSE;
  }
  const jsize packet_size = env->GetArrayLength(packet_array);
  if (packet_size < 1 || packet_size > kMaxPacketBytes) {
    Throw(env, "java/lang/IllegalArgumentException", "invalid Opus payload size");
    return JNI_FALSE;
  }
  std::array<unsigned char, kMaxPacketBytes> packet{};
  env->GetByteArrayRegion(packet_array, 0, packet_size,
                          reinterpret_cast<jbyte*>(packet.data()));
  if (env->ExceptionCheck()) return JNI_FALSE;
  const int result = opus_packet_has_lbrr(packet.data(), packet_size);
  if (result < 0) {
    Throw(env, "java/lang/IllegalArgumentException",
          std::string("invalid Opus packet: ") + opus_strerror(result));
    return JNI_FALSE;
  }
  return result == 1 ? JNI_TRUE : JNI_FALSE;
}

// S70: OPUS_BANDWIDTH_* of the first frame (1101 NB .. 1105 FB), or a negative libopus error.
extern "C" JNIEXPORT jint JNICALL
Java_org_vodog_gateway_media_LibOpusDecoder_nativePacketBandwidth(
    JNIEnv* env, jobject, jbyteArray packet_array) {
  if (packet_array == nullptr || env->GetArrayLength(packet_array) < 1) return OPUS_INVALID_PACKET;
  jbyte toc = 0;
  env->GetByteArrayRegion(packet_array, 0, 1, &toc);
  if (env->ExceptionCheck()) return OPUS_INVALID_PACKET;
  const unsigned char byte = static_cast<unsigned char>(toc);
  return opus_packet_get_bandwidth(&byte);
}

extern "C" JNIEXPORT jint JNICALL
Java_org_vodog_gateway_media_LibOpusDecoder_nativeComplexity(
    JNIEnv* env, jobject, jlong handle) {
  DecoderState* state = DecoderStateFromHandle(env, handle);
  if (state == nullptr) return -1;
  opus_int32 value = -1;
  std::lock_guard<std::mutex> lock(state->mutex);
  return opus_decoder_ctl(state->decoder, OPUS_GET_COMPLEXITY(&value)) == OPUS_OK ? value : -1;
}

extern "C" JNIEXPORT void JNICALL
Java_org_vodog_gateway_media_LibOpusDecoder_nativeReset(
    JNIEnv* env, jobject, jlong handle) {
  DecoderState* state = DecoderStateFromHandle(env, handle);
  if (state == nullptr) return;
  int status;
  {
    std::lock_guard<std::mutex> lock(state->mutex);
    status = opus_decoder_ctl(state->decoder, OPUS_RESET_STATE);
  }
  if (status != OPUS_OK) {
    Throw(env, "java/lang/IllegalStateException",
          std::string("libopus decoder reset failed: ") + opus_strerror(status));
  }
}

extern "C" JNIEXPORT jbyteArray JNICALL
Java_org_vodog_gateway_media_LibOpusDecoder_nativeRepacketizeForTest(
    JNIEnv* env, jobject, jobjectArray packet_arrays) {
  if (packet_arrays == nullptr) {
    Throw(env, "java/lang/IllegalArgumentException", "packets are required");
    return nullptr;
  }
  const jsize count = env->GetArrayLength(packet_arrays);
  if (count < 2 || count > 6) {
    Throw(env, "java/lang/IllegalArgumentException", "test repacketizer requires 2..6 packets");
    return nullptr;
  }
  std::unique_ptr<OpusRepacketizer, decltype(&opus_repacketizer_destroy)> repacketizer(
      opus_repacketizer_create(), opus_repacketizer_destroy);
  if (!repacketizer) {
    Throw(env, "java/lang/OutOfMemoryError", "cannot allocate test Opus repacketizer");
    return nullptr;
  }
  // libopus retains submitted frame pointers until out()/init()/destroy().
  std::array<std::array<unsigned char, kMaxPacketBytes>, 6> retained_packets{};
  for (jsize index = 0; index < count; ++index) {
    auto* packet_array = static_cast<jbyteArray>(env->GetObjectArrayElement(packet_arrays, index));
    if (packet_array == nullptr) {
      Throw(env, "java/lang/IllegalArgumentException", "test packet is null");
      return nullptr;
    }
    const jsize packet_size = env->GetArrayLength(packet_array);
    if (packet_size < 1 || packet_size > kMaxPacketBytes) {
      env->DeleteLocalRef(packet_array);
      Throw(env, "java/lang/IllegalArgumentException", "invalid test Opus payload size");
      return nullptr;
    }
    env->GetByteArrayRegion(packet_array, 0, packet_size,
                            reinterpret_cast<jbyte*>(retained_packets[index].data()));
    env->DeleteLocalRef(packet_array);
    if (env->ExceptionCheck()) return nullptr;
    const int status = opus_repacketizer_cat(
        repacketizer.get(), retained_packets[index].data(), packet_size);
    if (status != OPUS_OK) {
      Throw(env, "java/lang/IllegalArgumentException",
            std::string("cannot repacketize test packets: ") + opus_strerror(status));
      return nullptr;
    }
  }
  std::array<unsigned char, kMaxPacketBytes> output{};
  const int output_size = opus_repacketizer_out(repacketizer.get(), output.data(), output.size());
  if (output_size <= 0) {
    Throw(env, "java/lang/IllegalStateException",
          output_size < 0 ? std::string("test repacketize failed: ") + opus_strerror(output_size)
                          : "test repacketizer produced an empty packet");
    return nullptr;
  }
  jbyteArray result = env->NewByteArray(output_size);
  if (result != nullptr) {
    env->SetByteArrayRegion(result, 0, output_size,
                            reinterpret_cast<const jbyte*>(output.data()));
  }
  return result;
}

extern "C" JNIEXPORT void JNICALL
Java_org_vodog_gateway_media_LibOpusDecoder_nativeDestroy(
    JNIEnv*, jobject, jlong handle) {
  delete reinterpret_cast<DecoderState*>(handle);
}

extern "C" JNIEXPORT jstring JNICALL
Java_org_vodog_gateway_media_LibOpusDecoder_nativeVersion(
    JNIEnv* env, jobject) {
  return env->NewStringUTF(opus_get_version_string());
}
