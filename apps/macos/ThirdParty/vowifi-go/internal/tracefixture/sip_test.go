package tracefixture

import (
	"errors"
	"os"
	"reflect"
	"strconv"
	"strings"
	"testing"
)

func TestReplayEventSIPMessageParsesRegisterFixtureSemantics(t *testing.T) {
	raw, err := os.ReadFile("testdata/register_401_redacted.transcript.json")
	if err != nil {
		t.Fatalf("read fixture: %v", err)
	}
	replay, err := ParseReplayJSON(raw)
	if err != nil {
		t.Fatalf("ParseReplayJSON returned error: %v", err)
	}

	initial, err := replay.NextOutbound()
	if err != nil {
		t.Fatalf("NextOutbound initial register: %v", err)
	}
	initialMsg, err := initial.SIPMessage()
	if err != nil {
		t.Fatalf("initial register SIPMessage: %v", err)
	}
	if !initialMsg.IsRequest || initialMsg.IsStatus {
		t.Fatalf("initial message type = request:%v status:%v, want request", initialMsg.IsRequest, initialMsg.IsStatus)
	}
	if initialMsg.Method != "REGISTER" || initialMsg.RequestURI != "sip:ims.example.invalid" || initialMsg.Version != "SIP/2.0" {
		t.Fatalf("unexpected initial request line: %#v", initialMsg)
	}
	if initialMsg.Header("Call-ID") != "fixture-call" || initialMsg.Header("CSeq") != "1 REGISTER" {
		t.Fatalf("unexpected initial correlation headers: Call-ID=%q CSeq=%q", initialMsg.Header("Call-ID"), initialMsg.Header("CSeq"))
	}
	seq, method, ok := initialMsg.CSeq()
	if !ok || seq != 1 || method != "REGISTER" {
		t.Fatalf("initial CSeq = %d %q ok=%v, want 1 REGISTER true", seq, method, ok)
	}
	if got := initialMsg.Header("Content-Length"); got != "0" {
		t.Fatalf("initial Content-Length = %q, want 0", got)
	}
	if len(initialMsg.Body) != 0 {
		t.Fatalf("initial body length = %d, want 0", len(initialMsg.Body))
	}

	challenge, err := replay.NextInbound()
	if err != nil {
		t.Fatalf("NextInbound challenge: %v", err)
	}
	challengeMsg, err := challenge.SIPMessage()
	if err != nil {
		t.Fatalf("challenge SIPMessage: %v", err)
	}
	if !challengeMsg.IsStatus || challengeMsg.IsRequest {
		t.Fatalf("challenge message type = request:%v status:%v, want status", challengeMsg.IsRequest, challengeMsg.IsStatus)
	}
	if challengeMsg.Version != "SIP/2.0" || challengeMsg.StatusCode != 401 || challengeMsg.Reason != "Unauthorized" {
		t.Fatalf("unexpected challenge status line: %#v", challengeMsg)
	}
	if challengeMsg.Header("WWW-Authenticate") != "<redacted>" || challengeMsg.Header("Security-Server") != "<redacted>" {
		t.Fatalf("challenge auth headers not preserved as redacted values: WWW-Authenticate=%q Security-Server=%q",
			challengeMsg.Header("WWW-Authenticate"), challengeMsg.Header("Security-Server"))
	}
	seq, method, ok = challengeMsg.CSeq()
	if !ok || seq != 1 || method != "REGISTER" {
		t.Fatalf("challenge CSeq = %d %q ok=%v, want 1 REGISTER true", seq, method, ok)
	}

	authenticated, err := replay.NextOutbound()
	if err != nil {
		t.Fatalf("NextOutbound authenticated register: %v", err)
	}
	authenticatedMsg, err := authenticated.SIPMessage()
	if err != nil {
		t.Fatalf("authenticated register SIPMessage: %v", err)
	}
	if !authenticatedMsg.IsRequest || authenticatedMsg.Method != "REGISTER" || authenticatedMsg.Header("Authorization") != "<redacted>" {
		t.Fatalf("unexpected authenticated request: %#v", authenticatedMsg)
	}
	seq, method, ok = authenticatedMsg.CSeq()
	if !ok || seq != 2 || method != "REGISTER" {
		t.Fatalf("authenticated CSeq = %d %q ok=%v, want 2 REGISTER true", seq, method, ok)
	}
	if authenticatedMsg.Header("Security-Verify") != "<redacted>" {
		t.Fatalf("authenticated Security-Verify = %q, want redacted", authenticatedMsg.Header("Security-Verify"))
	}

	okEvent, err := replay.NextInbound()
	if err != nil {
		t.Fatalf("NextInbound register ok: %v", err)
	}
	okMsg, err := okEvent.SIPMessage()
	if err != nil {
		t.Fatalf("register ok SIPMessage: %v", err)
	}
	if !okMsg.IsStatus || okMsg.StatusCode != 200 || okMsg.Reason != "OK" {
		t.Fatalf("unexpected register ok status: %#v", okMsg)
	}
	seq, method, ok = okMsg.CSeq()
	if !ok || seq != 2 || method != "REGISTER" {
		t.Fatalf("register ok CSeq = %d %q ok=%v, want 2 REGISTER true", seq, method, ok)
	}
	if got := okMsg.Header("P-Associated-URI"); got == "" {
		t.Fatalf("register ok missing P-Associated-URI")
	}
}

