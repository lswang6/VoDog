#include <stddef.h>
#include "celldock_opus.h"

OpusEncoder *celldock_opus_encoder_create(int bitrate, int loss_percent, int complexity, int *error) {
    OpusEncoder *encoder = opus_encoder_create(8000, 1, OPUS_APPLICATION_VOIP, error);
    if (encoder == NULL) {
        return NULL;
    }
    if (opus_encoder_ctl(encoder, OPUS_SET_SIGNAL(OPUS_SIGNAL_VOICE)) != OPUS_OK ||
        opus_encoder_ctl(encoder, OPUS_SET_BITRATE(bitrate)) != OPUS_OK ||
        opus_encoder_ctl(encoder, OPUS_SET_EXPERT_FRAME_DURATION(OPUS_FRAMESIZE_20_MS)) != OPUS_OK ||
        opus_encoder_ctl(encoder, OPUS_SET_INBAND_FEC(1)) != OPUS_OK ||
        opus_encoder_ctl(encoder, OPUS_SET_PACKET_LOSS_PERC(loss_percent)) != OPUS_OK ||
        opus_encoder_ctl(encoder, OPUS_SET_COMPLEXITY(complexity)) != OPUS_OK) {
        opus_encoder_destroy(encoder);
        if (error != NULL) {
            *error = OPUS_BAD_ARG;
        }
        return NULL;
    }
    return encoder;
}

OpusDecoder *celldock_opus_decoder_create(int sample_rate, int complexity, int *error) {
    OpusDecoder *decoder = opus_decoder_create(sample_rate, 1, error);
    if (decoder != NULL && opus_decoder_ctl(decoder, OPUS_SET_COMPLEXITY(complexity)) != OPUS_OK) {
        opus_decoder_destroy(decoder);
        if (error != NULL) {
            *error = OPUS_BAD_ARG;
        }
        return NULL;
    }
    return decoder;
}

int celldock_opus_decoder_complexity(OpusDecoder *decoder) {
    opus_int32 value = 0;
    return opus_decoder_ctl(decoder, OPUS_GET_COMPLEXITY(&value)) == OPUS_OK ? (int)value : 0;
}

int celldock_opus_encoder_get(OpusEncoder *encoder, int what) {
    opus_int32 value = -1;
    switch (what) {
    case VODOG_OPUS_GET_FEC: opus_encoder_ctl(encoder, OPUS_GET_INBAND_FEC(&value)); break;
    case VODOG_OPUS_GET_LOSS: opus_encoder_ctl(encoder, OPUS_GET_PACKET_LOSS_PERC(&value)); break;
    case VODOG_OPUS_GET_BITRATE: opus_encoder_ctl(encoder, OPUS_GET_BITRATE(&value)); break;
    case VODOG_OPUS_GET_SIGNAL: opus_encoder_ctl(encoder, OPUS_GET_SIGNAL(&value)); break;
    case VODOG_OPUS_GET_COMPLEXITY: opus_encoder_ctl(encoder, OPUS_GET_COMPLEXITY(&value)); break;
    default: break;
    }
    return (int)value;
}
