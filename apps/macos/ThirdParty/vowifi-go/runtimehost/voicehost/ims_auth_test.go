package voicehost

import (
	"context"
	"encoding/base64"
	"strings"
	"testing"

	"github.com/boa-z/vowifi-go/engine/sim"
	"github.com/boa-z/vowifi-go/runtimehost/voiceclient"
)

func TestIMSOutboundAgentAppliesDigestAuthenticationInfo(t *testing.T) {
	binding := testVoiceDigestBinding(t, "nonce-voice")
	transport := &fakeIMSVoiceTransport{responses: []voiceclient.SIPResponse{
		{
			StatusCode: 200,
			Reason:     "OK",
			Headers: map[string][]string{
				"To":                  {"<sip:+18005551212@ims.example>;tag=remote-tag"},
				"Contact":             {"<sip:carrier@198.51.100.1:5060>"},
				"Authentication-Info": {`nextnonce="nonce-voice-next"`},
			},
			Body: []byte(sampleSDP("203.0.113.10", 49170)),
		},
		{StatusCode: 200, Reason: "OK"},
	}}
	agent := &IMSOutboundAgent{
		Transport:    transport,
		Profile:      voiceclient.IMSProfile{IMPI: "impi@example", IMPU: "sip:user@ims.example", Domain: "ims.example"},
		Registration: binding,
	}
	if _, err := agent.StartOutboundCall(context.Background(), OutboundCallRequest{
		CallID: "call-auth-info",
		Callee: "+18005551212",
		RawSDP: []byte(sampleSDP("192.0.2.50", 4002)),
	}); err != nil {
		t.Fatalf("StartOutboundCall() error = %v", err)
	}
	if len(transport.requests) != 1 || len(transport.writes) != 1 {
		t.Fatalf("requests=%+v writes=%+v", transport.requests, transport.writes)
	}
	if auth := transport.requests[0].Headers["Authorization"]; !strings.Contains(auth, `nonce="nonce-voice"`) || !strings.Contains(auth, `nc=00000002`) {
		t.Fatalf("INVITE Authorization=%s", auth)
	}
	if auth := transport.writes[0].Headers["Authorization"]; !strings.Contains(auth, `nonce="nonce-voice-next"`) || !strings.Contains(auth, `nc=00000001`) {
		t.Fatalf("ACK Authorization=%s", auth)
	}
	if err := agent.EndVoiceCall(context.Background(), DialogInfo{CallID: "call-auth-info"}); err != nil {
		t.Fatalf("EndVoiceCall() error = %v", err)
	}
	if len(transport.requests) != 2 {
		t.Fatalf("requests=%+v", transport.requests)
	}
	if auth := transport.requests[1].Headers["Authorization"]; !strings.Contains(auth, `nonce="nonce-voice-next"`) || !strings.Contains(auth, `nc=00000002`) {
		t.Fatalf("BYE Authorization=%s", auth)
	}
}

func TestIMSOutboundAgentRetriesDialogDigestChallenge(t *testing.T) {
	binding := testVoiceDigestBinding(t, "nonce-voice-retry")
	transport := &fakeIMSVoiceTransport{responses: []voiceclient.SIPResponse{
		{
			StatusCode: 200,
			Reason:     "OK",
			Headers: map[string][]string{
				"To":      {"<sip:+18005551212@ims.example>;tag=remote-tag"},
				"Contact": {"<sip:carrier@198.51.100.1:5060>"},
			},
			Body: []byte(sampleSDP("203.0.113.10", 49170)),
		},
		{
			StatusCode: 407,
			Reason:     "Proxy Authentication Required",
			Headers: map[string][]string{
				"Proxy-Authenticate": {`Digest realm="ims.example", nonce="nonce-voice-bye", algorithm=MD5, qop="auth"`},
			},
		},
		{StatusCode: 200, Reason: "OK"},
	}}
	agent := &IMSOutboundAgent{
		Transport:    transport,
		Profile:      voiceclient.IMSProfile{IMPI: "impi@example", IMPU: "sip:user@ims.example", Domain: "ims.example"},
		Registration: binding,
	}
	if _, err := agent.StartOutboundCall(context.Background(), OutboundCallRequest{
		CallID: "call-auth-retry",
		Callee: "+18005551212",
		RawSDP: []byte(sampleSDP("192.0.2.50", 4002)),
	}); err != nil {
		t.Fatalf("StartOutboundCall() error = %v", err)
	}
	if err := agent.EndVoiceCall(context.Background(), DialogInfo{CallID: "call-auth-retry"}); err != nil {
		t.Fatalf("EndVoiceCall() error = %v", err)
	}
	if len(transport.requests) != 3 {
		t.Fatalf("requests=%+v", transport.requests)
	}
	initial := transport.requests[1]
	retry := transport.requests[2]
	if initial.Method != "BYE" || retry.Method != "BYE" {
		t.Fatalf("requests=%+v", transport.requests)
	}
	if auth := retry.Headers["Proxy-Authorization"]; !strings.Contains(auth, `nonce="nonce-voice-bye"`) ||
		!strings.Contains(auth, `uri="sip:carrier@198.51.100.1:5060"`) ||
		!strings.Contains(auth, `nc=00000001`) {
		t.Fatalf("retry BYE Proxy-Authorization=%s", auth)
	}
	if retry.Headers["Authorization"] != "" {
		t.Fatalf("retry BYE kept Authorization: %+v", retry.Headers)
	}
}

