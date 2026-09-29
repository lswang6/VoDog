#include "CEuiccCore.h"

#include <ctype.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include <cjson/cJSON.h>
#include <euicc/es10b.h>
#include <euicc/es10c.h>
#include <euicc/es9p.h>
#include <euicc/euicc.h>
#include <euicc/interface.h>

#define VODOG_AT_BUFFER_SIZE (128 * 1024)
#define VODOG_MAX_ISDR_AID_LENGTH 17

typedef struct {
    const char *source_name;
    const uint8_t *bytes;
    uint8_t length;
} VoDogISDRAID;

#define VODOG_AID_ENTRY(name, value) {(name), (value), (uint8_t)sizeof(value)}

static const uint8_t gsma_isdr_aid[] = {
    0xA0, 0x00, 0x00, 0x05, 0x59, 0x10, 0x10, 0xFF,
    0xFF, 0xFF, 0xFF, 0x89, 0x00, 0x00, 0x01, 0x00
};
static const uint8_t xesim_isdr_aid[] = {
    0xA0, 0x00, 0x00, 0x05, 0x59, 0x10, 0x10, 0xFF,
    0xFF, 0xFF, 0xFF, 0x89, 0x00, 0x00, 0x01, 0x77
};
static const uint8_t estkme_se0_isdr_aid[] = {
    0xA0, 0x65, 0x73, 0x74, 0x6B, 0x6D, 0x65, 0xFF,
    0xFF, 0x49, 0x53, 0x44, 0x2D, 0x52, 0x20, 0x30
};
static const uint8_t estkme_se1_isdr_aid[] = {
    0xA0, 0x65, 0x73, 0x74, 0x6B, 0x6D, 0x65, 0xFF,
    0xFF, 0x49, 0x53, 0x44, 0x2D, 0x52, 0x20, 0x31
};
static const uint8_t esim_me_isdr_aid[] = {
    0xA0, 0x00, 0x00, 0x05, 0x59, 0x10, 0x10, 0x00,
    0x00, 0x00, 0x00, 0x89, 0x00, 0x00, 0x03, 0x00
};
static const uint8_t esim_me_v2_isdr_aid[] = {
    0xA0, 0x00, 0x00, 0x05, 0x59, 0x10, 0x10, 0x00,
    0x00, 0x00, 0x89, 0x00, 0x00, 0x00, 0x03, 0x00
};
static const uint8_t fiveber_isdr_aid[] = {
    0xA0, 0x00, 0x00, 0x05, 0x59, 0x10, 0x10, 0xFF,
    0xFF, 0xFF, 0xFF, 0x89, 0x00, 0x05, 0x05, 0x00
};
static const uint8_t linksfield_isdr_aid[] = {
    0xA0, 0x00, 0x00, 0x05, 0x59, 0x10, 0x4C, 0x69,
    0x6E, 0x6B, 0x73, 0x66, 0x69, 0x65, 0x6C, 0x64
};
static const uint8_t glocalme_isdr_aid[] = {
    0xA0, 0x00, 0x00, 0x06, 0x28, 0x10, 0x10, 0xFF,
    0xFF, 0xFF, 0xFF, 0x89, 0x00, 0x00, 0x01, 0x00
};
static const uint8_t estkme_aux_isdr_aid[] = {
    0xA0, 0x65, 0x73, 0x74, 0x6B, 0x6D, 0x65, 0xFF,
    0xFF, 0xFF, 0xFF, 0x49, 0x53, 0x44, 0x2D, 0x52
};

/*
 * Many removable and MFF2 eUICCs expose a vendor ISD-R AID instead of the
 * GSMA default. Keep the standard application first, followed by the AID
 * exposed by the currently supported XeSIM-compatible card, then the other
 * known LPA-card variants used by OpenEUICC-compatible implementations.
 * Sources and the brands that do not require a distinct byte entry are listed
 * in docs/ISDR_AID_SOURCES.md. The source name describes the AID variant; it is
 * not proof of the card manufacturer.
 */
