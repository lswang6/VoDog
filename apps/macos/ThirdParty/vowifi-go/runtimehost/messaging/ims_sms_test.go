package messaging

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/boa-z/vowifi-go/runtimehost/voiceclient"
)

func TestIMSSMSTransportSendsSIPMessage(t *testing.T) {
	transport := &fakeSIPRequestTransport{responses: []voiceclient.SIPResponse{{StatusCode: 202, Reason: "Accepted"}}}
	sms := IMSSMSTransport{
		Transport: transport,
		Profile:   voiceclient.IMSProfile{IMPU: "sip:user@ims.example", Domain: "ims.example", UserAgent: "VoHive"},
		Registration: voiceclient.RegistrationBinding{
			ContactURI:     "sip:user@192.0.2.10:5060",
			PublicIdentity: "sip:user@ims.example",
			ServiceRoutes:  []string{"<sip:pcscf.ims.example;lr>"},
		},
	}

	result, err := sms.SendSMSPart(context.Background(), SMSSendRequest{
		DeviceID:  "dev-1",
		IMSI:      "310280000000001",
		Peer:      "+18005551212",
		MessageID: "msg-1",
		Part:      SMSPart{PartNo: 2, TotalParts: 2, Text: "hello", Encoding: "gsm7"},
	})
	if err != nil {
		t.Fatalf("SendSMSPart() error = %v", err)
	}
	if result.State != "accepted" || result.SIPCode != 202 || result.RPMR != 2 || result.CallID != "msg-1-2@vowifi-go" {
		t.Fatalf("result=%+v", result)
	}
	if len(transport.requests) != 1 {
		t.Fatalf("requests=%d", len(transport.requests))
	}
	req := transport.requests[0]
	if req.Method != "MESSAGE" || req.URI != "sip:+18005551212@ims.example" {
		t.Fatalf("MESSAGE=%+v body=%q", req, req.Body)
	}
	if req.Headers["Route"] != "<sip:pcscf.ims.example;lr>" || req.Headers["Content-Type"] != IMS3GPPSMSContentType {
		t.Fatalf("headers=%+v", req.Headers)
	}
	rpMR, tpdu, err := ParseSMSRPData(req.Body)
	if err != nil {
		t.Fatalf("ParseSMSRPData() error = %v body=%x", err, req.Body)
	}
	if rpMR != 2 || len(tpdu) == 0 || tpdu[0] != 0x21 || !strings.HasSuffix(strings.ToUpper(hexString(req.Body)), "E8329BFD06") {
		t.Fatalf("RP-DATA rpMR=%d tpdu=%x body=%x", rpMR, tpdu, req.Body)
	}
	if req.Headers["P-Preferred-Service"] != "urn:urn-7:3gpp-service.ims.icsi.sms" || req.Headers["Accept-Contact"] != "*;+g.3gpp.smsip" {
		t.Fatalf("SMS service headers=%+v", req.Headers)
	}
	if !strings.Contains(req.Headers["From"], "sip:user@ims.example") || !strings.Contains(req.Headers["To"], "sip:+18005551212@ims.example") {
		t.Fatalf("dialog headers=%+v", req.Headers)
	}
}

func TestIMSSMSTransportCanDisableStatusReports(t *testing.T) {
	transport := &fakeSIPRequestTransport{responses: []voiceclient.SIPResponse{{StatusCode: 202, Reason: "Accepted"}}}
	sms := IMSSMSTransport{
		Transport:            transport,
		DisableStatusReports: true,
		Profile:              voiceclient.IMSProfile{IMPU: "sip:user@ims.example", Domain: "ims.example"},
		Registration:         voiceclient.RegistrationBinding{ContactURI: "sip:user@192.0.2.10:5060", PublicIdentity: "sip:user@ims.example"},
	}

	if _, err := sms.SendSMSPart(context.Background(), SMSSendRequest{
		Peer: "+18005551212",
		Part: SMSPart{PartNo: 1, TotalParts: 1, Text: "hello"},
	}); err != nil {
		t.Fatalf("SendSMSPart() error = %v", err)
	}
	if len(transport.requests) != 1 {
		t.Fatalf("requests=%+v", transport.requests)
	}
	_, tpdu, err := ParseSMSRPData(transport.requests[0].Body)
	if err != nil {
		t.Fatalf("ParseSMSRPData() error = %v", err)
	}
	if len(tpdu) == 0 || tpdu[0] != 0x01 {
		t.Fatalf("TPDU first octet=0x%02x want 0x01", tpdu[0])
	}
}

