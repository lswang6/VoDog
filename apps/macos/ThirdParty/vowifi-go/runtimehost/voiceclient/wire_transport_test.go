package voiceclient

import (
	"bufio"
	"context"
	"crypto/rand"
	"crypto/rsa"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/base64"
	"errors"
	"math/big"
	"net"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"
)

func TestParseSIPResponseWithFoldedAndCompactHeaders(t *testing.T) {
	raw := strings.Join([]string{
		"SIP/2.0 200 OK",
		"P-Associated-URI: <sip:user@example>,",
		" <tel:+18005551212>",
		"k: path, sec-agree",
		"a: *;+g.3gpp.smsip",
		"e: gzip",
		"l: 5",
		"",
		"hello ignored",
	}, "\r\n")
	resp, err := ParseSIPResponse([]byte(raw))
	if err != nil {
		t.Fatalf("ParseSIPResponse() error = %v", err)
	}
	if resp.StatusCode != 200 || resp.Reason != "OK" || string(resp.Body) != "hello" {
		t.Fatalf("response=%+v body=%q", resp, resp.Body)
	}
	if got := resp.Headers["Supported"]; len(got) != 1 || got[0] != "path, sec-agree" {
		t.Fatalf("Supported=%+v", got)
	}
	if got := resp.Headers["Accept-Contact"]; len(got) != 1 || got[0] != "*;+g.3gpp.smsip" {
		t.Fatalf("Accept-Contact=%+v", got)
	}
	if got := resp.Headers["Content-Encoding"]; len(got) != 1 || got[0] != "gzip" {
		t.Fatalf("Content-Encoding=%+v", got)
	}
	binding := BuildRegistrationBinding(IMSProfile{}, "sip:user@192.0.2.10:5060", resp, 3600)
	if len(binding.AssociatedURIs) != 2 || binding.AssociatedURIs[0] != "sip:user@example" || binding.AssociatedURIs[1] != "tel:+18005551212" {
		t.Fatalf("binding=%+v", binding)
	}
}

func TestSIPRetryAfterDelayParsesDeltaSeconds(t *testing.T) {
	resp, err := ParseSIPResponse([]byte(strings.Join([]string{
		"SIP/2.0 503 Service Unavailable",
		"Retry-After: 2 (maintenance);duration=60",
		"Retry-After: 5",
		"Content-Length: 0",
		"",
		"",
	}, "\r\n")))
	if err != nil {
		t.Fatalf("ParseSIPResponse() error = %v", err)
	}
	if resp.RetryAfter != 5*time.Second || SIPResponseRetryAfter(resp) != 5*time.Second {
		t.Fatalf("RetryAfter=%v helper=%v, want 5s", resp.RetryAfter, SIPResponseRetryAfter(resp))
	}
	if got := SIPRetryAfterDelay(map[string][]string{"Retry-After": {"invalid", "3;duration=10"}}); got != 3*time.Second {
		t.Fatalf("SIPRetryAfterDelay()=%v, want 3s", got)
	}
}

func TestSIPRetryAfterDelayParsesHTTPDate(t *testing.T) {
	now := time.Date(2026, 7, 6, 12, 0, 0, 0, time.UTC)
	tests := []struct {
		value string
		want  time.Duration
	}{
		{now.Add(90 * time.Second).Format(time.RFC1123), 90 * time.Second},
		{now.Add(2 * time.Minute).Format(time.RFC1123Z), 2 * time.Minute},
		{now.Add(3 * time.Minute).Format(time.RFC850), 3 * time.Minute},
		{now.Add(4*time.Minute).Format(time.ANSIC) + ";duration=30", 4 * time.Minute},
		{now.Add(-time.Minute).Format(time.RFC1123), 0},
	}
	for _, tc := range tests {
		got, ok := parseSIPRetryAfterValueAt(tc.value, now)
		if !ok || got != tc.want {
			t.Fatalf("parseSIPRetryAfterValueAt(%q)=%v,%v want %v,true", tc.value, got, ok, tc.want)
		}
	}
	future := time.Now().UTC().Add(30 * time.Second)
	if got := SIPRetryAfterDelay(map[string][]string{
		"Retry-After": {future.Format(time.RFC1123)},
	}); got < 0 || got > 31*time.Second {
		t.Fatalf("SIPRetryAfterDelay(date)=%v, want about <=31s", got)
	}
}

func TestParseSIPResponseRejectsInvalidStatusCode(t *testing.T) {
	for _, status := range []string{"99", "700", "0200", "2xx"} {
		_, err := ParseSIPResponse([]byte(strings.Join([]string{
			"SIP/2.0 " + status + " Invalid",
			"Content-Length: 0",
			"",
			"",
		}, "\r\n")))
		if !errors.Is(err, ErrInvalidSIPMessage) {
			t.Fatalf("ParseSIPResponse(%s) error=%v, want ErrInvalidSIPMessage", status, err)
		}
	}
}

func TestSIPFailureRecoveryClassifiesRecoverableFailures(t *testing.T) {
	tests := []struct {
		name string
		got  sipFailureRecovery
		want bool
	}{
		{
			name: "register request timeout",
			got:  sipResponseFailureRecovery(sipRecoveryRegister, 408),
			want: true,
		},
		{
			name: "dialog service unavailable",
			got:  sipResponseFailureRecovery(sipRecoveryDialog, 503),
			want: true,
		},
		{
			name: "dialog temporarily unavailable stays terminal",
			got:  sipResponseFailureRecovery(sipRecoveryDialog, 480),
			want: false,
		},
		{
			name: "connection reset",
			got:  sipTransportFailureRecovery(&net.OpError{Op: "read", Net: "tcp", Err: syscall.ECONNRESET}),
			want: true,
		},
		{
			name: "caller canceled",
			got:  sipTransportFailureRecovery(context.Canceled),
			want: false,
		},
	}
	for _, tc := range tests {
		if tc.got.Recoverable != tc.want || tc.got.TargetFailover != tc.want {
			t.Fatalf("%s recovery=%+v, want recoverable/failover=%t", tc.name, tc.got, tc.want)
		}
	}
}

type sipTestTimeoutError struct{}

func (sipTestTimeoutError) Error() string   { return "timeout" }
func (sipTestTimeoutError) Timeout() bool   { return true }
func (sipTestTimeoutError) Temporary() bool { return true }

func TestSIPTransactionFailureForClassifiesTimeoutsAndRetryAfter(t *testing.T) {
	tests := []struct {
		name                     string
		method                   string
		resp                     SIPResponse
		err                      error
		wantMethod               string
		wantTransaction          sipTransactionKind
		wantStatus               int
		wantTimedOut             bool
		wantFinalResponseTimeout bool
		wantRetryAfter           time.Duration
		wantRetryAfterPresent    bool
	}{
		{
			name:            "non invite transport timeout",
			method:          "MESSAGE",
			err:             sipTestTimeoutError{},
			wantMethod:      "MESSAGE",
			wantTransaction: sipTransactionNonInvite,
			wantTimedOut:    true,
		},
		{
			name:                     "invite final response timeout",
			method:                   " invite ",
			err:                      sipFinalResponseTimeoutError{Method: "INVITE", Err: sipTestTimeoutError{}},
			wantMethod:               "INVITE",
			wantTransaction:          sipTransactionInvite,
			wantTimedOut:             true,
			wantFinalResponseTimeout: true,
		},
		{
			name:                  "non invite 408 retry after zero",
			method:                "OPTIONS",
			resp:                  SIPResponse{StatusCode: 408, Headers: map[string][]string{"Retry-After": {"0"}}},
			wantMethod:            "OPTIONS",
			wantStatus:            408,
			wantTimedOut:          true,
			wantRetryAfterPresent: true,
		},
		{
			name:                  "invite 503 retry after",
			method:                "INVITE",
			resp:                  SIPResponse{StatusCode: 503, Headers: map[string][]string{"Retry-After": {"7"}}},
			wantMethod:            "INVITE",
			wantTransaction:       sipTransactionInvite,
			wantStatus:            503,
			wantRetryAfter:        7 * time.Second,
			wantRetryAfterPresent: true,
		},
		{
			name:            "503 invalid retry after",
			method:          "MESSAGE",
			resp:            SIPResponse{StatusCode: 503, Headers: map[string][]string{"Retry-After": {"later"}}},
			wantMethod:      "MESSAGE",
			wantTransaction: sipTransactionNonInvite,
			wantStatus:      503,
		},
	}
	for _, tc := range tests {
		got := sipTransactionFailureFor(tc.method, tc.resp, tc.err)
		if got.Method != tc.wantMethod || got.Transaction != tc.wantTransaction ||
			got.StatusCode != tc.wantStatus || got.TimedOut != tc.wantTimedOut ||
			got.FinalResponseTimeout != tc.wantFinalResponseTimeout ||
			got.RetryAfter != tc.wantRetryAfter || got.RetryAfterPresent != tc.wantRetryAfterPresent {
			t.Fatalf("%s classification=%+v", tc.name, got)
		}
	}
}

func TestSIPResponseRecoveryPlanClassifiesIMSRecovery(t *testing.T) {
	tests := []struct {
		name          string
		method        string
		resp          SIPResponse
		want          SIPRecoveryPlan
		wantRetry     time.Duration
		wantRetrySeen bool
	}{
		{
			name:   "register service unavailable fails over with retry after",
			method: "REGISTER",
			resp: SIPResponse{
				StatusCode: 503,
				Headers:    map[string][]string{"Retry-After": {"11"}},
			},
			want: SIPRecoveryPlan{
				Method:         "REGISTER",
				StatusCode:     503,
				Recoverable:    true,
				TargetFailover: true,
			},
			wantRetry:     11 * time.Second,
			wantRetrySeen: true,
		},
		{
			name:   "dialog service unavailable requires registration recovery",
			method: "MESSAGE",
			resp:   SIPResponse{StatusCode: 503, RetryAfter: 7 * time.Second},
			want: SIPRecoveryPlan{
				Method:               "MESSAGE",
				StatusCode:           503,
				Recoverable:          true,
				TargetFailover:       true,
				RegistrationRequired: true,
			},
			wantRetry:     7 * time.Second,
			wantRetrySeen: true,
		},
		{
			name:   "register authentication challenge refreshes credentials",
			method: "REGISTER",
			resp:   SIPResponse{StatusCode: 401},
			want: SIPRecoveryPlan{
				Method:                "REGISTER",
				StatusCode:            401,
				AuthenticationRefresh: true,
			},
		},
		{
			name:   "register interval too brief refreshes registration",
			method: "REGISTER",
			resp:   SIPResponse{StatusCode: 423},
			want: SIPRecoveryPlan{
				Method:              "REGISTER",
				StatusCode:          423,
				RegistrationRefresh: true,
			},
		},
		{
			name:   "dialog temporarily unavailable is terminal",
			method: "INVITE",
			resp:   SIPResponse{StatusCode: 480},
			want: SIPRecoveryPlan{
				Method:               "INVITE",
				StatusCode:           480,
				RegistrationRequired: true,
			},
		},
	}
	for _, tc := range tests {
		got := SIPResponseRecoveryPlan(tc.method, tc.resp)
		if got.Method != tc.want.Method || got.StatusCode != tc.want.StatusCode ||
			got.Recoverable != tc.want.Recoverable || got.TargetFailover != tc.want.TargetFailover ||
			got.RegistrationRefresh != tc.want.RegistrationRefresh ||
			got.RegistrationRequired != tc.want.RegistrationRequired ||
			got.AuthenticationRefresh != tc.want.AuthenticationRefresh ||
			got.RetryAfter != tc.wantRetry || got.RetryAfterPresent != tc.wantRetrySeen {
			t.Fatalf("%s plan=%+v", tc.name, got)
		}
	}
}