func TestIMSOutboundAgentRetriesInviteDigestChallenge(t *testing.T) {
	binding := testVoiceDigestBinding(t, "nonce-invite-old")
	transport := &fakeIMSVoiceTransport{responses: []voiceclient.SIPResponse{
		{
			StatusCode: 401,
			Reason:     "Unauthorized",
			Headers: map[string][]string{
				"To":               {"<sip:+18005551212@ims.example>;tag=challenge-tag"},
				"WWW-Authenticate": {`Digest realm="ims.example", nonce="nonce-invite-new", algorithm=MD5, qop="auth"`},
			},
		},
		{
			StatusCode: 200,
			Reason:     "OK",
			Headers: map[string][]string{
				"To":      {"<sip:+18005551212@ims.example>;tag=remote-tag"},
				"Contact": {"<sip:carrier@198.51.100.1:5060>"},
			},
			Body: []byte(sampleSDP("203.0.113.10", 49170)),
		},
		{StatusCode: 200, Reason: "OK"},
	}}
	agent := &IMSOutboundAgent{
		Transport:    transport,
		Profile:      voiceclient.IMSProfile{IMPI: "impi@example", IMPU: "sip:user@ims.example", Domain: "ims.example"},
		Registration: binding,
	}
	result, err := agent.StartOutboundCall(context.Background(), OutboundCallRequest{
		CallID: "call-invite-auth-retry",
		Callee: "+18005551212",
		RawSDP: []byte(sampleSDP("192.0.2.50", 4002)),
	})
	if err != nil || !result.Accepted {
		t.Fatalf("StartOutboundCall() result=%+v err=%v", result, err)
	}
	if len(transport.requests) != 2 {
		t.Fatalf("requests=%+v", transport.requests)
	}
	firstInvite := transport.requests[0]
	retryInvite := transport.requests[1]
	if firstInvite.Headers["CSeq"] != "1 INVITE" || retryInvite.Headers["CSeq"] != "2 INVITE" {
		t.Fatalf("INVITE CSeqs=%q/%q", firstInvite.Headers["CSeq"], retryInvite.Headers["CSeq"])
	}
	if auth := retryInvite.Headers["Authorization"]; !strings.Contains(auth, `nonce="nonce-invite-new"`) ||
		!strings.Contains(auth, `uri="sip:+18005551212@ims.example"`) ||
		!strings.Contains(auth, `nc=00000001`) {
		t.Fatalf("retry INVITE Authorization=%s", auth)
	}
	if len(transport.writes) != 2 || transport.writes[0].Method != "ACK" || transport.writes[1].Method != "ACK" {
		t.Fatalf("writes=%+v", transport.writes)
	}
	if transport.writes[0].Headers["CSeq"] != "1 ACK" || !strings.Contains(transport.writes[0].Headers["To"], "challenge-tag") ||
		transport.writes[0].Headers["Via"] != firstInvite.Headers["Via"] {
		t.Fatalf("challenge ACK=%+v first=%+v", transport.writes[0], firstInvite)
	}
	if transport.writes[1].Headers["CSeq"] != "2 ACK" || transport.writes[1].URI != "sip:carrier@198.51.100.1:5060" {
		t.Fatalf("final ACK=%+v", transport.writes[1])
	}
	if err := agent.EndVoiceCall(context.Background(), DialogInfo{CallID: "call-invite-auth-retry"}); err != nil {
		t.Fatalf("EndVoiceCall() error = %v", err)
	}
	if len(transport.requests) != 3 || transport.requests[2].Method != "BYE" || transport.requests[2].Headers["CSeq"] != "3 BYE" {
		t.Fatalf("BYE after invite auth retry=%+v", transport.requests)
	}
}