func TestIMSSMSTransportCanWrap3GPPSMSInCPIMWithIMDN(t *testing.T) {
	transport := &fakeSIPRequestTransport{responses: []voiceclient.SIPResponse{{StatusCode: 202, Reason: "Accepted"}}}
	sms := IMSSMSTransport{
		Transport: transport,
		UseCPIM:   true,
		Profile:   voiceclient.IMSProfile{IMPU: "sip:user@ims.example", Domain: "ims.example"},
		Registration: voiceclient.RegistrationBinding{
			ContactURI:     "sip:user@192.0.2.10:5060",
			PublicIdentity: "sip:user@ims.example",
		},
	}

	result, err := sms.SendSMSPart(context.Background(), SMSSendRequest{
		Peer:      "+18005551212",
		MessageID: "cpim sms",
		Part:      SMSPart{PartNo: 1, TotalParts: 1, Text: "hello"},
	})
	if err != nil || result.State != "accepted" {
		t.Fatalf("SendSMSPart() result=%+v err=%v", result, err)
	}
	if len(transport.requests) != 1 {
		t.Fatalf("requests=%+v", transport.requests)
	}
	req := transport.requests[0]
	if req.Headers["Content-Type"] != IMSCPIMContentType {
		t.Fatalf("MESSAGE Content-Type=%q want %q", req.Headers["Content-Type"], IMSCPIMContentType)
	}
	cpim, err := ParseIMSCPIMMessage(req.Body)
	if err != nil {
		t.Fatalf("ParseIMSCPIMMessage() error = %v body=%s", err, req.Body)
	}
	if cpim.ContentType != IMS3GPPSMSContentType {
		t.Fatalf("CPIM content type=%q want %q", cpim.ContentType, IMS3GPPSMSContentType)
	}
	imdn := ParseIMSCPIMIMDNDispositionRequest(cpim)
	if imdn.MessageID != "cpim-sms-1@vowifi-go" || !imdn.Required || !imdn.PositiveDelivery || !imdn.NegativeDelivery || imdn.Display {
		t.Fatalf("IMDN request=%+v headers=%+v", imdn, cpim.Headers)
	}
	if got := imsHeaderValue(cpim.Headers, "From"); got != "sip:user@ims.example" {
		t.Fatalf("CPIM From=%q", got)
	}
	if got := imsHeaderValue(cpim.Headers, "To"); got != "sip:+18005551212@ims.example" {
		t.Fatalf("CPIM To=%q", got)
	}
	rpMR, tpdu, err := ParseSMSRPData(cpim.Body)
	if err != nil {
		t.Fatalf("ParseSMSRPData(CPIM body) error = %v body=%x", err, cpim.Body)
	}
	if rpMR != 1 || len(tpdu) == 0 || tpdu[0] != 0x21 {
		t.Fatalf("CPIM RP-DATA rpMR=%d tpdu=%x", rpMR, tpdu)
	}
}

