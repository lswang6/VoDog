package messaging

import (
	"context"
	"strings"
	"testing"

	"github.com/boa-z/vowifi-go/runtimehost/voiceclient"
)

func TestIMSSMSTransportAppliesDigestAuthenticationInfo(t *testing.T) {
	binding := testMessagingDigestBinding(t, "nonce-sms")
	transport := &fakeSIPRequestTransport{responses: []voiceclient.SIPResponse{
		{
			StatusCode: 202,
			Reason:     "Accepted",
			Headers:    map[string][]string{"Authentication-Info": {`nextnonce="nonce-sms-next"`}},
		},
		{StatusCode: 202, Reason: "Accepted"},
	}}
	sms := IMSSMSTransport{
		Transport:    transport,
		Profile:      voiceclient.IMSProfile{IMPI: "impi@example", IMPU: "sip:user@ims.example", Domain: "ims.example"},
		Registration: binding,
	}
	for i := 1; i <= 2; i++ {
		if _, err := sms.SendSMSPart(context.Background(), SMSSendRequest{
			Peer:      "+18005551212",
			MessageID: "auth-sms",
			Part:      SMSPart{PartNo: i, TotalParts: 2, Text: "hello"},
		}); err != nil {
			t.Fatalf("SendSMSPart(%d) error = %v", i, err)
		}
	}
	if len(transport.requests) != 2 {
		t.Fatalf("requests=%+v", transport.requests)
	}
	if auth := transport.requests[0].Headers["Authorization"]; !strings.Contains(auth, `nonce="nonce-sms"`) || !strings.Contains(auth, `nc=00000002`) {
		t.Fatalf("first MESSAGE Authorization=%s", auth)
	}
	if auth := transport.requests[1].Headers["Authorization"]; !strings.Contains(auth, `nonce="nonce-sms-next"`) || !strings.Contains(auth, `nc=00000001`) {
		t.Fatalf("second MESSAGE Authorization=%s", auth)
	}
}

func TestIMSSMSTransportRetriesDigestChallenge(t *testing.T) {
	binding := testMessagingDigestBinding(t, "nonce-sms-retry")
	transport := &fakeSIPRequestTransport{responses: []voiceclient.SIPResponse{
		{
			StatusCode: 401,
			Reason:     "Unauthorized",
			Headers: map[string][]string{
				"WWW-Authenticate": {`Digest realm="ims.example", nonce="nonce-sms-message", algorithm=MD5, qop="auth"`},
			},
		},
		{StatusCode: 202, Reason: "Accepted"},
	}}
	sms := IMSSMSTransport{
		Transport:    transport,
		Profile:      voiceclient.IMSProfile{IMPI: "impi@example", IMPU: "sip:user@ims.example", Domain: "ims.example"},
		Registration: binding,
	}
	result, err := sms.SendSMSPart(context.Background(), SMSSendRequest{
		Peer:      "+18005551212",
		MessageID: "auth-sms-retry",
		Part:      SMSPart{PartNo: 1, TotalParts: 1, Text: "hello"},
	})
	if err != nil || result.State != "accepted" || result.SIPCode != 202 {
		t.Fatalf("SendSMSPart() result=%+v err=%v", result, err)
	}
	if len(transport.requests) != 2 {
		t.Fatalf("requests=%+v", transport.requests)
	}
	if auth := transport.requests[1].Headers["Authorization"]; !strings.Contains(auth, `nonce="nonce-sms-message"`) ||
		!strings.Contains(auth, `uri="sip:+18005551212@ims.example"`) ||
		!strings.Contains(auth, `nc=00000001`) {
		t.Fatalf("retry MESSAGE Authorization=%s", auth)
	}
}