func TestIMSOutboundAgentRetriesInviteAKASyncFailureChallenge(t *testing.T) {
	registerNonce := append(voiceAuthBytesFrom(0x10, 16), voiceAuthBytesFrom(0x40, 16)...)
	staleNonce := append(voiceAuthBytesFrom(0x20, 16), voiceAuthBytesFrom(0x50, 16)...)
	freshNonce := append(voiceAuthBytesFrom(0x70, 16), voiceAuthBytesFrom(0x90, 16)...)
	aka := &voiceSyncFailureAKAProvider{auts: voiceAuthBytesFrom(0xC0, 14)}
	binding := testVoiceAKADigestBinding(t, registerNonce, aka)
	transport := &fakeIMSVoiceTransport{responses: []voiceclient.SIPResponse{
		{
			StatusCode: 401,
			Reason:     "Unauthorized",
			Headers: map[string][]string{
				"To":               {"<sip:+18005551212@ims.example>;tag=sync-tag"},
				"WWW-Authenticate": {`Digest realm="ims.example", nonce="` + base64.StdEncoding.EncodeToString(staleNonce) + `", algorithm=AKAv1-MD5, qop="auth"`},
			},
		},
		{
			StatusCode: 401,
			Reason:     "Unauthorized",
			Headers: map[string][]string{
				"To":               {"<sip:+18005551212@ims.example>;tag=fresh-tag"},
				"WWW-Authenticate": {`Digest realm="ims.example", nonce="` + base64.StdEncoding.EncodeToString(freshNonce) + `", algorithm=AKAv1-MD5, qop="auth"`},
			},
		},
		{
			StatusCode: 200,
			Reason:     "OK",
			Headers: map[string][]string{
				"To":      {"<sip:+18005551212@ims.example>;tag=remote-tag"},
				"Contact": {"<sip:carrier@198.51.100.1:5060>"},
			},
			Body: []byte(sampleSDP("203.0.113.10", 49170)),
		},
		{StatusCode: 200, Reason: "OK"},
	}}
	agent := &IMSOutboundAgent{
		Transport:    transport,
		Profile:      voiceclient.IMSProfile{IMPI: "impi@example", IMPU: "sip:user@ims.example", Domain: "ims.example"},
		Registration: binding,
	}
	result, err := agent.StartOutboundCall(context.Background(), OutboundCallRequest{
		CallID: "call-invite-aka-sync",
		Callee: "+18005551212",
		RawSDP: []byte(sampleSDP("192.0.2.50", 4002)),
	})
	if err != nil || !result.Accepted {
		t.Fatalf("StartOutboundCall() result=%+v err=%v", result, err)
	}
	if len(transport.requests) != 3 {
		t.Fatalf("requests=%+v", transport.requests)
	}
	firstInvite := transport.requests[0]
	syncInvite := transport.requests[1]
	finalInvite := transport.requests[2]
	if firstInvite.Headers["CSeq"] != "1 INVITE" || syncInvite.Headers["CSeq"] != "2 INVITE" || finalInvite.Headers["CSeq"] != "3 INVITE" {
		t.Fatalf("INVITE CSeqs=%q/%q/%q", firstInvite.Headers["CSeq"], syncInvite.Headers["CSeq"], finalInvite.Headers["CSeq"])
	}
	if auth := syncInvite.Headers["Authorization"]; !strings.Contains(auth, `nonce="`+base64.StdEncoding.EncodeToString(staleNonce)+`"`) ||
		!strings.Contains(auth, `auts="`+base64.StdEncoding.EncodeToString(aka.auts)+`"`) {
		t.Fatalf("sync INVITE Authorization=%s", auth)
	}
	if auth := finalInvite.Headers["Authorization"]; strings.Contains(auth, `auts=`) ||
		!strings.Contains(auth, `nonce="`+base64.StdEncoding.EncodeToString(freshNonce)+`"`) ||
		!strings.Contains(auth, `nc=00000001`) {
		t.Fatalf("final INVITE Authorization=%s", auth)
	}
	if len(transport.writes) != 3 || transport.writes[0].Method != "ACK" || transport.writes[1].Method != "ACK" || transport.writes[2].Method != "ACK" {
		t.Fatalf("writes=%+v", transport.writes)
	}
	if transport.writes[0].Headers["CSeq"] != "1 ACK" || transport.writes[0].Headers["Via"] != firstInvite.Headers["Via"] ||
		!strings.Contains(transport.writes[0].Headers["To"], "sync-tag") {
		t.Fatalf("sync challenge ACK=%+v", transport.writes[0])
	}
	if transport.writes[1].Headers["CSeq"] != "2 ACK" || transport.writes[1].Headers["Via"] != syncInvite.Headers["Via"] ||
		!strings.Contains(transport.writes[1].Headers["To"], "fresh-tag") {
		t.Fatalf("fresh challenge ACK=%+v", transport.writes[1])
	}
	if transport.writes[2].Headers["CSeq"] != "3 ACK" || transport.writes[2].URI != "sip:carrier@198.51.100.1:5060" {
		t.Fatalf("final ACK=%+v", transport.writes[2])
	}
	if len(aka.rands) != 3 || !voiceAuthBytesEqual(aka.rands[1], staleNonce[:16]) || !voiceAuthBytesEqual(aka.rands[2], freshNonce[:16]) {
		t.Fatalf("AKA rands=%x", aka.rands)
	}
	if err := agent.EndVoiceCall(context.Background(), DialogInfo{CallID: "call-invite-aka-sync"}); err != nil {
		t.Fatalf("EndVoiceCall() error = %v", err)
	}
	if len(transport.requests) != 4 || transport.requests[3].Method != "BYE" || transport.requests[3].Headers["CSeq"] != "4 BYE" {
		t.Fatalf("BYE after AKA sync retry=%+v", transport.requests)
	}
}