func TestIMSSMSTransportCPIMHonorsCustomIMDNNotifications(t *testing.T) {
	transport := &fakeSIPRequestTransport{responses: []voiceclient.SIPResponse{{StatusCode: 202, Reason: "Accepted"}}}
	sms := IMSSMSTransport{
		Transport:            transport,
		UseCPIM:              true,
		IMDNNotifications:    []string{IMSIMDNDispositionDisplay},
		DisableStatusReports: true,
		Profile:              voiceclient.IMSProfile{IMPU: "sip:user@ims.example", Domain: "ims.example"},
		Registration:         voiceclient.RegistrationBinding{ContactURI: "sip:user@192.0.2.10:5060", PublicIdentity: "sip:user@ims.example"},
	}
	if _, err := sms.SendSMSPart(context.Background(), SMSSendRequest{Peer: "+18005551212", Part: SMSPart{PartNo: 1, Text: "hello"}}); err != nil {
		t.Fatalf("SendSMSPart() error = %v", err)
	}
	cpim, err := ParseIMSCPIMMessage(transport.requests[0].Body)
	if err != nil {
		t.Fatalf("ParseIMSCPIMMessage() error = %v", err)
	}
	imdn := ParseIMSCPIMIMDNDispositionRequest(cpim)
	if !imdn.Display || imdn.PositiveDelivery || imdn.NegativeDelivery {
		t.Fatalf("custom IMDN request=%+v", imdn)
	}
	_, tpdu, err := ParseSMSRPData(cpim.Body)
	if err != nil {
		t.Fatalf("ParseSMSRPData() error = %v", err)
	}
	if len(tpdu) == 0 || tpdu[0] != 0x01 {
		t.Fatalf("TPDU first octet=0x%02x want 0x01 with status reports disabled", tpdu[0])
	}
}

func TestIMSSMSTransportFollowsRedirectContact(t *testing.T) {
	transport := &fakeSIPRequestTransport{responses: []voiceclient.SIPResponse{
		{
			StatusCode: 302,
			Reason:     "Moved Temporarily",
			Headers:    map[string][]string{"Contact": {"<sip:sms-as@ims.example>"}},
		},
		{StatusCode: 202, Reason: "Accepted"},
	}}
	sms := IMSSMSTransport{
		Transport: transport,
		Profile:   voiceclient.IMSProfile{IMPU: "sip:user@ims.example", Domain: "ims.example"},
		Registration: voiceclient.RegistrationBinding{
			ContactURI:     "sip:user@192.0.2.10:5060",
			PublicIdentity: "sip:user@ims.example",
		},
	}

	result, err := sms.SendSMSPart(context.Background(), SMSSendRequest{
		Peer:      "+18005551212",
		MessageID: "sms-redirect",
		Part:      SMSPart{PartNo: 1, TotalParts: 1, Text: "hello"},
	})
	if err != nil || result.State != "accepted" || result.SIPCode != 202 {
		t.Fatalf("SendSMSPart() result=%+v err=%v", result, err)
	}
	if len(transport.requests) != 2 {
		t.Fatalf("requests=%+v", transport.requests)
	}
	first := transport.requests[0]
	redirect := transport.requests[1]
	if first.URI != "sip:+18005551212@ims.example" || first.Headers["CSeq"] != "1 MESSAGE" {
		t.Fatalf("first MESSAGE=%+v", first)
	}
	if redirect.URI != "sip:sms-as@ims.example" || redirect.Headers["CSeq"] != "2 MESSAGE" {
		t.Fatalf("redirect MESSAGE=%+v", redirect)
	}
	firstMR, firstTPDU, err := ParseSMSRPData(first.Body)
	if err != nil {
		t.Fatalf("ParseSMSRPData(first) error = %v", err)
	}
	redirectMR, redirectTPDU, err := ParseSMSRPData(redirect.Body)
	if err != nil {
		t.Fatalf("ParseSMSRPData(redirect) error = %v", err)
	}
	if firstMR != 1 || redirectMR != 1 || string(firstTPDU) != string(redirectTPDU) {
		t.Fatalf("RP-DATA changed firstMR=%d redirectMR=%d first=%x redirect=%x", firstMR, redirectMR, firstTPDU, redirectTPDU)
	}
}

func TestIMSMessagingRedirectContactSelectionHonorsQAndExpires(t *testing.T) {
	resp := voiceclient.SIPResponse{
		StatusCode: 302,
		Reason:     "Moved Temporarily",
		Headers: map[string][]string{
			"Contact": {
				"<sip:expired@ims.example>;expires=0, <sip:low@ims.example>;q=0.1",
				"<tel:+18005551212>;q=1, <sip:backup@ims.example>;q=0.4",
				"<sips:preferred@ims.example>;q=0.9, <sip:low@ims.example>;q=0.2",
			},
		},
	}

	contacts := messagingRedirectContactURIs(resp.Headers)
	if got, want := strings.Join(contacts, "|"), "sips:preferred@ims.example|sip:backup@ims.example|sip:low@ims.example"; got != want {
		t.Fatalf("messagingRedirectContactURIs()=%q want %q", got, want)
	}
	if target := firstMessagingRedirectContactURI(resp); target != "sips:preferred@ims.example" {
		t.Fatalf("firstMessagingRedirectContactURI()=%q", target)
	}
}

