#include "CEuiccCore.h"

#include <assert.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define GSMA_ISDR_COMMAND "AT+CCHO=\"A0000005591010FFFFFFFF8900000100\""
#define XESIM_ISDR_COMMAND "AT+CCHO=\"A0000005591010FFFFFFFF8900000177\""
#define LINKSFIELD_ISDR_COMMAND "AT+CCHO=\"A000000559104C696E6B736669656C64\""
#define MAX_RECORDED_OPEN_COMMANDS 16
#define MAX_RECORDED_OPEN_COMMAND_LENGTH 80

typedef struct {
    int capability_failure;
    int standard_aid_opens;
    int xesim_aid_opens;
    int linksfield_aid_opens;
    int standard_attempts;
    int xesim_attempts;
    int linksfield_attempts;
    int eid_requests;
    int profile_requests;
    int close_requests;
    int active_is_xesim;
    int apdus_on_channel;
    int open_command_count;
    char open_commands[MAX_RECORDED_OPEN_COMMANDS][MAX_RECORDED_OPEN_COMMAND_LENGTH];
} FakeModem;

static int write_response(char *output, size_t capacity, const char *response) {
    if (!output || capacity == 0) return -1;
    int written = snprintf(output, capacity, "%s", response);
    return written >= 0 && (size_t)written < capacity ? 0 : -1;
}

static int fake_at_command(
    void *context,
    const char *command,
    int timeout_ms,
    char *output,
    size_t output_capacity
) {
    (void)timeout_ms;
    FakeModem *modem = context;
    if (!modem || !command) return -1;

    if (strcmp(command, "AT+CCHO=?") == 0 ||
        strcmp(command, "AT+CCHC=?") == 0 ||
        strcmp(command, "AT+CGLA=?") == 0) {
        if (modem->capability_failure) return -1;
        return write_response(output, output_capacity, "OK");
    }

    if (strncmp(command, "AT+CCHO=\"", sizeof("AT+CCHO=\"") - 1) == 0) {
        assert(modem->open_command_count < MAX_RECORDED_OPEN_COMMANDS);
        int index = modem->open_command_count++;
        int written = snprintf(
            modem->open_commands[index],
            sizeof(modem->open_commands[index]),
            "%s",
            command
        );
        assert(written > 0 && (size_t)written < sizeof(modem->open_commands[index]));
    }

    if (strcmp(command, GSMA_ISDR_COMMAND) == 0) {
        modem->standard_attempts++;
        if (modem->standard_aid_opens) {
            modem->active_is_xesim = 0;
            modem->apdus_on_channel = 0;
            return write_response(output, output_capacity, "+CCHO: 1\r\nOK");
        }
        (void)write_response(output, output_capacity, "ERROR");
        return -1;
    }

    if (strcmp(command, XESIM_ISDR_COMMAND) == 0) {
        modem->xesim_attempts++;
        if (modem->xesim_aid_opens) {
            modem->active_is_xesim = 1;
            modem->apdus_on_channel = 0;
            return write_response(output, output_capacity, "+CCHO: 1\r\nOK");
        }
        (void)write_response(output, output_capacity, "ERROR");
        return -1;
    }

    if (strcmp(command, LINKSFIELD_ISDR_COMMAND) == 0) {
        modem->linksfield_attempts++;
        if (modem->linksfield_aid_opens) {
            modem->active_is_xesim = 1;
            modem->apdus_on_channel = 0;
            return write_response(output, output_capacity, "+CCHO: 1\r\nOK");
        }
        (void)write_response(output, output_capacity, "ERROR");
        return -1;
    }

    if (strncmp(command, "AT+CCHO=", 9) == 0) {
        (void)write_response(output, output_capacity, "ERROR");
        return -1;
    }

    if (strncmp(command, "AT+CGLA=", 8) == 0) {
        if (!modem->active_is_xesim) {
            modem->eid_requests++;
            modem->apdus_on_channel++;
            return write_response(output, output_capacity, "+CGLA: 4,\"6D00\"\r\nOK");
        }
        if (modem->apdus_on_channel == 0) {
            modem->eid_requests++;
            modem->apdus_on_channel++;
            return write_response(
                output,
                output_capacity,
                "+CGLA: 46,\"BF3E125A10890490320000000000000000000000019000\"\r\nOK"
            );
        }
        modem->profile_requests++;
        modem->apdus_on_channel++;
        return write_response(output, output_capacity, "+CGLA: 14,\"BF2D02A0009000\"\r\nOK");
    }

    if (strcmp(command, "AT+CCHC=1") == 0) {
        modem->close_requests++;
        return write_response(output, output_capacity, "OK");
    }

    return -1;
}

