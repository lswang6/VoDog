#include <opus.h>

#include <algorithm>
#include <array>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <ctime>
#include <cstdio>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <iomanip>
#include <iostream>
#include <memory>
#include <set>
#include <sstream>
#include <stdexcept>
#include <string>
#include <vector>

namespace fs = std::filesystem;
using Clock = std::chrono::steady_clock;

namespace {
constexpr int kSampleRate = 16000;
constexpr int kChannels = 1;
constexpr int kFrameMs = 20;
constexpr int kSamplesPerFrame = 320;
constexpr int kBytesPerFrame = 640;
constexpr int kMaxPacketBytes = 1275;

struct Options {
  fs::path input;
  fs::path fixture_dir = "opus-loss-fixture";
  int bitrate = 20000;
  int loss_percent = 12;
  uint32_t seed = 0x4f505553U;
  int generated_frames = 180;
  // S70: "manifest" (default fixture), "bandwidth" (WB share of voiced packets), "plc" (random-loss PLC error).
  std::string mode = "manifest";
  int random_loss_percent = 10;
  int decoder_complexity = 0;
};

// S70: the production encoder CTLs (libopus_jni.cpp); every harness mode must encode like the gateway.
constexpr int kVoicedRms = 300;

struct Timings {
  double wall_ms = 0;
  double cpu_ms = 0;
  std::vector<double> operation_us;
};

struct ScenarioResult {
  std::string name;
  std::string loss_profile;
  std::set<int> missing;
  std::vector<int16_t> pcm;
  int normal_packets = 0;
  int fec_decode_attempts = 0;
  int plc_frames = 0;
  int decode_errors = 0;
  Timings decode_time;
};

struct MissingMetric {
  int frame = 0;
  bool has_lbrr = false;
  bool fec_attempted = false;
  double fec_reference_mae = 0;
  double plc_reference_mae = 0;
  double fec_plc_mae = 0;
  double fec_next_mae = 0;
  bool fec_aligned_to_missing = false;
  bool fec_aligned_to_next = false;
};

using EncoderPtr = std::unique_ptr<OpusEncoder, decltype(&opus_encoder_destroy)>;
using DecoderPtr = std::unique_ptr<OpusDecoder, decltype(&opus_decoder_destroy)>;

[[noreturn]] void Fail(const std::string& message) { throw std::runtime_error(message); }

Options ParseOptions(int argc, char** argv) {
  Options options;
  for (int index = 1; index < argc; ++index) {
    const std::string arg = argv[index];
    if (index + 1 >= argc) Fail("missing value for " + arg);
    const std::string value = argv[++index];
    if (arg == "--input") options.input = value;
    else if (arg == "--fixture-dir") options.fixture_dir = value;
    else if (arg == "--bitrate") options.bitrate = std::stoi(value);
    else if (arg == "--loss-percent") options.loss_percent = std::stoi(value);
    else if (arg == "--seed") options.seed = static_cast<uint32_t>(std::stoul(value));
    else if (arg == "--frames") options.generated_frames = std::stoi(value);
    else if (arg == "--mode") options.mode = value;
    else if (arg == "--random-loss") options.random_loss_percent = std::stoi(value);
    else if (arg == "--decoder-complexity") options.decoder_complexity = std::stoi(value);
    else Fail("unknown argument: " + arg);
  }
  if (options.bitrate < 6000 || options.bitrate > 64000) Fail("bitrate must be 6000..64000");
  if (options.loss_percent < 10 || options.loss_percent > 15) Fail("loss-percent must be 10..15");
  if (options.generated_frames < 12) Fail("frames must be at least 12");
  if (options.mode != "manifest" && options.mode != "bandwidth" && options.mode != "plc") Fail("unknown mode");
  if (options.random_loss_percent < 1 || options.random_loss_percent > 50) Fail("random-loss must be 1..50");
  if (options.decoder_complexity < 0 || options.decoder_complexity > 10) Fail("decoder-complexity must be 0..10");
  return options;
}

std::vector<int16_t> ReadPcm(const Options& options) {
  if (!options.input.empty()) {
    std::ifstream stream(options.input, std::ios::binary);
    if (!stream) Fail("cannot open input PCM: " + options.input.string());
    std::vector<uint8_t> bytes((std::istreambuf_iterator<char>(stream)), {});
    const size_t complete_bytes = bytes.size() / kBytesPerFrame * kBytesPerFrame;
    if (complete_bytes < static_cast<size_t>(12 * kBytesPerFrame)) Fail("input has fewer than 12 complete frames");
    std::vector<int16_t> samples(complete_bytes / 2);
    for (size_t index = 0; index < samples.size(); ++index) {
      samples[index] = static_cast<int16_t>(bytes[index * 2] |
          (static_cast<uint16_t>(bytes[index * 2 + 1]) << 8));
    }
    return samples;
  }

  std::vector<int16_t> samples(options.generated_frames * kSamplesPerFrame);
  uint32_t noise = options.seed;
  for (size_t index = 0; index < samples.size(); ++index) {
    noise = noise * 1664525U + 1013904223U;
    const double time = static_cast<double>(index) / kSampleRate;
    const double syllable = 0.25 + 0.75 * std::pow(std::sin(3.141592653589793 * 2.7 * time), 2);
    const double voiced = std::sin(2 * 3.141592653589793 * 137 * time) * 0.58 +
        std::sin(2 * 3.141592653589793 * 274 * time) * 0.24 +
        std::sin(2 * 3.141592653589793 * 733 * time) * 0.10;
    const double hiss = (static_cast<int32_t>(noise >> 16) - 32768) / 32768.0 * 0.03;
    samples[index] = static_cast<int16_t>(std::clamp((voiced * syllable + hiss) * 18000.0,
                                                     -32768.0, 32767.0));
  }
  return samples;
}

void WritePcm(const fs::path& path, const std::vector<int16_t>& samples) {
  std::ofstream stream(path, std::ios::binary);
  if (!stream) Fail("cannot write " + path.string());
  for (const int16_t sample : samples) {
    const auto bits = static_cast<uint16_t>(sample);
    stream.put(static_cast<char>(bits & 0xff));
    stream.put(static_cast<char>((bits >> 8) & 0xff));
  }
}

void WritePackets(const fs::path& path, const std::vector<std::vector<uint8_t>>& packets) {
  std::ofstream stream(path, std::ios::binary);
  if (!stream) Fail("cannot write " + path.string());
  for (const auto& packet : packets) {
    const uint32_t size = static_cast<uint32_t>(packet.size());
    const std::array<char, 4> prefix = {
        static_cast<char>((size >> 24) & 0xff), static_cast<char>((size >> 16) & 0xff),
        static_cast<char>((size >> 8) & 0xff), static_cast<char>(size & 0xff)};
    stream.write(prefix.data(), prefix.size());
    stream.write(reinterpret_cast<const char*>(packet.data()), packet.size());
  }
}

uint32_t RotateRight(uint32_t value, int bits) {
  return (value >> bits) | (value << (32 - bits));
}

std::string Sha256File(const fs::path& path) {
  static constexpr std::array<uint32_t, 64> round_constants = {
      0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
      0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
      0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
      0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
      0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
      0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
      0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
      0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
      0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
      0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
      0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2};
  std::ifstream stream(path, std::ios::binary);
  if (!stream) Fail("cannot hash " + path.string());
  std::vector<uint8_t> bytes((std::istreambuf_iterator<char>(stream)), {});
  const uint64_t original_bits = static_cast<uint64_t>(bytes.size()) * 8;
  bytes.push_back(0x80);
  while (bytes.size() % 64 != 56) bytes.push_back(0);
  for (int shift = 56; shift >= 0; shift -= 8) bytes.push_back((original_bits >> shift) & 0xff);
  std::array<uint32_t, 8> hash = {0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
                                  0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19};
  for (size_t block = 0; block < bytes.size(); block += 64) {
    std::array<uint32_t, 64> words{};
    for (int index = 0; index < 16; ++index) {
      const size_t offset = block + index * 4;
      words[index] = (static_cast<uint32_t>(bytes[offset]) << 24) |
          (static_cast<uint32_t>(bytes[offset + 1]) << 16) |
          (static_cast<uint32_t>(bytes[offset + 2]) << 8) | bytes[offset + 3];
    }
    for (int index = 16; index < 64; ++index) {
      const uint32_t s0 = RotateRight(words[index - 15], 7) ^ RotateRight(words[index - 15], 18) ^
                          (words[index - 15] >> 3);
      const uint32_t s1 = RotateRight(words[index - 2], 17) ^ RotateRight(words[index - 2], 19) ^
                          (words[index - 2] >> 10);
      words[index] = words[index - 16] + s0 + words[index - 7] + s1;
    }
    uint32_t a = hash[0], b = hash[1], c = hash[2], d = hash[3];
    uint32_t e = hash[4], f = hash[5], g = hash[6], h = hash[7];
    for (int index = 0; index < 64; ++index) {
      const uint32_t sum1 = RotateRight(e, 6) ^ RotateRight(e, 11) ^ RotateRight(e, 25);
      const uint32_t choice = (e & f) ^ (~e & g);
      const uint32_t temporary1 = h + sum1 + choice + round_constants[index] + words[index];
      const uint32_t sum0 = RotateRight(a, 2) ^ RotateRight(a, 13) ^ RotateRight(a, 22);
      const uint32_t majority = (a & b) ^ (a & c) ^ (b & c);
      const uint32_t temporary2 = sum0 + majority;
      h = g; g = f; f = e; e = d + temporary1;
      d = c; c = b; b = a; a = temporary1 + temporary2;
    }
    hash[0] += a; hash[1] += b; hash[2] += c; hash[3] += d;
    hash[4] += e; hash[5] += f; hash[6] += g; hash[7] += h;
  }
  std::ostringstream out;
  out << std::hex << std::setfill('0');
  for (uint32_t word : hash) out << std::setw(8) << word;
  return out.str();
}

double Mae(const int16_t* left, const int16_t* right, int count = kSamplesPerFrame) {
  double total = 0;
  for (int index = 0; index < count; ++index) {
    total += std::abs(static_cast<double>(left[index]) - right[index]);
  }
  return total / count;
}

std::vector<int> HighEnergyFrames(const std::vector<int16_t>& source, int count, int min_spacing) {
  const int frames = static_cast<int>(source.size() / kSamplesPerFrame);
  std::vector<std::pair<double, int>> candidates;
  for (int frame = 4; frame < frames - 4; ++frame) {
    double energy = 0;
    for (int offset = 0; offset < kSamplesPerFrame; ++offset) {
      const double sample = source[frame * kSamplesPerFrame + offset];
      energy += sample * sample;
    }
    candidates.emplace_back(energy, frame);
  }
  std::sort(candidates.begin(), candidates.end(), std::greater<>());
  std::vector<int> selected;
  for (const auto& candidate : candidates) {
    const bool spaced = std::all_of(selected.begin(), selected.end(), [&](int frame) {
      return std::abs(frame - candidate.second) >= min_spacing;
    });
    if (spaced) selected.push_back(candidate.second);
    if (static_cast<int>(selected.size()) == count) break;
  }
  if (static_cast<int>(selected.size()) != count) Fail("input is too short for controlled loss matrix");
  std::sort(selected.begin(), selected.end());
  return selected;
}

std::vector<std::vector<uint8_t>> Encode(const std::vector<int16_t>& source,
                                         const Options& options, Timings* timing,
                                         int* lookahead, bool fec_enabled) {
  int error = OPUS_OK;
  EncoderPtr encoder(opus_encoder_create(kSampleRate, kChannels, OPUS_APPLICATION_VOIP, &error),
                     opus_encoder_destroy);
  if (!encoder || error != OPUS_OK) Fail("opus_encoder_create failed");
  const int configured_loss = fec_enabled ? options.loss_percent : 0;
  if (opus_encoder_ctl(encoder.get(), OPUS_SET_BITRATE(options.bitrate)) != OPUS_OK ||
      opus_encoder_ctl(encoder.get(), OPUS_SET_INBAND_FEC(fec_enabled ? 1 : 0)) != OPUS_OK ||
      opus_encoder_ctl(encoder.get(), OPUS_SET_PACKET_LOSS_PERC(configured_loss)) != OPUS_OK ||
      opus_encoder_ctl(encoder.get(), OPUS_SET_SIGNAL(OPUS_SIGNAL_VOICE)) != OPUS_OK ||
      opus_encoder_ctl(encoder.get(), OPUS_SET_MAX_BANDWIDTH(OPUS_BANDWIDTH_WIDEBAND)) != OPUS_OK ||
      opus_encoder_ctl(encoder.get(), OPUS_SET_COMPLEXITY(10)) != OPUS_OK) {
    Fail("encoder CTL setup failed");
  }
  int actual_bitrate = 0;
  int actual_fec = 0;
  int actual_loss = 0;
  if (opus_encoder_ctl(encoder.get(), OPUS_GET_BITRATE(&actual_bitrate)) != OPUS_OK ||
      opus_encoder_ctl(encoder.get(), OPUS_GET_INBAND_FEC(&actual_fec)) != OPUS_OK ||
      opus_encoder_ctl(encoder.get(), OPUS_GET_PACKET_LOSS_PERC(&actual_loss)) != OPUS_OK ||
      opus_encoder_ctl(encoder.get(), OPUS_GET_LOOKAHEAD(lookahead)) != OPUS_OK) {
    Fail("encoder CTL readback failed");
  }
  if (actual_bitrate != options.bitrate || actual_fec != (fec_enabled ? 1 : 0) ||
      actual_loss != configured_loss) {
    Fail("encoder CTL readback mismatch");
  }

  const auto wall_start = Clock::now();
  const std::clock_t cpu_start = std::clock();
  std::vector<std::vector<uint8_t>> packets;
  const int frames = static_cast<int>(source.size() / kSamplesPerFrame);
  packets.reserve(frames);
  for (int frame = 0; frame < frames; ++frame) {
    std::array<unsigned char, kMaxPacketBytes> buffer{};
    const auto operation_start = Clock::now();
    const int bytes = opus_encode(encoder.get(), source.data() + frame * kSamplesPerFrame,
                                  kSamplesPerFrame, buffer.data(), buffer.size());
    timing->operation_us.push_back(
        std::chrono::duration<double, std::micro>(Clock::now() - operation_start).count());
    if (bytes < 0) Fail(std::string("encode failed: ") + opus_strerror(bytes));
    packets.emplace_back(buffer.begin(), buffer.begin() + bytes);
  }
  timing->cpu_ms = (std::clock() - cpu_start) * 1000.0 / CLOCKS_PER_SEC;
  timing->wall_ms = std::chrono::duration<double, std::milli>(Clock::now() - wall_start).count();
  return packets;
}

ScenarioResult Decode(const std::string& name, const std::string& profile,
                      const std::vector<std::vector<uint8_t>>& packets,
                      const std::set<int>& missing, bool use_fec, int complexity = 0) {
  int error = OPUS_OK;
  DecoderPtr decoder(opus_decoder_create(kSampleRate, kChannels, &error), opus_decoder_destroy);
  if (!decoder || error != OPUS_OK) Fail("opus_decoder_create failed");
  // S70: complexity >= 5 selects deep PLC when libopus is built with OPUS_DEEP_PLC; 0 is classic PLC.
  if (opus_decoder_ctl(decoder.get(), OPUS_SET_COMPLEXITY(complexity)) != OPUS_OK) Fail("decoder complexity CTL failed");
  ScenarioResult result;
  result.name = name;
  result.loss_profile = profile;
  result.missing = missing;
  result.pcm.reserve(packets.size() * kSamplesPerFrame);
  const auto wall_start = Clock::now();
  const std::clock_t cpu_start = std::clock();
  for (int frame = 0; frame < static_cast<int>(packets.size()); ++frame) {
    std::array<int16_t, kSamplesPerFrame> output{};
    int decoded = OPUS_INVALID_PACKET;
    const auto operation_start = Clock::now();
    if (missing.count(frame) == 0) {
      const auto& packet = packets[frame];
      decoded = opus_decode(decoder.get(), packet.data(), packet.size(), output.data(),
                            kSamplesPerFrame, 0);
      ++result.normal_packets;
    } else if (use_fec && frame + 1 < static_cast<int>(packets.size()) &&
               missing.count(frame + 1) == 0) {
      const auto& next = packets[frame + 1];
      decoded = opus_decode(decoder.get(), next.data(), next.size(), output.data(),
                            kSamplesPerFrame, 1);
      ++result.fec_decode_attempts;
    } else {
      decoded = opus_decode(decoder.get(), nullptr, 0, output.data(), kSamplesPerFrame, 0);
      ++result.plc_frames;
    }
    if (decoded != kSamplesPerFrame) {
      ++result.decode_errors;
      output.fill(0);
    }
    result.decode_time.operation_us.push_back(
        std::chrono::duration<double, std::micro>(Clock::now() - operation_start).count());
    result.pcm.insert(result.pcm.end(), output.begin(), output.end());
  }
  result.decode_time.cpu_ms = (std::clock() - cpu_start) * 1000.0 / CLOCKS_PER_SEC;
  result.decode_time.wall_ms =
      std::chrono::duration<double, std::milli>(Clock::now() - wall_start).count();
  return result;
}

std::vector<MissingMetric> Metrics(const ScenarioResult& fec, const ScenarioResult& plc,
                                   const std::vector<int16_t>& clean_reference,
                                   const std::vector<std::vector<uint8_t>>& packets) {
  std::vector<MissingMetric> metrics;
  for (int frame : fec.missing) {
    const int16_t* reference = clean_reference.data() + frame * kSamplesPerFrame;
    const int16_t* fec_pcm = fec.pcm.data() + frame * kSamplesPerFrame;
    const int16_t* plc_pcm = plc.pcm.data() + frame * kSamplesPerFrame;
    const bool next_available = frame + 1 < static_cast<int>(packets.size()) &&
                                fec.missing.count(frame + 1) == 0;
    const double fec_reference = Mae(fec_pcm, reference);
    const double fec_next = next_available
        ? Mae(fec_pcm, clean_reference.data() + (frame + 1) * kSamplesPerFrame)
        : -1;
    metrics.push_back(MissingMetric{
        frame,
        next_available && opus_packet_has_lbrr(packets[frame + 1].data(), packets[frame + 1].size()) == 1,
        next_available,
        fec_reference,
        Mae(plc_pcm, reference),
        Mae(fec_pcm, plc_pcm),
        fec_next,
        next_available && fec_reference < fec_next,
        next_available && fec_next <= fec_reference,
    });
  }
  return metrics;
}

std::string JsonIndices(const std::set<int>& values) {
  std::ostringstream out;
  out << '[';
  bool first = true;
  for (int value : values) {
    if (!first) out << ',';
    first = false;
    out << value;
  }
  out << ']';
  return out.str();
}

std::string JsonBursts(const std::vector<std::pair<int, int>>& bursts) {
  std::ostringstream out;
  out << '[';
  for (size_t index = 0; index < bursts.size(); ++index) {
    if (index) out << ',';
    out << "{\"startFrame\":" << bursts[index].first
        << ",\"frameCount\":" << bursts[index].second << '}';
  }
  out << ']';
  return out.str();
}

void WriteCountersJson(std::ostream& out, const ScenarioResult& value) {
  out << "{\"decodeErrors\":" << value.decode_errors
      << ",\"droppedFrames\":" << value.missing.size()
      << ",\"fecDecodeAttempts\":" << value.fec_decode_attempts
      << ",\"fecRecovered\":0"
      << ",\"plcFrames\":" << value.plc_frames << '}';
}

void WriteTimingJson(std::ostream& out, const Timings& timing) {
  std::vector<double> values = timing.operation_us;
  std::sort(values.begin(), values.end());
  const auto percentile = [&](double fraction) {
    if (values.empty()) return 0.0;
    const size_t index = static_cast<size_t>(std::ceil(fraction * values.size())) - 1;
    return values[std::min(index, values.size() - 1)];
  };
  out << "{\"p95Us\":" << percentile(0.95) << ",\"p99Us\":" << percentile(0.99)
      << ",\"maxUs\":" << (values.empty() ? 0.0 : values.back())
      << ",\"cpuUs\":" << timing.cpu_ms * 1000.0
      << ",\"wallUs\":" << timing.wall_ms * 1000.0 << '}';
}

void WriteArtifactJson(std::ostream& out, const fs::path& directory, const char* path) {
  out << "{\"path\":\"" << path << "\",\"sha256\":\""
      << Sha256File(directory / path) << "\"}";
}

void WriteMetricsJson(std::ostream& out, const std::vector<MissingMetric>& metrics) {
  out << '[';
  for (size_t index = 0; index < metrics.size(); ++index) {
    if (index) out << ',';
    const auto& metric = metrics[index];
    out << "{\"frameIndex\":" << metric.frame
        << ",\"sampleOffset\":" << metric.frame * kSamplesPerFrame
        << ",\"hasLbrr\":" << (metric.has_lbrr ? "true" : "false")
        << ",\"fecDecodeAttempted\":" << (metric.fec_attempted ? "true" : "false")
        << ",\"fecVsReferenceError\":" << metric.fec_reference_mae
        << ",\"plcVsReferenceError\":" << metric.plc_reference_mae
        << ",\"fecVsPlcError\":" << metric.fec_plc_mae
        << ",\"fecVsNextReferenceError\":" << metric.fec_next_mae
        << ",\"fecAlignedToMissing\":" << (metric.fec_aligned_to_missing ? "true" : "false")
        << ",\"fecAlignedToNext\":" << (metric.fec_aligned_to_next ? "true" : "false") << '}';
  }
  out << ']';
}

double Rms(const int16_t* frame) {
  double total = 0;
  for (int index = 0; index < kSamplesPerFrame; ++index) total += static_cast<double>(frame[index]) * frame[index];
  return std::sqrt(total / kSamplesPerFrame);
}

// Log-spectral distance (dB) between two 20 ms frames, Hann window, naive DFT; a phase-blind error.
double LogSpectralDistance(const int16_t* left, const int16_t* right) {
  double total = 0;
  const int bins = kSamplesPerFrame / 2;
  for (int bin = 1; bin < bins; ++bin) {
    double lr = 0, li = 0, rr = 0, ri = 0;
    for (int n = 0; n < kSamplesPerFrame; ++n) {
      const double window = 0.5 - 0.5 * std::cos(2 * 3.141592653589793 * n / (kSamplesPerFrame - 1));
      const double angle = -2 * 3.141592653589793 * bin * n / kSamplesPerFrame;
      lr += window * left[n] * std::cos(angle); li += window * left[n] * std::sin(angle);
      rr += window * right[n] * std::cos(angle); ri += window * right[n] * std::sin(angle);
    }
    const double a = 10 * std::log10(lr * lr + li * li + 1.0);
    const double b = 10 * std::log10(rr * rr + ri * ri + 1.0);
    total += (a - b) * (a - b);
  }
  return std::sqrt(total / (bins - 1));
}

// S70 bitrate choice: share of voiced source frames whose packet still decodes as wideband.
void RunBandwidth(const Options& options, const std::vector<int16_t>& source) {
  Timings timing;
  int lookahead = 0;
  const auto packets = Encode(source, options, &timing, &lookahead, true);
  int voiced = 0, voiced_wb = 0, lbrr = 0;
  std::array<int, 5> bands{};
  size_t bytes = 0;
  for (size_t frame = 0; frame < packets.size(); ++frame) {
    const int bandwidth = opus_packet_get_bandwidth(packets[frame].data());
    if (bandwidth >= OPUS_BANDWIDTH_NARROWBAND && bandwidth <= OPUS_BANDWIDTH_FULLBAND) ++bands[bandwidth - OPUS_BANDWIDTH_NARROWBAND];
    if (opus_packet_has_lbrr(packets[frame].data(), packets[frame].size()) == 1) ++lbrr;
    bytes += packets[frame].size();
    if (Rms(source.data() + frame * kSamplesPerFrame) < kVoicedRms) continue;
    ++voiced;
    if (bandwidth == OPUS_BANDWIDTH_WIDEBAND) ++voiced_wb;
  }
  std::cout << std::fixed << std::setprecision(2) << "bitrate=" << options.bitrate
            << " loss=" << options.loss_percent << " packets=" << packets.size() << " voiced=" << voiced
            << " voicedWb=" << voiced_wb << " voicedWbPct=" << (voiced ? 100.0 * voiced_wb / voiced : 0.0)
            << " lbrrPct=" << 100.0 * lbrr / packets.size()
            << " nb/mb/wb/swb/fb=" << bands[0] << '/' << bands[1] << '/' << bands[2] << '/' << bands[3] << '/' << bands[4]
            << " meanBytes=" << static_cast<double>(bytes) / packets.size() << '\n';
}

// S70 deep-PLC decision: seeded random loss, PLC only (no FEC), error of concealed frames vs the clean decode.
void RunPlc(const Options& options, const std::vector<int16_t>& source) {
  Timings timing;
  int lookahead = 0;
  const auto packets = Encode(source, options, &timing, &lookahead, true);
  const auto clean = Decode("clean", "none", packets, {}, false, options.decoder_complexity);
  std::set<int> missing;
  uint32_t state = options.seed;
  for (int frame = 1; frame < static_cast<int>(packets.size()); ++frame) {
    state = state * 1664525U + 1013904223U;
    if ((state >> 8) % 1000 < static_cast<uint32_t>(options.random_loss_percent * 10)) missing.insert(frame);
  }
  const auto lossy = Decode("plc", "random", packets, missing, false, options.decoder_complexity);
  double error = 0, energy = 0, lsd = 0, snr_sum = 0;
  int counted = 0;
  for (int frame : missing) {
    const int16_t* ref = clean.pcm.data() + frame * kSamplesPerFrame;
    if (Rms(ref) < kVoicedRms) continue;  // concealing silence is trivially right for both
    const int16_t* out = lossy.pcm.data() + frame * kSamplesPerFrame;
    double frame_error = 0, frame_energy = 0;
    for (int index = 0; index < kSamplesPerFrame; ++index) {
      const double diff = static_cast<double>(out[index]) - ref[index];
      frame_error += diff * diff; frame_energy += static_cast<double>(ref[index]) * ref[index];
    }
    error += frame_error; energy += frame_energy;
    snr_sum += 10 * std::log10((frame_energy + 1) / (frame_error + 1));
    lsd += LogSpectralDistance(out, ref);
    ++counted;
  }
  std::cout << std::fixed << std::setprecision(3) << "decoderComplexity=" << options.decoder_complexity
            << " randomLoss=" << options.random_loss_percent << " lost=" << missing.size()
            << " voicedLost=" << counted << " nrmse=" << std::sqrt(error / std::max(energy, 1.0))
            << " meanSegSnrDb=" << snr_sum / std::max(counted, 1)
            << " meanLsdDb=" << lsd / std::max(counted, 1)
            << " decodeCpuMs=" << lossy.decode_time.cpu_ms << '\n';
}
}  // namespace