func TestSIPTransportRecoveryPlanClassifiesTransportFailures(t *testing.T) {
	got := SIPTransportRecoveryPlan("MESSAGE", sipTestTimeoutError{})
	if got.Method != "MESSAGE" || !got.TransportFailure || !got.TimedOut ||
		!got.Recoverable || !got.TargetFailover || !got.RegistrationRequired {
		t.Fatalf("timeout recovery plan=%+v", got)
	}
	got = SIPTransportRecoveryPlan("REGISTER", context.Canceled)
	if got.Method != "REGISTER" || !got.TransportFailure || got.Recoverable ||
		got.TargetFailover || got.RegistrationRequired {
		t.Fatalf("canceled recovery plan=%+v", got)
	}
}

func TestSIPTransactionTimerPolicyDefaults(t *testing.T) {
	invite := DefaultSIPTransactionTimerPolicy(" invite ")
	if !invite.Invite || invite.Method != "INVITE" ||
		invite.T1 != 500*time.Millisecond || invite.T2 != 4*time.Second || invite.T4 != 5*time.Second ||
		invite.TimerA != 500*time.Millisecond || invite.TimerB != 32*time.Second ||
		invite.TimerD != 32*time.Second || invite.TimerG != 500*time.Millisecond ||
		invite.TimerH != 32*time.Second || invite.TimerI != 5*time.Second ||
		invite.TimerE != 0 || invite.TimerF != 0 || invite.TimerJ != 0 || invite.TimerK != 0 {
		t.Fatalf("INVITE policy=%+v", invite)
	}

	message := DefaultSIPTransactionTimerPolicy("MESSAGE")
	if message.Invite || message.Method != "MESSAGE" ||
		message.TimerA != 0 || message.TimerB != 0 ||
		message.TimerD != 0 || message.TimerG != 0 || message.TimerH != 0 || message.TimerI != 0 ||
		message.TimerE != 500*time.Millisecond || message.TimerF != 32*time.Second ||
		message.TimerJ != 32*time.Second || message.TimerK != 5*time.Second {
		t.Fatalf("MESSAGE policy=%+v", message)
	}
}

func TestSIPTransactionRetryScheduleForInviteAndNonInvite(t *testing.T) {
	cfg := SIPTransactionTimerConfig{
		T1: 100 * time.Millisecond,
		T2: 400 * time.Millisecond,
		T4: 900 * time.Millisecond,
	}
	invite := SIPTransactionRetryScheduleFor("INVITE", cfg)
	if !invite.Invite || invite.Timeout != 6400*time.Millisecond || invite.CleanupWait != 0 {
		t.Fatalf("INVITE schedule=%+v", invite)
	}
	if len(invite.Intervals) < 5 ||
		invite.Intervals[0] != 100*time.Millisecond ||
		invite.Intervals[1] != 200*time.Millisecond ||
		invite.Intervals[2] != 400*time.Millisecond ||
		invite.Intervals[len(invite.Intervals)-1] != 400*time.Millisecond {
		t.Fatalf("INVITE intervals=%v", invite.Intervals)
	}
	var inviteElapsed time.Duration
	for _, interval := range invite.Intervals {
		inviteElapsed += interval
		if inviteElapsed >= invite.Timeout {
			t.Fatalf("INVITE interval %v reaches timeout %v", invite.Intervals, invite.Timeout)
		}
	}

	message := SIPTransactionRetryScheduleFor("MESSAGE", cfg)
	if message.Invite || message.Timeout != 6400*time.Millisecond || message.CleanupWait != 900*time.Millisecond {
		t.Fatalf("MESSAGE schedule=%+v", message)
	}
	if len(message.Intervals) != len(invite.Intervals) || message.Intervals[0] != invite.Intervals[0] {
		t.Fatalf("MESSAGE intervals=%v INVITE intervals=%v", message.Intervals, invite.Intervals)
	}
}

func TestSIPFinalResponseDrainDurationSkipsInvite(t *testing.T) {
	if got := sipFinalResponseDrainDuration("INVITE", time.Second); got != 0 {
		t.Fatalf("sipFinalResponseDrainDuration(INVITE)=%v, want 0", got)
	}
	if got := sipFinalResponseDrainDuration("MESSAGE", 25*time.Millisecond); got != 25*time.Millisecond {
		t.Fatalf("sipFinalResponseDrainDuration(MESSAGE)=%v", got)
	}
}

func TestDrainSIPUDPFinalResponsesConsumesMatchedDuplicateFinal(t *testing.T) {
	client, server := net.Pipe()
	defer client.Close()
	defer server.Close()

	msg := SIPRequestMessage{
		Method: "MESSAGE",
		Headers: map[string]string{
			"Via":     "SIP/2.0/UDP 127.0.0.1:5060;branch=z9hG4bK-drain",
			"Call-ID": "drain-final",
			"CSeq":    "1 MESSAGE",
		},
	}
	duplicateFinal := strings.Join([]string{
		"SIP/2.0 202 Accepted",
		"Via: SIP/2.0/UDP 127.0.0.1:5060;branch=z9hG4bK-drain",
		"Call-ID: drain-final",
		"CSeq: 1 MESSAGE",
		"Content-Length: 0",
		"",
		"",
	}, "\r\n")

	wrote := make(chan error, 1)
	go func() {
		_, err := server.Write([]byte(duplicateFinal))
		wrote <- err
	}()

	drainSIPUDPFinalResponses(context.Background(), client, msg, 20*time.Millisecond)
	if err := <-wrote; err != nil {
		t.Fatalf("server.Write() error = %v", err)
	}

	buf := make([]byte, 1)
	_ = client.SetReadDeadline(time.Now().Add(20 * time.Millisecond))
	if _, err := client.Read(buf); !isSIPTimeout(err) {
		t.Fatalf("client.Read() err=%v, want timeout after duplicate was drained", err)
	}
}

func TestParseSIPRequestAndBuildResponseWire(t *testing.T) {
	raw := strings.Join([]string{
		"INVITE sip:user@example SIP/2.0",
		"v: SIP/2.0/UDP 192.0.2.1:5060;branch=z9hG4bK-a",
		"t: <sip:user@example>",
		"f: <sip:caller@example>;tag=remote",
		"i: call-1",
		"CSeq: 7 INVITE",
		"s: hello",
		" world",
		"u: presence",
		"o: reg",
		"r: <sip:refer@example>",
		"b: <sip:referrer@example>",
		"d: no-fork",
		"j: *;audio",
		"x: 1800;refresher=uac",
		"l: 5",
		"",
		"abcde ignored",
	}, "\r\n")
	req, err := ParseSIPRequest([]byte(raw))
	if err != nil {
		t.Fatalf("ParseSIPRequest() error = %v", err)
	}
	if req.Method != "INVITE" || req.URI != "sip:user@example" || string(req.Body) != "abcde" {
		t.Fatalf("request=%+v body=%q", req, req.Body)
	}
	for name, want := range map[string]string{
		"Via":                 "SIP/2.0/UDP 192.0.2.1:5060;branch=z9hG4bK-a",
		"To":                  "<sip:user@example>",
		"From":                "<sip:caller@example>;tag=remote",
		"Call-ID":             "call-1",
		"Subject":             "hello world",
		"Allow-Events":        "presence",
		"Event":               "reg",
		"Refer-To":            "<sip:refer@example>",
		"Referred-By":         "<sip:referrer@example>",
		"Request-Disposition": "no-fork",
		"Reject-Contact":      "*;audio",
		"Session-Expires":     "1800;refresher=uac",
	} {
		if got := req.Headers[name]; len(got) != 1 || got[0] != want {
			t.Fatalf("%s=%+v, want %q", name, got, want)
		}
	}
	wire, err := BuildSIPResponseWire(req, 200, "OK", map[string]string{
		"Contact":      "<sip:user@192.0.2.10:5060>",
		"Content-Type": "application/sdp",
	}, []byte("answer"))
	if err != nil {
		t.Fatalf("BuildSIPResponseWire() error = %v", err)
	}
	text := string(wire)
	for _, want := range []string{
		"SIP/2.0 200 OK\r\n",
		"Via: SIP/2.0/UDP 192.0.2.1:5060;branch=z9hG4bK-a\r\n",
		"To: <sip:user@example>\r\n",
		"From: <sip:caller@example>;tag=remote\r\n",
		"Call-ID: call-1\r\n",
		"CSeq: 7 INVITE\r\n",
		"Contact: <sip:user@192.0.2.10:5060>\r\n",
		"Content-Length: 6\r\n\r\nanswer",
	} {
		if !strings.Contains(text, want) {
			t.Fatalf("response wire missing %q in %q", want, text)
		}
	}
}

