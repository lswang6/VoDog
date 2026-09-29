package simtransport

import (
	"strings"
	"testing"
)

func TestDescribeAPDUStatusCommonSIMWords(t *testing.T) {
	tests := []struct {
		name        string
		sw1         byte
		sw2         byte
		class       APDUStatusClass
		meaningPart string
		recovery    RecoveryClass
		remaining   int
		correctLe   int
		retriesLeft int
	}{
		{
			name:        "success",
			sw1:         0x90,
			sw2:         0x00,
			class:       APDUStatusClassSuccess,
			meaningPart: "successful",
			recovery:    RecoveryClassNone,
		},
		{
			name:        "response bytes available",
			sw1:         0x61,
			sw2:         0x02,
			class:       APDUStatusClassProcedure,
			meaningPart: "response bytes",
			recovery:    RecoveryClassMalformedReply,
			remaining:   2,
		},
		{
			name:        "sim get response available",
			sw1:         0x9F,
			sw2:         0x00,
			class:       APDUStatusClassProcedure,
			meaningPart: "response bytes",
			recovery:    RecoveryClassMalformedReply,
			remaining:   256,
		},
		{
			name:        "wrong le",
			sw1:         0x6C,
			sw2:         0x00,
			class:       APDUStatusClassProcedure,
			meaningPart: "wrong Le",
			recovery:    RecoveryClassMalformedReply,
			correctLe:   256,
		},
		{
			name:        "pin retries",
			sw1:         0x63,
			sw2:         0xC2,
			class:       APDUStatusClassWarning,
			meaningPart: "verification failed",
			recovery:    RecoveryClassNone,
			retriesLeft: 2,
		},
		{
			name:        "security status",
			sw1:         0x69,
			sw2:         0x82,
			class:       APDUStatusClassCheckingError,
			meaningPart: "security status",
			recovery:    RecoveryClassNone,
		},
		{
			name:        "file missing",
			sw1:         0x6A,
			sw2:         0x82,
			class:       APDUStatusClassCheckingError,
			meaningPart: "not found",
			recovery:    RecoveryClassFileNotFound,
		},
		{
			name:        "technical problem",
			sw1:         0x6F,
			sw2:         0x00,
			class:       APDUStatusClassExecutionError,
			meaningPart: "technical problem",
			recovery:    RecoveryClassSIMBusy,
		},
		{
			name:        "generic warning",
			sw1:         0x62,
			sw2:         0xF1,
			class:       APDUStatusClassWarning,
			meaningPart: "memory unchanged",
			recovery:    RecoveryClassNone,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := DescribeAPDUStatus(tt.sw1, tt.sw2)
			if got.SW1 != tt.sw1 || got.SW2 != tt.sw2 || got.Status != uint16(tt.sw1)<<8|uint16(tt.sw2) {
				t.Fatalf("status identity = %02X%02X/%04X, want %02X%02X", got.SW1, got.SW2, got.Status, tt.sw1, tt.sw2)
			}
			if got.Class != tt.class {
				t.Fatalf("Class = %q, want %q", got.Class, tt.class)
			}
			if !strings.Contains(got.Meaning, tt.meaningPart) {
				t.Fatalf("Meaning = %q, want contains %q", got.Meaning, tt.meaningPart)
			}
			if got.Recovery != tt.recovery {
				t.Fatalf("Recovery = %q, want %q", got.Recovery, tt.recovery)
			}
			if got.Remaining != tt.remaining {
				t.Fatalf("Remaining = %d, want %d", got.Remaining, tt.remaining)
			}
			if got.CorrectLe != tt.correctLe {
				t.Fatalf("CorrectLe = %d, want %d", got.CorrectLe, tt.correctLe)
			}
			if got.RetriesLeft != tt.retriesLeft {
				t.Fatalf("RetriesLeft = %d, want %d", got.RetriesLeft, tt.retriesLeft)
			}
		})
	}
}

func TestAPDUAndCRSMStatusDescriptions(t *testing.T) {
	apdu := APDUResult{SW1: 0x6C, SW2: 0x10}
	if got := apdu.StatusInfo(); got.CorrectLe != 16 || got.Class != APDUStatusClassProcedure {
		t.Fatalf("APDU StatusInfo() = %+v, want Le=16 procedure", got)
	}
	if got := apdu.StatusDescription(); !strings.Contains(got, "6C10") || !strings.Contains(got, "Le=16") {
		t.Fatalf("APDU StatusDescription() = %q, want status and Le", got)
	}

	crsm := CRSMResult{SW1: 0x69, SW2: 0x82}
	if got := crsm.StatusInfo(); got.Meaning != "security status not satisfied" {
		t.Fatalf("CRSM StatusInfo() = %+v", got)
	}
	if got := crsm.StatusDescription(); !strings.Contains(got, "6982") || !strings.Contains(got, "security status") {
		t.Fatalf("CRSM StatusDescription() = %q, want status and security detail", got)
	}
}
