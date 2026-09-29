package eventhost

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/boa-z/vowifi-go/runtimehost/simtransport"
)

type captureDispatcher struct {
	events []Event
}

func (d *captureDispatcher) Dispatch(ctx context.Context, ev Event) {
	d.events = append(d.events, ev)
}

func TestNewControlPortHangRecoveryBuildsStructuredHint(t *testing.T) {
	ev := NewControlPortHangRecovery("dev-1", "identity", "AT", "read_imsi", context.DeadlineExceeded)
	if ev.Class != simtransport.RecoveryClassControlPortHung || !ev.Recoverable {
		t.Fatalf("recovery=%+v, want control port hung recoverable", ev)
	}
	if ev.Hint == nil || ev.Hint.PortType != ControlPortAT ||
		ev.Hint.Operation != "read_imsi" ||
		ev.Hint.SuggestedAction != RecoveryActionRestartControlPort {
		t.Fatalf("hint=%+v, want AT restart hint", ev.Hint)
	}
}

func TestNewControlPortHangRecoveryDefaultsUnknownErrorToHung(t *testing.T) {
	ev := NewControlPortHangRecovery("dev-1", "carrier", "qmi", "read_profile", nil)
	if ev.Class != simtransport.RecoveryClassControlPortHung || !ev.Recoverable {
		t.Fatalf("recovery=%+v, want explicit hung class", ev)
	}
	if ev.Hint == nil || ev.Hint.PortType != ControlPortQMI {
		t.Fatalf("hint=%+v, want QMI hint", ev.Hint)
	}
}

func TestNewFallbackRecoveryClassifiesAndNormalizesMetadata(t *testing.T) {
	ev := NewFallbackRecovery(
		"dev-1",
		"identity",
		"prepare_start",
		"IMSI",
		"QMI",
		"profile",
		errors.New("AT CME ERROR: SIM busy"),
	)
	if ev.Field != "imsi" || ev.PrimarySource != "qmi" || ev.FallbackSource != "profile" || !ev.UsedFallback {
		t.Fatalf("fallback recovery=%+v", ev)
	}
	if ev.Class != simtransport.RecoveryClassSIMBusy || !ev.Recoverable {
		t.Fatalf("fallback recovery=%+v, want SIM busy recoverable", ev)
	}
}

func TestDispatchRecoveryFillsTimeAndSkipsNilDispatcher(t *testing.T) {
	if DispatchRecovery(context.Background(), nil, RuntimeRecovery{}) {
		t.Fatal("DispatchRecovery(nil) = true, want false")
	}
	dispatcher := &captureDispatcher{}
	ev := RuntimeRecovery{Class: simtransport.RecoveryClassSIMBusy}
	if !DispatchRecovery(context.Background(), dispatcher, ev) {
		t.Fatal("DispatchRecovery() = false, want true")
	}
	if len(dispatcher.events) != 1 {
		t.Fatalf("events=%d, want one event", len(dispatcher.events))
	}
	got, ok := dispatcher.events[0].(RuntimeRecovery)
	if !ok {
		t.Fatalf("event type=%T, want RuntimeRecovery", dispatcher.events[0])
	}
	if got.Time.IsZero() || !got.Recoverable {
		t.Fatalf("event=%+v, want time and recoverable populated", got)
	}
}

func TestDispatchRuntimeStateSnapshotNormalizesAndValidates(t *testing.T) {
	if ok, err := DispatchRuntimeStateSnapshot(context.Background(), nil, RuntimeStateSnapshot{}); ok || err != nil {
		t.Fatalf("DispatchRuntimeStateSnapshot(nil) = %t, %v; want false, nil", ok, err)
	}

	dispatcher := &captureDispatcher{}
	ok, err := DispatchRuntimeStateSnapshot(context.Background(), dispatcher, RuntimeStateSnapshot{
		DevID:                    " dev-1 ",
		Phase:                    " READY ",
		DataplaneMode:            " userspace ",
		RegStatusText:            " registered ",
		NetworkMode:              " LTE ",
		LastReason:               " started ",
		IMSRecoveryPending:       true,
		IMSRecoveryRetryAfter:    3 * time.Second,
		IMSRecoveryNextAttemptAt: time.Now(),
		IMSRecoveryReason:        " retry-after ",
		IMSReady:                 true,
		SMSReady:                 true,
	})
	if err != nil || !ok {
		t.Fatalf("DispatchRuntimeStateSnapshot() = %t, %v; want true, nil", ok, err)
	}
	got, ok := dispatcher.events[0].(RuntimeStateSnapshot)
	if !ok {
		t.Fatalf("event type=%T, want RuntimeStateSnapshot", dispatcher.events[0])
	}
	if got.DevID != "dev-1" || got.Phase != RuntimePhaseReady ||
		got.DataplaneMode != "userspace" || got.RegStatusText != "registered" ||
		got.NetworkMode != "LTE" || got.LastReason != "started" ||
		!got.IMSReady || !got.SMSReady || !got.IMSRecoveryPending ||
		got.IMSRecoveryRetryAfter != 3*time.Second || got.IMSRecoveryNextAttemptAt.IsZero() ||
		got.IMSRecoveryReason != "retry-after" || got.Time.IsZero() {
		t.Fatalf("snapshot=%+v, want normalized ready snapshot", got)
	}

	if ok, err := DispatchRuntimeStateSnapshot(context.Background(), dispatcher, RuntimeStateSnapshot{
		DevID: "dev-1",
		Phase: "paused",
	}); ok || err == nil {
		t.Fatalf("DispatchRuntimeStateSnapshot(invalid phase) = %t, %v; want false, error", ok, err)
	}
	if len(dispatcher.events) != 1 {
		t.Fatalf("events=%d, want invalid snapshot skipped", len(dispatcher.events))
	}
}
