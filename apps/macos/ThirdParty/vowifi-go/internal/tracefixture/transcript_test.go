package tracefixture

import (
	"encoding/json"
	"errors"
	"strconv"
	"strings"
	"testing"
)

func TestTranscriptJSONSchemaIsValid(t *testing.T) {
	if !json.Valid([]byte(TranscriptJSONSchema)) {
		t.Fatal("transcript JSON schema is not valid JSON")
	}
	var schema map[string]any
	if err := json.Unmarshal([]byte(TranscriptJSONSchema), &schema); err != nil {
		t.Fatalf("unmarshal transcript JSON schema: %v", err)
	}
	props, ok := schema["properties"].(map[string]any)
	if !ok {
		t.Fatalf("schema properties missing: %#v", schema["properties"])
	}
	schemaProp, ok := props["schema"].(map[string]any)
	if !ok || schemaProp["const"] != TranscriptSchemaVersion {
		t.Fatalf("schema const mismatch: %#v", props["schema"])
	}
}

func TestParseTranscriptJSONAcceptsRedactedTranscript(t *testing.T) {
	raw := marshalTranscript(t, Transcript{
		Schema: TranscriptSchemaVersion,
		Name:   "register-401-redacted",
		Events: []TranscriptEvent{
			{
				Label:     "initial-register",
				Direction: "outbound",
				Transport: "udp",
				Wire: strings.Join([]string{
					"REGISTER sip:ims.example.invalid SIP/2.0",
					"Via: SIP/2.0/UDP redacted.invalid:5060;branch=z9hG4bKfixture",
					"From: <sip:redacted.invalid>;tag=fixture",
					"To: <sip:redacted.invalid>",
					"Call-ID: fixture-call",
					"CSeq: 1 REGISTER",
					"Authorization: <redacted>",
					"Content-Length: 0",
					"",
					"",
				}, "\r\n"),
			},
		},
	})

	transcript, err := ParseTranscriptJSON(raw)
	if err != nil {
		t.Fatalf("ParseTranscriptJSON returned error: %v", err)
	}
	if transcript.Name != "register-401-redacted" || len(transcript.Events) != 1 {
		t.Fatalf("unexpected transcript: %#v", transcript)
	}
}

func TestParseTranscriptJSONRejectsSensitiveFixture(t *testing.T) {
	tests := []struct {
		name     string
		wire     string
		secret   string
		wantKind string
	}{
		{
			name:     "imsi",
			wire:     "X-IMSI: 001010000000000",
			secret:   "001010000000000",
			wantKind: "subscriber",
		},
		{
			name:     "imei",
			wire:     "X-IMEI: 004999010640000",
			secret:   "004999010640000",
			wantKind: "subscriber",
		},
		{
			name:     "msisdn",
			wire:     "To: <tel:+15550101234>",
			secret:   "+15550101234",
			wantKind: "msisdn",
		},
		{
			name:     "labelled msisdn",
			wire:     "X-MSISDN: 15550101234",
			secret:   "15550101234",
			wantKind: "msisdn",
		},
		{
			name:     "msisdn sip uri user",
			wire:     "P-Preferred-Identity: <sip:15550101234@ims.example.invalid;user=phone>",
			secret:   "15550101234",
			wantKind: "sip uri user identity",
		},
		{
			name:     "prefixed imsi sip uri user",
			wire:     "P-Associated-URI: <sip:imsi-001-01-0000000000@ims.example.invalid>",
			secret:   "001-01-0000000000",
			wantKind: "sip uri user identity",
		},
		{
			name:     "auth",
			wire:     `Authorization: Digest username="<redacted-sip-user-1>", nonce="auth-secret", response="auth-response"`,
			secret:   "auth-secret",
			wantKind: "auth",
		},
		{
			name:     "aka",
			wire:     "X-AKA: rand=00112233445566778899AABBCCDDEEFF",
			secret:   "00112233445566778899AABBCCDDEEFF",
			wantKind: "aka",
		},
		{
			name:     "aka nonce",
			wire:     "X-Debug-AKA: nonce=plainAKA",
			secret:   "plainAKA",
			wantKind: "auth",
		},
		{
			name:     "pani cell id",
			wire:     "P-Access-Network-Info: 3GPP-E-UTRAN-FDD;utran-cell-id-3gpp=310260ABCDEFFF",
			secret:   "310260ABCDEFFF",
			wantKind: "access network",
		},
		{
			name:     "mac address",
			wire:     "X-BSSID: 00:11:22:33:44:55",
			secret:   "00:11:22:33:44:55",
			wantKind: "mac",
		},
		{
			name:     "ip",
			wire:     "Via: SIP/2.0/UDP 192.0.2.10:5060;branch=z9hG4bKfixture",
			secret:   "192.0.2.10",
			wantKind: "ip",
		},
		{
			name:     "ipv6",
			wire:     "Via: SIP/2.0/TCP [2001:db8::10]:5060;branch=z9hG4bKfixture",
			secret:   "2001:db8::10",
			wantKind: "ip",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			raw := marshalTranscript(t, Transcript{
				Schema: TranscriptSchemaVersion,
				Name:   "sensitive-" + tt.name,
				Events: []TranscriptEvent{
					{
						Direction: "inbound",
						Transport: "udp",
						Wire:      tt.wire,
					},
				},
			})

			_, err := ParseTranscriptJSON(raw)
			if !errors.Is(err, ErrSensitiveFixture) {
				t.Fatalf("ParseTranscriptJSON error = %v, want ErrSensitiveFixture", err)
			}
			if strings.Contains(err.Error(), tt.secret) {
				t.Fatalf("redaction error leaked sensitive value %q: %v", tt.secret, err)
			}
			var redactionErr *RedactionError
			if !errors.As(err, &redactionErr) {
				t.Fatalf("error does not expose RedactionError: %T", err)
			}
			if len(redactionErr.Violations) == 0 {
				t.Fatal("redaction error had no violations")
			}
			if !strings.Contains(redactionErr.Violations[0].Kind, tt.wantKind) {
				t.Fatalf("violation kind = %q, want substring %q", redactionErr.Violations[0].Kind, tt.wantKind)
			}
		})
	}
}