static void expect_xesim_fallback(int standard_aid_opens) {
    FakeModem modem = {
        .standard_aid_opens = standard_aid_opens,
        .xesim_aid_opens = 1
    };
    VoDogEUICCCallbacks callbacks = {
        .context = &modem,
        .at_command = fake_at_command,
        .http_request = NULL
    };
    VoDogEUICCSession *session = celldock_euicc_create(callbacks);
    assert(session != NULL);

    char *json = NULL;
    int result = celldock_euicc_read_snapshot(session, &json);
    if (result != VODOG_EUICC_OK) {
        fprintf(
            stderr,
            "snapshot failed: result=%d error=%s standard=%d xesim=%d eid=%d profiles=%d closes=%d\n",
            result,
            celldock_euicc_last_error(session),
            modem.standard_attempts,
            modem.xesim_attempts,
            modem.eid_requests,
            modem.profile_requests,
            modem.close_requests
        );
    }
    assert(result == VODOG_EUICC_OK);
    assert(json != NULL);
    assert(strstr(json, "\"eid\":\"89049032000000000000000000000001\"") != NULL);
    assert(strstr(json, "\"isdrAidSource\":\"XeSIM\"") != NULL);
    assert(strstr(json, "\"profiles\":[]") != NULL);
    assert(modem.standard_attempts == 1);
    assert(modem.xesim_attempts == 1);
    assert(modem.profile_requests == 1);
    assert(modem.close_requests == (standard_aid_opens ? 2 : 1));

    celldock_euicc_free(json);

    /* The verified AID is tried first when the same session is reused. */
    json = NULL;
    result = celldock_euicc_read_snapshot(session, &json);
    assert(result == VODOG_EUICC_OK);
    assert(json != NULL);
    assert(modem.standard_attempts == 1);
    assert(modem.xesim_attempts == 2);
    assert(modem.profile_requests == 2);
    assert(modem.close_requests == (standard_aid_opens ? 3 : 2));

    celldock_euicc_free(json);
    celldock_euicc_destroy(session);
}

static void expect_linksfield_fallback(void) {
    FakeModem modem = {.linksfield_aid_opens = 1};
    VoDogEUICCCallbacks callbacks = {
        .context = &modem,
        .at_command = fake_at_command,
        .http_request = NULL
    };
    VoDogEUICCSession *session = celldock_euicc_create(callbacks);
    assert(session != NULL);

    char *json = NULL;
    int result = celldock_euicc_read_snapshot(session, &json);
    assert(result == VODOG_EUICC_OK);
    assert(json != NULL);
    assert(strstr(json, "\"isdrAidSource\":\"LinksField\"") != NULL);
    assert(modem.standard_attempts == 1);
    assert(modem.xesim_attempts == 1);
    assert(modem.linksfield_attempts == 1);

    celldock_euicc_free(json);
    celldock_euicc_destroy(session);
}

static void expect_unsupported_modem_is_not_classified_as_a_physical_sim(void) {
    FakeModem modem = {.capability_failure = 1};
    VoDogEUICCCallbacks callbacks = {
        .context = &modem,
        .at_command = fake_at_command,
        .http_request = NULL
    };
    VoDogEUICCSession *session = celldock_euicc_create(callbacks);
    assert(session != NULL);

    char *json = NULL;
    int result = celldock_euicc_read_snapshot(session, &json);
    assert(result == VODOG_EUICC_TRANSPORT_ERROR);
    assert(json == NULL);
    assert(strstr(celldock_euicc_last_error(session), "does not expose standard UICC") != NULL);
    assert(modem.standard_attempts == 0);
    assert(modem.xesim_attempts == 0);

    celldock_euicc_destroy(session);
}

static void expect_candidate_list_is_unique(void) {
    FakeModem modem = {0};
    VoDogEUICCCallbacks callbacks = {
        .context = &modem,
        .at_command = fake_at_command,
        .http_request = NULL
    };
    VoDogEUICCSession *session = celldock_euicc_create(callbacks);
    assert(session != NULL);

    char *json = NULL;
    int result = celldock_euicc_read_snapshot(session, &json);
    assert(result == VODOG_EUICC_TRANSPORT_ERROR);
    assert(json == NULL);
    if (modem.open_command_count != 10) {
        fprintf(stderr, "unexpected ISD-R candidate count: %d\n", modem.open_command_count);
        for (int index = 0; index < modem.open_command_count; index++) {
            fprintf(stderr, "candidate[%d]=%s\n", index, modem.open_commands[index]);
        }
    }
    assert(modem.open_command_count == 10);
    for (int left = 0; left < modem.open_command_count; left++) {
        for (int right = left + 1; right < modem.open_command_count; right++) {
            assert(strcmp(modem.open_commands[left], modem.open_commands[right]) != 0);
        }
    }

    celldock_euicc_destroy(session);
}

int main(void) {
    /* The actual card: standard ISD-R is rejected, XeSIM AID returns an EID. */
    expect_xesim_fallback(0);

    /* A selectable AID is not accepted unless it also returns a valid EID. */
    expect_xesim_fallback(1);

    /* The maintained OpenEUICC LinksField AID is tried exactly as published. */
    expect_linksfield_fallback();

    expect_unsupported_modem_is_not_classified_as_a_physical_sim();
    expect_candidate_list_is_unique();

    puts("CEuiccCore self-tests passed");
    return 0;
}
