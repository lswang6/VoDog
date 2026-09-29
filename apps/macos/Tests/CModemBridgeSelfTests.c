#include "CModemBridge.h"

#include <assert.h>
#include <stdio.h>

int main(void) {
    size_t discovered_count = celldock_modem_copy_devices(NULL, 0);
    VoDogModemDevice discovered[8] = {0};
    size_t copied_count = celldock_modem_copy_devices(discovered, 8);
    assert(copied_count == discovered_count);
    size_t inspected_count = copied_count < 8 ? copied_count : 8;
    for (size_t index = 0; index < inspected_count; index++) {
        assert(discovered[index].location_id != 0);
        assert(discovered[index].vendor_id == 0x2C7C || discovered[index].vendor_id == 0x2CA3);
        if (index > 0) {
            assert(discovered[index - 1].location_id < discovered[index].location_id);
        }
    }

    int32_t owner_pid = -1;
    char owner_name[32] = "unexpected";
    assert(celldock_usb_interface_owner_process(
        0,
        6,
        &owner_pid,
        owner_name,
        sizeof(owner_name)
    ) == 0);
    assert(owner_pid == 0);
    assert(owner_name[0] == '\0');

    VoDogModem *modem = celldock_modem_create();
    assert(modem != NULL);
    assert(celldock_modem_is_open(modem) == 0);
    assert(celldock_modem_interrupt_read(modem) == VODOG_MODEM_NOT_OPEN);
    celldock_modem_close(modem);
    celldock_modem_destroy(modem);
    printf(
        "CModemBridge self-tests passed (discovery=%zu, lifecycle and idle read interruption).\n",
        discovered_count
    );
    return 0;
}