func TestBuildSIPResponseWireOrdersReferHeaders(t *testing.T) {
	req := SIPIncomingRequest{
		Method: "REFER",
		URI:    "sip:user@example",
		Headers: map[string][]string{
			"Via":     {"SIP/2.0/UDP 192.0.2.1:5060;branch=z9hG4bK-a"},
			"To":      {"<sip:user@example>"},
			"From":    {"<sip:caller@example>;tag=remote"},
			"Call-ID": {"refer-order"},
			"CSeq":    {"7 REFER"},
		},
	}
	wire, err := BuildSIPResponseWire(req, 202, "Accepted", map[string]string{
		"X-Late":              "tail",
		"Refer-Sub":           "false",
		"Request-Disposition": "no-fork",
		"Referred-By":         "<sip:caller@example>",
		"Reject-Contact":      "*;audio",
		"Refer-To":            "<sip:target@example>",
	}, nil)
	if err != nil {
		t.Fatalf("BuildSIPResponseWire() error = %v", err)
	}
	assertWireHeaderOrder(t, string(wire),
		"CSeq: 7 REFER\r\n",
		"Refer-To: <sip:target@example>\r\n",
		"Referred-By: <sip:caller@example>\r\n",
		"Refer-Sub: false\r\n",
		"Request-Disposition: no-fork\r\n",
		"Reject-Contact: *;audio\r\n",
		"X-Late: tail\r\n",
		"Content-Length: 0\r\n",
	)
}

func TestBuildSIPRequestWireOrdersReferHeaders(t *testing.T) {
	wire, err := buildSIPRequestWire(SIPRequestMessage{
		Method: "REFER",
		URI:    "sip:callee@example",
		Headers: map[string]string{
			"Via":                 "SIP/2.0/UDP 192.0.2.10:5060;branch=z9hG4bK-order;rport",
			"To":                  "<sip:callee@example>;tag=remote",
			"From":                "<sip:user@example>;tag=local",
			"Call-ID":             "request-refer-order",
			"CSeq":                "9 REFER",
			"Max-Forwards":        "70",
			"Refer-Sub":           "true",
			"Request-Disposition": "no-fork",
			"Referred-By":         "<sip:user@example>",
			"Reject-Contact":      "*;audio",
			"Refer-To":            "<sip:target@example>",
			"X-Late":              "tail",
		},
	}, "UDP", nil)
	if err != nil {
		t.Fatalf("buildSIPRequestWire() error = %v", err)
	}
	assertWireHeaderOrder(t, string(wire),
		"CSeq: 9 REFER\r\n",
		"Refer-To: <sip:target@example>\r\n",
		"Referred-By: <sip:user@example>\r\n",
		"Refer-Sub: true\r\n",
		"Request-Disposition: no-fork\r\n",
		"Reject-Contact: *;audio\r\n",
		"X-Late: tail\r\n",
		"Content-Length: 0\r\n",
	)
}

func TestBuildSIPRequestWireCanonicalizesIMSVisitedNetworkID(t *testing.T) {
	wire, err := buildSIPRequestWire(SIPRequestMessage{
		Method: "REGISTER",
		URI:    "sip:ims.example.test",
		Headers: map[string]string{
			"Via":                   "SIP/2.0/UDP 192.0.2.10:5060;branch=z9hG4bK-ims;rport",
			"To":                    "<sip:user@ims.example.test>",
			"From":                  "<sip:user@ims.example.test>;tag=local",
			"Call-ID":               "register-ims-order",
			"CSeq":                  "1 REGISTER",
			"Max-Forwards":          "70",
			"P-Preferred-Identity":  "<sip:user@ims.example.test>",
			"p-access-network-info": `IEEE-802.11;i-wlan-node-id="node;1"`,
			"p-visited-network-id":  `"visited.example.test"`,
			"Security-Client":       "ipsec-3gpp;alg=hmac-sha-1-96",
		},
	}, "UDP", nil)
	if err != nil {
		t.Fatalf("buildSIPRequestWire() error = %v", err)
	}
	assertWireHeaderOrder(t, string(wire),
		"P-Preferred-Identity: <sip:user@ims.example.test>\r\n",
		"P-Access-Network-Info: IEEE-802.11;i-wlan-node-id=\"node;1\"\r\n",
		"P-Visited-Network-ID: \"visited.example.test\"\r\n",
		"Security-Client: ipsec-3gpp;alg=hmac-sha-1-96\r\n",
		"Content-Length: 0\r\n",
	)
}

func assertWireHeaderOrder(t *testing.T, wire string, headers ...string) {
	t.Helper()
	last := -1
	for _, header := range headers {
		idx := strings.Index(wire, header)
		if idx < 0 {
			t.Fatalf("wire missing header %q in %q", header, wire)
		}
		if idx <= last {
			t.Fatalf("header %q out of order in %q", header, wire)
		}
		last = idx
	}
}

func TestBuildSIPResponseWireRejectsInvalidStatusCode(t *testing.T) {
	req := SIPIncomingRequest{
		Method: "OPTIONS",
		URI:    "sip:user@example",
		Headers: map[string][]string{
			"Via":     {"SIP/2.0/UDP 192.0.2.1:5060;branch=z9hG4bK-a"},
			"To":      {"<sip:user@example>"},
			"From":    {"<sip:caller@example>;tag=remote"},
			"Call-ID": {"bad-status-builder"},
			"CSeq":    {"1 OPTIONS"},
		},
	}
	for _, status := range []int{99, 700} {
		_, err := BuildSIPResponseWire(req, status, "Invalid", nil, nil)
		if !errors.Is(err, ErrInvalidSIPMessage) {
			t.Fatalf("BuildSIPResponseWire(%d) error=%v, want ErrInvalidSIPMessage", status, err)
		}
	}
}

func TestParseSIPMessageRejectsInvalidContentLength(t *testing.T) {
	tests := []struct {
		name  string
		raw   string
		parse func([]byte) error
	}{
		{
			name: "request_short_body",
			raw: strings.Join([]string{
				"MESSAGE sip:user@example SIP/2.0",
				"Call-ID: short-request",
				"CSeq: 1 MESSAGE",
				"Content-Length: 5",
				"",
				"abc",
			}, "\r\n"),
			parse: func(raw []byte) error {
				_, err := ParseSIPRequest(raw)
				return err
			},
		},
		{
			name: "response_short_body",
			raw: strings.Join([]string{
				"SIP/2.0 200 OK",
				"Content-Length: 5",
				"",
				"abc",
			}, "\r\n"),
			parse: func(raw []byte) error {
				_, err := ParseSIPResponse(raw)
				return err
			},
		},
		{
			name: "request_negative_length",
			raw: strings.Join([]string{
				"OPTIONS sip:user@example SIP/2.0",
				"Call-ID: bad-length",
				"CSeq: 1 OPTIONS",
				"Content-Length: -1",
				"",
				"",
			}, "\r\n"),
			parse: func(raw []byte) error {
				_, err := ParseSIPRequest(raw)
				return err
			},
		},
		{
			name: "response_nonnumeric_length",
			raw: strings.Join([]string{
				"SIP/2.0 200 OK",
				"Content-Length: many",
				"",
				"",
			}, "\r\n"),
			parse: func(raw []byte) error {
				_, err := ParseSIPResponse(raw)
				return err
			},
		},
		{
			name: "request_conflicting_lengths",
			raw: strings.Join([]string{
				"MESSAGE sip:user@example SIP/2.0",
				"Call-ID: conflicting-length",
				"CSeq: 1 MESSAGE",
				"Content-Length: 5",
				"l: 3",
				"",
				"abcde",
			}, "\r\n"),
			parse: func(raw []byte) error {
				_, err := ParseSIPRequest(raw)
				return err
			},
		},
	}
	for _, tc := range tests {
		err := tc.parse([]byte(tc.raw))
		if !errors.Is(err, ErrInvalidSIPMessage) {
			t.Fatalf("%s error=%v, want ErrInvalidSIPMessage", tc.name, err)
		}
	}
}

func TestParseSIPMessageAllowsMatchingContentLength(t *testing.T) {
	resp, err := ParseSIPResponse([]byte(strings.Join([]string{
		"SIP/2.0 200 OK",
		"Content-Length: 5",
		"l: 5",
		"",
		"hello ignored",
	}, "\r\n")))
	if err != nil {
		t.Fatalf("ParseSIPResponse() error = %v", err)
	}
	if string(resp.Body) != "hello" {
		t.Fatalf("body=%q, want hello", resp.Body)
	}
}

func TestReadSIPStreamMessageSkipsCRLFKeepalive(t *testing.T) {
	reader := bufio.NewReader(strings.NewReader("\r\n\r\n\r\nSIP/2.0 200 OK\r\nContent-Length: 5\r\n\r\nreadytrailing"))
	raw, err := readSIPStreamMessage(reader)
	if err != nil {
		t.Fatalf("readSIPStreamMessage() error = %v", err)
	}
	resp, err := ParseSIPResponse(raw)
	if err != nil {
		t.Fatalf("ParseSIPResponse() error = %v raw=%q", err, raw)
	}
	if resp.StatusCode != 200 || string(resp.Body) != "ready" {
		t.Fatalf("response=%+v body=%q raw=%q", resp, resp.Body, raw)
	}
}

func TestReadSIPStreamMessageRejectsConflictingContentLength(t *testing.T) {
	reader := bufio.NewReader(strings.NewReader("SIP/2.0 200 OK\r\nContent-Length: 2\r\nContent-Length: 3\r\n\r\nabc"))
	_, err := readSIPStreamMessage(reader)
	if !errors.Is(err, ErrInvalidSIPMessage) {
		t.Fatalf("readSIPStreamMessage() error = %v, want ErrInvalidSIPMessage", err)
	}
}

func TestSIPURIAddrParsesHostPortAndIPv6(t *testing.T) {
	cases := map[string]string{
		"sip:ims.example":                  "ims.example:5060",
		"sip:user@ims.example:5070;lr":     "ims.example:5070",
		"sips:user@[2001:db8::1]:5071;lr":  "[2001:db8::1]:5071",
		"sip:user@[2001:db8::2];transport": "[2001:db8::2]:5060",
	}
	for uri, want := range cases {
		got, err := sipURIAddr(uri)
		if err != nil {
			t.Fatalf("sipURIAddr(%q) error = %v", uri, err)
		}
		if got != want {
			t.Fatalf("sipURIAddr(%q)=%q, want %q", uri, got, want)
		}
	}
}

func TestSIPNetworkForRequestAndResolverProtoHandleSIPSAndTLS(t *testing.T) {
	if got := sipNetworkForRequest("", "sips:user@ims.example"); got != "tls" {
		t.Fatalf("sipNetworkForRequest(sips)=%q, want tls", got)
	}
	if got := sipNetworkForRequest("tcp", "sips:user@ims.example"); got != "tcp" {
		t.Fatalf("sipNetworkForRequest(explicit tcp)=%q, want tcp", got)
	}
	if got := sipResolverProto("tls", false); got != "tcp" {
		t.Fatalf("sipResolverProto(tls)=%q, want tcp", got)
	}
	if got := transportName("tls6"); got != "TLS" {
		t.Fatalf("transportName(tls6)=%q, want TLS", got)
	}
}

