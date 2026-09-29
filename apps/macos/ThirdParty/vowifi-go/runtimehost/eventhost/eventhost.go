package eventhost

import (
	"context"
	"errors"
	"strings"
	"time"

	"github.com/boa-z/vowifi-go/runtimehost/simtransport"
)

type Event interface{}

type Dispatcher interface {
	Dispatch(context.Context, Event)
}

const (
	ControlPortAT      = "at"
	ControlPortQMI     = "qmi"
	ControlPortUnknown = "unknown"

	RecoveryActionRestartControlPort = "restart_control_port"
	RecoveryActionRetryLater         = "retry_later"

	RuntimePhaseStarting = "starting"
	RuntimePhaseSIMReady = "sim_ready"
	RuntimePhaseReady    = "ready"
	RuntimePhaseStopped  = "stopped"
	RuntimePhaseError    = "error"
)

type SMSReceived struct {
	DevID   string
	Sender  string
	Content string
	Time    time.Time
}

type SMSSent struct {
	DevID      string
	TargetURI  string
	Content    string
	Time       time.Time
	TotalParts int
}

type USSDUpdated struct {
	DevID     string
	SessionID string
	Text      string
	RawText   string
	Status    int
	DCS       int
	Done      bool
	Time      time.Time
}

type LocalNumberLearned struct {
	DevID  string
	IMSI   string
	Number string
	Source string
	Time   time.Time
}

type LogNotify struct {
	DevID   string
	Message string
	Time    time.Time
}

type RuntimeStateSnapshot struct {
	DevID                    string
	Phase                    string
	DataplaneMode            string
	SIMReady                 bool
	AccessReady              bool
	TunnelReady              bool
	IMSReady                 bool
	SMSReady                 bool
	RegStatus                int
	RegStatusText            string
	NetworkMode              string
	LastErrorClass           string
	LastError                string
	LastReason               string
	IMSRecoveryPending       bool
	IMSRecoveryRetryAfter    time.Duration
	IMSRecoveryNextAttemptAt time.Time
	IMSRecoveryReason        string
	Time                     time.Time
}

type ControlPortHint struct {
	PortType        string
	Operation       string
	SuggestedAction string
}

type RuntimeRecovery struct {
	DevID          string
	Component      string
	Operation      string
	Field          string
	PrimarySource  string
	FallbackSource string
	UsedFallback   bool
	Class          simtransport.RecoveryClass
	Recoverable    bool
	Reason         string
	Hint           *ControlPortHint
	Time           time.Time
}

func NewRuntimeRecovery(devID, component, operation string, err error) RuntimeRecovery {
	class := simtransport.ClassifyError(err)
	return RuntimeRecovery{
		DevID:       strings.TrimSpace(devID),
		Component:   strings.TrimSpace(component),
		Operation:   strings.TrimSpace(operation),
		Class:       class,
		Recoverable: class.Recoverable(),
		Reason:      errorReason(err),
	}
}

func NewFallbackRecovery(devID, component, operation, field, primarySource, fallbackSource string, err error) RuntimeRecovery {
	ev := NewRuntimeRecovery(devID, component, operation, err)
	ev.Field = strings.ToLower(strings.TrimSpace(field))
	ev.PrimarySource = strings.ToLower(strings.TrimSpace(primarySource))
	ev.FallbackSource = strings.ToLower(strings.TrimSpace(fallbackSource))
	ev.UsedFallback = ev.FallbackSource != ""
	return ev
}

func NewControlPortHangRecovery(devID, component, portType, operation string, err error) RuntimeRecovery {
	ev := NewRuntimeRecovery(devID, component, operation, err)
	if ev.Class == simtransport.RecoveryClassNone {
		ev.Class = simtransport.RecoveryClassControlPortHung
		ev.Recoverable = true
	}
	ev.Hint = &ControlPortHint{
		PortType:        normalizeControlPort(portType),
		Operation:       strings.TrimSpace(operation),
		SuggestedAction: RecoveryActionRestartControlPort,
	}
	return ev
}

func DispatchRecovery(ctx context.Context, dispatcher Dispatcher, ev RuntimeRecovery) bool {
	if dispatcher == nil {
		return false
	}
	if ev.Time.IsZero() {
		ev.Time = time.Now()
	}
	if !ev.Recoverable {
		ev.Recoverable = ev.Class.Recoverable()
	}
	dispatcher.Dispatch(ctx, ev)
	return true
}

func NormalizeRuntimeStateSnapshot(snapshot RuntimeStateSnapshot) (RuntimeStateSnapshot, error) {
	snapshot.DevID = strings.TrimSpace(snapshot.DevID)
	snapshot.Phase = strings.ToLower(strings.TrimSpace(snapshot.Phase))
	snapshot.DataplaneMode = strings.TrimSpace(snapshot.DataplaneMode)
	snapshot.RegStatusText = strings.TrimSpace(snapshot.RegStatusText)
	snapshot.NetworkMode = strings.TrimSpace(snapshot.NetworkMode)
	snapshot.LastErrorClass = strings.TrimSpace(snapshot.LastErrorClass)
	snapshot.LastError = strings.TrimSpace(snapshot.LastError)
	snapshot.LastReason = strings.TrimSpace(snapshot.LastReason)
	snapshot.IMSRecoveryReason = strings.TrimSpace(snapshot.IMSRecoveryReason)
	if snapshot.DevID == "" {
		return RuntimeStateSnapshot{}, errors.New("runtime state snapshot device id is empty")
	}
	if !validRuntimePhase(snapshot.Phase) {
		return RuntimeStateSnapshot{}, errors.New("runtime state snapshot phase is invalid")
	}
	return snapshot, nil
}

func DispatchRuntimeStateSnapshot(ctx context.Context, dispatcher Dispatcher, snapshot RuntimeStateSnapshot) (bool, error) {
	if dispatcher == nil {
		return false, nil
	}
	normalized, err := NormalizeRuntimeStateSnapshot(snapshot)
	if err != nil {
		return false, err
	}
	if normalized.Time.IsZero() {
		normalized.Time = time.Now()
	}
	dispatcher.Dispatch(ctx, normalized)
	return true, nil
}

func normalizeControlPort(portType string) string {
	switch strings.ToLower(strings.TrimSpace(portType)) {
	case ControlPortAT:
		return ControlPortAT
	case ControlPortQMI:
		return ControlPortQMI
	default:
		return ControlPortUnknown
	}
}

func errorReason(err error) string {
	if err == nil {
		return ""
	}
	return strings.TrimSpace(err.Error())
}

func validRuntimePhase(phase string) bool {
	switch phase {
	case RuntimePhaseStarting, RuntimePhaseSIMReady, RuntimePhaseReady, RuntimePhaseStopped, RuntimePhaseError:
		return true
	default:
		return false
	}
}