func TestIMSMessagingResponseHandlingClassifiesRedirectAndAuth(t *testing.T) {
	redirect := imsMessagingResponseHandlingFor(voiceclient.SIPResponse{
		StatusCode: 302,
		Reason:     "Moved Temporarily",
		Headers: map[string][]string{
			"Contact": {"<tel:+18005551212>", "<sip:sms-as@ims.example>;expires=60"},
		},
	})
	if redirect.RedirectURI != "sip:sms-as@ims.example" || redirect.FailureText != "Moved Temporarily" {
		t.Fatalf("redirect handling=%+v", redirect)
	}
	if redirect.AuthChallengeHeader != "" || redirect.AuthAuthorizationHeader != "" || redirect.AuthChallenge != "" {
		t.Fatalf("redirect auth handling=%+v", redirect)
	}

	unauthorized := imsMessagingResponseHandlingFor(voiceclient.SIPResponse{
		StatusCode: 401,
		Reason:     "Unauthorized",
		Headers: map[string][]string{
			"WWW-Authenticate": {`Digest realm="ims.example", nonce="n1"`},
			"Retry-After":      {"4"},
		},
	})
	if unauthorized.AuthChallengeHeader != "WWW-Authenticate" || unauthorized.AuthAuthorizationHeader != "Authorization" || !strings.Contains(unauthorized.AuthChallenge, `nonce="n1"`) {
		t.Fatalf("unauthorized handling=%+v", unauthorized)
	}
	if unauthorized.RetryAfter != 4*time.Second || unauthorized.FailureText != "Unauthorized" {
		t.Fatalf("unauthorized retry/failure=%+v", unauthorized)
	}

	proxy := imsMessagingResponseHandlingFor(voiceclient.SIPResponse{
		StatusCode: 407,
		Reason:     "Proxy Authentication Required",
		Headers:    map[string][]string{"Proxy-Authenticate": {`Digest realm="ims.example", nonce="p1"`}},
	})
	if proxy.AuthChallengeHeader != "Proxy-Authenticate" || proxy.AuthAuthorizationHeader != "Proxy-Authorization" || !strings.Contains(proxy.AuthChallenge, `nonce="p1"`) {
		t.Fatalf("proxy handling=%+v", proxy)
	}
}

func TestIMSSMSTransportAllowsTextPlainPayload(t *testing.T) {
	transport := &fakeSIPRequestTransport{responses: []voiceclient.SIPResponse{{StatusCode: 200, Reason: "OK"}}}
	sms := IMSSMSTransport{
		Transport:   transport,
		ContentType: "text/plain;charset=UTF-8",
		Profile:     voiceclient.IMSProfile{IMPU: "sip:user@ims.example", Domain: "ims.example"},
		Registration: voiceclient.RegistrationBinding{
			ContactURI:     "sip:user@192.0.2.10:5060",
			PublicIdentity: "sip:user@ims.example",
		},
	}
	if _, err := sms.SendSMSPart(context.Background(), SMSSendRequest{Peer: "+18005551212", Part: SMSPart{PartNo: 1, Text: "hello"}}); err != nil {
		t.Fatalf("SendSMSPart() error = %v", err)
	}
	if len(transport.requests) != 1 || string(transport.requests[0].Body) != "hello" || transport.requests[0].Headers["Content-Type"] != "text/plain;charset=UTF-8" {
		t.Fatalf("request=%+v", transport.requests)
	}
}