func TestSIPRedirectTargetsHonorContactQAndExpiresVariants(t *testing.T) {
	resp := SIPResponse{
		StatusCode: 302,
		Reason:     "Moved Temporarily",
		Headers: map[string][]string{
			"contact": {
				`<sip:expired@198.51.100.1:5060>;expires=0, sip:low@198.51.100.2:5060;transport=udp;q=0.1`,
				`"Preferred, Edge" <sips:preferred@[2001:db8::5];transport=tcp;lr>;q="0.9";expires=60`,
				`<tel:+18005551212>;q=1, <sip:backup@198.51.100.3:5070;lr>;q=0.4`,
			},
		},
	}
	got := sipRedirectTargets(resp)
	want := []string{"[2001:db8::5]:5061", "198.51.100.3:5070", "198.51.100.2:5060"}
	if len(got) != len(want) {
		t.Fatalf("sipRedirectTargets()=%+v, want %+v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("sipRedirectTargets()[%d]=%q, want %q (all=%+v)", i, got[i], want[i], got)
		}
	}
}

func TestWireRegisterTransportRoundTripRegisterOverTLS(t *testing.T) {
	ln := listenTestSIPTLS(t)
	defer ln.Close()

	seen := make(chan string, 1)
	go func() {
		conn, err := ln.Accept()
		if err != nil {
			seen <- "accept error: " + err.Error()
			return
		}
		defer conn.Close()
		raw, err := readSIPStreamMessage(bufio.NewReader(conn))
		if err != nil {
			seen <- "read error: " + err.Error()
			return
		}
		seen <- string(raw)
		_, _ = conn.Write([]byte("SIP/2.0 200 OK\r\nContent-Length: 0\r\n\r\n"))
	}()

	resp, err := WireRegisterTransport{
		Network:    "tls",
		ServerAddr: ln.Addr().String(),
		Timeout:    time.Second,
		TLSConfig:  testSIPClientTLSConfig(),
	}.RoundTripRegister(context.Background(), RegisterMessage{
		URI: "sips:ims.example",
		Headers: map[string]string{
			"To":           "<sips:user@example>",
			"From":         "<sips:user@example>;tag=t",
			"Contact":      "<sips:user@192.0.2.10:5061>",
			"Call-ID":      "tls-register",
			"CSeq":         "1 REGISTER",
			"Max-Forwards": "70",
		},
	})
	if err != nil {
		t.Fatalf("RoundTripRegister(tls) error = %v", err)
	}
	if resp.StatusCode != 200 {
		t.Fatalf("response=%+v", resp)
	}
	wire := <-seen
	if !strings.Contains(wire, "REGISTER sips:ims.example SIP/2.0") ||
		!strings.Contains(wire, "Via: SIP/2.0/TLS") {
		t.Fatalf("REGISTER TLS wire=%q", wire)
	}
}

func TestWireSIPTransportRoundTripOverTLS(t *testing.T) {
	ln := listenTestSIPTLS(t)
	defer ln.Close()

	seen := make(chan string, 1)
	go func() {
		conn, err := ln.Accept()
		if err != nil {
			seen <- "accept error: " + err.Error()
			return
		}
		defer conn.Close()
		raw, err := readSIPStreamMessage(bufio.NewReader(conn))
		if err != nil {
			seen <- "read error: " + err.Error()
			return
		}
		seen <- string(raw)
		_, _ = conn.Write([]byte("SIP/2.0 202 Accepted\r\nContent-Length: 5\r\n\r\nhello"))
	}()

	resp, err := WireSIPTransport{
		ServerAddr: ln.Addr().String(),
		Timeout:    time.Second,
		TLSConfig:  testSIPClientTLSConfig(),
	}.RoundTripRequest(context.Background(), SIPRequestMessage{
		Method: "MESSAGE",
		URI:    "sips:+18005551212@example",
		Headers: map[string]string{
			"To":           "<sips:+18005551212@example>",
			"From":         "<sips:user@example>;tag=t",
			"Contact":      "<sips:user@192.0.2.10:5061>",
			"Call-ID":      "tls-message",
			"CSeq":         "1 MESSAGE",
			"Max-Forwards": "70",
		},
		Body: []byte("ping"),
	})
	if err != nil {
		t.Fatalf("RoundTripRequest(tls) error = %v", err)
	}
	if resp.StatusCode != 202 || string(resp.Body) != "hello" {
		t.Fatalf("response=%+v body=%q", resp, resp.Body)
	}
	wire := <-seen
	if !strings.Contains(wire, "MESSAGE sips:+18005551212@example SIP/2.0") ||
		!strings.Contains(wire, "Via: SIP/2.0/TLS") ||
		!strings.Contains(wire, "Content-Length: 4") {
		t.Fatalf("MESSAGE TLS wire=%q", wire)
	}
}

func TestWireRegisterTransportIgnoresUDPKeepaliveBeforeResponse(t *testing.T) {
	pc, err := net.ListenPacket("udp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("ListenPacket() error = %v", err)
	}
	defer pc.Close()

	requestCh := make(chan string, 1)
	go func() {
		buf := make([]byte, 65535)
		_ = pc.SetReadDeadline(time.Now().Add(time.Second))
		n, addr, err := pc.ReadFrom(buf)
		if err != nil {
			requestCh <- "read error: " + err.Error()
			return
		}
		requestCh <- string(append([]byte(nil), buf[:n]...))
		_, _ = pc.WriteTo([]byte("\r\n\r\n"), addr)
		_, _ = pc.WriteTo([]byte("SIP/2.0 200 OK\r\nContent-Length: 0\r\n\r\n"), addr)
	}()

	resp, err := WireRegisterTransport{
		Network:    "udp",
		ServerAddr: pc.LocalAddr().String(),
		Timeout:    time.Second,
	}.RoundTripRegister(context.Background(), RegisterMessage{
		URI: "sip:ims.example",
		Headers: map[string]string{
			"To":           "<sip:user@example>",
			"From":         "<sip:user@example>;tag=t",
			"Contact":      "<sip:user@192.0.2.10:5060>",
			"Call-ID":      "keepalive-register",
			"CSeq":         "1 REGISTER",
			"Max-Forwards": "70",
		},
	})
	if err != nil {
		t.Fatalf("RoundTripRegister() error = %v", err)
	}
	if resp.StatusCode != 200 {
		t.Fatalf("response=%+v", resp)
	}
	if req := <-requestCh; !strings.Contains(req, "REGISTER sip:ims.example SIP/2.0") {
		t.Fatalf("REGISTER wire=%q", req)
	}
}

func TestWireRegisterTransportRoundTripRegisterOverUDP(t *testing.T) {
	pc, err := net.ListenPacket("udp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("ListenPacket() error = %v", err)
	}
	defer pc.Close()

	rawNonce := append(bytesFrom(0x10, 16), bytesFrom(0x40, 16)...)
	requests := make(chan []string, 1)
	go func() {
		var seen []string
		buf := make([]byte, 65535)
		for i := 0; i < 2; i++ {
			n, addr, err := pc.ReadFrom(buf)
			if err != nil {
				requests <- append(seen, "read error: "+err.Error())
				return
			}
			req := string(append([]byte(nil), buf[:n]...))
			seen = append(seen, req)
			var resp string
			if i == 0 {
				resp = "SIP/2.0 401 Unauthorized\r\n" +
					"WWW-Authenticate: Digest realm=\"ims.example\", nonce=\"" + base64.StdEncoding.EncodeToString(rawNonce) + "\", algorithm=AKAv1-MD5, qop=\"auth\"\r\n" +
					"Security-Server: ipsec-3gpp;alg=hmac-sha-1-96;ealg=null;spi-c=111;spi-s=222;port-c=5062;port-s=5063\r\n" +
					"Content-Length: 0\r\n\r\n"
			} else {
				resp = "SIP/2.0 200 OK\r\n" +
					"P-Associated-URI: <sip:user@example>\r\n" +
					"Service-Route: <sip:pcscf.example;lr>\r\n" +
					"Contact: <sip:user@192.0.2.10:5060>;expires=1800\r\n" +
					"Content-Length: 0\r\n\r\n"
			}
			_, _ = pc.WriteTo([]byte(resp), addr)
		}
		requests <- seen
	}()

	result, err := RegisterSession{
		Transport: WireRegisterTransport{
			Network:    "udp",
			ServerAddr: pc.LocalAddr().String(),
			Timeout:    time.Second,
		},
		AKAProvider:  &registerAKAProvider{},
		Profile:      IMSProfile{IMPI: "impi@example", IMPU: "sip:user@example", Domain: "example"},
		RegistrarURI: "sip:ims.example",
		ContactURI:   "sip:user@192.0.2.10:5060",
		CallID:       "wire-call",
		CNonce:       "wire-cnonce",
	}.Register(context.Background())
	if err != nil {
		t.Fatalf("Register() error = %v", err)
	}
	if !result.Registered || result.Binding.PublicIdentity != "sip:user@example" || len(result.Binding.ServiceRoutes) != 1 {
		t.Fatalf("result=%+v", result)
	}
	seen := <-requests
	if len(seen) != 2 {
		t.Fatalf("requests=%d %v", len(seen), seen)
	}
	if !strings.Contains(seen[0], "REGISTER sip:ims.example SIP/2.0\r\n") || !strings.Contains(seen[0], "Via: SIP/2.0/UDP") {
		t.Fatalf("first REGISTER wire=%q", seen[0])
	}
	if !strings.Contains(seen[1], "Authorization: Digest") || !strings.Contains(seen[1], "Security-Verify: ipsec-3gpp") {
		t.Fatalf("second REGISTER wire=%q", seen[1])
	}
}