func TestParseAndRedactTranscriptJSONSanitizesSensitiveFixture(t *testing.T) {
	raw := marshalTranscript(t, Transcript{
		Schema: TranscriptSchemaVersion,
		Name:   "register-001010123456789",
		Events: []TranscriptEvent{
			{
				Label:     "register-001010123456789",
				Direction: "outbound",
				Transport: "udp",
				Wire: strings.Join([]string{
					"REGISTER sip:ims.example.invalid SIP/2.0",
					"Via: SIP/2.0/UDP 192.0.2.10:5060;branch=z9hG4bKfixture1",
					"From: <sip:001010123456789@ims.example.invalid>;tag=fixture1",
					"To: <tel:+15550101234>",
					"Call-ID: fixture-call",
					"CSeq: 1 REGISTER",
					`Authorization: Digest username="001010123456789@ims.example.invalid", nonce="secret", response="0123456789abcdef0123456789abcdef"`,
					"Content-Length: 0",
					"",
					"",
				}, "\r\n"),
			},
			{
				Label:     "challenge-001010123456789",
				Direction: "inbound",
				Transport: "udp",
				Wire: strings.Join([]string{
					"SIP/2.0 401 Unauthorized",
					"Via: SIP/2.0/UDP 192.0.2.10:5060;branch=z9hG4bKfixture1",
					"From: <sip:001010123456789@ims.example.invalid>;tag=fixture1",
					"To: <tel:+15550101234>;tag=fixture2",
					"Call-ID: fixture-call",
					"CSeq: 1 REGISTER",
					`WWW-Authenticate: Digest realm="ims.example.invalid", nonce="secret"`,
					`Security-Server: ipsec-3gpp;alg=hmac-sha-1-96;spi-c=00112233;spi-s=44556677`,
					"Content-Length: 0",
					"",
					"",
				}, "\r\n"),
			},
		},
	})

	if _, err := ParseTranscriptJSON(raw); !errors.Is(err, ErrSensitiveFixture) {
		t.Fatalf("ParseTranscriptJSON error = %v, want ErrSensitiveFixture", err)
	}
	transcript, err := ParseAndRedactTranscriptJSON(raw)
	if err != nil {
		t.Fatalf("ParseAndRedactTranscriptJSON returned error: %v", err)
	}
	if err := ValidateTranscript(transcript); err != nil {
		t.Fatalf("redacted transcript did not validate: %v", err)
	}
	joined := transcript.Name + "\n" + transcript.Events[0].Label + "\n" + transcript.Events[0].Wire + "\n" + transcript.Events[1].Label + "\n" + transcript.Events[1].Wire
	for _, sensitive := range []string{
		"001010123456789",
		"+15550101234",
		"192.0.2.10",
		"0123456789abcdef0123456789abcdef",
		`nonce="secret"`,
		"00112233",
		"44556677",
	} {
		if strings.Contains(joined, sensitive) {
			t.Fatalf("redacted transcript still contains %q:\n%s", sensitive, joined)
		}
	}
	if strings.Count(joined, "sip:<redacted-sip-user-1>@<redacted-domain-1>.invalid") != 2 {
		t.Fatalf("shared SIP placeholder was not reused:\n%s", joined)
	}
	for _, want := range []string{
		"Authorization: <redacted>",
		"WWW-Authenticate: <redacted>",
		"Security-Server: <redacted>",
		"<redacted-id-1>",
		"tel:<redacted-msisdn-1>",
		"<redacted-ipv4-1>",
	} {
		if !strings.Contains(joined, want) {
			t.Fatalf("redacted transcript missing %q:\n%s", want, joined)
		}
	}
}