func TestIMSOutboundAgentRetriesReinviteDigestChallenge(t *testing.T) {
	binding := testVoiceDigestBinding(t, "nonce-reinvite-old")
	transport := &fakeIMSVoiceTransport{responses: []voiceclient.SIPResponse{
		{
			StatusCode: 200,
			Reason:     "OK",
			Headers: map[string][]string{
				"To":      {"<sip:+18005551212@ims.example>;tag=remote-tag"},
				"Contact": {"<sip:carrier@198.51.100.1:5060>"},
			},
			Body: []byte(sampleSDP("203.0.113.10", 49170)),
		},
		{
			StatusCode: 407,
			Reason:     "Proxy Authentication Required",
			Headers: map[string][]string{
				"To":                 {"<sip:+18005551212@ims.example>;tag=remote-tag"},
				"Proxy-Authenticate": {`Digest realm="ims.example", nonce="nonce-reinvite-new", algorithm=MD5, qop="auth"`},
			},
		},
		{
			StatusCode: 200,
			Reason:     "OK",
			Headers: map[string][]string{
				"To":      {"<sip:+18005551212@ims.example>;tag=remote-tag"},
				"Contact": {"<sip:updated@198.51.100.2:5060>"},
				"X-IMS":   {"reinvite-auth-ok"},
			},
			Body: []byte(sampleSDP("203.0.113.20", 49180)),
		},
		{StatusCode: 200, Reason: "OK"},
	}}
	agent := &IMSOutboundAgent{
		Transport:    transport,
		Profile:      voiceclient.IMSProfile{IMPI: "impi@example", IMPU: "sip:user@ims.example", Domain: "ims.example"},
		Registration: binding,
	}
	if _, err := agent.StartOutboundCall(context.Background(), OutboundCallRequest{
		CallID: "call-reinvite-auth-retry",
		Callee: "+18005551212",
		RawSDP: []byte(sampleSDP("192.0.2.50", 4002)),
	}); err != nil {
		t.Fatalf("StartOutboundCall() error = %v", err)
	}
	result, err := agent.SendDialogReinvite(context.Background(), DialogReinviteRequest{
		CallID:      "call-reinvite-auth-retry",
		ContentType: "application/sdp",
		Body:        []byte(sampleSDP("192.0.2.60", 4010)),
		Headers:     map[string]string{"Session-Expires": "1800"},
	})
	if err != nil || !result.Accepted || result.Headers["X-IMS"] != "reinvite-auth-ok" {
		t.Fatalf("SendDialogReinvite() result=%+v err=%v", result, err)
	}
	if len(transport.requests) != 3 {
		t.Fatalf("requests=%+v", transport.requests)
	}
	firstReinvite := transport.requests[1]
	retryReinvite := transport.requests[2]
	if firstReinvite.Headers["CSeq"] != "2 INVITE" || retryReinvite.Headers["CSeq"] != "3 INVITE" {
		t.Fatalf("re-INVITE CSeqs=%q/%q", firstReinvite.Headers["CSeq"], retryReinvite.Headers["CSeq"])
	}
	if auth := retryReinvite.Headers["Proxy-Authorization"]; !strings.Contains(auth, `nonce="nonce-reinvite-new"`) ||
		!strings.Contains(auth, `uri="sip:carrier@198.51.100.1:5060"`) ||
		!strings.Contains(auth, `nc=00000001`) {
		t.Fatalf("retry re-INVITE Proxy-Authorization=%s", auth)
	}
	if retryReinvite.Headers["Session-Expires"] != "1800" || retryReinvite.Headers["Content-Type"] != "application/sdp" {
		t.Fatalf("retry re-INVITE headers=%+v", retryReinvite.Headers)
	}
	if len(transport.writes) != 3 || transport.writes[1].Method != "ACK" || transport.writes[2].Method != "ACK" {
		t.Fatalf("ACK writes=%+v", transport.writes)
	}
	if transport.writes[1].Headers["CSeq"] != "2 ACK" || transport.writes[1].Headers["Via"] != firstReinvite.Headers["Via"] {
		t.Fatalf("challenge ACK=%+v first=%+v", transport.writes[1], firstReinvite)
	}
	if transport.writes[2].Headers["CSeq"] != "3 ACK" || transport.writes[2].URI != "sip:updated@198.51.100.2:5060" {
		t.Fatalf("final ACK=%+v", transport.writes[2])
	}
	if err := agent.EndVoiceCall(context.Background(), DialogInfo{CallID: "call-reinvite-auth-retry"}); err != nil {
		t.Fatalf("EndVoiceCall() error = %v", err)
	}
	if len(transport.requests) != 4 || transport.requests[3].Method != "BYE" || transport.requests[3].Headers["CSeq"] != "4 BYE" {
		t.Fatalf("BYE after re-INVITE auth retry=%+v", transport.requests)
	}
}

