package runtimehost

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/boa-z/vowifi-go/runtimehost/eventhost"
	"github.com/boa-z/vowifi-go/runtimehost/voiceclient"
)

func TestSafeDiagnosticStateRedactsSensitiveRuntimeText(t *testing.T) {
	next := time.Now().Add(time.Minute)
	unixPath := "/" + "home" + "/" + "boa" + "/vohive/config/config.yaml"
	macPath := "/" + "Users" + "/" + "boa" + "/trace.txt"
	state := State{
		DeviceID:                 "wwan0-imei-490154203237518",
		Phase:                    PhaseReady,
		DataplaneMode:            "tun",
		SIMReady:                 true,
		AccessReady:              true,
		TunnelReady:              true,
		IMSReady:                 true,
		SMSReady:                 true,
		RegStatus:                1,
		RegStatusText:            "registered IMSI 310280000000001 from 192.0.2.34",
		NetworkMode:              "LTE ue-ip=192.0.2.34",
		LastErrorClass:           "ims",
		LastError:                `Authorization: Digest nonce="nonce-secret", response="0123456789abcdef0123456789abcdef"; ck=0123456789abcdef0123456789abcdef; path=` + unixPath,
		LastReason:               "mobike 192.0.2.34 -> 87.194.9.8 for sip:310280000000001@ims.example using " + unixPath,
		IMSRecoveryPending:       true,
		IMSRecoveryRetryAfter:    3 * time.Second,
		IMSRecoveryNextAttemptAt: next,
		IMSRecoveryReason:        "retry trace " + macPath + "; Proxy-Authenticate: Digest nonce=\"recover-secret\"",
		UpdatedAt:                next.Add(-time.Second),
	}

	got := SafeDiagnosticState(state)
	if !got.Redacted || got.Phase != PhaseReady || !got.SIMReady || !got.TunnelReady ||
		got.IMSRecoveryRetryAfter != 3*time.Second || !got.IMSRecoveryNextAttemptAt.Equal(next) {
		t.Fatalf("diagnostic state lost operational fields: %+v", got)
	}
	assertNoRuntimeDiagnosticLeak(t, fmt.Sprintf("%+v", got), unixPath, macPath)
	for _, want := range []string{"<redacted", ".invalid", "<redacted-local-path>"} {
		if !strings.Contains(fmt.Sprintf("%+v", got), want) {
			t.Fatalf("diagnostic state does not contain redaction marker %q: %+v", want, got)
		}
	}
	if state.LastError == got.LastError || state.LastReason == got.LastReason || state.DeviceID == got.DeviceID {
		t.Fatalf("sensitive fields were not redacted: state=%+v diagnostic=%+v", state, got)
	}
}

func TestRuntimeSnapshotAndObsUseDiagnosticState(t *testing.T) {
	dispatch := &runtimeDispatcher{}
	inst := &Instance{
		state: State{
			DeviceID:          "dev-imsi-310280000000001",
			Phase:             PhaseReady,
			IMSReady:          true,
			SMSReady:          true,
			LastReason:        "registration from 192.0.2.34",
			IMSRecoveryReason: `WWW-Authenticate: Digest nonce="recover-secret"`,
			UpdatedAt:         time.Now(),
		},
		dispatch: dispatch,
	}

	diag := inst.DiagnosticState()
	assertNoRuntimeDiagnosticLeak(t, fmt.Sprintf("%+v", diag))

	obs := inst.Obs()
	if obs["redacted"] != true {
		t.Fatalf("Obs redacted flag=%v, want true", obs["redacted"])
	}
	assertNoRuntimeDiagnosticLeak(t, fmt.Sprintf("%+v", obs))

	inst.dispatchRuntimeState(context.Background())
	if len(dispatch.events) != 1 {
		t.Fatalf("events=%d, want one runtime snapshot", len(dispatch.events))
	}
	snapshot, ok := dispatch.events[0].(eventhost.RuntimeStateSnapshot)
	if !ok {
		t.Fatalf("event type=%T, want RuntimeStateSnapshot", dispatch.events[0])
	}
	assertNoRuntimeDiagnosticLeak(t, fmt.Sprintf("%+v", snapshot))
	if snapshot.Phase != eventhost.RuntimePhaseReady || !snapshot.IMSReady || !snapshot.SMSReady {
		t.Fatalf("snapshot lost operational fields: %+v", snapshot)
	}
}

