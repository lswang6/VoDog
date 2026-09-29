package runtimehost

import (
	"regexp"
	"strings"
	"time"

	"github.com/boa-z/vowifi-go/internal/tracefixture"
)

var runtimeLocalPathRE = regexp.MustCompile(`(?i)(?:/(?:home|Users)/[A-Za-z0-9_.-]+(?:/[^\s"'<>:;,)]*)*|[A-Za-z]:\\Users\\[A-Za-z0-9_.-]+(?:\\[^\s"'<>:;,)]*)*)`)

// DiagnosticState is a redacted runtime state view intended for logs, UI state,
// and support diagnostics. It preserves operational state while removing common
// subscriber identifiers, AKA/digest material, IPs, MACs, and local paths.
type DiagnosticState struct {
	DeviceID                 string
	Phase                    Phase
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
	UpdatedAt                time.Time
	Redacted                 bool
}

// DiagnosticIMSRegisterResponseDecision is a redacted view of an IMS REGISTER
// recovery decision. It is suitable for logs/UI because it carries the
// operational recovery action without exposing SIP identities or auth material
// from the response reason.
type DiagnosticIMSRegisterResponseDecision struct {
	StatusCode      int
	Action          string
	Recoverable     bool
	Retry           bool
	Reauthenticate  bool
	RefreshIdentity bool
	RefreshSecurity bool
	Backoff         bool
	RetryAfter      time.Duration
	Reason          string
	Redacted        bool
}

// DiagnosticIMSRegistrationRecoveryState is a redacted view of ongoing IMS
// registration recovery bookkeeping. It preserves retry counters and timestamps
// while removing sensitive text from the last reason/error fields.
type DiagnosticIMSRegistrationRecoveryState struct {
	Attempts            int
	ConsecutiveFailures int
	LastReason          string
	LastError           string
	LastAttemptAt       time.Time
	LastSucceededAt     time.Time
	NextAttemptAt       time.Time
	LastSwitchedTarget  bool
	Redacted            bool
}

// DiagnosticIMSRegistrationResult is a redacted view of an IMS registration
// result for support surfaces. It deliberately omits Profile and Binding, which
// can contain IMS identities, Contact URIs, security material, and route state.
type DiagnosticIMSRegistrationResult struct {
	Registered          bool
	StatusCode          int
	Reason              string
	Server              string
	RegisteredAt        time.Time
	ExpiresAt           time.Time
	RefreshDelay        time.Duration
	NextRefreshAt       time.Time
	RecoveryState       DiagnosticIMSRegistrationRecoveryState
	VoiceTransportReady bool
	SMSTransportReady   bool
	USSDTransportReady  bool
	Redacted            bool
}

// SafeDiagnosticState returns a diagnostic view of state with sensitive text
// fields redacted. It does not mutate the input State.
func SafeDiagnosticState(state State) DiagnosticState {
	redactor := tracefixture.NewRedactor()
	return DiagnosticState{
		DeviceID:                 redactRuntimeDiagnosticString(redactor, state.DeviceID),
		Phase:                    state.Phase,
		DataplaneMode:            redactRuntimeDiagnosticString(redactor, state.DataplaneMode),
		SIMReady:                 state.SIMReady,
		AccessReady:              state.AccessReady,
		TunnelReady:              state.TunnelReady,
		IMSReady:                 state.IMSReady,
		SMSReady:                 state.SMSReady,
		RegStatus:                state.RegStatus,
		RegStatusText:            redactRuntimeDiagnosticString(redactor, state.RegStatusText),
		NetworkMode:              redactRuntimeDiagnosticString(redactor, state.NetworkMode),
		LastErrorClass:           redactRuntimeDiagnosticString(redactor, state.LastErrorClass),
		LastError:                redactRuntimeDiagnosticString(redactor, state.LastError),
		LastReason:               redactRuntimeDiagnosticString(redactor, state.LastReason),
		IMSRecoveryPending:       state.IMSRecoveryPending,
		IMSRecoveryRetryAfter:    state.IMSRecoveryRetryAfter,
		IMSRecoveryNextAttemptAt: state.IMSRecoveryNextAttemptAt,
		IMSRecoveryReason:        redactRuntimeDiagnosticString(redactor, state.IMSRecoveryReason),
		UpdatedAt:                state.UpdatedAt,
		Redacted:                 true,
	}
}