func TestParseSIPMessageValidatesBodyAgainstContentLength(t *testing.T) {
	wire := []byte(strings.Join([]string{
		"MESSAGE sip:ims.example.invalid SIP/2.0",
		"Call-ID: fixture-call",
		"CSeq: 3 MESSAGE",
		"Content-Length: 5",
		"Content-Length: 5",
		"",
		"hello",
	}, "\r\n"))
	msg, err := ParseSIPMessage(wire)
	if err != nil {
		t.Fatalf("ParseSIPMessage valid body returned error: %v", err)
	}
	wire[len(wire)-1] = '!'
	if !msg.IsRequest || msg.Method != "MESSAGE" || string(msg.Body) != "hello" {
		t.Fatalf("unexpected parsed message: %#v", msg)
	}

	tests := []struct {
		name string
		wire string
	}{
		{
			name: "short body",
			wire: "MESSAGE sip:ims.example.invalid SIP/2.0\r\nContent-Length: 5\r\n\r\nhey",
		},
		{
			name: "long body",
			wire: "MESSAGE sip:ims.example.invalid SIP/2.0\r\nContent-Length: 1\r\n\r\nhello",
		},
		{
			name: "conflicting duplicate length",
			wire: "MESSAGE sip:ims.example.invalid SIP/2.0\r\nContent-Length: 5\r\nl: 4\r\n\r\nhello",
		},
		{
			name: "body without length",
			wire: "MESSAGE sip:ims.example.invalid SIP/2.0\r\nCall-ID: fixture-call\r\n\r\nhello",
		},
		{
			name: "missing terminator",
			wire: "MESSAGE sip:ims.example.invalid SIP/2.0\r\nContent-Length: 0",
		},
		{
			name: "bad request line",
			wire: "MESSAGE sip:ims.example.invalid\r\nContent-Length: 0\r\n\r\n",
		},
		{
			name: "bad status code",
			wire: "SIP/2.0 nope Broken\r\nContent-Length: 0\r\n\r\n",
		},
		{
			name: "bad header",
			wire: "SIP/2.0 200 OK\r\nBroken-Header\r\nContent-Length: 0\r\n\r\n",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			_, err := ParseSIPMessage([]byte(tt.wire))
			if !errors.Is(err, ErrInvalidSIPMessage) {
				t.Fatalf("ParseSIPMessage error = %v, want ErrInvalidSIPMessage", err)
			}
		})
	}
}

func TestSIPMessageHeaderLookupIsCaseInsensitiveAndDefensive(t *testing.T) {
	msg, err := ParseSIPMessage([]byte(strings.Join([]string{
		"SIP/2.0 200 OK",
		"i: fixture-call",
		"cseq: 7 message",
		"v: SIP/2.0/UDP ue.redacted.invalid:5060",
		" ;branch=z9hG4bKfixture",
		"l: 0",
		"",
		"",
	}, "\n")))
	if err != nil {
		t.Fatalf("ParseSIPMessage returned error: %v", err)
	}

	if got := msg.Header("call-id"); got != "fixture-call" {
		t.Fatalf("Call-ID = %q, want fixture-call", got)
	}
	if got := msg.Header("Content-Length"); got != "0" {
		t.Fatalf("Content-Length = %q, want 0", got)
	}
	if got := msg.Header("Via"); got != "SIP/2.0/UDP ue.redacted.invalid:5060 ;branch=z9hG4bKfixture" {
		t.Fatalf("folded Via = %q", got)
	}
	seq, method, ok := msg.CSeq()
	if !ok || seq != 7 || method != "MESSAGE" {
		t.Fatalf("CSeq = %d %q ok=%v, want 7 MESSAGE true", seq, method, ok)
	}

	values := msg.HeaderValues("Via")
	values[0] = "mutated"
	if got := msg.Header("Via"); got == "mutated" {
		t.Fatalf("HeaderValues exposed mutable internal slice")
	}
}