func TestWireRegisterTransportRetransmitsUDPRegister(t *testing.T) {
	pc, err := net.ListenPacket("udp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("ListenPacket() error = %v", err)
	}
	defer pc.Close()

	seen := make(chan []string, 1)
	go func() {
		var requests []string
		buf := make([]byte, 65535)
		for i := 0; i < 2; i++ {
			_ = pc.SetReadDeadline(time.Now().Add(time.Second))
			n, addr, err := pc.ReadFrom(buf)
			if err != nil {
				seen <- append(requests, "read error: "+err.Error())
				return
			}
			requests = append(requests, string(append([]byte(nil), buf[:n]...)))
			if i == 1 {
				_, _ = pc.WriteTo([]byte("SIP/2.0 200 OK\r\nContent-Length: 0\r\n\r\n"), addr)
			}
		}
		seen <- requests
	}()

	resp, err := WireRegisterTransport{
		Network:               "udp",
		ServerAddr:            pc.LocalAddr().String(),
		Timeout:               time.Second,
		RetransmitInterval:    20 * time.Millisecond,
		MaxRetransmitInterval: 20 * time.Millisecond,
		MaxRetransmits:        2,
	}.RoundTripRegister(context.Background(), RegisterMessage{
		URI: "sip:ims.example",
		Headers: map[string]string{
			"To":           "<sip:user@example>",
			"From":         "<sip:user@example>;tag=t",
			"Contact":      "<sip:user@192.0.2.10:5060>",
			"Call-ID":      "retransmit-register",
			"CSeq":         "1 REGISTER",
			"Max-Forwards": "70",
		},
	})
	if err != nil {
		t.Fatalf("RoundTripRegister() error = %v", err)
	}
	if resp.StatusCode != 200 {
		t.Fatalf("response=%+v", resp)
	}
	requests := <-seen
	if len(requests) != 2 || !strings.Contains(requests[0], "REGISTER sip:ims.example") || requests[0] != requests[1] {
		t.Fatalf("requests=%d %v", len(requests), requests)
	}
}

func TestWireRegisterTransportWaitsForFinalAfterProvisional(t *testing.T) {
	pc, err := net.ListenPacket("udp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("ListenPacket() error = %v", err)
	}
	defer pc.Close()

	serverErr := make(chan string, 1)
	go func() {
		buf := make([]byte, 65535)
		_ = pc.SetReadDeadline(time.Now().Add(time.Second))
		n, addr, err := pc.ReadFrom(buf)
		if err != nil {
			serverErr <- "read error: " + err.Error()
			return
		}
		req, err := ParseSIPRequest(buf[:n])
		if err != nil {
			serverErr <- "parse request error: " + err.Error()
			return
		}
		trying, err := BuildSIPResponseWire(req, 100, "Trying", nil, nil)
		if err != nil {
			serverErr <- "build trying error: " + err.Error()
			return
		}
		if _, err := pc.WriteTo(trying, addr); err != nil {
			serverErr <- "write trying error: " + err.Error()
			return
		}
		_ = pc.SetReadDeadline(time.Now().Add(80 * time.Millisecond))
		n, _, err = pc.ReadFrom(buf)
		if err == nil {
			serverErr <- "unexpected retransmit after 100 Trying: " + string(append([]byte(nil), buf[:n]...))
			return
		}
		ok, err := BuildSIPResponseWire(req, 200, "OK", nil, nil)
		if err != nil {
			serverErr <- "build ok error: " + err.Error()
			return
		}
		if _, err := pc.WriteTo(ok, addr); err != nil {
			serverErr <- "write ok error: " + err.Error()
			return
		}
		serverErr <- ""
	}()

	resp, err := WireRegisterTransport{
		Network:               "udp",
		ServerAddr:            pc.LocalAddr().String(),
		Timeout:               time.Second,
		RetransmitInterval:    20 * time.Millisecond,
		MaxRetransmitInterval: 20 * time.Millisecond,
	}.RoundTripRegister(context.Background(), RegisterMessage{
		URI: "sip:ims.example",
		Headers: map[string]string{
			"To":           "<sip:user@example>",
			"From":         "<sip:user@example>;tag=t",
			"Contact":      "<sip:user@192.0.2.10:5060>",
			"Call-ID":      "provisional-register",
			"CSeq":         "1 REGISTER",
			"Max-Forwards": "70",
		},
	})
	if err != nil || resp.StatusCode != 200 {
		t.Fatalf("RoundTripRegister() response=%+v err=%v", resp, err)
	}
	if msg := <-serverErr; msg != "" {
		t.Fatal(msg)
	}
}

func TestWireRegisterTransportIgnoresMismatchedUDPResponse(t *testing.T) {
	pc, err := net.ListenPacket("udp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("ListenPacket() error = %v", err)
	}
	defer pc.Close()

	go func() {
		buf := make([]byte, 65535)
		_ = pc.SetReadDeadline(time.Now().Add(time.Second))
		n, addr, err := pc.ReadFrom(buf)
		if err != nil {
			return
		}
		req, err := ParseSIPRequest(buf[:n])
		if err != nil {
			return
		}
		via := firstHeader(req.Headers, "Via")
		cseq := firstHeader(req.Headers, "CSeq")
		bad := strings.Join([]string{
			"SIP/2.0 503 Service Unavailable",
			"Via: " + via,
			"Call-ID: unrelated-register",
			"CSeq: " + cseq,
			"Content-Length: 0",
			"",
			"",
		}, "\r\n")
		good := strings.Join([]string{
			"SIP/2.0 200 OK",
			"Via: " + via,
			"Call-ID: " + firstHeader(req.Headers, "Call-ID"),
			"CSeq: " + cseq,
			"Content-Length: 0",
			"",
			"",
		}, "\r\n")
		_, _ = pc.WriteTo([]byte(bad), addr)
		_, _ = pc.WriteTo([]byte(good), addr)
	}()

	resp, err := WireRegisterTransport{
		Network:    "udp",
		ServerAddr: pc.LocalAddr().String(),
		Timeout:    time.Second,
	}.RoundTripRegister(context.Background(), RegisterMessage{
		URI: "sip:ims.example",
		Headers: map[string]string{
			"To":           "<sip:user@example>",
			"From":         "<sip:user@example>;tag=t",
			"Contact":      "<sip:user@192.0.2.10:5060>",
			"Call-ID":      "matched-register",
			"CSeq":         "1 REGISTER",
			"Max-Forwards": "70",
		},
	})
	if err != nil || resp.StatusCode != 200 {
		t.Fatalf("RoundTripRegister() response=%+v err=%v", resp, err)
	}
}

func TestWireRegisterTransportFailsOverResolvedUDPTargets(t *testing.T) {
	dead, err := net.ListenPacket("udp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("ListenPacket(dead) error = %v", err)
	}
	defer dead.Close()
	live, err := net.ListenPacket("udp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("ListenPacket(live) error = %v", err)
	}
	defer live.Close()

	deadSeen := make(chan string, 1)
	go func() {
		buf := make([]byte, 65535)
		_ = dead.SetReadDeadline(time.Now().Add(time.Second))
		n, _, err := dead.ReadFrom(buf)
		if err != nil {
			deadSeen <- "read error: " + err.Error()
			return
		}
		deadSeen <- string(append([]byte(nil), buf[:n]...))
	}()
	liveSeen := make(chan string, 1)
	go func() {
		buf := make([]byte, 65535)
		_ = live.SetReadDeadline(time.Now().Add(time.Second))
		n, addr, err := live.ReadFrom(buf)
		if err != nil {
			liveSeen <- "read error: " + err.Error()
			return
		}
		liveSeen <- string(append([]byte(nil), buf[:n]...))
		_, _ = live.WriteTo([]byte("SIP/2.0 200 OK\r\nContent-Length: 0\r\n\r\n"), addr)
	}()

	resolver := SIPServerCandidateResolverFunc(func(ctx context.Context, network, uri string) ([]string, error) {
		if network != "udp" || uri != "sip:ims.example" {
			t.Fatalf("resolver network=%q uri=%q", network, uri)
		}
		return []string{dead.LocalAddr().String(), live.LocalAddr().String()}, nil
	})
	resp, err := WireRegisterTransport{
		Network:               "udp",
		Resolver:              resolver,
		Timeout:               80 * time.Millisecond,
		RetransmitInterval:    20 * time.Millisecond,
		MaxRetransmitInterval: 20 * time.Millisecond,
		MaxRetransmits:        1,
	}.RoundTripRegister(context.Background(), RegisterMessage{
		URI: "sip:ims.example",
		Headers: map[string]string{
			"To":           "<sip:user@example>",
			"From":         "<sip:user@example>;tag=t",
			"Contact":      "<sip:user@192.0.2.10:5060>",
			"Call-ID":      "failover-register",
			"CSeq":         "1 REGISTER",
			"Max-Forwards": "70",
		},
	})
	if err != nil {
		t.Fatalf("RoundTripRegister() error = %v", err)
	}
	if resp.StatusCode != 200 {
		t.Fatalf("response=%+v", resp)
	}
	if wire := <-deadSeen; !strings.Contains(wire, "REGISTER sip:ims.example") {
		t.Fatalf("dead target wire=%q", wire)
	}
	if wire := <-liveSeen; !strings.Contains(wire, "REGISTER sip:ims.example") {
		t.Fatalf("live target wire=%q", wire)
	}
}

func TestWireRegisterTransportFailsOverRecoverableResponse(t *testing.T) {
	first, err := net.ListenPacket("udp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("ListenPacket(first) error = %v", err)
	}
	defer first.Close()
	second, err := net.ListenPacket("udp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("ListenPacket(second) error = %v", err)
	}
	defer second.Close()

	firstSeen := make(chan string, 1)
	go func() {
		buf := make([]byte, 65535)
		_ = first.SetReadDeadline(time.Now().Add(time.Second))
		n, addr, err := first.ReadFrom(buf)
		if err != nil {
			firstSeen <- "read error: " + err.Error()
			return
		}
		firstSeen <- string(append([]byte(nil), buf[:n]...))
		_, _ = first.WriteTo([]byte("SIP/2.0 503 Service Unavailable\r\nRetry-After: 30\r\nContent-Length: 0\r\n\r\n"), addr)
	}()
	secondSeen := make(chan string, 1)
	go func() {
		buf := make([]byte, 65535)
		_ = second.SetReadDeadline(time.Now().Add(time.Second))
		n, addr, err := second.ReadFrom(buf)
		if err != nil {
			secondSeen <- "read error: " + err.Error()
			return
		}
		secondSeen <- string(append([]byte(nil), buf[:n]...))
		_, _ = second.WriteTo([]byte("SIP/2.0 200 OK\r\nContent-Length: 0\r\n\r\n"), addr)
	}()

	resp, err := WireRegisterTransport{
		Network: "udp",
		Resolver: SIPServerCandidateResolverFunc(func(ctx context.Context, network, uri string) ([]string, error) {
			return []string{first.LocalAddr().String(), second.LocalAddr().String()}, nil
		}),
		Timeout: time.Second,
	}.RoundTripRegister(context.Background(), RegisterMessage{
		URI: "sip:ims.example",
		Headers: map[string]string{
			"To":           "<sip:user@example>",
			"From":         "<sip:user@example>;tag=t",
			"Contact":      "<sip:user@192.0.2.10:5060>",
			"Call-ID":      "failover-response-register",
			"CSeq":         "1 REGISTER",
			"Max-Forwards": "70",
		},
	})
	if err != nil || resp.StatusCode != 200 {
		t.Fatalf("RoundTripRegister() response=%+v err=%v", resp, err)
	}
	if wire := <-firstSeen; !strings.Contains(wire, "REGISTER sip:ims.example") {
		t.Fatalf("first target wire=%q", wire)
	}
	if wire := <-secondSeen; !strings.Contains(wire, "REGISTER sip:ims.example") {
		t.Fatalf("second target wire=%q", wire)
	}
}