func TestIMSUSSDTransportAppliesDigestAuthenticationInfo(t *testing.T) {
	binding := testMessagingDigestBinding(t, "nonce-ussd")
	replyXML, err := BuildIMSUSSDXML(IMSUSSDPayload{Text: "Balance: 10", Operation: IMSUSSDOperationNotify})
	if err != nil {
		t.Fatalf("BuildIMSUSSDXML() error = %v", err)
	}
	transport := &fakeSIPRequestTransport{responses: []voiceclient.SIPResponse{
		{
			StatusCode: 200,
			Reason:     "OK",
			Headers: map[string][]string{
				"To":                  {"<sip:*100%23@ims.example;user=dialstring>;tag=as-tag"},
				"Contact":             {"<sip:ussd-as@ims.example>"},
				"Authentication-Info": {`nextnonce="nonce-ussd-next"`},
			},
		},
		{
			StatusCode: 200,
			Reason:     "OK",
			Headers:    map[string][]string{"Content-Type": {IMSUSSDContentType}},
			Body:       replyXML,
		},
	}}
	ussd := &IMSUSSDTransport{
		Transport:    transport,
		Profile:      voiceclient.IMSProfile{IMPI: "impi@example", IMPU: "sip:user@ims.example", Domain: "ims.example", LocalIP: "192.0.2.10"},
		Registration: binding,
	}
	if _, err := ussd.ExecuteUSSD(context.Background(), USSDRequest{SessionID: "auth-ussd", Command: "*100#"}); err != nil {
		t.Fatalf("ExecuteUSSD() error = %v", err)
	}
	if len(transport.writes) != 1 {
		t.Fatalf("writes=%+v", transport.writes)
	}
	if auth := transport.requests[0].Headers["Authorization"]; !strings.Contains(auth, `nonce="nonce-ussd"`) || !strings.Contains(auth, `nc=00000002`) {
		t.Fatalf("USSD INVITE Authorization=%s", auth)
	}
	if auth := transport.writes[0].Headers["Authorization"]; !strings.Contains(auth, `nonce="nonce-ussd-next"`) || !strings.Contains(auth, `nc=00000001`) {
		t.Fatalf("USSD ACK Authorization=%s", auth)
	}
	if _, err := ussd.ContinueUSSD(context.Background(), USSDRequest{SessionID: "auth-ussd", Input: "1"}); err != nil {
		t.Fatalf("ContinueUSSD() error = %v", err)
	}
	if len(transport.requests) != 2 {
		t.Fatalf("requests=%+v", transport.requests)
	}
	if auth := transport.requests[1].Headers["Authorization"]; !strings.Contains(auth, `nonce="nonce-ussd-next"`) || !strings.Contains(auth, `nc=00000002`) {
		t.Fatalf("USSD INFO Authorization=%s", auth)
	}
}

func TestIMSUSSDTransportRetriesDigestChallenge(t *testing.T) {
	binding := testMessagingDigestBinding(t, "nonce-ussd-retry")
	replyXML, err := BuildIMSUSSDXML(IMSUSSDPayload{Text: "Balance: 10", Operation: IMSUSSDOperationNotify})
	if err != nil {
		t.Fatalf("BuildIMSUSSDXML() error = %v", err)
	}
	transport := &fakeSIPRequestTransport{responses: []voiceclient.SIPResponse{
		{
			StatusCode: 200,
			Reason:     "OK",
			Headers: map[string][]string{
				"To":      {"<sip:*100%23@ims.example;user=dialstring>;tag=as-tag"},
				"Contact": {"<sip:ussd-as@ims.example>"},
			},
		},
		{
			StatusCode: 407,
			Reason:     "Proxy Authentication Required",
			Headers: map[string][]string{
				"Proxy-Authenticate": {`Digest realm="ims.example", nonce="nonce-ussd-info", algorithm=MD5, qop="auth"`},
			},
		},
		{
			StatusCode: 200,
			Reason:     "OK",
			Headers:    map[string][]string{"Content-Type": {IMSUSSDContentType}},
			Body:       replyXML,
		},
	}}
	ussd := &IMSUSSDTransport{
		Transport:    transport,
		Profile:      voiceclient.IMSProfile{IMPI: "impi@example", IMPU: "sip:user@ims.example", Domain: "ims.example", LocalIP: "192.0.2.10"},
		Registration: binding,
	}
	if _, err := ussd.ExecuteUSSD(context.Background(), USSDRequest{SessionID: "auth-ussd-retry", Command: "*100#"}); err != nil {
		t.Fatalf("ExecuteUSSD() error = %v", err)
	}
	if _, err := ussd.ContinueUSSD(context.Background(), USSDRequest{SessionID: "auth-ussd-retry", Input: "1"}); err != nil {
		t.Fatalf("ContinueUSSD() error = %v", err)
	}
	if len(transport.requests) != 3 {
		t.Fatalf("requests=%+v", transport.requests)
	}
	initial := transport.requests[1]
	retry := transport.requests[2]
	if initial.Method != "INFO" || retry.Method != "INFO" {
		t.Fatalf("requests=%+v", transport.requests)
	}
	if auth := retry.Headers["Proxy-Authorization"]; !strings.Contains(auth, `nonce="nonce-ussd-info"`) ||
		!strings.Contains(auth, `uri="sip:ussd-as@ims.example"`) ||
		!strings.Contains(auth, `nc=00000001`) {
		t.Fatalf("retry INFO Proxy-Authorization=%s", auth)
	}
}

func testMessagingDigestBinding(t *testing.T, nonce string) voiceclient.RegistrationBinding {
	t.Helper()
	transport := &fakeMessagingRegisterTransport{responses: []voiceclient.RegisterResponse{
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
			Headers:    map[string][]string{"Contact": {`<sip:user@192.0.2.10:5060>;expires=1800`}},
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

type fakeMessagingRegisterTransport struct {
	responses []voiceclient.RegisterResponse
	requests  []voiceclient.RegisterMessage
}

func (t *fakeMessagingRegisterTransport) RoundTripRegister(ctx context.Context, msg voiceclient.RegisterMessage) (voiceclient.RegisterResponse, error) {
	t.requests = append(t.requests, msg)
	if len(t.responses) == 0 {
		return voiceclient.RegisterResponse{StatusCode: 500, Reason: "empty"}, nil
	}
	resp := t.responses[0]
	t.responses = t.responses[1:]
	return resp, nil
}