func TestSafeDiagnosticIMSRegisterResponseDecisionRedactsReason(t *testing.T) {
	reason := `403 Forbidden for sip:310280000000001@ims.example from 192.0.2.34; WWW-Authenticate: Digest nonce="recover-secret"; path=/` + "home" + `/boa/vohive/ims.log`
	decision := ClassifyIMSRegisterResponse(503, 7*time.Second)

	got := SafeDiagnosticIMSRegisterResponseDecision(decision, reason)
	if !got.Redacted || got.StatusCode != 503 || got.Action != IMSRegisterResponseActionBackoffRetry ||
		!got.Recoverable || !got.Retry || !got.Backoff || got.RetryAfter != 7*time.Second {
		t.Fatalf("diagnostic decision lost recovery fields: %+v", got)
	}
	assertNoRuntimeDiagnosticLeak(t, fmt.Sprintf("%+v", got), "/"+filepathJoinForDiagnosticTest("home", "boa", "vohive", "ims.log"))
	for _, want := range []string{"<redacted", ".invalid", "<redacted-local-path>"} {
		if !strings.Contains(fmt.Sprintf("%+v", got), want) {
			t.Fatalf("diagnostic decision does not contain redaction marker %q: %+v", want, got)
		}
	}
}

func TestSafeDiagnosticIMSRegistrationRecoveryStateRedactsReasonAndError(t *testing.T) {
	now := time.Now()
	localPath := "/" + filepathJoinForDiagnosticTest("home", "boa", "vohive", "ims-recovery.log")
	state := IMSRegistrationRecoveryState{
		Attempts:            3,
		ConsecutiveFailures: 2,
		LastReason:          "refresh 503 for sip:310280000000001@ims.example from 192.0.2.34 via " + localPath,
		LastError:           `REGISTER retry failed: Digest nonce="recover-secret", response="0123456789abcdef0123456789abcdef"; pcscf=87.194.9.8`,
		LastAttemptAt:       now.Add(-2 * time.Second),
		LastSucceededAt:     now.Add(-time.Minute),
		NextAttemptAt:       now.Add(5 * time.Second),
		LastSwitchedTarget:  true,
	}

	got := SafeDiagnosticIMSRegistrationRecoveryState(state)
	if !got.Redacted || got.Attempts != 3 || got.ConsecutiveFailures != 2 ||
		!got.LastAttemptAt.Equal(state.LastAttemptAt) ||
		!got.LastSucceededAt.Equal(state.LastSucceededAt) ||
		!got.NextAttemptAt.Equal(state.NextAttemptAt) ||
		!got.LastSwitchedTarget {
		t.Fatalf("diagnostic recovery state lost operational fields: %+v", got)
	}
	assertNoRuntimeDiagnosticLeak(t, fmt.Sprintf("%+v", got), localPath)
	for _, want := range []string{"<redacted", ".invalid", "<redacted-local-path>"} {
		if !strings.Contains(fmt.Sprintf("%+v", got), want) {
			t.Fatalf("diagnostic recovery state does not contain marker %q: %+v", want, got)
		}
	}
	if state.LastReason == got.LastReason || state.LastError == got.LastError {
		t.Fatalf("recovery reason/error were not redacted: state=%+v diagnostic=%+v", state, got)
	}
}