func TestIMSOutboundAgentRetriesReinviteAKASyncFailureChallenge(t *testing.T) {
	registerNonce := append(voiceAuthBytesFrom(0x11, 16), voiceAuthBytesFrom(0x41, 16)...)
	staleNonce := append(voiceAuthBytesFrom(0x21, 16), voiceAuthBytesFrom(0x51, 16)...)
	freshNonce := append(voiceAuthBytesFrom(0x71, 16), voiceAuthBytesFrom(0x91, 16)...)
	aka := &voiceSyncFailureAKAProvider{auts: voiceAuthBytesFrom(0xD0, 14)}
	binding := testVoiceAKADigestBinding(t, registerNonce, aka)
	transport := &fakeIMSVoiceTransport{responses: []voiceclient.SIPResponse{
		{
			StatusCode: 200,
			Reason:     "OK",
			Headers: map[string][]string{
				"To":      {"<sip:+18005551212@ims.example>;tag=remote-tag"},
				"Contact": {"<sip:carrier@198.51.100.1:5060>"},
			},
			Body: []byte(sampleSDP("203.0.113.10", 49170)),
		},
		{
			StatusCode: 407,
			Reason:     "Proxy Authentication Required",
			Headers: map[string][]string{
				"To":                 {"<sip:+18005551212@ims.example>;tag=remote-tag"},
				"Proxy-Authenticate": {`Digest realm="ims.example", nonce="` + base64.StdEncoding.EncodeToString(staleNonce) + `", algorithm=AKAv1-MD5, qop="auth"`},
			},
		},
		{
			StatusCode: 407,
			Reason:     "Proxy Authentication Required",
			Headers: map[string][]string{
				"To":                 {"<sip:+18005551212@ims.example>;tag=remote-tag"},
				"Proxy-Authenticate": {`Digest realm="ims.example", nonce="` + base64.StdEncoding.EncodeToString(freshNonce) + `", algorithm=AKAv1-MD5, qop="auth"`},
			},
		},
		{
			StatusCode: 200,
			Reason:     "OK",
			Headers: map[string][]string{
				"To":      {"<sip:+18005551212@ims.example>;tag=remote-tag"},
				"Contact": {"<sip:updated@198.51.100.2:5060>"},
				"X-IMS":   {"reinvite-aka-ok"},
			},
			Body: []byte(sampleSDP("203.0.113.20", 49180)),
		},
		{StatusCode: 200, Reason: "OK"},
	}}
	agent := &IMSOutboundAgent{
		Transport:    transport,
		Profile:      voiceclient.IMSProfile{IMPI: "impi@example", IMPU: "sip:user@ims.example", Domain: "ims.example"},
		Registration: binding,
	}
	if _, err := agent.StartOutboundCall(context.Background(), OutboundCallRequest{
		CallID: "call-reinvite-aka-sync",
		Callee: "+18005551212",
		RawSDP: []byte(sampleSDP("192.0.2.50", 4002)),
	}); err != nil {
		t.Fatalf("StartOutboundCall() error = %v", err)
	}
	result, err := agent.SendDialogReinvite(context.Background(), DialogReinviteRequest{
		CallID:      "call-reinvite-aka-sync",
		ContentType: "application/sdp",
		Body:        []byte(sampleSDP("192.0.2.60", 4010)),
	})
	if err != nil || !result.Accepted || result.Headers["X-IMS"] != "reinvite-aka-ok" {
		t.Fatalf("SendDialogReinvite() result=%+v err=%v", result, err)
	}
	if len(transport.requests) != 4 {
		t.Fatalf("requests=%+v", transport.requests)
	}
	firstReinvite := transport.requests[1]
	syncReinvite := transport.requests[2]
	finalReinvite := transport.requests[3]
	if firstReinvite.Headers["CSeq"] != "2 INVITE" || syncReinvite.Headers["CSeq"] != "3 INVITE" || finalReinvite.Headers["CSeq"] != "4 INVITE" {
		t.Fatalf("re-INVITE CSeqs=%q/%q/%q", firstReinvite.Headers["CSeq"], syncReinvite.Headers["CSeq"], finalReinvite.Headers["CSeq"])
	}
	if auth := syncReinvite.Headers["Proxy-Authorization"]; !strings.Contains(auth, `nonce="`+base64.StdEncoding.EncodeToString(staleNonce)+`"`) ||
		!strings.Contains(auth, `auts="`+base64.StdEncoding.EncodeToString(aka.auts)+`"`) {
		t.Fatalf("sync re-INVITE Proxy-Authorization=%s", auth)
	}
	if auth := finalReinvite.Headers["Proxy-Authorization"]; strings.Contains(auth, `auts=`) ||
		!strings.Contains(auth, `nonce="`+base64.StdEncoding.EncodeToString(freshNonce)+`"`) ||
		!strings.Contains(auth, `nc=00000001`) {
		t.Fatalf("final re-INVITE Proxy-Authorization=%s", auth)
	}
	if len(transport.writes) != 4 || transport.writes[1].Headers["CSeq"] != "2 ACK" ||
		transport.writes[2].Headers["CSeq"] != "3 ACK" || transport.writes[3].Headers["CSeq"] != "4 ACK" {
		t.Fatalf("ACK writes=%+v", transport.writes)
	}
	if transport.writes[1].Headers["Via"] != firstReinvite.Headers["Via"] || transport.writes[2].Headers["Via"] != syncReinvite.Headers["Via"] ||
		transport.writes[3].URI != "sip:updated@198.51.100.2:5060" {
		t.Fatalf("re-INVITE ACK writes=%+v", transport.writes)
	}
	if len(aka.rands) != 3 || !voiceAuthBytesEqual(aka.rands[1], staleNonce[:16]) || !voiceAuthBytesEqual(aka.rands[2], freshNonce[:16]) {
		t.Fatalf("AKA rands=%x", aka.rands)
	}
	if err := agent.EndVoiceCall(context.Background(), DialogInfo{CallID: "call-reinvite-aka-sync"}); err != nil {
		t.Fatalf("EndVoiceCall() error = %v", err)
	}
	if len(transport.requests) != 5 || transport.requests[4].Method != "BYE" || transport.requests[4].Headers["CSeq"] != "5 BYE" {
		t.Fatalf("BYE after re-INVITE AKA retry=%+v", transport.requests)
	}
}