static const VoDogISDRAID supported_isdr_aids[] = {
    VODOG_AID_ENTRY("GSMA standard", gsma_isdr_aid),
    VODOG_AID_ENTRY("XeSIM", xesim_isdr_aid),
    VODOG_AID_ENTRY("eSTK.me SE0", estkme_se0_isdr_aid),
    VODOG_AID_ENTRY("eSTK.me SE1", estkme_se1_isdr_aid),
    VODOG_AID_ENTRY("eSIM.me", esim_me_isdr_aid),
    VODOG_AID_ENTRY("eSIM.me field variant", esim_me_v2_isdr_aid),
    VODOG_AID_ENTRY("5ber", fiveber_isdr_aid),
    VODOG_AID_ENTRY("LinksField", linksfield_isdr_aid),
    VODOG_AID_ENTRY("GlocalMe/Tianyu field variant", glocalme_isdr_aid),
    VODOG_AID_ENTRY("eSTK.me AUX", estkme_aux_isdr_aid)
};

struct VoDogEUICCSession {
    VoDogEUICCCallbacks callbacks;
    struct euicc_apdu_interface apdu;
    struct euicc_http_interface http;
    int logical_channel;
    int logical_channel_commands_available;
    uint8_t selected_aid[VODOG_MAX_ISDR_AID_LENGTH];
    uint8_t selected_aid_length;
    const char *selected_aid_source_name;
    char last_error[256];
};

static void set_error(VoDogEUICCSession *session, const char *message) {
    if (!session) return;
    snprintf(
        session->last_error,
        sizeof(session->last_error),
        "%s",
        message ? message : "Unknown eUICC error"
    );
}

static int run_at(
    VoDogEUICCSession *session,
    const char *command,
    int timeout_ms,
    char *output,
    size_t output_capacity
) {
    if (!session || !session->callbacks.at_command) return -1;
    if (session->callbacks.at_command(
            session->callbacks.context,
            command,
            timeout_ms,
            output,
            output_capacity
        ) != 0) {
        set_error(session, "The modem rejected an eUICC AT command");
        return -1;
    }
    return 0;
}

static int apdu_connect(struct euicc_ctx *ctx) {
    VoDogEUICCSession *session = ctx->userdata;
    if (session->logical_channel_commands_available != 0) {
        return session->logical_channel_commands_available > 0 ? 0 : -1;
    }
    char output[2048];
    if (run_at(session, "AT+CCHO=?", 3000, output, sizeof(output)) < 0 ||
        run_at(session, "AT+CCHC=?", 3000, output, sizeof(output)) < 0 ||
        run_at(session, "AT+CGLA=?", 3000, output, sizeof(output)) < 0) {
        session->logical_channel_commands_available = -1;
        set_error(session, "The modem does not expose standard UICC logical-channel commands");
        return -1;
    }
    session->logical_channel_commands_available = 1;
    return 0;
}

static void apdu_disconnect(struct euicc_ctx *ctx) {
    (void)ctx;
}

static const char *find_response_value(const char *output, const char *prefix) {
    const char *match = strstr(output, prefix);
    if (!match) return NULL;
    match += strlen(prefix);
    while (*match == ' ' || *match == '\t') match++;
    return match;
}

static int apdu_logic_channel_open(
    struct euicc_ctx *ctx,
    const uint8_t *aid,
    uint8_t aid_len
) {
    VoDogEUICCSession *session = ctx->userdata;
    char command[160];
    char output[4096];
    size_t offset = 0;

    offset += (size_t)snprintf(command + offset, sizeof(command) - offset, "AT+CCHO=\"");
    for (uint8_t index = 0; index < aid_len && offset + 2 < sizeof(command); index++) {
        offset += (size_t)snprintf(command + offset, sizeof(command) - offset, "%02X", aid[index]);
    }
    snprintf(command + offset, sizeof(command) - offset, "\"");

    if (run_at(session, command, 10000, output, sizeof(output)) < 0) {
        set_error(session, "The current card did not expose the eUICC ISD-R application");
        return -1;
    }
    const char *value = find_response_value(output, "+CCHO:");
    if (!value) {
        set_error(session, "The current card did not expose the eUICC ISD-R application");
        return -1;
    }
    int channel = atoi(value);
    if (channel <= 0 || channel > 19) {
        set_error(session, "The modem returned an invalid eUICC logical channel");
        return -1;
    }
    session->logical_channel = channel;
    return channel;
}