func TestParseAndRedactTranscriptJSONSanitizesE911VoiceSIPWithBody(t *testing.T) {
	outboundBody := strings.Join([]string{
		"v=0",
		"o=- 123456 1 IN IP4 192.0.2.44",
		"s=VoLTE emergency",
		"c=IN IP4 192.0.2.44",
		"m=audio 49170 RTP/AVP 0 8 96",
		"a=rtcp:49171 IN IP4 192.0.2.44",
		"",
	}, "\r\n")
	inboundBody := strings.Join([]string{
		"v=0",
		"o=- 654321 1 IN IP6 2001:db8::20",
		"s=VoLTE progress",
		"c=IN IP6 2001:db8::20",
		"m=audio 50000 RTP/AVP 0 8 96",
		"",
	}, "\r\n")
	raw := marshalTranscript(t, Transcript{
		Schema: TranscriptSchemaVersion,
		Name:   "e911-voice-001010123456789",
		Events: []TranscriptEvent{
			{
				Label:     "invite-001010123456789",
				Direction: "outbound",
				Transport: "udp",
				Wire: sipWireWithBody([]string{
					"INVITE urn:service:sos SIP/2.0",
					"Via: SIP/2.0/UDP 192.0.2.10:5060;branch=z9hG4bKfixture",
					"From: <sip:+15550101234@ims.example.invalid;user=phone>;tag=fixture",
					"To: <urn:service:sos>",
					"Call-ID: emergency-call",
					"CSeq: 1 INVITE",
					`Contact: <sip:001010123456789@[2001:db8::10]:5060;transport=udp>;+sip.instance="<urn:gsma:imei:49015420-323751-8>"`,
					`P-Access-Network-Info: 3GPP-E-UTRAN-FDD;utran-cell-id-3gpp=310260ABCDEFFF;ue-ip=2001:db8::10;ssid="Home WiFi"`,
					"Geolocation: <cid:pidf-001010123456789>",
					"Content-Type: application/sdp",
				}, outboundBody),
			},
			{
				Label:     "progress-001010123456789",
				Direction: "inbound",
				Transport: "udp",
				Wire: sipWireWithBody([]string{
					"SIP/2.0 183 Session Progress",
					"Via: SIP/2.0/UDP 192.0.2.10:5060;branch=z9hG4bKfixture",
					"From: <sip:+15550101234@ims.example.invalid;user=phone>;tag=fixture",
					"To: <urn:service:sos>;tag=fixture2",
					"Call-ID: emergency-call",
					"CSeq: 1 INVITE",
					"Contact: <sip:psap@example.net>",
					"Content-Type: application/sdp",
				}, inboundBody),
			},
		},
	})

	if _, err := ParseTranscriptJSON(raw); !errors.Is(err, ErrSensitiveFixture) {
		t.Fatalf("ParseTranscriptJSON error = %v, want ErrSensitiveFixture", err)
	}
	transcript, err := ParseAndRedactTranscriptJSON(raw)
	if err != nil {
		t.Fatalf("ParseAndRedactTranscriptJSON returned error: %v", err)
	}
	replay, err := NewReplay(transcript)
	if err != nil {
		t.Fatalf("NewReplay returned error: %v", err)
	}
	invite, err := replay.NextOutbound()
	if err != nil {
		t.Fatalf("NextOutbound returned error: %v", err)
	}
	inviteMsg, err := invite.SIPMessage()
	if err != nil {
		t.Fatalf("redacted INVITE did not parse: %v\n%s", err, string(invite.Wire))
	}
	if inviteMsg.Method != "INVITE" || inviteMsg.Header("Content-Length") != strconv.Itoa(len(inviteMsg.Body)) {
		t.Fatalf("unexpected redacted INVITE parse result: method=%q content-length=%q body=%d", inviteMsg.Method, inviteMsg.Header("Content-Length"), len(inviteMsg.Body))
	}
	progress, err := replay.NextInbound()
	if err != nil {
		t.Fatalf("NextInbound returned error: %v", err)
	}
	progressMsg, err := progress.SIPMessage()
	if err != nil {
		t.Fatalf("redacted progress response did not parse: %v\n%s", err, string(progress.Wire))
	}
	if progressMsg.StatusCode != 183 || progressMsg.Header("Content-Length") != strconv.Itoa(len(progressMsg.Body)) {
		t.Fatalf("unexpected redacted progress parse result: status=%d content-length=%q body=%d", progressMsg.StatusCode, progressMsg.Header("Content-Length"), len(progressMsg.Body))
	}

	joined := transcript.Name + "\n" + transcript.Events[0].Label + "\n" + transcript.Events[0].Wire + "\n" + transcript.Events[1].Label + "\n" + transcript.Events[1].Wire
	for _, sensitive := range []string{
		"001010123456789",
		"+15550101234",
		"49015420-323751-8",
		"310260ABCDEFFF",
		"192.0.2.10",
		"192.0.2.44",
		"2001:db8::10",
		"2001:db8::20",
		"Home WiFi",
	} {
		if strings.Contains(joined, sensitive) {
			t.Fatalf("redacted E911 voice transcript still contains %q:\n%s", sensitive, joined)
		}
	}
	for _, want := range []string{
		"INVITE urn:service:sos SIP/2.0",
		"Contact: <sip:<redacted-sip-user-2>@[<redacted-ipv6-1>]:5060;transport=udp>",
		"utran-cell-id-3gpp=<redacted-pani-1>",
		`ssid="<redacted-pani-2>"`,
		"c=IN IP4 <redacted-ipv4-2>",
		"c=IN IP6 <redacted-ipv6-2>",
	} {
		if !strings.Contains(joined, want) {
			t.Fatalf("redacted E911 voice transcript missing %q:\n%s", want, joined)
		}
	}
}

