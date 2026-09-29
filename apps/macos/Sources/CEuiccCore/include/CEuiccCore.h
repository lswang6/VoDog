#ifndef VODOG_EUICC_CORE_H
#define VODOG_EUICC_CORE_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef struct VoDogEUICCSession VoDogEUICCSession;

typedef int (*VoDogEUICCATCallback)(
    void *context,
    const char *command,
    int timeout_ms,
    char *output,
    size_t output_capacity
);

typedef int (*VoDogEUICCHTTPCallback)(
    void *context,
    const char *url,
    const char *const *headers,
    const uint8_t *request_bytes,
    uint32_t request_length,
    uint32_t *status_code,
    uint8_t **response_bytes,
    uint32_t *response_length
);

typedef struct {
    void *context;
    VoDogEUICCATCallback at_command;
    VoDogEUICCHTTPCallback http_request;
} VoDogEUICCCallbacks;

enum {
    VODOG_EUICC_OK = 0,
    VODOG_EUICC_TRANSPORT_ERROR = -1,
    VODOG_EUICC_PROTOCOL_ERROR = -2,
    VODOG_EUICC_INVALID_ARGUMENT = -3,
    VODOG_EUICC_OUT_OF_MEMORY = -4
};

VoDogEUICCSession *celldock_euicc_create(VoDogEUICCCallbacks callbacks);
void celldock_euicc_destroy(VoDogEUICCSession *session);

/* Returns a UTF-8 JSON object containing eid and profiles. */
int celldock_euicc_read_snapshot(VoDogEUICCSession *session, char **json_output);

int celldock_euicc_enable_profile(VoDogEUICCSession *session, const char *iccid);
int celldock_euicc_disable_profile(VoDogEUICCSession *session, const char *iccid);
int celldock_euicc_delete_profile(VoDogEUICCSession *session, const char *iccid);
int celldock_euicc_set_nickname(
    VoDogEUICCSession *session,
    const char *iccid,
    const char *nickname
);

int celldock_euicc_download_profile(
    VoDogEUICCSession *session,
    const char *smdp_address,
    const char *matching_id,
    const char *confirmation_code,
    const char *imei
);

const char *celldock_euicc_last_error(const VoDogEUICCSession *session);
void celldock_euicc_free(void *pointer);

#ifdef __cplusplus
}
#endif

#endif