static void apdu_logic_channel_close(struct euicc_ctx *ctx, uint8_t channel) {
    VoDogEUICCSession *session = ctx->userdata;
    if (!session || channel == 0) return;
    char command[32];
    char output[2048];
    snprintf(command, sizeof(command), "AT+CCHC=%u", channel);
    (void)run_at(session, command, 5000, output, sizeof(output));
    session->logical_channel = 0;
}

static int hex_nibble(char value) {
    if (value >= '0' && value <= '9') return value - '0';
    value = (char)toupper((unsigned char)value);
    if (value >= 'A' && value <= 'F') return value - 'A' + 10;
    return -1;
}

static int apdu_transmit(
    struct euicc_ctx *ctx,
    uint8_t **rx,
    uint32_t *rx_len,
    const uint8_t *tx,
    uint32_t tx_len
) {
    VoDogEUICCSession *session = ctx->userdata;
    char *command = NULL;
    char *output = NULL;
    int result = -1;

    *rx = NULL;
    *rx_len = 0;
    if (!session || session->logical_channel <= 0 || tx_len == 0) return -1;

    size_t command_capacity = 64 + ((size_t)tx_len * 2);
    command = malloc(command_capacity);
    output = malloc(VODOG_AT_BUFFER_SIZE);
    if (!command || !output) {
        set_error(session, "Not enough memory for an eUICC APDU");
        goto exit;
    }

    size_t offset = (size_t)snprintf(
        command,
        command_capacity,
        "AT+CGLA=%d,%u,\"",
        session->logical_channel,
        tx_len * 2
    );
    for (uint32_t index = 0; index < tx_len; index++) {
        offset += (size_t)snprintf(command + offset, command_capacity - offset, "%02X", tx[index]);
    }
    snprintf(command + offset, command_capacity - offset, "\"");

    if (run_at(session, command, 30000, output, VODOG_AT_BUFFER_SIZE) < 0) goto exit;
    const char *value = find_response_value(output, "+CGLA:");
    if (!value) {
        set_error(session, "The modem returned no APDU payload");
        goto exit;
    }

    char *end = NULL;
    unsigned long declared_hex_length = strtoul(value, &end, 10);
    if (!end || end == value) goto exit;
    const char *payload = strchr(end, ',');
    if (!payload) goto exit;
    payload++;
    while (*payload == ' ' || *payload == '\t') payload++;
    const char *payload_end = NULL;
    if (*payload == '"') {
        payload++;
        payload_end = strchr(payload, '"');
    } else {
        payload_end = payload;
        while (isxdigit((unsigned char)*payload_end)) payload_end++;
    }
    if (!payload_end) goto exit;
    size_t hex_length = (size_t)(payload_end - payload);
    if (declared_hex_length != hex_length || hex_length % 2 != 0) {
        set_error(session, "The modem returned a malformed APDU payload");
        goto exit;
    }

    *rx_len = (uint32_t)(hex_length / 2);
    *rx = malloc(*rx_len);
    if (!*rx) goto exit;
    for (uint32_t index = 0; index < *rx_len; index++) {
        int high = hex_nibble(payload[index * 2]);
        int low = hex_nibble(payload[index * 2 + 1]);
        if (high < 0 || low < 0) {
            free(*rx);
            *rx = NULL;
            *rx_len = 0;
            set_error(session, "The modem returned non-hexadecimal APDU data");
            goto exit;
        }
        (*rx)[index] = (uint8_t)((high << 4) | low);
    }
    result = 0;

exit:
    free(command);
    free(output);
    return result;
}

static int http_transmit(
    struct euicc_ctx *ctx,
    const char *url,
    uint32_t *rcode,
    uint8_t **rx,
    uint32_t *rx_len,
    const uint8_t *tx,
    uint32_t tx_len,
    const char **headers
) {
    VoDogEUICCSession *session = ctx->userdata;
    if (!session || !session->callbacks.http_request) {
        set_error(session, "No secure HTTP transport is available");
        return -1;
    }
    return session->callbacks.http_request(
        session->callbacks.context,
        url,
        headers,
        tx,
        tx_len,
        rcode,
        rx,
        rx_len
    );
}

