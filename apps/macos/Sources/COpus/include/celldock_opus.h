#ifndef VODOG_OPUS_H
#define VODOG_OPUS_H

// libopus 1.6.1 (vendored under Sources/COpus/opus, float build, deep PLC compiled in) plus
// non-variadic wrappers: Swift cannot call opus_encoder_ctl / opus_decoder_ctl.

#include "opus.h"

/// S70 uplink encoder: 8 kHz mono, VOIP, SIGNAL_VOICE, `bitrate` bps, in-band FEC on,
/// expected loss `loss_percent`, `complexity`. Returns NULL (and *error) on failure.
OpusEncoder *celldock_opus_encoder_create(int bitrate, int loss_percent, int complexity, int *error);

/// Decoder at `sample_rate` Hz mono with OPUS_SET_COMPLEXITY(`complexity`): >= 5 enables deep PLC
/// (LPCNet, runs at 16 kHz inside libopus), lower keeps classic PLC. NULL (and *error) on failure.
OpusDecoder *celldock_opus_decoder_create(int sample_rate, int complexity, int *error);

/// OPUS_GET_COMPLEXITY on the decoder (0 when the query fails).
int celldock_opus_decoder_complexity(OpusDecoder *decoder);

/// OPUS_GET_INBAND_FEC / OPUS_GET_PACKET_LOSS_PERC / OPUS_GET_BITRATE / OPUS_GET_SIGNAL (tests).
int celldock_opus_encoder_get(OpusEncoder *encoder, int what);
#define VODOG_OPUS_GET_FEC 1
#define VODOG_OPUS_GET_LOSS 2
#define VODOG_OPUS_GET_BITRATE 3
#define VODOG_OPUS_GET_SIGNAL 4
#define VODOG_OPUS_GET_COMPLEXITY 5

#endif