func testVoiceDigestBinding(t *testing.T, nonce string) voiceclient.RegistrationBinding {
	t.Helper()
	transport := &fakeVoiceRegisterTransport{responses: []voiceclient.RegisterResponse{
		{
			StatusCode: 401,
			Reason:     "Unauthorized",
			Headers: map[string][]string{
				"WWW-Authenticate": {`Digest realm="ims.example", nonce="` + nonce + `", algorithm=MD5, qop="auth"`},
			},
		},
		{
			StatusCode: 200,
			Reason:     "OK",
			Headers: map[string][]string{
				"Contact": {`<sip:user@192.0.2.10:5060>;expires=1800`},
			},
		},
	}}
	result, err := voiceclient.RegisterSession{
		Transport:    transport,
		Profile:      voiceclient.IMSProfile{IMPI: "impi@example", IMPU: "sip:user@ims.example", Domain: "ims.example"},
		RegistrarURI: "sip:ims.example",
		ContactURI:   "sip:user@192.0.2.10:5060",
		CallID:       "register-auth-info",
		CNonce:       "cnonce",
	}.Register(context.Background())
	if err != nil {
		t.Fatalf("Register() error = %v", err)
	}
	if !result.Registered || result.Binding.AuthSession == nil {
		t.Fatalf("registration result=%+v", result)
	}
	return result.Binding
}