int main(int argc, char** argv) {
  try {
    const Options options = ParseOptions(argc, argv);
    if (options.mode == "bandwidth") { RunBandwidth(options, ReadPcm(options)); return 0; }
    if (options.mode == "plc") { RunPlc(options, ReadPcm(options)); return 0; }
    fs::create_directories(options.fixture_dir);
    const std::vector<int16_t> source = ReadPcm(options);
    Timings encode_fec_time;
    Timings encode_no_fec_time;
    int lookahead = 0;
    int no_fec_lookahead = 0;
    const auto fec_packets = Encode(source, options, &encode_fec_time, &lookahead, true);
    const auto no_fec_packets = Encode(source, options, &encode_no_fec_time, &no_fec_lookahead, false);
    if (lookahead != no_fec_lookahead) Fail("FEC and no-FEC lookahead mismatch");
    const auto single_frames = HighEnergyFrames(source, 8, 12);
    const std::set<int> single_missing(single_frames.begin(), single_frames.end());
    const auto burst_end_frames = HighEnergyFrames(source, 8, 18);
    std::vector<std::pair<int, int>> bursts;
    std::set<int> burst_missing;
    for (size_t index = 0; index < burst_end_frames.size(); ++index) {
      const int length = index < 4 ? 2 : 3;
      const int start = burst_end_frames[index] - length + 1;
      bursts.emplace_back(start, length);
      for (int frame = start; frame < start + length; ++frame) burst_missing.insert(frame);
    }

    const auto lossless_fec = Decode("losslessFec", "none", fec_packets, {}, false);
    const auto lossless_no_fec = Decode("losslessNoFec", "none", no_fec_packets, {}, false);
    const auto single_fec = Decode("singleFec", "8-isolated-single-frame-losses", fec_packets, single_missing, true);
    const auto single_plc = Decode("singlePlc", "8-isolated-single-frame-losses", fec_packets, single_missing, false);
    const auto burst_fec = Decode("burstFec", "4x2-frame-and-4x3-frame-bursts", fec_packets, burst_missing, true);
    const auto burst_plc = Decode("burstPlc", "4x2-frame-and-4x3-frame-bursts", fec_packets, burst_missing, false);
    const auto single_metrics = Metrics(single_fec, single_plc, lossless_fec.pcm, fec_packets);
    const auto burst_metrics = Metrics(burst_fec, burst_plc, lossless_fec.pcm, fec_packets);

    WritePcm(options.fixture_dir / "source.pcm16le", source);
    WritePcm(options.fixture_dir / "losslessFec.pcm16le", lossless_fec.pcm);
    WritePcm(options.fixture_dir / "losslessNoFec.pcm16le", lossless_no_fec.pcm);
    WritePcm(options.fixture_dir / "singleFec.pcm16le", single_fec.pcm);
    WritePcm(options.fixture_dir / "singlePlc.pcm16le", single_plc.pcm);
    WritePcm(options.fixture_dir / "burstFec.pcm16le", burst_fec.pcm);
    WritePcm(options.fixture_dir / "burstPlc.pcm16le", burst_plc.pcm);
    WritePackets(options.fixture_dir / "encodedFec.opusframes", fec_packets);
    WritePackets(options.fixture_dir / "encodedNoFec.opusframes", no_fec_packets);

    std::ofstream manifest(options.fixture_dir / "manifest.json");
    if (!manifest) Fail("cannot write manifest.json");
    manifest << std::fixed << std::setprecision(3);
    manifest << "{\n  \"schemaVersion\":2,\n  \"config\":{\"sampleRate\":" << kSampleRate
             << ",\"channels\":" << kChannels << ",\"frameMs\":" << kFrameMs
             << ",\"frameSamples\":" << kSamplesPerFrame << ",\"fecEnabled\":true"
             << ",\"lossPercent\":" << options.loss_percent << ",\"bitrate\":" << options.bitrate
             << ",\"codecVersion\":\"" << opus_get_version_string() << "\",\"seed\":" << options.seed
             << "},\n  \"packetFormat\":\"uint32-be-length-prefixed-raw-opus\""
             << ",\n  \"packetDurationUs\":20000,\n  \"packetCount\":" << fec_packets.size()
             << ",\n  \"outputSamples\":" << source.size()
             << ",\n  \"comparison\":{\"reference\":\"losslessFec\",\"sourceAlignmentSamples\":" << lookahead
             << ",\"validStartSample\":" << lookahead << ",\"validEndSample\":" << source.size()
             << ",\"metricAlgorithm\":\"frame-aligned decoded PCM16 mean absolute error against the clean decode of the same FEC-enabled packet stream\""
             << ",\"qualityThresholdPolicy\":\"fecRecovered remains zero here; independent validation must require FEC error below PLC error and closer alignment to missing than next\"},"
             << "\n  \"artifacts\":{";
    manifest << "\"source\":"; WriteArtifactJson(manifest, options.fixture_dir, "source.pcm16le");
    manifest << ",\"losslessFec\":"; WriteArtifactJson(manifest, options.fixture_dir, "losslessFec.pcm16le");
    manifest << ",\"losslessNoFec\":"; WriteArtifactJson(manifest, options.fixture_dir, "losslessNoFec.pcm16le");
    manifest << ",\"singleFec\":"; WriteArtifactJson(manifest, options.fixture_dir, "singleFec.pcm16le");
    manifest << ",\"singlePlc\":"; WriteArtifactJson(manifest, options.fixture_dir, "singlePlc.pcm16le");
    manifest << ",\"burstFec\":"; WriteArtifactJson(manifest, options.fixture_dir, "burstFec.pcm16le");
    manifest << ",\"burstPlc\":"; WriteArtifactJson(manifest, options.fixture_dir, "burstPlc.pcm16le");
    manifest << ",\"encodedFec\":"; WriteArtifactJson(manifest, options.fixture_dir, "encodedFec.opusframes");
    manifest << ",\"encodedNoFec\":"; WriteArtifactJson(manifest, options.fixture_dir, "encodedNoFec.opusframes");
    manifest << "},\n  \"scenarios\":{";
    manifest << "\"lossless\":{\"lossFrameIndices\":[],\"fec\":"; WriteCountersJson(manifest, lossless_fec);
    manifest << ",\"noFec\":"; WriteCountersJson(manifest, lossless_no_fec); manifest << "},";
    manifest << "\"single\":{\"lossFrameIndices\":" << JsonIndices(single_missing) << ",\"fec\":";
    WriteCountersJson(manifest, single_fec); manifest << ",\"plc\":"; WriteCountersJson(manifest, single_plc);
    manifest << ",\"missingMetrics\":"; WriteMetricsJson(manifest, single_metrics); manifest << "},";
    manifest << "\"burst\":{\"lossFrameIndices\":" << JsonIndices(burst_missing)
             << ",\"lossBursts\":" << JsonBursts(bursts) << ",\"fec\":";
    WriteCountersJson(manifest, burst_fec); manifest << ",\"plc\":"; WriteCountersJson(manifest, burst_plc);
    manifest << ",\"missingMetrics\":"; WriteMetricsJson(manifest, burst_metrics); manifest << "}},";
    manifest << "\n  \"timing\":{\"encode\":{\"fec\":"; WriteTimingJson(manifest, encode_fec_time);
    manifest << ",\"noFec\":"; WriteTimingJson(manifest, encode_no_fec_time); manifest << "},\"decode\":{";
    manifest << "\"losslessFec\":"; WriteTimingJson(manifest, lossless_fec.decode_time);
    manifest << ",\"losslessNoFec\":"; WriteTimingJson(manifest, lossless_no_fec.decode_time);
    manifest << ",\"singleFec\":"; WriteTimingJson(manifest, single_fec.decode_time);
    manifest << ",\"singlePlc\":"; WriteTimingJson(manifest, single_plc.decode_time);
    manifest << ",\"burstFec\":"; WriteTimingJson(manifest, burst_fec.decode_time);
    manifest << ",\"burstPlc\":"; WriteTimingJson(manifest, burst_plc.decode_time);
    manifest << "}}\n}\n";
    manifest.close();
    if (!manifest) Fail("failed writing manifest.json");

    std::cout << (options.fixture_dir / "manifest.json") << '\n';
    return 0;
  } catch (const std::exception& error) {
    std::cerr << "opus_loss_harness: " << error.what() << '\n';
    return 1;
  }
}