func TestIMSSMSTransportRejectsFailedMessage(t *testing.T) {
	transport := &fakeSIPRequestTransport{responses: []voiceclient.SIPResponse{{StatusCode: 403, Reason: "Forbidden"}}}
	sms := IMSSMSTransport{
		Transport:    transport,
		Profile:      voiceclient.IMSProfile{IMPU: "sip:user@ims.example", Domain: "ims.example"},
		Registration: voiceclient.RegistrationBinding{ContactURI: "sip:user@192.0.2.10:5060"},
	}

	result, err := sms.SendSMSPart(context.Background(), SMSSendRequest{
		Peer:      "sip:+18005551212@ims.example",
		MessageID: "msg reject",
		Part:      SMSPart{PartNo: 1, TotalParts: 1, Text: "hello"},
	})
	if err == nil {
		t.Fatal("SendSMSPart() err=nil, want rejection")
	}
	if result.State != "failed" || result.SIPCode != 403 || result.CallID != "msg-reject-1@vowifi-go" || result.ErrorText != "Forbidden" {
		t.Fatalf("result=%+v", result)
	}
	if result.RegistrationRecoveryNeeded {
		t.Fatalf("RegistrationRecoveryNeeded=true for non-recoverable 403: %+v", result)
	}
}

func TestIMSSMSTransportFlagsRecoverableFailures(t *testing.T) {
	transport := &fakeSIPRequestTransport{responses: []voiceclient.SIPResponse{{
		StatusCode: 503,
		Reason:     "Service Unavailable",
		Headers:    map[string][]string{"Retry-After": {"3"}},
	}}}
	sms := IMSSMSTransport{
		Transport:    transport,
		Profile:      voiceclient.IMSProfile{IMPU: "sip:user@ims.example", Domain: "ims.example"},
		Registration: voiceclient.RegistrationBinding{ContactURI: "sip:user@192.0.2.10:5060"},
	}

	result, err := sms.SendSMSPart(context.Background(), SMSSendRequest{
		Peer: "+18005551212",
		Part: SMSPart{PartNo: 1, Text: "hello"},
	})
	if err == nil || result.SIPCode != 503 || !result.RegistrationRecoveryNeeded || result.RetryAfter != 3*time.Second {
		t.Fatalf("SendSMSPart() result=%+v err=%v, want recoverable 503", result, err)
	}

	transport = &fakeSIPRequestTransport{errors: []error{errors.New("pcscf flow reset")}}
	sms.Transport = transport
	result, err = sms.SendSMSPart(context.Background(), SMSSendRequest{
		Peer: "+18005551212",
		Part: SMSPart{PartNo: 1, Text: "hello"},
	})
	if err == nil || result.SIPCode != 0 || !result.RegistrationRecoveryNeeded {
		t.Fatalf("SendSMSPart() result=%+v err=%v, want recoverable transport error", result, err)
	}
}

func TestIMSSMSTransportRequiresSIPTransport(t *testing.T) {
	_, err := IMSSMSTransport{}.SendSMSPart(context.Background(), SMSSendRequest{Peer: "+18005551212", Part: SMSPart{Text: "hello"}})
	if !errors.Is(err, ErrSMSTransportUnavailable) {
		t.Fatalf("err=%v, want ErrSMSTransportUnavailable", err)
	}
}

type fakeSIPRequestTransport struct {
	requests  []voiceclient.SIPRequestMessage
	responses []voiceclient.SIPResponse
	writes    []voiceclient.SIPRequestMessage
	errors    []error
}

func (t *fakeSIPRequestTransport) RoundTripRequest(ctx context.Context, msg voiceclient.SIPRequestMessage) (voiceclient.SIPResponse, error) {
	t.requests = append(t.requests, msg)
	if len(t.errors) > 0 {
		err := t.errors[0]
		t.errors = t.errors[1:]
		if err != nil {
			return voiceclient.SIPResponse{}, err
		}
	}
	if len(t.responses) == 0 {
		return voiceclient.SIPResponse{StatusCode: 500, Reason: "empty"}, nil
	}
	resp := t.responses[0]
	t.responses = t.responses[1:]
	return resp, nil
}

func (t *fakeSIPRequestTransport) WriteRequest(ctx context.Context, msg voiceclient.SIPRequestMessage) error {
	t.writes = append(t.writes, msg)
	return nil
}

func hexString(b []byte) string {
	const digits = "0123456789abcdef"
	out := make([]byte, len(b)*2)
	for i, v := range b {
		out[i*2] = digits[v>>4]
		out[i*2+1] = digits[v&0x0f]
	}
	return string(out)
}