func testVoiceAKADigestBinding(t *testing.T, nonce []byte, aka sim.AKAProvider) voiceclient.RegistrationBinding {
	t.Helper()
	transport := &fakeVoiceRegisterTransport{responses: []voiceclient.RegisterResponse{
		{
			StatusCode: 401,
			Reason:     "Unauthorized",
			Headers: map[string][]string{
				"WWW-Authenticate": {`Digest realm="ims.example", nonce="` + base64.StdEncoding.EncodeToString(nonce) + `", algorithm=AKAv1-MD5, qop="auth"`},
			},
		},
		{
			StatusCode: 200,
			Reason:     "OK",
			Headers: map[string][]string{
				"Contact": {`<sip:user@192.0.2.10:5060>;expires=1800`},
			},
		},
	}}
	result, err := voiceclient.RegisterSession{
		Transport:    transport,
		AKAProvider:  aka,
		Profile:      voiceclient.IMSProfile{IMPI: "impi@example", IMPU: "sip:user@ims.example", Domain: "ims.example"},
		RegistrarURI: "sip:ims.example",
		ContactURI:   "sip:user@192.0.2.10:5060",
		CallID:       "register-aka-auth-info",
		CNonce:       "cnonce",
	}.Register(context.Background())
	if err != nil {
		t.Fatalf("Register() error = %v", err)
	}
	if !result.Registered || result.Binding.AuthSession == nil {
		t.Fatalf("registration result=%+v", result)
	}
	return result.Binding
}

type voiceSyncFailureAKAProvider struct {
	auts  []byte
	rands [][]byte
	autns [][]byte
}

func (p *voiceSyncFailureAKAProvider) CalculateAKA(rand16, autn16 []byte) (sim.AKAResult, error) {
	p.rands = append(p.rands, append([]byte(nil), rand16...))
	p.autns = append(p.autns, append([]byte(nil), autn16...))
	switch len(p.rands) {
	case 2:
		return sim.AKAResult{AUTS: append([]byte(nil), p.auts...)}, sim.ErrSyncFailure
	default:
		return sim.AKAResult{RES: []byte{0x11, 0x22, 0x33, 0x44}}, nil
	}
}

func voiceAuthBytesFrom(start byte, n int) []byte {
	out := make([]byte, n)
	for i := range out {
		out[i] = start + byte(i)
	}
	return out
}

func voiceAuthBytesEqual(a, b []byte) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

type fakeVoiceRegisterTransport struct {
	responses []voiceclient.RegisterResponse
	requests  []voiceclient.RegisterMessage
}

func (t *fakeVoiceRegisterTransport) RoundTripRegister(ctx context.Context, msg voiceclient.RegisterMessage) (voiceclient.RegisterResponse, error) {
	t.requests = append(t.requests, msg)
	if len(t.responses) == 0 {
		return voiceclient.RegisterResponse{StatusCode: 500, Reason: "empty"}, nil
	}
	resp := t.responses[0]
	t.responses = t.responses[1:]
	return resp, nil
}
