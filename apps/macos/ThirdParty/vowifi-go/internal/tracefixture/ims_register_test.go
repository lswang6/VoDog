package tracefixture

import (
	"errors"
	"os"
	"reflect"
	"strconv"
	"strings"
	"testing"
)

func TestClassifyIMSRegisterReplaySummarizesRedactedChallengeFlow(t *testing.T) {
	raw, err := os.ReadFile("testdata/register_401_redacted.transcript.json")
	if err != nil {
		t.Fatalf("read fixture: %v", err)
	}
	transcript, err := ParseTranscriptJSON(raw)
	if err != nil {
		t.Fatalf("ParseTranscriptJSON returned error: %v", err)
	}

	summary, err := ClassifyIMSRegisterReplay(transcript)
	if err != nil {
		t.Fatalf("ClassifyIMSRegisterReplay returned error: %v", err)
	}
	if summary.Name != "ims-register-401-redacted" || summary.EventCount != 4 || summary.WireBytes == 0 {
		t.Fatalf("unexpected summary shape: %+v", summary)
	}
	if summary.State != IMSRegisterReplayStateRegistered || !summary.Registered || !summary.Challenged || !summary.Authenticated || !summary.SecurityNegotiated {
		t.Fatalf("unexpected register state: %+v", summary)
	}
	if summary.CallID != "fixture-call" || summary.FinalStatusCode != 200 || summary.FinalReason != "OK" {
		t.Fatalf("unexpected final correlation/status: %+v", summary)
	}
	if !reflect.DeepEqual(summary.StatusCodes, []int{401, 200}) {
		t.Fatalf("StatusCodes = %#v, want [401 200]", summary.StatusCodes)
	}
	if !reflect.DeepEqual(summary.AssociatedURIs, []string{"<sip:redacted-user-1@ims.example.invalid>"}) {
		t.Fatalf("AssociatedURIs = %#v", summary.AssociatedURIs)
	}
	if !reflect.DeepEqual(summary.Contacts, []string{"<sip:redacted-user-1@ue.redacted.invalid:5060>"}) {
		t.Fatalf("Contacts = %#v", summary.Contacts)
	}
	if len(summary.Transactions) != 2 {
		t.Fatalf("transaction count = %d, want 2: %+v", len(summary.Transactions), summary.Transactions)
	}
	first := summary.Transactions[0]
	if first.RequestIndex != 0 || first.ResponseIndex != 1 || first.CSeq != 1 || first.StatusCode != 401 || !first.Challenge {
		t.Fatalf("unexpected first transaction: %+v", first)
	}
	if first.RequestLabel != "initial-register" || first.ResponseLabel != "register-challenge" || !first.HasContact || !first.HasWWWAuthenticate || !first.HasSecurityServer {
		t.Fatalf("unexpected challenge transaction metadata: %+v", first)
	}
	second := summary.Transactions[1]
	if second.RequestIndex != 2 || second.ResponseIndex != 3 || second.CSeq != 2 || second.StatusCode != 200 {
		t.Fatalf("unexpected second transaction: %+v", second)
	}
	if !second.HasContact || !second.HasAuthorization || !second.HasSecurityVerify || second.Challenge {
		t.Fatalf("unexpected authenticated transaction metadata: %+v", second)
	}
}

func TestClassifyIMSRegisterReplayCapturesRequestAccessNetworkInfo(t *testing.T) {
	pani := "P-Access-Network-Info: 3GPP-E-UTRAN-FDD;utran-cell-id-3gpp=<redacted-pani-1>;ue-ip=<redacted-ipv6-1>"
	transcript := registerReplayTranscript(t, []TranscriptEvent{
		registerRequestEvent("initial-register", 1, pani),
		registerStatusEvent("register-ok", 1, 200, "OK", nil),
	})

	summary, err := ClassifyIMSRegisterReplay(transcript)
	if err != nil {
		t.Fatalf("ClassifyIMSRegisterReplay returned error: %v", err)
	}
	if !reflect.DeepEqual(summary.AccessNetworkInfo, []string{"3GPP-E-UTRAN-FDD;utran-cell-id-3gpp=<redacted-pani-1>;ue-ip=<redacted-ipv6-1>"}) {
		t.Fatalf("AccessNetworkInfo = %#v", summary.AccessNetworkInfo)
	}
	if len(summary.Transactions) != 1 {
		t.Fatalf("transaction count = %d, want 1", len(summary.Transactions))
	}
	tx := summary.Transactions[0]
	if !tx.HasContact || !tx.HasPAccessNetworkInfo || tx.StatusCode != 200 {
		t.Fatalf("unexpected transaction access-network metadata: %+v", tx)
	}
}

func TestClassifyIMSRegisterReplayAppliesBounds(t *testing.T) {
	transcript := registerReplayTranscript(t, []TranscriptEvent{
		registerRequestEvent("initial-register", 1, ""),
		registerStatusEvent("register-ok", 1, 200, "OK", nil),
	})

	tests := []struct {
		name   string
		bounds IMSRegisterReplayBounds
	}{
		{
			name:   "event limit",
			bounds: IMSRegisterReplayBounds{MaxEvents: 1},
		},
		{
			name:   "wire limit",
			bounds: IMSRegisterReplayBounds{MaxWireBytes: len(transcript.Events[0].Wire) - 1},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			_, err := ClassifyIMSRegisterReplayBounded(transcript, tt.bounds)
			if !errors.Is(err, ErrInvalidIMSRegisterReplay) {
				t.Fatalf("ClassifyIMSRegisterReplayBounded error = %v, want ErrInvalidIMSRegisterReplay", err)
			}
		})
	}
}