static int initialize_context_for_aid(
    VoDogEUICCSession *session,
    struct euicc_ctx *ctx,
    const uint8_t *aid,
    uint8_t aid_length
) {
    if (!session || !ctx) return VODOG_EUICC_INVALID_ARGUMENT;
    memset(ctx, 0, sizeof(*ctx));
    session->last_error[0] = '\0';
    session->logical_channel = 0;
    ctx->aid = aid;
    ctx->aid_len = aid_length;
    ctx->userdata = session;
    ctx->apdu.interface = &session->apdu;
    ctx->http.interface = &session->http;
    if (euicc_init(ctx) != 0) {
        if (!session->last_error[0]) set_error(session, "Unable to initialize the eUICC");
        return VODOG_EUICC_TRANSPORT_ERROR;
    }
    return VODOG_EUICC_OK;
}

static int is_valid_eid(const char *eid) {
    if (!eid) return 0;
    size_t length = strlen(eid);
    if (length < 16) return 0;
    for (size_t index = 0; index < length; index++) {
        if (!isdigit((unsigned char)eid[index])) return 0;
    }
    return 1;
}

static int open_verified_context_for_aid(
    VoDogEUICCSession *session,
    struct euicc_ctx *ctx,
    const char *source_name,
    const uint8_t *aid,
    uint8_t aid_length,
    char **verified_eid,
    int *opened_candidate
) {
    int result = initialize_context_for_aid(session, ctx, aid, aid_length);
    if (result != VODOG_EUICC_OK) return 0;
    if (opened_candidate) *opened_candidate = 1;

    char *eid = NULL;
    if (es10c_get_eid(ctx, &eid) == 0 && is_valid_eid(eid)) {
        if (aid != session->selected_aid) {
            memcpy(session->selected_aid, aid, aid_length);
        }
        session->selected_aid_length = aid_length;
        session->selected_aid_source_name = source_name;
        session->last_error[0] = '\0';
        if (verified_eid) *verified_eid = eid;
        else free(eid);
        return 1;
    }

    free(eid);
    euicc_fini(ctx);
    return 0;
}

/*
 * Opens the first candidate ISD-R application that also returns a valid EID.
 * A successful CCHO alone is not sufficient: other UICC applications can be
 * selectable without implementing the ES10 eUICC management protocol.
 */
static int begin_context(
    VoDogEUICCSession *session,
    struct euicc_ctx *ctx,
    char **verified_eid
) {
    if (!session || !ctx) return VODOG_EUICC_INVALID_ARGUMENT;
    if (verified_eid) *verified_eid = NULL;

    int opened_candidate = 0;
    if (session->selected_aid_length > 0 &&
        open_verified_context_for_aid(
            session,
            ctx,
            session->selected_aid_source_name,
            session->selected_aid,
            session->selected_aid_length,
            verified_eid,
            &opened_candidate
        )) {
        return VODOG_EUICC_OK;
    }
    session->selected_aid_length = 0;
    session->selected_aid_source_name = NULL;

    for (size_t index = 0; index < sizeof(supported_isdr_aids) / sizeof(supported_isdr_aids[0]); index++) {
        const VoDogISDRAID *candidate = &supported_isdr_aids[index];
        if (open_verified_context_for_aid(
                session,
                ctx,
                candidate->source_name,
                candidate->bytes,
                candidate->length,
                verified_eid,
                &opened_candidate
            )) {
            return VODOG_EUICC_OK;
        }
        if (session->logical_channel_commands_available < 0) break;
    }

    session->selected_aid_length = 0;
    session->selected_aid_source_name = NULL;
    if (session->logical_channel_commands_available < 0) {
        set_error(session, "The modem does not expose standard UICC logical-channel commands");
        return VODOG_EUICC_TRANSPORT_ERROR;
    }
    set_error(session, "The current card did not expose the eUICC ISD-R application");
    return opened_candidate ? VODOG_EUICC_PROTOCOL_ERROR : VODOG_EUICC_TRANSPORT_ERROR;
}