func TestSafeDiagnosticIMSRegistrationResultOmitsSensitiveProfileAndBinding(t *testing.T) {
	now := time.Now()
	localPath := "/" + filepathJoinForDiagnosticTest("home", "boa", "vohive", "ims-result.log")
	result := IMSRegistrationResult{
		Registered:    true,
		StatusCode:    200,
		Reason:        "registered sip:310280000000001@ims.example from 192.0.2.34 using " + localPath,
		Server:        "sip:310280000000001@ims.example via 87.194.9.8",
		RegisteredAt:  now.Add(-time.Minute),
		ExpiresAt:     now.Add(time.Hour),
		RefreshDelay:  30 * time.Minute,
		NextRefreshAt: now.Add(30 * time.Minute),
		Profile: voiceclient.IMSProfile{
			IMPI:              "310280000000001@ims.example",
			IMPU:              "sip:310280000000001@ims.example",
			Domain:            "ims.example",
			LocalIP:           "192.0.2.34",
			AccessNetworkInfo: `IEEE-802.11;i-wlan-node-id="00:11:22:33:44:55"`,
		},
		Binding: voiceclient.RegistrationBinding{
			ContactURI:     "sip:310280000000001@192.0.2.34:5060",
			PublicIdentity: "sip:310280000000001@ims.example",
			AuthHeader:     `Authorization: Digest nonce="recover-secret", response="0123456789abcdef0123456789abcdef"`,
			ServiceRoutes:  []string{"<sip:pcscf.ims.example;lr>"},
		},
		RecoveryState: IMSRegistrationRecoveryState{
			Attempts:   1,
			LastReason: "refresh sip:310280000000001@ims.example",
			LastError:  `Digest nonce="recover-secret" from 87.194.9.8`,
		},
	}

	got := SafeDiagnosticIMSRegistrationResult(result)
	if !got.Redacted || !got.Registered || got.StatusCode != 200 ||
		!got.RegisteredAt.Equal(result.RegisteredAt) ||
		!got.ExpiresAt.Equal(result.ExpiresAt) ||
		got.RefreshDelay != result.RefreshDelay ||
		!got.NextRefreshAt.Equal(result.NextRefreshAt) ||
		got.RecoveryState.Attempts != 1 || !got.RecoveryState.Redacted {
		t.Fatalf("diagnostic registration result lost operational fields: %+v", got)
	}
	assertNoRuntimeDiagnosticLeak(t, fmt.Sprintf("%+v", got), localPath, "00:11:22:33:44:55")
	for _, leak := range []string{"ContactURI", "PublicIdentity", "AuthHeader", "ServiceRoutes", "IMPI", "IMPU"} {
		if strings.Contains(fmt.Sprintf("%+v", got), leak) {
			t.Fatalf("diagnostic registration result exposed raw field name %q: %+v", leak, got)
		}
	}
	for _, want := range []string{"<redacted", ".invalid", "<redacted-local-path>"} {
		if !strings.Contains(fmt.Sprintf("%+v", got), want) {
			t.Fatalf("diagnostic registration result does not contain marker %q: %+v", want, got)
		}
	}
}

func TestSafeDiagnosticStringAndErrorRedactFreeFormRuntimeText(t *testing.T) {
	localPath := "/" + filepathJoinForDiagnosticTest("home", "boa", "vohive", "runtime.log")
	text := `SWU tunnel establishment failed: read udp 192.0.2.34:44789->87.194.9.8:4500: i/o timeout; ` +
		`sip:310280000000001@ims.example; Authorization: Digest nonce="nonce-secret", response="0123456789abcdef0123456789abcdef"; path=` + localPath

	gotText := SafeDiagnosticString(text)
	gotErr := SafeDiagnosticError(errors.New(text))
	if gotText == "" || gotErr == "" || gotText != gotErr {
		t.Fatalf("SafeDiagnosticString=%q SafeDiagnosticError=%q, want matching non-empty redacted text", gotText, gotErr)
	}
	assertNoRuntimeDiagnosticLeak(t, gotText, localPath)
	for _, want := range []string{"<redacted", ".invalid", "<redacted-local-path>"} {
		if !strings.Contains(gotText, want) {
			t.Fatalf("redacted free-form text does not contain marker %q: %q", want, gotText)
		}
	}
	if got := SafeDiagnosticString(" \t\n "); got != "" {
		t.Fatalf("blank diagnostic string=%q, want empty", got)
	}
	if got := SafeDiagnosticError(nil); got != "" {
		t.Fatalf("nil diagnostic error=%q, want empty", got)
	}
}

func assertNoRuntimeDiagnosticLeak(t *testing.T, value string, extraLeaks ...string) {
	t.Helper()
	leaks := []string{
		"490154203237518",
		"310280000000001",
		"192.0.2.34",
		"87.194.9.8",
		"nonce-secret",
		"recover-secret",
		"0123456789abcdef0123456789abcdef",
	}
	leaks = append(leaks, extraLeaks...)
	for _, leak := range leaks {
		if strings.Contains(value, leak) {
			t.Fatalf("diagnostic output leaked %q in %q", leak, value)
		}
	}
}

func filepathJoinForDiagnosticTest(parts ...string) string {
	return strings.Join(parts, "/")
}