func TestClassifyIMSRegisterReplayRejectsMismatchedTransactions(t *testing.T) {
	tests := []struct {
		name   string
		events []TranscriptEvent
	}{
		{
			name: "odd event count",
			events: []TranscriptEvent{
				registerRequestEvent("initial-register", 1, ""),
			},
		},
		{
			name: "response direction first",
			events: []TranscriptEvent{
				registerStatusEvent("register-ok", 1, 200, "OK", nil),
				registerRequestEvent("initial-register", 1, ""),
			},
		},
		{
			name: "response cseq mismatch",
			events: []TranscriptEvent{
				registerRequestEvent("initial-register", 1, ""),
				registerStatusEvent("register-ok", 2, 200, "OK", nil),
			},
		},
		{
			name: "call id mismatch",
			events: []TranscriptEvent{
				registerRequestEvent("initial-register", 1, ""),
				registerStatusEvent("register-ok", 1, 200, "OK", map[string]string{"Call-ID": "other-call"}),
			},
		},
		{
			name: "non register request",
			events: []TranscriptEvent{
				{
					Label:     "message",
					Direction: "outbound",
					Transport: "udp",
					Wire: strings.Join([]string{
						"MESSAGE sip:ims.example.invalid SIP/2.0",
						"Call-ID: fixture-call",
						"CSeq: 1 MESSAGE",
						"Content-Length: 0",
						"",
						"",
					}, "\r\n"),
				},
				registerStatusEvent("register-ok", 1, 200, "OK", nil),
			},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			transcript := registerReplayTranscript(t, tt.events)
			_, err := ClassifyIMSRegisterReplay(transcript)
			if !errors.Is(err, ErrInvalidIMSRegisterReplay) {
				t.Fatalf("ClassifyIMSRegisterReplay error = %v, want ErrInvalidIMSRegisterReplay", err)
			}
		})
	}
}

func TestClassifyIMSRegisterReplayStates(t *testing.T) {
	tests := []struct {
		name   string
		status int
		reason string
		want   IMSRegisterReplayState
	}{
		{name: "challenge", status: 401, reason: "Unauthorized", want: IMSRegisterReplayStateChallenged},
		{name: "rejected", status: 403, reason: "Forbidden", want: IMSRegisterReplayStateRejected},
		{name: "incomplete", status: 100, reason: "Trying", want: IMSRegisterReplayStateIncomplete},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			transcript := registerReplayTranscript(t, []TranscriptEvent{
				registerRequestEvent("initial-register", 1, ""),
				registerStatusEvent("register-status", 1, tt.status, tt.reason, nil),
			})
			summary, err := ClassifyIMSRegisterReplay(transcript)
			if err != nil {
				t.Fatalf("ClassifyIMSRegisterReplay returned error: %v", err)
			}
			if summary.State != tt.want || summary.Registered != (tt.want == IMSRegisterReplayStateRegistered) {
				t.Fatalf("state=%q registered=%v, want state %q", summary.State, summary.Registered, tt.want)
			}
		})
	}
}

func registerReplayTranscript(t *testing.T, events []TranscriptEvent) Transcript {
	t.Helper()
	transcript := Transcript{
		Schema: TranscriptSchemaVersion,
		Name:   "ims-register-test-redacted",
		Events: events,
	}
	if err := ValidateTranscript(transcript); err != nil {
		t.Fatalf("test transcript failed validation: %v", err)
	}
	return transcript
}

func registerRequestEvent(label string, cseq int, extraHeader string) TranscriptEvent {
	lines := []string{
		"REGISTER sip:ims.example.invalid SIP/2.0",
		"Via: SIP/2.0/UDP ue.redacted.invalid:5060;branch=z9hG4bKfixture",
		"From: <sip:redacted-user-1@ims.example.invalid>;tag=fixture",
		"To: <sip:redacted-user-1@ims.example.invalid>",
		"Call-ID: fixture-call",
		"CSeq: " + intString(cseq) + " REGISTER",
		"Contact: <sip:redacted-user-1@ue.redacted.invalid:5060>",
	}
	if extraHeader != "" {
		lines = append(lines, extraHeader)
	}
	lines = append(lines, "Content-Length: 0", "", "")
	return TranscriptEvent{
		Label:     label,
		Direction: "outbound",
		Transport: "udp",
		Wire:      strings.Join(lines, "\r\n"),
	}
}

func registerStatusEvent(label string, cseq int, status int, reason string, overrides map[string]string) TranscriptEvent {
	callID := "fixture-call"
	if overrides != nil && overrides["Call-ID"] != "" {
		callID = overrides["Call-ID"]
	}
	lines := []string{
		"SIP/2.0 " + intString(status) + " " + reason,
		"Via: SIP/2.0/UDP ue.redacted.invalid:5060;branch=z9hG4bKfixture",
		"From: <sip:redacted-user-1@ims.example.invalid>;tag=fixture",
		"To: <sip:redacted-user-1@ims.example.invalid>;tag=fixture2",
		"Call-ID: " + callID,
		"CSeq: " + intString(cseq) + " REGISTER",
	}
	if status == 401 {
		lines = append(lines, "WWW-Authenticate: <redacted>", "Security-Server: <redacted>")
	}
	if status >= 200 && status < 300 {
		lines = append(lines, "P-Associated-URI: <sip:redacted-user-1@ims.example.invalid>")
	}
	lines = append(lines, "Content-Length: 0", "", "")
	return TranscriptEvent{
		Label:     label,
		Direction: "inbound",
		Transport: "udp",
		Wire:      strings.Join(lines, "\r\n"),
	}
}

func intString(value int) string {
	return strconv.Itoa(value)
}