func TestWireRegisterTransportFollowsRedirectContactTarget(t *testing.T) {
	first, err := net.ListenPacket("udp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("ListenPacket(first) error = %v", err)
	}
	defer first.Close()
	second, err := net.ListenPacket("udp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("ListenPacket(second) error = %v", err)
	}
	defer second.Close()

	firstSeen := make(chan string, 1)
	go func() {
		buf := make([]byte, 65535)
		_ = first.SetReadDeadline(time.Now().Add(time.Second))
		n, addr, err := first.ReadFrom(buf)
		if err != nil {
			firstSeen <- "read error: " + err.Error()
			return
		}
		firstSeen <- string(append([]byte(nil), buf[:n]...))
		_, _ = first.WriteTo([]byte("SIP/2.0 302 Moved Temporarily\r\nContact: <sip:pcscf@"+second.LocalAddr().String()+">\r\nContent-Length: 0\r\n\r\n"), addr)
	}()
	secondSeen := make(chan string, 1)
	go func() {
		buf := make([]byte, 65535)
		_ = second.SetReadDeadline(time.Now().Add(time.Second))
		n, addr, err := second.ReadFrom(buf)
		if err != nil {
			secondSeen <- "read error: " + err.Error()
			return
		}
		secondSeen <- string(append([]byte(nil), buf[:n]...))
		_, _ = second.WriteTo([]byte("SIP/2.0 200 OK\r\nContent-Length: 0\r\n\r\n"), addr)
	}()

	resp, err := WireRegisterTransport{
		Network:    "udp",
		ServerAddr: first.LocalAddr().String(),
		Timeout:    time.Second,
	}.RoundTripRegister(context.Background(), RegisterMessage{
		URI: "sip:ims.example",
		Headers: map[string]string{
			"To":           "<sip:user@example>",
			"From":         "<sip:user@example>;tag=t",
			"Contact":      "<sip:user@192.0.2.10:5060>",
			"Call-ID":      "register-redirect",
			"CSeq":         "1 REGISTER",
			"Max-Forwards": "70",
		},
	})
	if err != nil || resp.StatusCode != 200 {
		t.Fatalf("RoundTripRegister() response=%+v err=%v", resp, err)
	}
	if wire := <-firstSeen; !strings.Contains(wire, "REGISTER sip:ims.example") {
		t.Fatalf("first target wire=%q", wire)
	}
	if wire := <-secondSeen; !strings.Contains(wire, "REGISTER sip:ims.example") {
		t.Fatalf("redirect target wire=%q", wire)
	}
}

func TestWireSIPTransportFailsOverRecoverableDialogResponse(t *testing.T) {
	first, err := net.ListenPacket("udp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("ListenPacket(first) error = %v", err)
	}
	defer first.Close()
	second, err := net.ListenPacket("udp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("ListenPacket(second) error = %v", err)
	}
	defer second.Close()

	firstSeen := make(chan string, 1)
	go func() {
		buf := make([]byte, 65535)
		_ = first.SetReadDeadline(time.Now().Add(time.Second))
		n, addr, err := first.ReadFrom(buf)
		if err != nil {
			firstSeen <- "read error: " + err.Error()
			return
		}
		firstSeen <- string(append([]byte(nil), buf[:n]...))
		_, _ = first.WriteTo([]byte("SIP/2.0 503 Service Unavailable\r\nRetry-After: 10\r\nContent-Length: 0\r\n\r\n"), addr)
	}()
	secondSeen := make(chan string, 1)
	go func() {
		buf := make([]byte, 65535)
		_ = second.SetReadDeadline(time.Now().Add(time.Second))
		n, addr, err := second.ReadFrom(buf)
		if err != nil {
			secondSeen <- "read error: " + err.Error()
			return
		}
		secondSeen <- string(append([]byte(nil), buf[:n]...))
		_, _ = second.WriteTo([]byte("SIP/2.0 202 Accepted\r\nContent-Length: 0\r\n\r\n"), addr)
	}()

	resp, err := WireSIPTransport{
		Network: "udp",
		Resolver: SIPServerCandidateResolverFunc(func(ctx context.Context, network, uri string) ([]string, error) {
			return []string{first.LocalAddr().String(), second.LocalAddr().String()}, nil
		}),
		Timeout: time.Second,
	}.RoundTripRequest(context.Background(), SIPRequestMessage{
		Method: "MESSAGE",
		URI:    "sip:+18005551212@example",
		Headers: map[string]string{
			"To":           "<sip:+18005551212@example>",
			"From":         "<sip:user@example>;tag=t",
			"Contact":      "<sip:user@192.0.2.10:5060>",
			"Call-ID":      "failover-dialog-message",
			"CSeq":         "1 MESSAGE",
			"Max-Forwards": "70",
		},
		Body: []byte("hello"),
	})
	if err != nil || resp.StatusCode != 202 {
		t.Fatalf("RoundTripRequest() response=%+v err=%v", resp, err)
	}
	if wire := <-firstSeen; !strings.Contains(wire, "MESSAGE sip:+18005551212@example") {
		t.Fatalf("first target wire=%q", wire)
	}
	if wire := <-secondSeen; !strings.Contains(wire, "MESSAGE sip:+18005551212@example") {
		t.Fatalf("second target wire=%q", wire)
	}
}

func TestWireSIPTransportFailsOverTCPConnectionReset(t *testing.T) {
	first, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("Listen(first) error = %v", err)
	}
	defer first.Close()
	second, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("Listen(second) error = %v", err)
	}
	defer second.Close()

	firstSeen := make(chan string, 1)
	go func() {
		conn, err := first.Accept()
		if err != nil {
			firstSeen <- "accept error: " + err.Error()
			return
		}
		raw, err := readSIPStreamMessage(bufio.NewReader(conn))
		if err != nil {
			firstSeen <- "read error: " + err.Error()
			_ = conn.Close()
			return
		}
		firstSeen <- string(raw)
		if tcp, ok := conn.(*net.TCPConn); ok {
			_ = tcp.SetLinger(0)
		}
		_ = conn.Close()
	}()
	secondSeen := make(chan string, 1)
	go func() {
		conn, err := second.Accept()
		if err != nil {
			secondSeen <- "accept error: " + err.Error()
			return
		}
		defer conn.Close()
		raw, err := readSIPStreamMessage(bufio.NewReader(conn))
		if err != nil {
			secondSeen <- "read error: " + err.Error()
			return
		}
		secondSeen <- string(raw)
		_, _ = conn.Write([]byte("SIP/2.0 202 Accepted\r\nContent-Length: 0\r\n\r\n"))
	}()

	resp, err := WireSIPTransport{
		Network: "tcp",
		Resolver: SIPServerCandidateResolverFunc(func(ctx context.Context, network, uri string) ([]string, error) {
			return []string{first.Addr().String(), second.Addr().String()}, nil
		}),
		Timeout: time.Second,
	}.RoundTripRequest(context.Background(), SIPRequestMessage{
		Method: "MESSAGE",
		URI:    "sip:+18005551212@example",
		Headers: map[string]string{
			"To":           "<sip:+18005551212@example>",
			"From":         "<sip:user@example>;tag=t",
			"Contact":      "<sip:user@192.0.2.10:5060>",
			"Call-ID":      "failover-tcp-reset-message",
			"CSeq":         "1 MESSAGE",
			"Max-Forwards": "70",
		},
		Body: []byte("hello"),
	})
	if err != nil || resp.StatusCode != 202 {
		t.Fatalf("RoundTripRequest() response=%+v err=%v", resp, err)
	}
	if wire := <-firstSeen; !strings.Contains(wire, "MESSAGE sip:+18005551212@example") {
		t.Fatalf("first target wire=%q", wire)
	}
	if wire := <-secondSeen; !strings.Contains(wire, "MESSAGE sip:+18005551212@example") {
		t.Fatalf("second target wire=%q", wire)
	}
}

func TestWireSIPTransportFollowsRedirectContactTarget(t *testing.T) {
	first, err := net.ListenPacket("udp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("ListenPacket(first) error = %v", err)
	}
	defer first.Close()
	second, err := net.ListenPacket("udp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("ListenPacket(second) error = %v", err)
	}
	defer second.Close()

	firstSeen := make(chan string, 1)
	go func() {
		buf := make([]byte, 65535)
		_ = first.SetReadDeadline(time.Now().Add(time.Second))
		n, addr, err := first.ReadFrom(buf)
		if err != nil {
			firstSeen <- "read error: " + err.Error()
			return
		}
		firstSeen <- string(append([]byte(nil), buf[:n]...))
		_, _ = first.WriteTo([]byte("SIP/2.0 380 Alternative Service\r\nContact: <sip:pcscf@"+second.LocalAddr().String()+";transport=udp>\r\nContent-Length: 0\r\n\r\n"), addr)
	}()
	secondSeen := make(chan string, 1)
	go func() {
		buf := make([]byte, 65535)
		_ = second.SetReadDeadline(time.Now().Add(time.Second))
		n, addr, err := second.ReadFrom(buf)
		if err != nil {
			secondSeen <- "read error: " + err.Error()
			return
		}
		secondSeen <- string(append([]byte(nil), buf[:n]...))
		_, _ = second.WriteTo([]byte("SIP/2.0 202 Accepted\r\nContent-Length: 0\r\n\r\n"), addr)
	}()

	resp, err := WireSIPTransport{
		Network:    "udp",
		ServerAddr: first.LocalAddr().String(),
		Timeout:    time.Second,
	}.RoundTripRequest(context.Background(), SIPRequestMessage{
		Method: "MESSAGE",
		URI:    "sip:+18005551212@example",
		Headers: map[string]string{
			"To":           "<sip:+18005551212@example>",
			"From":         "<sip:user@example>;tag=sms",
			"Contact":      "<sip:user@192.0.2.10:5060>",
			"Call-ID":      "dialog-redirect",
			"CSeq":         "1 MESSAGE",
			"Max-Forwards": "70",
		},
		Body: []byte("hello"),
	})
	if err != nil || resp.StatusCode != 202 {
		t.Fatalf("RoundTripRequest() response=%+v err=%v", resp, err)
	}
	if wire := <-firstSeen; !strings.Contains(wire, "MESSAGE sip:+18005551212@example") {
		t.Fatalf("first target wire=%q", wire)
	}
	if wire := <-secondSeen; !strings.Contains(wire, "MESSAGE sip:+18005551212@example") {
		t.Fatalf("redirect target wire=%q", wire)
	}
}