VoDogEUICCSession *celldock_euicc_create(VoDogEUICCCallbacks callbacks) {
    if (!callbacks.at_command) return NULL;
    VoDogEUICCSession *session = calloc(1, sizeof(*session));
    if (!session) return NULL;
    session->callbacks = callbacks;
    session->apdu.connect = apdu_connect;
    session->apdu.disconnect = apdu_disconnect;
    session->apdu.logic_channel_open = apdu_logic_channel_open;
    session->apdu.logic_channel_close = apdu_logic_channel_close;
    session->apdu.transmit = apdu_transmit;
    session->http.transmit = http_transmit;
    return session;
}

void celldock_euicc_destroy(VoDogEUICCSession *session) {
    free(session);
}

static cJSON *profile_json(const struct es10c_profile_info_list *profile) {
    cJSON *object = cJSON_CreateObject();
    if (!object) return NULL;
    cJSON_AddStringToObject(object, "iccid", profile->iccid);
    cJSON_AddStringToObject(object, "isdpAid", profile->isdpAid);
    cJSON_AddNumberToObject(object, "state", profile->profileState);
    cJSON_AddNumberToObject(object, "class", profile->profileClass);
    if (profile->profileNickname) cJSON_AddStringToObject(object, "nickname", profile->profileNickname);
    if (profile->serviceProviderName) {
        cJSON_AddStringToObject(object, "serviceProviderName", profile->serviceProviderName);
    }
    if (profile->profileName) cJSON_AddStringToObject(object, "profileName", profile->profileName);
    return object;
}

int celldock_euicc_read_snapshot(VoDogEUICCSession *session, char **json_output) {
    if (!session || !json_output) return VODOG_EUICC_INVALID_ARGUMENT;
    *json_output = NULL;
    struct euicc_ctx ctx;
    char *eid = NULL;
    int result = begin_context(session, &ctx, &eid);
    if (result != VODOG_EUICC_OK) return result;

    struct es10c_profile_info_list *profiles = NULL;
    cJSON *root = NULL;
    cJSON *array = NULL;

    if (es10c_get_profiles_info(&ctx, &profiles) != 0) {
        set_error(session, "Unable to read installed eSIM profiles");
        result = VODOG_EUICC_PROTOCOL_ERROR;
        goto exit;
    }

    root = cJSON_CreateObject();
    array = cJSON_CreateArray();
    if (!root || !array) {
        result = VODOG_EUICC_OUT_OF_MEMORY;
        goto exit;
    }
    cJSON_AddStringToObject(root, "eid", eid);
    cJSON_AddStringToObject(
        root,
        "isdrAidSource",
        session->selected_aid_source_name ? session->selected_aid_source_name : "unknown"
    );
    cJSON_AddItemToObject(root, "profiles", array);
    array = NULL;
    for (const struct es10c_profile_info_list *item = profiles; item; item = item->next) {
        cJSON *object = profile_json(item);
        if (!object) {
            result = VODOG_EUICC_OUT_OF_MEMORY;
            goto exit;
        }
        cJSON_AddItemToArray(cJSON_GetObjectItem(root, "profiles"), object);
    }
    *json_output = cJSON_PrintUnformatted(root);
    if (!*json_output) result = VODOG_EUICC_OUT_OF_MEMORY;

exit:
    free(eid);
    es10c_profile_info_list_free_all(profiles);
    cJSON_Delete(root);
    cJSON_Delete(array);
    euicc_fini(&ctx);
    return result;
}

typedef int (*profile_operation)(struct euicc_ctx *, const char *);

static int run_profile_operation(
    VoDogEUICCSession *session,
    const char *iccid,
    profile_operation operation,
    const char *failure_message
) {
    if (!session || !iccid || !*iccid) return VODOG_EUICC_INVALID_ARGUMENT;
    struct euicc_ctx ctx;
    int result = begin_context(session, &ctx, NULL);
    if (result != VODOG_EUICC_OK) return result;
    if (operation(&ctx, iccid) != 0) {
        set_error(session, failure_message);
        result = VODOG_EUICC_PROTOCOL_ERROR;
    }
    euicc_fini(&ctx);
    return result;
}