func TestSIPMessageMultipartLeavesExposeMetadata(t *testing.T) {
	body := strings.Join([]string{
		"--outer",
		"Content-Type: application/sdp",
		"Content-Disposition: session;handling=required",
		"Content-ID: <sdp>",
		"",
		"v=0",
		"m=audio 49170 RTP/AVP 0",
		"--outer",
		"Content-Type: multipart/mixed; boundary=inner",
		"",
		"--inner",
		"Content-Type: application/vnd.3gpp.sms",
		"Content-ID: <sms>",
		"",
		"sms-body",
		"--inner--",
		"--outer--",
		"",
	}, "\r\n")
	wire := []byte(strings.Join([]string{
		"MESSAGE sip:ims.example.invalid SIP/2.0",
		"Call-ID: fixture-call",
		"CSeq: 8 MESSAGE",
		"Content-Type: multipart/mixed; boundary=outer",
		"Content-Length: " + strconv.Itoa(len(body)),
		"",
		body,
	}, "\r\n"))

	msg, err := ParseSIPMessage(wire)
	if err != nil {
		t.Fatalf("ParseSIPMessage returned error: %v", err)
	}
	mediaType, params, ok, err := msg.ContentType()
	if err != nil {
		t.Fatalf("ContentType returned error: %v", err)
	}
	if !ok || mediaType != "multipart/mixed" || params["boundary"] != "outer" {
		t.Fatalf("ContentType = %q %#v ok=%v, want multipart/mixed boundary outer", mediaType, params, ok)
	}

	leaves, err := msg.MultipartLeaves()
	if err != nil {
		t.Fatalf("MultipartLeaves returned error: %v", err)
	}
	if len(leaves) != 2 {
		t.Fatalf("leaf count = %d, want 2: %#v", len(leaves), leaves)
	}
	if !reflect.DeepEqual(leaves[0].Path, []int{0}) {
		t.Fatalf("first leaf path = %#v, want [0]", leaves[0].Path)
	}
	if leaves[0].ContentType != "application/sdp" || leaves[0].ContentDisposition != "session;handling=required" || leaves[0].ContentID != "<sdp>" {
		t.Fatalf("first leaf metadata = %#v", leaves[0])
	}
	if string(leaves[0].Body) != "v=0\r\nm=audio 49170 RTP/AVP 0" {
		t.Fatalf("first leaf body = %q", string(leaves[0].Body))
	}
	if !reflect.DeepEqual(leaves[1].Path, []int{1, 0}) {
		t.Fatalf("second leaf path = %#v, want [1 0]", leaves[1].Path)
	}
	if leaves[1].ContentType != "application/vnd.3gpp.sms" || leaves[1].Header("content-id") != "<sms>" || string(leaves[1].Body) != "sms-body" {
		t.Fatalf("second leaf metadata/body = %#v body=%q", leaves[1], string(leaves[1].Body))
	}

	leaves[0].Headers["Content-Type"][0] = "mutated"
	leaves[0].Body[0] = 'X'
	again, err := msg.MultipartLeaves()
	if err != nil {
		t.Fatalf("MultipartLeaves after mutation returned error: %v", err)
	}
	if again[0].ContentType != "application/sdp" || string(again[0].Body) != "v=0\r\nm=audio 49170 RTP/AVP 0" {
		t.Fatalf("MultipartLeaves exposed mutable internal state: %#v body=%q", again[0], string(again[0].Body))
	}
}

func TestSIPMessageMultipartLeavesRejectMalformedContentType(t *testing.T) {
	wireWithBody := func(contentType, body string) string {
		return strings.Join([]string{
			"MESSAGE sip:ims.example.invalid SIP/2.0",
			"Content-Type: " + contentType,
			"Content-Length: " + strconv.Itoa(len(body)),
			"",
			body,
		}, "\r\n")
	}
	nestedBody := strings.Join([]string{
		"--outer",
		"Content-Type: multipart/mixed",
		"",
		"nested",
		"--outer--",
		"",
	}, "\r\n")
	tests := []struct {
		name string
		wire string
	}{
		{
			name: "top level missing boundary",
			wire: wireWithBody("multipart/mixed", ""),
		},
		{
			name: "nested missing boundary",
			wire: wireWithBody("multipart/mixed; boundary=outer", nestedBody),
		},
		{
			name: "invalid content type",
			wire: wireWithBody("multipart/mixed; boundary", ""),
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			msg, err := ParseSIPMessage([]byte(tt.wire))
			if err != nil {
				t.Fatalf("ParseSIPMessage returned error: %v", err)
			}
			_, err = msg.MultipartLeaves()
			if !errors.Is(err, ErrInvalidSIPMessage) {
				t.Fatalf("MultipartLeaves error = %v, want ErrInvalidSIPMessage", err)
			}
		})
	}
}