func TestWireRegisterTransportRoundTripOverTCP(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("Listen() error = %v", err)
	}
	defer ln.Close()
	requestCh := make(chan string, 1)
	go func() {
		conn, err := ln.Accept()
		if err != nil {
			requestCh <- "accept error: " + err.Error()
			return
		}
		defer conn.Close()
		raw, err := readSIPStreamMessage(bufio.NewReader(conn))
		if err != nil {
			requestCh <- "read error: " + err.Error()
			return
		}
		requestCh <- string(raw)
		body := "ready"
		resp := "SIP/2.0 200 OK\r\nContent-Length: " + strconv.Itoa(len(body)) + "\r\n\r\n" + body
		_, _ = conn.Write([]byte(resp))
	}()

	resp, err := WireRegisterTransport{
		Network:    "tcp",
		ServerAddr: ln.Addr().String(),
		Timeout:    time.Second,
	}.RoundTripRegister(context.Background(), RegisterMessage{
		URI: "sip:ims.example",
		Headers: map[string]string{
			"To":           "<sip:user@example>",
			"From":         "<sip:user@example>;tag=t",
			"Contact":      "<sip:user@192.0.2.10:5060>",
			"Call-ID":      "tcp-call",
			"CSeq":         "1 REGISTER",
			"Max-Forwards": "70",
		},
	})
	if err != nil {
		t.Fatalf("RoundTripRegister() error = %v", err)
	}
	if resp.StatusCode != 200 || string(resp.Body) != "ready" {
		t.Fatalf("response=%+v body=%q", resp, resp.Body)
	}
	req := <-requestCh
	if !strings.Contains(req, "Via: SIP/2.0/TCP") || !strings.Contains(req, "Content-Length: 0") {
		t.Fatalf("TCP request=%q", req)
	}
}

func TestWireSIPTransportIgnoresUDPKeepaliveBeforeResponse(t *testing.T) {
	pc, err := net.ListenPacket("udp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("ListenPacket() error = %v", err)
	}
	defer pc.Close()

	go func() {
		buf := make([]byte, 65535)
		_ = pc.SetReadDeadline(time.Now().Add(time.Second))
		_, addr, err := pc.ReadFrom(buf)
		if err != nil {
			return
		}
		_, _ = pc.WriteTo([]byte("\r\n\r\n"), addr)
		_, _ = pc.WriteTo([]byte("SIP/2.0 202 Accepted\r\nContent-Length: 0\r\n\r\n"), addr)
	}()

	resp, err := WireSIPTransport{
		Network:    "udp",
		ServerAddr: pc.LocalAddr().String(),
		Timeout:    time.Second,
	}.RoundTripRequest(context.Background(), SIPRequestMessage{
		Method: "MESSAGE",
		URI:    "sip:callee@example",
		Headers: map[string]string{
			"To":           "<sip:callee@example>",
			"From":         "<sip:user@example>;tag=t",
			"Call-ID":      "keepalive-message",
			"CSeq":         "1 MESSAGE",
			"Contact":      "<sip:user@192.0.2.10:5060>",
			"Max-Forwards": "70",
		},
	})
	if err != nil {
		t.Fatalf("RoundTripRequest() error = %v", err)
	}
	if resp.StatusCode != 202 {
		t.Fatalf("response=%+v", resp)
	}
}

func TestWireSIPTransportWaitsForNonInviteFinalAfterProvisional(t *testing.T) {
	pc, err := net.ListenPacket("udp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("ListenPacket() error = %v", err)
	}
	defer pc.Close()

	serverErr := make(chan string, 1)
	go func() {
		buf := make([]byte, 65535)
		_ = pc.SetReadDeadline(time.Now().Add(time.Second))
		n, addr, err := pc.ReadFrom(buf)
		if err != nil {
			serverErr <- "read error: " + err.Error()
			return
		}
		req, err := ParseSIPRequest(buf[:n])
		if err != nil {
			serverErr <- "parse request error: " + err.Error()
			return
		}
		trying, err := BuildSIPResponseWire(req, 100, "Trying", nil, nil)
		if err != nil {
			serverErr <- "build trying error: " + err.Error()
			return
		}
		if _, err := pc.WriteTo(trying, addr); err != nil {
			serverErr <- "write trying error: " + err.Error()
			return
		}
		_ = pc.SetReadDeadline(time.Now().Add(80 * time.Millisecond))
		n, _, err = pc.ReadFrom(buf)
		if err == nil {
			serverErr <- "unexpected retransmit after 100 Trying: " + string(append([]byte(nil), buf[:n]...))
			return
		}
		accepted, err := BuildSIPResponseWire(req, 202, "Accepted", nil, nil)
		if err != nil {
			serverErr <- "build accepted error: " + err.Error()
			return
		}
		if _, err := pc.WriteTo(accepted, addr); err != nil {
			serverErr <- "write accepted error: " + err.Error()
			return
		}
		serverErr <- ""
	}()

	resp, err := WireSIPTransport{
		Network:               "udp",
		ServerAddr:            pc.LocalAddr().String(),
		Timeout:               time.Second,
		RetransmitInterval:    20 * time.Millisecond,
		MaxRetransmitInterval: 20 * time.Millisecond,
	}.RoundTripRequest(context.Background(), SIPRequestMessage{
		Method: "MESSAGE",
		URI:    "sip:callee@example",
		Headers: map[string]string{
			"To":           "<sip:callee@example>",
			"From":         "<sip:user@example>;tag=t",
			"Call-ID":      "provisional-message",
			"CSeq":         "1 MESSAGE",
			"Contact":      "<sip:user@192.0.2.10:5060>",
			"Max-Forwards": "70",
		},
	})
	if err != nil || resp.StatusCode != 202 {
		t.Fatalf("RoundTripRequest() response=%+v err=%v", resp, err)
	}
	if msg := <-serverErr; msg != "" {
		t.Fatal(msg)
	}
}

func TestWireSIPTransportRetransmitsUDPInvite(t *testing.T) {
	pc, err := net.ListenPacket("udp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("ListenPacket() error = %v", err)
	}
	defer pc.Close()

	seen := make(chan []string, 1)
	go func() {
		var requests []string
		buf := make([]byte, 65535)
		for i := 0; i < 2; i++ {
			_ = pc.SetReadDeadline(time.Now().Add(time.Second))
			n, addr, err := pc.ReadFrom(buf)
			if err != nil {
				seen <- append(requests, "read error: "+err.Error())
				return
			}
			requests = append(requests, string(append([]byte(nil), buf[:n]...)))
			if i == 1 {
				_, _ = pc.WriteTo([]byte("SIP/2.0 200 OK\r\nContent-Length: 0\r\n\r\n"), addr)
			}
		}
		seen <- requests
	}()

	resp, err := WireSIPTransport{
		Network:               "udp",
		ServerAddr:            pc.LocalAddr().String(),
		Timeout:               time.Second,
		RetransmitInterval:    20 * time.Millisecond,
		MaxRetransmitInterval: 20 * time.Millisecond,
		MaxRetransmits:        2,
	}.RoundTripRequest(context.Background(), SIPRequestMessage{
		Method: "INVITE",
		URI:    "sip:callee@example",
		Headers: map[string]string{
			"To":           "<sip:callee@example>",
			"From":         "<sip:user@example>;tag=t",
			"Call-ID":      "retransmit-invite",
			"CSeq":         "1 INVITE",
			"Contact":      "<sip:user@192.0.2.10:5060>",
			"Max-Forwards": "70",
		},
	})
	if err != nil {
		t.Fatalf("RoundTripRequest() error = %v", err)
	}
	if resp.StatusCode != 200 {
		t.Fatalf("response=%+v", resp)
	}
	requests := <-seen
	if len(requests) != 2 || !strings.Contains(requests[0], "INVITE sip:callee@example") || requests[0] != requests[1] {
		t.Fatalf("requests=%d %v", len(requests), requests)
	}
}

func TestWireSIPTransportIgnoresMismatchedUDPResponse(t *testing.T) {
	pc, err := net.ListenPacket("udp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("ListenPacket() error = %v", err)
	}
	defer pc.Close()

	go func() {
		buf := make([]byte, 65535)
		_ = pc.SetReadDeadline(time.Now().Add(time.Second))
		n, addr, err := pc.ReadFrom(buf)
		if err != nil {
			return
		}
		req, err := ParseSIPRequest(buf[:n])
		if err != nil {
			return
		}
		via := firstHeader(req.Headers, "Via")
		cseq := firstHeader(req.Headers, "CSeq")
		bad := strings.Join([]string{
			"SIP/2.0 486 Busy Here",
			"Via: " + via,
			"Call-ID: unrelated-message",
			"CSeq: " + cseq,
			"Content-Length: 0",
			"",
			"",
		}, "\r\n")
		good := strings.Join([]string{
			"SIP/2.0 202 Accepted",
			"Via: " + via,
			"Call-ID: " + firstHeader(req.Headers, "Call-ID"),
			"CSeq: " + cseq,
			"Content-Length: 0",
			"",
			"",
		}, "\r\n")
		_, _ = pc.WriteTo([]byte(bad), addr)
		_, _ = pc.WriteTo([]byte(good), addr)
	}()

	resp, err := WireSIPTransport{
		Network:    "udp",
		ServerAddr: pc.LocalAddr().String(),
		Timeout:    time.Second,
	}.RoundTripRequest(context.Background(), SIPRequestMessage{
		Method: "MESSAGE",
		URI:    "sip:callee@example",
		Headers: map[string]string{
			"To":           "<sip:callee@example>",
			"From":         "<sip:user@example>;tag=t",
			"Call-ID":      "matched-message",
			"CSeq":         "1 MESSAGE",
			"Contact":      "<sip:user@192.0.2.10:5060>",
			"Max-Forwards": "70",
		},
	})
	if err != nil || resp.StatusCode != 202 {
		t.Fatalf("RoundTripRequest() response=%+v err=%v", resp, err)
	}
}