static int enable_no_refresh(struct euicc_ctx *ctx, const char *iccid) {
    return es10c_enable_profile(ctx, iccid, 0);
}

static int disable_no_refresh(struct euicc_ctx *ctx, const char *iccid) {
    return es10c_disable_profile(ctx, iccid, 0);
}

int celldock_euicc_enable_profile(VoDogEUICCSession *session, const char *iccid) {
    return run_profile_operation(session, iccid, enable_no_refresh, "Unable to enable the eSIM profile");
}

int celldock_euicc_disable_profile(VoDogEUICCSession *session, const char *iccid) {
    return run_profile_operation(session, iccid, disable_no_refresh, "Unable to disable the eSIM profile");
}

int celldock_euicc_delete_profile(VoDogEUICCSession *session, const char *iccid) {
    return run_profile_operation(session, iccid, es10c_delete_profile, "Unable to delete the eSIM profile");
}

int celldock_euicc_set_nickname(
    VoDogEUICCSession *session,
    const char *iccid,
    const char *nickname
) {
    if (!session || !iccid || !nickname) return VODOG_EUICC_INVALID_ARGUMENT;
    struct euicc_ctx ctx;
    int result = begin_context(session, &ctx, NULL);
    if (result != VODOG_EUICC_OK) return result;
    if (es10c_set_nickname(&ctx, iccid, nickname) != 0) {
        set_error(session, "Unable to rename the eSIM profile");
        result = VODOG_EUICC_PROTOCOL_ERROR;
    }
    euicc_fini(&ctx);
    return result;
}

int celldock_euicc_download_profile(
    VoDogEUICCSession *session,
    const char *smdp_address,
    const char *matching_id,
    const char *confirmation_code,
    const char *imei
) {
    if (!session || !smdp_address || !*smdp_address || !matching_id || !*matching_id) {
        return VODOG_EUICC_INVALID_ARGUMENT;
    }
    struct euicc_ctx ctx;
    int result = begin_context(session, &ctx, NULL);
    if (result != VODOG_EUICC_OK) return result;
    ctx.http.server_address = smdp_address;

    struct es10b_load_bound_profile_package_result download_result = {0};
    const char *failed_stage = NULL;
    if (es10b_get_euicc_challenge_and_info(&ctx) != 0) {
        failed_stage = "read_euicc_challenge";
    } else if (es9p_initiate_authentication(&ctx) != 0) {
        failed_stage = "initiate_authentication";
    } else if (es10b_authenticate_server(
                   &ctx,
                   matching_id,
                   (imei && *imei) ? imei : NULL
               ) != 0) {
        failed_stage = "authenticate_server";
    } else if (es9p_authenticate_client(&ctx) != 0) {
        failed_stage = "authenticate_client";
    } else if (es10b_prepare_download(
                   &ctx,
                   (confirmation_code && *confirmation_code) ? confirmation_code : NULL
               ) != 0) {
        failed_stage = "prepare_download";
    } else if (es9p_get_bound_profile_package(&ctx) != 0) {
        failed_stage = "get_bound_profile_package";
    } else if (es10b_load_bound_profile_package(&ctx, &download_result) != 0) {
        failed_stage = "load_bound_profile_package";
    }

    if (failed_stage) {
        char failure[256];
        snprintf(
            failure,
            sizeof(failure),
            "eSIM download failed stage=%s: %s",
            failed_stage,
            ctx.http.status.message[0] ? ctx.http.status.message : "protocol error"
        );
        set_error(session, failure);
        (void)es10b_cancel_session(&ctx, ES10B_CANCEL_SESSION_REASON_ENDUSERREJECTION);
        (void)es9p_cancel_session(&ctx);
        result = VODOG_EUICC_PROTOCOL_ERROR;
    }

    euicc_http_cleanup(&ctx);
    euicc_fini(&ctx);
    return result;
}

const char *celldock_euicc_last_error(const VoDogEUICCSession *session) {
    if (!session || !session->last_error[0]) return "Unknown eUICC error";
    return session->last_error;
}

void celldock_euicc_free(void *pointer) {
    free(pointer);
}