func TestParseTranscriptJSONRejectsInvalidShape(t *testing.T) {
	tests := []struct {
		name string
		raw  string
	}{
		{
			name: "unknown top-level field",
			raw:  `{"schema":"vowifi-go.tracefixture.transcript.v1","name":"x","events":[{"direction":"inbound","transport":"udp","wire":"SIP/2.0 200 OK\r\n\r\n"}],"extra":true}`,
		},
		{
			name: "wrong schema",
			raw:  `{"schema":"vowifi-go.tracefixture.transcript.v0","name":"x","events":[{"direction":"inbound","transport":"udp","wire":"SIP/2.0 200 OK\r\n\r\n"}]}`,
		},
		{
			name: "empty events",
			raw:  `{"schema":"vowifi-go.tracefixture.transcript.v1","name":"x","events":[]}`,
		},
		{
			name: "trailing json",
			raw:  `{"schema":"vowifi-go.tracefixture.transcript.v1","name":"x","events":[{"direction":"inbound","transport":"udp","wire":"SIP/2.0 200 OK\r\n\r\n"}]} {}`,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			_, err := ParseTranscriptJSON([]byte(tt.raw))
			if !errors.Is(err, ErrInvalidTranscript) {
				t.Fatalf("ParseTranscriptJSON error = %v, want ErrInvalidTranscript", err)
			}
		})
	}
}

func marshalTranscript(t *testing.T, transcript Transcript) []byte {
	t.Helper()
	raw, err := json.Marshal(transcript)
	if err != nil {
		t.Fatalf("marshal transcript: %v", err)
	}
	return raw
}

func sipWireWithBody(headers []string, body string) string {
	lines := append([]string(nil), headers...)
	lines = append(lines, "Content-Length: "+strconv.Itoa(len(body)), "", body)
	return strings.Join(lines, "\r\n")
}