func TestWireSIPTransportStopsInviteRetransmitAfterProvisional(t *testing.T) {
	pc, err := net.ListenPacket("udp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("ListenPacket() error = %v", err)
	}
	defer pc.Close()

	seen := make(chan []string, 1)
	go func() {
		buf := make([]byte, 65535)
		_ = pc.SetReadDeadline(time.Now().Add(time.Second))
		n, addr, err := pc.ReadFrom(buf)
		if err != nil {
			seen <- []string{"read error: " + err.Error()}
			return
		}
		first := string(append([]byte(nil), buf[:n]...))
		_, _ = pc.WriteTo([]byte("SIP/2.0 180 Ringing\r\nContent-Length: 0\r\n\r\n"), addr)
		_ = pc.SetReadDeadline(time.Now().Add(80 * time.Millisecond))
		n, _, err = pc.ReadFrom(buf)
		if err == nil {
			seen <- []string{first, "unexpected retransmit: " + string(append([]byte(nil), buf[:n]...))}
			return
		}
		_, _ = pc.WriteTo([]byte("SIP/2.0 200 OK\r\nContent-Length: 0\r\n\r\n"), addr)
		seen <- []string{first}
	}()

	resp, err := WireSIPTransport{
		Network:               "udp",
		ServerAddr:            pc.LocalAddr().String(),
		Timeout:               time.Second,
		RetransmitInterval:    20 * time.Millisecond,
		MaxRetransmitInterval: 20 * time.Millisecond,
	}.RoundTripRequest(context.Background(), SIPRequestMessage{
		Method: "INVITE",
		URI:    "sip:callee@example",
		Headers: map[string]string{
			"To":           "<sip:callee@example>",
			"From":         "<sip:user@example>;tag=t",
			"Call-ID":      "provisional-invite",
			"CSeq":         "1 INVITE",
			"Contact":      "<sip:user@192.0.2.10:5060>",
			"Max-Forwards": "70",
		},
	})
	if err != nil {
		t.Fatalf("RoundTripRequest() error = %v", err)
	}
	if resp.StatusCode != 200 {
		t.Fatalf("response=%+v", resp)
	}
	requests := <-seen
	if len(requests) != 1 || !strings.Contains(requests[0], "INVITE sip:callee@example") {
		t.Fatalf("requests=%d %v", len(requests), requests)
	}
}

func TestWireSIPTransportReportsReliableProvisional(t *testing.T) {
	pc, err := net.ListenPacket("udp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("ListenPacket() error = %v", err)
	}
	defer pc.Close()

	go func() {
		buf := make([]byte, 65535)
		_ = pc.SetReadDeadline(time.Now().Add(time.Second))
		_, addr, err := pc.ReadFrom(buf)
		if err != nil {
			return
		}
		_, _ = pc.WriteTo([]byte("SIP/2.0 183 Session Progress\r\nRequire: 100rel\r\nRSeq: 7\r\nContent-Length: 0\r\n\r\n"), addr)
		_, _ = pc.WriteTo([]byte("SIP/2.0 200 OK\r\nContent-Length: 0\r\n\r\n"), addr)
	}()

	var provisionals []SIPResponse
	resp, err := WireSIPTransport{
		Network:    "udp",
		ServerAddr: pc.LocalAddr().String(),
		Timeout:    time.Second,
	}.RoundTripInvite(context.Background(), SIPRequestMessage{
		Method: "INVITE",
		URI:    "sip:callee@example",
		Headers: map[string]string{
			"To":           "<sip:callee@example>",
			"From":         "<sip:user@example>;tag=t",
			"Call-ID":      "provisional-callback",
			"CSeq":         "1 INVITE",
			"Contact":      "<sip:user@192.0.2.10:5060>",
			"Max-Forwards": "70",
		},
	}, func(ctx context.Context, req SIPRequestMessage, resp SIPResponse) error {
		provisionals = append(provisionals, resp)
		return nil
	})
	if err != nil {
		t.Fatalf("RoundTripInvite() error = %v", err)
	}
	if resp.StatusCode != 200 {
		t.Fatalf("response=%+v", resp)
	}
	if len(provisionals) != 1 || provisionals[0].StatusCode != 183 || firstHeader(provisionals[0].Headers, "RSeq") != "7" {
		t.Fatalf("provisionals=%+v", provisionals)
	}
}

func TestWireSIPTransportWritesGeneratedViaBackToRequest(t *testing.T) {
	pc, err := net.ListenPacket("udp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("ListenPacket() error = %v", err)
	}
	defer pc.Close()

	seen := make(chan string, 1)
	go func() {
		buf := make([]byte, 65535)
		_ = pc.SetReadDeadline(time.Now().Add(time.Second))
		n, addr, err := pc.ReadFrom(buf)
		if err != nil {
			seen <- "read error: " + err.Error()
			return
		}
		seen <- string(append([]byte(nil), buf[:n]...))
		_, _ = pc.WriteTo([]byte("SIP/2.0 200 OK\r\nContent-Length: 0\r\n\r\n"), addr)
	}()

	msg := SIPRequestMessage{
		Method: "INVITE",
		URI:    "sip:callee@example",
		Headers: map[string]string{
			"To":           "<sip:callee@example>",
			"From":         "<sip:user@example>;tag=t",
			"Call-ID":      "via-writeback",
			"CSeq":         "1 INVITE",
			"Contact":      "<sip:user@192.0.2.10:5060>",
			"Max-Forwards": "70",
		},
	}
	resp, err := WireSIPTransport{
		Network:    "udp",
		ServerAddr: pc.LocalAddr().String(),
		Timeout:    time.Second,
	}.RoundTripInvite(context.Background(), msg, nil)
	if err != nil {
		t.Fatalf("RoundTripInvite() error = %v", err)
	}
	if resp.StatusCode != 200 {
		t.Fatalf("response=%+v", resp)
	}
	wire := <-seen
	via := msg.Headers["Via"]
	if via == "" || !strings.Contains(via, ";branch=z9hG4bK") || !strings.Contains(wire, "Via: "+via+"\r\n") {
		t.Fatalf("Via writeback=%q wire=%q", via, wire)
	}
}

func TestWireSIPTransportInviteWaitsForFinalResponseAndWritesAck(t *testing.T) {
	pc, err := net.ListenPacket("udp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("ListenPacket() error = %v", err)
	}
	defer pc.Close()

	requests := make(chan []string, 1)
	go func() {
		var seen []string
		buf := make([]byte, 65535)
		n, addr, err := pc.ReadFrom(buf)
		if err != nil {
			requests <- []string{"read invite error: " + err.Error()}
			return
		}
		seen = append(seen, string(append([]byte(nil), buf[:n]...)))
		_, _ = pc.WriteTo([]byte("SIP/2.0 180 Ringing\r\nContent-Length: 0\r\n\r\n"), addr)
		_, _ = pc.WriteTo([]byte("SIP/2.0 200 OK\r\nContent-Type: application/sdp\r\nContent-Length: 9\r\n\r\nanswer=ok"), addr)

		n, _, err = pc.ReadFrom(buf)
		if err != nil {
			requests <- append(seen, "read ack error: "+err.Error())
			return
		}
		seen = append(seen, string(append([]byte(nil), buf[:n]...)))
		requests <- seen
	}()

	transport := WireSIPTransport{Network: "udp", ServerAddr: pc.LocalAddr().String(), Timeout: time.Second}
	resp, err := transport.RoundTripRequest(context.Background(), SIPRequestMessage{
		Method: "INVITE",
		URI:    "sip:callee@example",
		Headers: map[string]string{
			"To":           "<sip:callee@example>",
			"From":         "<sip:user@example>;tag=t",
			"Call-ID":      "call-1",
			"CSeq":         "1 INVITE",
			"Contact":      "<sip:user@192.0.2.10:5060>",
			"Max-Forwards": "70",
		},
		Body: []byte("offer=ok"),
	})
	if err != nil {
		t.Fatalf("RoundTripRequest() error = %v", err)
	}
	if resp.StatusCode != 200 || string(resp.Body) != "answer=ok" {
		t.Fatalf("response=%+v body=%q", resp, resp.Body)
	}
	if err := transport.WriteRequest(context.Background(), SIPRequestMessage{
		Method: "ACK",
		URI:    "sip:callee@example",
		Headers: map[string]string{
			"To":           "<sip:callee@example>;tag=remote",
			"From":         "<sip:user@example>;tag=t",
			"Call-ID":      "call-1",
			"CSeq":         "1 ACK",
			"Max-Forwards": "70",
		},
	}); err != nil {
		t.Fatalf("WriteRequest() error = %v", err)
	}
	seen := <-requests
	if len(seen) != 2 {
		t.Fatalf("requests=%d %v", len(seen), seen)
	}
	if !strings.Contains(seen[0], "INVITE sip:callee@example SIP/2.0") || !strings.Contains(seen[0], "Content-Length: 8") {
		t.Fatalf("INVITE wire=%q", seen[0])
	}
	if !strings.Contains(seen[1], "ACK sip:callee@example SIP/2.0") || !strings.Contains(seen[1], "Via: SIP/2.0/UDP") {
		t.Fatalf("ACK wire=%q", seen[1])
	}
}

func listenTestSIPTLS(tb testing.TB) net.Listener {
	tb.Helper()
	ln, err := tls.Listen("tcp", "127.0.0.1:0", testSIPServerTLSConfig(tb))
	if err != nil {
		tb.Fatalf("Listen(tls) error = %v", err)
	}
	return ln
}

func testSIPServerTLSConfig(tb testing.TB) *tls.Config {
	tb.Helper()
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		tb.Fatalf("GenerateKey() error = %v", err)
	}
	template := x509.Certificate{
		SerialNumber: big.NewInt(1),
		Subject: pkix.Name{
			CommonName: "ims.example",
		},
		NotBefore:   time.Now().Add(-time.Hour),
		NotAfter:    time.Now().Add(time.Hour),
		DNSNames:    []string{"ims.example", "example"},
		IPAddresses: []net.IP{net.ParseIP("127.0.0.1")},
		KeyUsage:    x509.KeyUsageKeyEncipherment | x509.KeyUsageDigitalSignature,
		ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
	}
	der, err := x509.CreateCertificate(rand.Reader, &template, &template, &key.PublicKey, key)
	if err != nil {
		tb.Fatalf("CreateCertificate() error = %v", err)
	}
	return &tls.Config{
		Certificates: []tls.Certificate{{
			Certificate: [][]byte{der},
			PrivateKey:  key,
		}},
		MinVersion: tls.VersionTLS12,
	}
}

func testSIPClientTLSConfig() *tls.Config {
	return &tls.Config{
		InsecureSkipVerify: true,
		MinVersion:         tls.VersionTLS12,
	}
}