// SafeDiagnosticIMSRegistrationResult returns a diagnostic summary of IMS
// registration without exposing raw IMS profile, binding, or SIP route data.
func SafeDiagnosticIMSRegistrationResult(result IMSRegistrationResult) DiagnosticIMSRegistrationResult {
	redactor := tracefixture.NewRedactor()
	return DiagnosticIMSRegistrationResult{
		Registered:          result.Registered,
		StatusCode:          result.StatusCode,
		Reason:              redactRuntimeDiagnosticString(redactor, result.Reason),
		Server:              redactRuntimeDiagnosticString(redactor, result.Server),
		RegisteredAt:        result.RegisteredAt,
		ExpiresAt:           result.ExpiresAt,
		RefreshDelay:        result.RefreshDelay,
		NextRefreshAt:       result.NextRefreshAt,
		RecoveryState:       SafeDiagnosticIMSRegistrationRecoveryState(result.RecoveryState),
		VoiceTransportReady: result.VoiceTransport != nil,
		SMSTransportReady:   result.SMSTransport != nil,
		USSDTransportReady:  result.USSDTransport != nil,
		Redacted:            true,
	}
}

// SafeDiagnosticIMSRegistrationRecoveryState returns a diagnostic view of IMS
// registration recovery state with sensitive reason/error text redacted.
func SafeDiagnosticIMSRegistrationRecoveryState(state IMSRegistrationRecoveryState) DiagnosticIMSRegistrationRecoveryState {
	redactor := tracefixture.NewRedactor()
	return DiagnosticIMSRegistrationRecoveryState{
		Attempts:            state.Attempts,
		ConsecutiveFailures: state.ConsecutiveFailures,
		LastReason:          redactRuntimeDiagnosticString(redactor, state.LastReason),
		LastError:           redactRuntimeDiagnosticString(redactor, state.LastError),
		LastAttemptAt:       state.LastAttemptAt,
		LastSucceededAt:     state.LastSucceededAt,
		NextAttemptAt:       state.NextAttemptAt,
		LastSwitchedTarget:  state.LastSwitchedTarget,
		Redacted:            true,
	}
}

// SafeDiagnosticIMSRegisterResponseDecision returns a diagnostic view of an IMS
// REGISTER recovery decision with optional response reason text redacted.
func SafeDiagnosticIMSRegisterResponseDecision(decision IMSRegisterResponseDecision, reason string) DiagnosticIMSRegisterResponseDecision {
	redactor := tracefixture.NewRedactor()
	return DiagnosticIMSRegisterResponseDecision{
		StatusCode:      decision.StatusCode,
		Action:          redactRuntimeDiagnosticString(redactor, decision.Action),
		Recoverable:     decision.Recoverable,
		Retry:           decision.Retry,
		Reauthenticate:  decision.Reauthenticate,
		RefreshIdentity: decision.RefreshIdentity,
		RefreshSecurity: decision.RefreshSecurity,
		Backoff:         decision.Backoff,
		RetryAfter:      decision.RetryAfter,
		Reason:          redactRuntimeDiagnosticString(redactor, reason),
		Redacted:        true,
	}
}

// SafeDiagnosticString redacts subscriber identifiers, AKA/digest material,
// IPs, MACs, and local paths from free-form runtime diagnostic text.
func SafeDiagnosticString(value string) string {
	return redactRuntimeDiagnosticString(tracefixture.NewRedactor(), value)
}

// SafeDiagnosticError returns a redacted error string for logs, UI, and
// structured runtime status. It returns an empty string when err is nil.
func SafeDiagnosticError(err error) string {
	if err == nil {
		return ""
	}
	return SafeDiagnosticString(err.Error())
}

func redactRuntimeDiagnosticString(redactor *tracefixture.Redactor, value string) string {
	value = strings.TrimSpace(value)
	if value == "" {
		return ""
	}
	if redactor == nil {
		redactor = tracefixture.NewRedactor()
	}
	value = redactor.RedactString(value)
	return runtimeLocalPathRE.ReplaceAllString(value, "<redacted-local-path>")
}
