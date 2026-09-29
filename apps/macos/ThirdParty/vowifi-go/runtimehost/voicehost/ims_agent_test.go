package voicehost

import (
	"bytes"
	"context"
	"net"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/boa-z/vowifi-go/runtimehost/e911"
	"github.com/boa-z/vowifi-go/runtimehost/voiceclient"
)

func TestIMSOutboundAgentInviteAckAndBye(t *testing.T) {
	transport := &fakeIMSVoiceTransport{responses: []voiceclient.SIPResponse{
		{
			StatusCode: 200,
			Reason:     "OK",
			Headers: map[string][]string{
				"To":           {"<sip:+18005551212@ims.example>;tag=remote-tag"},
				"Contact":      {"<sip:carrier@198.51.100.1:5060>"},
				"Record-Route": {"<sip:pcscf-dialog1.ims.example;lr>, <sip:pcscf-dialog2.ims.example;lr>"},
			},
			Body: []byte(sampleSDP("203.0.113.10", 49170)),
		},
		{StatusCode: 200, Reason: "OK"},
	}}
	agent := &IMSOutboundAgent{
		Transport: transport,
		Profile: voiceclient.IMSProfile{
			IMPI:      "impi@example",
			IMPU:      "sip:user@ims.example",
			Domain:    "ims.example",
			UserAgent: "VoHive",
		},
		Registration: voiceclient.RegistrationBinding{
			ContactURI:     "sip:user@192.0.2.10:5060",
			PublicIdentity: "sip:user@ims.example",
			ServiceRoutes:  []string{"<sip:pcscf.ims.example;lr>"},
		},
		LocalTag: "local-tag",
	}

	result, err := agent.StartOutboundCall(context.Background(), OutboundCallRequest{
		DeviceID:  "dev-1",
		CallID:    "call-1",
		Callee:    "+18005551212",
		RawSDP:    []byte(sampleSDP("192.0.2.50", 4002)),
		RemoteSDP: SDPInfo{ConnectionIP: "192.0.2.50", MediaPort: 4002},
	})
	if err != nil {
		t.Fatalf("StartOutboundCall() error = %v", err)
	}
	if !result.Accepted || result.LocalSDP.ConnectionIP != "203.0.113.10" || result.LocalSDP.MediaPort != 49170 {
		t.Fatalf("result=%+v", result)
	}
	if len(transport.requests) != 1 || transport.requests[0].Method != "INVITE" {
		t.Fatalf("requests=%+v", transport.requests)
	}
	invite := transport.requests[0]
	if invite.URI != "sip:+18005551212@ims.example" || invite.Headers["Route"] != "<sip:pcscf.ims.example;lr>" {
		t.Fatalf("INVITE=%+v", invite)
	}
	if invite.Headers["P-Preferred-Service"] != "urn:urn-7:3gpp-service.ims.icsi.mmtel" ||
		!strings.Contains(invite.Headers["Accept-Contact"], "g.3gpp.icsi-ref") {
		t.Fatalf("INVITE service headers=%+v", invite.Headers)
	}
	if !strings.Contains(string(invite.Body), "m=audio 4002 RTP/AVP") {
		t.Fatalf("INVITE body=%q", invite.Body)
	}
	if len(transport.writes) != 1 || transport.writes[0].Method != "ACK" {
		t.Fatalf("writes=%+v", transport.writes)
	}
	if transport.writes[0].URI != "sip:carrier@198.51.100.1:5060" || !strings.Contains(transport.writes[0].Headers["To"], "remote-tag") {
		t.Fatalf("ACK=%+v", transport.writes[0])
	}
	if route := transport.writes[0].Headers["Route"]; route != "<sip:pcscf-dialog2.ims.example;lr>, <sip:pcscf-dialog1.ims.example;lr>" {
		t.Fatalf("ACK Route=%q", route)
	}

	if err := agent.EndVoiceCall(context.Background(), DialogInfo{
		CallID:      "call-1",
		ContentType: "message/sipfrag",
		Body:        []byte("SIP/2.0 200 OK\r\n"),
		Headers:     map[string]string{"Reason": "SIP;cause=200;text=\"completed\"", "X-Test": "bye", "Content-Type": "ignored"},
	}); err != nil {
		t.Fatalf("EndVoiceCall() error = %v", err)
	}
	if len(transport.requests) != 2 || transport.requests[1].Method != "BYE" {
		t.Fatalf("requests=%+v", transport.requests)
	}
	bye := transport.requests[1]
	if bye.URI != "sip:carrier@198.51.100.1:5060" || bye.Headers["CSeq"] != "2 BYE" ||
		bye.Headers["Content-Type"] != "message/sipfrag" ||
		bye.Headers["Reason"] != "SIP;cause=200;text=\"completed\"" ||
		bye.Headers["X-Test"] != "bye" ||
		string(bye.Body) != "SIP/2.0 200 OK\r\n" {
		t.Fatalf("BYE=%+v", bye)
	}
	if route := bye.Headers["Route"]; route != "<sip:pcscf-dialog2.ims.example;lr>, <sip:pcscf-dialog1.ims.example;lr>" {
		t.Fatalf("BYE Route=%q", route)
	}
}

func TestIMSOutboundAgentEmergencyINVITEUsesRequestURIAndHeaders(t *testing.T) {
	info := e911.BuildEmergencySIPRequestInfo(e911.EmergencySIPHeaderConfig{
		ServiceURN: "fire",
		AccessNetworkInfo: e911.EmergencyAccessNetworkInfo{
			Raw: "3GPP-E-UTRAN-FDD;utran-cell-id-3gpp=3102600abcdef",
		},
		GeolocationURI:     "cid:location-1",
		GeolocationRouting: true,
	})
	info.RouteSet = e911.EmergencySIPRouteSet([]e911.EmergencyRoute{
		{PCSCF: []string{"pcscf-emergency.ims.example"}},
		{ESRP: []string{"sips:esrp-emergency.ims.example"}},
	})
	transport := &fakeIMSVoiceTransport{responses: []voiceclient.SIPResponse{
		{
			StatusCode: 200,
			Reason:     "OK",
			Headers: map[string][]string{
				"To":      {"<sip:911@ims.example>;tag=remote-tag"},
				"Contact": {"<sip:emergency-carrier@198.51.100.9:5060>"},
			},
			Body: []byte(sampleSDP("203.0.113.10", 49170)),
		},
	}}
	agent := &IMSOutboundAgent{
		Transport: transport,
		Profile:   voiceclient.IMSProfile{IMPU: "sip:user@ims.example", Domain: "ims.example"},
		Registration: voiceclient.RegistrationBinding{
			ContactURI:     "sip:user@192.0.2.10:5060",
			PublicIdentity: "sip:user@ims.example",
			ServiceRoutes:  []string{"<sip:pcscf.ims.example;lr>"},
		},
	}

	result, err := agent.StartOutboundCall(context.Background(), OutboundCallRequest{
		CallID:     "call-emergency",
		Callee:     "911",
		RequestURI: info.RequestURI,
		RouteSet:   info.RouteSet,
		RawSDP:     []byte(sampleSDP("192.0.2.50", 4002)),
		Headers:    info.Headers,
	})
	if err != nil || !result.Accepted {
		t.Fatalf("StartOutboundCall() result=%+v err=%v", result, err)
	}
	if len(transport.requests) != 1 || transport.requests[0].Method != "INVITE" {
		t.Fatalf("requests=%+v", transport.requests)
	}
	invite := transport.requests[0]
	if invite.URI != "urn:service:sos.fire" || invite.Headers["To"] != "<sip:911@ims.example>" {
		t.Fatalf("emergency INVITE target=%q headers=%+v", invite.URI, invite.Headers)
	}
	if invite.Headers["Accept-Contact"] != e911.IMSEmergencyAcceptContact ||
		invite.Headers["P-Access-Network-Info"] != "3GPP-E-UTRAN-FDD;utran-cell-id-3gpp=3102600abcdef" ||
		invite.Headers["Geolocation"] != "<cid:location-1>;inserted-by=endpoint" ||
		invite.Headers["Geolocation-Routing"] != "yes" {
		t.Fatalf("emergency INVITE headers=%+v", invite.Headers)
	}
	if invite.Headers["Route"] != "<sip:pcscf-emergency.ims.example;lr>, <sips:esrp-emergency.ims.example;lr>" {
		t.Fatalf("emergency INVITE Route=%q", invite.Headers["Route"])
	}
	if len(transport.writes) != 1 || transport.writes[0].Method != "ACK" ||
		transport.writes[0].URI != "sip:emergency-carrier@198.51.100.9:5060" {
		t.Fatalf("ACK writes=%+v", transport.writes)
	}
}

func TestIMSOutboundAgentFollowsInviteRedirectContact(t *testing.T) {
	transport := &fakeIMSVoiceTransport{responses: []voiceclient.SIPResponse{
		{
			StatusCode: 302,
			Reason:     "Moved Temporarily",
			Headers: map[string][]string{
				"To":      {"<sip:+18005551212@ims.example>;tag=redirect-tag"},
				"Contact": {"<sip:redirect@198.51.100.30:5060>"},
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
		Transport: transport,
		Profile:   voiceclient.IMSProfile{IMPU: "sip:user@ims.example", Domain: "ims.example"},
		Registration: voiceclient.RegistrationBinding{
			ContactURI:     "sip:user@192.0.2.10:5060",
			PublicIdentity: "sip:user@ims.example",
			ServiceRoutes:  []string{"<sip:pcscf.ims.example;lr>"},
		},
	}

	result, err := agent.StartOutboundCall(context.Background(), OutboundCallRequest{
		CallID: "call-redirect",
		Callee: "+18005551212",
		RawSDP: []byte(sampleSDP("192.0.2.50", 4002)),
	})
	if err != nil || !result.Accepted {
		t.Fatalf("StartOutboundCall() result=%+v err=%v", result, err)
	}
	if len(transport.requests) != 2 || transport.requests[0].Method != "INVITE" || transport.requests[1].Method != "INVITE" {
		t.Fatalf("requests=%+v", transport.requests)
	}
	firstInvite := transport.requests[0]
	redirectInvite := transport.requests[1]
	if firstInvite.URI != "sip:+18005551212@ims.example" || firstInvite.Headers["CSeq"] != "1 INVITE" {
		t.Fatalf("first INVITE=%+v", firstInvite)
	}
	if redirectInvite.URI != "sip:redirect@198.51.100.30:5060" ||
		redirectInvite.Headers["CSeq"] != "2 INVITE" ||
		redirectInvite.Headers["To"] != firstInvite.Headers["To"] ||
		redirectInvite.Headers["Route"] != "<sip:pcscf.ims.example;lr>" {
		t.Fatalf("redirect INVITE=%+v first=%+v", redirectInvite, firstInvite)
	}
	if len(transport.writes) != 2 || transport.writes[0].Method != "ACK" || transport.writes[1].Method != "ACK" {
		t.Fatalf("ACK writes=%+v", transport.writes)
	}
	if transport.writes[0].Headers["CSeq"] != "1 ACK" ||
		transport.writes[0].Headers["Via"] != firstInvite.Headers["Via"] ||
		!strings.Contains(transport.writes[0].Headers["To"], "redirect-tag") {
		t.Fatalf("redirect ACK=%+v first=%+v", transport.writes[0], firstInvite)
	}
	if transport.writes[1].Headers["CSeq"] != "2 ACK" ||
		transport.writes[1].URI != "sip:carrier@198.51.100.1:5060" ||
		!strings.Contains(transport.writes[1].Headers["To"], "remote-tag") {
		t.Fatalf("final ACK=%+v", transport.writes[1])
	}

	if err := agent.EndVoiceCall(context.Background(), DialogInfo{CallID: "call-redirect"}); err != nil {
		t.Fatalf("EndVoiceCall() error = %v", err)
	}
	if len(transport.requests) != 3 || transport.requests[2].Method != "BYE" ||
		transport.requests[2].URI != "sip:carrier@198.51.100.1:5060" ||
		transport.requests[2].Headers["CSeq"] != "3 BYE" {
		t.Fatalf("BYE after redirect=%+v", transport.requests)
	}
}

func TestIMSOutboundAgentSendsInDialogInfoAndAdvancesCSeq(t *testing.T) {
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
		{StatusCode: 200, Reason: "OK", Headers: map[string][]string{"X-IMS": {"info-ok"}}},
		{StatusCode: 200, Reason: "OK"},
	}}
	agent := &IMSOutboundAgent{
		Transport: transport,
		Profile:   voiceclient.IMSProfile{IMPU: "sip:user@ims.example", Domain: "ims.example"},
		Registration: voiceclient.RegistrationBinding{
			ContactURI:     "sip:user@192.0.2.10:5060",
			PublicIdentity: "sip:user@ims.example",
			ServiceRoutes:  []string{"<sip:pcscf.ims.example;lr>"},
		},
	}
	if _, err := agent.StartOutboundCall(context.Background(), OutboundCallRequest{
		CallID: "call-info",
		Callee: "+18005551212",
		RawSDP: []byte(sampleSDP("192.0.2.50", 4002)),
	}); err != nil {
		t.Fatalf("StartOutboundCall() error = %v", err)
	}
	result, err := agent.SendDialogInfo(context.Background(), DialogInfoRequest{
		CallID:      "call-info",
		ContentType: "application/dtmf-relay",
		InfoPackage: "dtmf",
		Body:        []byte("Signal=1\r\nDuration=160\r\n"),
		Headers:     map[string]string{"X-Test": "info"},
	})
	if err != nil || !result.Accepted || result.Headers["X-IMS"] != "info-ok" {
		t.Fatalf("SendDialogInfo() result=%+v err=%v", result, err)
	}
	if result.RegistrationRecoveryNeeded {
		t.Fatalf("successful INFO requested registration recovery: %+v", result)
	}
	if len(transport.requests) != 2 || transport.requests[1].Method != "INFO" {
		t.Fatalf("requests=%+v", transport.requests)
	}
	info := transport.requests[1]
	if info.URI != "sip:carrier@198.51.100.1:5060" || info.Headers["CSeq"] != "2 INFO" ||
		info.Headers["Content-Type"] != "application/dtmf-relay" || info.Headers["Info-Package"] != "dtmf" ||
		info.Headers["X-Test"] != "info" || !strings.Contains(string(info.Body), "Signal=1") {
		t.Fatalf("INFO=%+v body=%q", info, info.Body)
	}
	if err := agent.EndVoiceCall(context.Background(), DialogInfo{CallID: "call-info"}); err != nil {
		t.Fatalf("EndVoiceCall() error = %v", err)
	}
	if len(transport.requests) != 3 || transport.requests[2].Method != "BYE" || transport.requests[2].Headers["CSeq"] != "3 BYE" {
		t.Fatalf("BYE after INFO=%+v", transport.requests)
	}
}

func TestIMSOutboundAgentSendsInDialogMessage(t *testing.T) {
	transport := &fakeIMSVoiceTransport{responses: []voiceclient.SIPResponse{
		{
			StatusCode: 200,
			Reason:     "OK",
			Headers: map[string][]string{
				"To":           {"<sip:+18005551212@ims.example>;tag=remote-tag"},
				"Contact":      {"<sip:carrier@198.51.100.1:5060>"},
				"Record-Route": {"<sip:pcscf-dialog1.ims.example;lr>, <sip:pcscf-dialog2.ims.example;lr>"},
			},
			Body: []byte(sampleSDP("203.0.113.10", 49170)),
		},
		{
			StatusCode: 200,
			Reason:     "OK",
			Headers: map[string][]string{
				"Contact":      {"<sip:carrier@198.51.100.9:5060>"},
				"Content-Type": {"text/plain"},
				"X-IMS":        {"message-ok"},
			},
			Body: []byte("delivered"),
		},
		{StatusCode: 200, Reason: "OK"},
	}}
	agent := &IMSOutboundAgent{
		Transport: transport,
		Profile:   voiceclient.IMSProfile{IMPU: "sip:user@ims.example", Domain: "ims.example"},
		Registration: voiceclient.RegistrationBinding{
			ContactURI:     "sip:user@192.0.2.10:5060",
			PublicIdentity: "sip:user@ims.example",
			ServiceRoutes:  []string{"<sip:pcscf.ims.example;lr>"},
		},
	}
	if _, err := agent.StartOutboundCall(context.Background(), OutboundCallRequest{
		CallID: "call-message",
		Callee: "+18005551212",
		RawSDP: []byte(sampleSDP("192.0.2.50", 4002)),
	}); err != nil {
		t.Fatalf("StartOutboundCall() error = %v", err)
	}
	result, err := agent.SendDialogMessage(context.Background(), DialogMessageRequest{
		CallID:      "call-message",
		ContentType: "text/plain",
		Body:        []byte("hello"),
		Headers:     map[string]string{"X-Test": "message", "Content-Type": "application/ignored"},
	})
	if err != nil || !result.Accepted || result.Headers["X-IMS"] != "message-ok" ||
		result.ContentType != "text/plain" || string(result.Body) != "delivered" {
		t.Fatalf("SendDialogMessage() result=%+v err=%v", result, err)
	}
	if len(transport.requests) != 2 || transport.requests[1].Method != "MESSAGE" {
		t.Fatalf("requests=%+v", transport.requests)
	}
	message := transport.requests[1]
	if message.URI != "sip:carrier@198.51.100.1:5060" || message.Headers["CSeq"] != "2 MESSAGE" ||
		message.Headers["Content-Type"] != "text/plain" ||
		message.Headers["Accept"] != voiceclient.DefaultDialogMessageAccept ||
		message.Headers["P-Preferred-Service"] != "" ||
		message.Headers["Accept-Contact"] != "" ||
		message.Headers["Contact"] != "<sip:user@192.0.2.10:5060>" ||
		message.Headers["X-Test"] != "message" ||
		message.Headers["Route"] != "<sip:pcscf-dialog2.ims.example;lr>, <sip:pcscf-dialog1.ims.example;lr>" ||
		string(message.Body) != "hello" {
		t.Fatalf("MESSAGE=%+v body=%q", message, message.Body)
	}
	if err := agent.EndVoiceCall(context.Background(), DialogInfo{CallID: "call-message"}); err != nil {
		t.Fatalf("EndVoiceCall() error = %v", err)
	}
	if len(transport.requests) != 3 || transport.requests[2].Method != "BYE" ||
		transport.requests[2].URI != "sip:carrier@198.51.100.9:5060" ||
		transport.requests[2].Headers["CSeq"] != "3 BYE" {
		t.Fatalf("BYE after MESSAGE=%+v", transport.requests)
	}
}

func TestIMSOutboundAgentFollowsDialogInfoAndMessageRedirectContacts(t *testing.T) {
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
			StatusCode: 302,
			Reason:     "Moved Temporarily",
			Headers: map[string][]string{
				"Contact": {"<sip:info-redirect@198.51.100.30:5060>"},
			},
		},
		{
			StatusCode: 200,
			Reason:     "OK",
			Headers: map[string][]string{
				"Contact": {"<sip:info-final@198.51.100.31:5060>"},
				"X-IMS":   {"info-redirect-ok"},
			},
		},
		{
			StatusCode: 302,
			Reason:     "Moved Temporarily",
			Headers: map[string][]string{
				"Contact": {"<sip:message-redirect@198.51.100.40:5060>"},
			},
		},
		{
			StatusCode: 200,
			Reason:     "OK",
			Headers: map[string][]string{
				"Contact":      {"<sip:message-final@198.51.100.41:5060>"},
				"Content-Type": {"text/plain"},
				"X-IMS":        {"message-redirect-ok"},
			},
			Body: []byte("delivered"),
		},
		{StatusCode: 200, Reason: "OK"},
	}}
	agent := &IMSOutboundAgent{
		Transport: transport,
		Profile:   voiceclient.IMSProfile{IMPU: "sip:user@ims.example", Domain: "ims.example"},
		Registration: voiceclient.RegistrationBinding{
			ContactURI:     "sip:user@192.0.2.10:5060",
			PublicIdentity: "sip:user@ims.example",
		},
	}
	if _, err := agent.StartOutboundCall(context.Background(), OutboundCallRequest{
		CallID: "call-info-message-redirect",
		Callee: "+18005551212",
		RawSDP: []byte(sampleSDP("192.0.2.50", 4002)),
	}); err != nil {
		t.Fatalf("StartOutboundCall() error = %v", err)
	}
	infoResult, err := agent.SendDialogInfo(context.Background(), DialogInfoRequest{
		CallID:      "call-info-message-redirect",
		ContentType: "application/dtmf-relay",
		InfoPackage: "dtmf",
		Body:        []byte("Signal=1\r\nDuration=160\r\n"),
	})
	if err != nil || !infoResult.Accepted || infoResult.Headers["X-IMS"] != "info-redirect-ok" {
		t.Fatalf("SendDialogInfo() result=%+v err=%v", infoResult, err)
	}
	messageResult, err := agent.SendDialogMessage(context.Background(), DialogMessageRequest{
		CallID:      "call-info-message-redirect",
		ContentType: "text/plain",
		Body:        []byte("hello"),
	})
	if err != nil || !messageResult.Accepted || messageResult.Headers["X-IMS"] != "message-redirect-ok" ||
		string(messageResult.Body) != "delivered" {
		t.Fatalf("SendDialogMessage() result=%+v err=%v", messageResult, err)
	}
	if len(transport.requests) != 5 || transport.requests[1].Method != "INFO" ||
		transport.requests[2].Method != "INFO" ||
		transport.requests[3].Method != "MESSAGE" ||
		transport.requests[4].Method != "MESSAGE" {
		t.Fatalf("dialog requests=%+v", transport.requests)
	}
	firstInfo := transport.requests[1]
	redirectInfo := transport.requests[2]
	if firstInfo.URI != "sip:carrier@198.51.100.1:5060" || firstInfo.Headers["CSeq"] != "2 INFO" {
		t.Fatalf("first INFO=%+v", firstInfo)
	}
	if redirectInfo.URI != "sip:info-redirect@198.51.100.30:5060" ||
		redirectInfo.Headers["CSeq"] != "3 INFO" ||
		redirectInfo.Headers["Info-Package"] != "dtmf" {
		t.Fatalf("redirect INFO=%+v", redirectInfo)
	}
	firstMessage := transport.requests[3]
	redirectMessage := transport.requests[4]
	if firstMessage.URI != "sip:info-final@198.51.100.31:5060" ||
		firstMessage.Headers["CSeq"] != "4 MESSAGE" {
		t.Fatalf("first MESSAGE=%+v", firstMessage)
	}
	if redirectMessage.URI != "sip:message-redirect@198.51.100.40:5060" ||
		redirectMessage.Headers["CSeq"] != "5 MESSAGE" ||
		string(redirectMessage.Body) != "hello" {
		t.Fatalf("redirect MESSAGE=%+v body=%q", redirectMessage, redirectMessage.Body)
	}
	if err := agent.EndVoiceCall(context.Background(), DialogInfo{CallID: "call-info-message-redirect"}); err != nil {
		t.Fatalf("EndVoiceCall() error = %v", err)
	}
	if len(transport.requests) != 6 || transport.requests[5].Method != "BYE" ||
		transport.requests[5].URI != "sip:message-final@198.51.100.41:5060" ||
		transport.requests[5].Headers["CSeq"] != "6 BYE" {
		t.Fatalf("BYE after redirects=%+v", transport.requests)
	}
}

func TestIMSOutboundAgentSendsDialogPrack(t *testing.T) {
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
		{StatusCode: 200, Reason: "OK", Headers: map[string][]string{"Content-Type": {"application/sdp"}, "X-IMS": {"prack-ok"}}, Body: []byte(sampleSDP("203.0.113.20", 49180))},
		{StatusCode: 200, Reason: "OK"},
	}}
	agent := &IMSOutboundAgent{
		Transport: transport,
		Profile:   voiceclient.IMSProfile{IMPU: "sip:user@ims.example", Domain: "ims.example"},
		Registration: voiceclient.RegistrationBinding{
			ContactURI:     "sip:user@192.0.2.10:5060",
			PublicIdentity: "sip:user@ims.example",
			ServiceRoutes:  []string{"<sip:pcscf.ims.example;lr>"},
		},
	}
	if _, err := agent.StartOutboundCall(context.Background(), OutboundCallRequest{
		CallID: "call-prack",
		Callee: "+18005551212",
		RawSDP: []byte(sampleSDP("192.0.2.50", 4002)),
	}); err != nil {
		t.Fatalf("StartOutboundCall() error = %v", err)
	}
	result, err := agent.SendDialogPrack(context.Background(), DialogPrackRequest{
		CallID:      "call-prack",
		RAck:        "1 1 INVITE",
		ContentType: "application/sdp",
		Body:        []byte(sampleSDP("192.0.2.60", 4012)),
		Headers:     map[string]string{"X-Test": "prack", "RAck": "wrong"},
	})
	if err != nil || !result.Accepted || result.Headers["X-IMS"] != "prack-ok" || result.ContentType != "application/sdp" || !strings.Contains(string(result.Body), "m=audio 49180") {
		t.Fatalf("SendDialogPrack() result=%+v err=%v", result, err)
	}
	if len(transport.requests) != 2 || transport.requests[1].Method != "PRACK" {
		t.Fatalf("requests=%+v", transport.requests)
	}
	prack := transport.requests[1]
	if prack.URI != "sip:carrier@198.51.100.1:5060" || prack.Headers["CSeq"] != "2 PRACK" ||
		prack.Headers["RAck"] != "1 1 INVITE" || prack.Headers["Content-Type"] != "application/sdp" ||
		prack.Headers["X-Test"] != "prack" || !strings.Contains(string(prack.Body), "m=audio 4012") {
		t.Fatalf("PRACK=%+v body=%q", prack, prack.Body)
	}
	if err := agent.EndVoiceCall(context.Background(), DialogInfo{CallID: "call-prack"}); err != nil {
		t.Fatalf("EndVoiceCall() error = %v", err)
	}
	if len(transport.requests) != 3 || transport.requests[2].Method != "BYE" || transport.requests[2].Headers["CSeq"] != "3 BYE" {
		t.Fatalf("BYE after PRACK=%+v", transport.requests)
	}
}

func TestIMSOutboundAgentSendsDialogDTMF(t *testing.T) {
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
		{StatusCode: 200, Reason: "OK", Headers: map[string][]string{"X-IMS": {"dtmf-ok"}}},
		{StatusCode: 200, Reason: "OK"},
	}}
	agent := &IMSOutboundAgent{
		Transport: transport,
		Profile:   voiceclient.IMSProfile{IMPU: "sip:user@ims.example", Domain: "ims.example"},
		Registration: voiceclient.RegistrationBinding{
			ContactURI:     "sip:user@192.0.2.10:5060",
			PublicIdentity: "sip:user@ims.example",
			ServiceRoutes:  []string{"<sip:pcscf.ims.example;lr>"},
		},
	}
	if _, err := agent.StartOutboundCall(context.Background(), OutboundCallRequest{
		CallID: "call-dtmf",
		Callee: "+18005551212",
		RawSDP: []byte(sampleSDP("192.0.2.50", 4002)),
	}); err != nil {
		t.Fatalf("StartOutboundCall() error = %v", err)
	}
	result, err := agent.SendDialogDTMF(context.Background(), DialogDTMFRequest{
		CallID:     "call-dtmf",
		Signal:     "*",
		DurationMS: 90,
		Headers:    map[string]string{"X-Test": "dtmf"},
	})
	if err != nil || !result.Accepted || result.Headers["X-IMS"] != "dtmf-ok" {
		t.Fatalf("SendDialogDTMF() result=%+v err=%v", result, err)
	}
	if len(transport.requests) != 2 || transport.requests[1].Method != "INFO" {
		t.Fatalf("requests=%+v", transport.requests)
	}
	info := transport.requests[1]
	if info.URI != "sip:carrier@198.51.100.1:5060" || info.Headers["CSeq"] != "2 INFO" ||
		info.Headers["Content-Type"] != DTMFRelayContentType || info.Headers["Info-Package"] != DTMFInfoPackage ||
		info.Headers["X-Test"] != "dtmf" || string(info.Body) != "Signal=*\r\nDuration=90\r\n" {
		t.Fatalf("DTMF INFO=%+v body=%q", info, info.Body)
	}
	if err := agent.EndVoiceCall(context.Background(), DialogInfo{CallID: "call-dtmf"}); err != nil {
		t.Fatalf("EndVoiceCall() error = %v", err)
	}
	if len(transport.requests) != 3 || transport.requests[2].Method != "BYE" || transport.requests[2].Headers["CSeq"] != "3 BYE" {
		t.Fatalf("BYE after DTMF=%+v", transport.requests)
	}
}

func TestIMSOutboundAgentSendsDialogOptions(t *testing.T) {
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
		{StatusCode: 200, Reason: "OK", Headers: map[string][]string{"Content-Type": {"application/sdp"}, "Allow": {"INVITE, UPDATE"}, "X-IMS": {"options-ok"}}, Body: []byte(sampleSDP("203.0.113.20", 49180))},
		{StatusCode: 200, Reason: "OK"},
	}}
	agent := &IMSOutboundAgent{
		Transport: transport,
		Profile:   voiceclient.IMSProfile{IMPU: "sip:user@ims.example", Domain: "ims.example"},
		Registration: voiceclient.RegistrationBinding{
			ContactURI:     "sip:user@192.0.2.10:5060",
			PublicIdentity: "sip:user@ims.example",
			ServiceRoutes:  []string{"<sip:pcscf.ims.example;lr>"},
		},
	}
	if _, err := agent.StartOutboundCall(context.Background(), OutboundCallRequest{
		CallID: "call-options",
		Callee: "+18005551212",
		RawSDP: []byte(sampleSDP("192.0.2.50", 4002)),
	}); err != nil {
		t.Fatalf("StartOutboundCall() error = %v", err)
	}
	result, err := agent.SendDialogOptions(context.Background(), DialogOptionsRequest{
		CallID:  "call-options",
		Headers: map[string]string{"X-Test": "options"},
	})
	if err != nil || !result.Accepted || result.Headers["X-IMS"] != "options-ok" || result.ContentType != "application/sdp" || !strings.Contains(string(result.Body), "m=audio 49180") {
		t.Fatalf("SendDialogOptions() result=%+v err=%v", result, err)
	}
	if len(transport.requests) != 2 || transport.requests[1].Method != "OPTIONS" {
		t.Fatalf("requests=%+v", transport.requests)
	}
	options := transport.requests[1]
	if options.URI != "sip:carrier@198.51.100.1:5060" || options.Headers["CSeq"] != "2 OPTIONS" ||
		options.Headers["Accept"] != "application/sdp" || options.Headers["Supported"] == "" ||
		options.Headers["X-Test"] != "options" || options.Headers["Contact"] != "" || len(options.Body) != 0 {
		t.Fatalf("OPTIONS=%+v body=%q", options, options.Body)
	}
	if err := agent.EndVoiceCall(context.Background(), DialogInfo{CallID: "call-options"}); err != nil {
		t.Fatalf("EndVoiceCall() error = %v", err)
	}
	if len(transport.requests) != 3 || transport.requests[2].Method != "BYE" || transport.requests[2].Headers["CSeq"] != "3 BYE" {
		t.Fatalf("BYE after OPTIONS=%+v", transport.requests)
	}
}

func TestIMSOutboundAgentFollowsPrackAndOptionsRedirectContacts(t *testing.T) {
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
			StatusCode: 302,
			Reason:     "Moved Temporarily",
			Headers:    map[string][]string{"Contact": {"<sip:prack-redirect@198.51.100.20:5060>"}},
		},
		{
			StatusCode: 200,
			Reason:     "OK",
			Headers:    map[string][]string{"Contact": {"<sip:prack-final@198.51.100.21:5060>"}, "X-IMS": {"prack-redirect-ok"}},
		},
		{
			StatusCode: 302,
			Reason:     "Moved Temporarily",
			Headers:    map[string][]string{"Contact": {"<sip:options-redirect@198.51.100.30:5060>"}},
		},
		{
			StatusCode: 200,
			Reason:     "OK",
			Headers:    map[string][]string{"Contact": {"<sip:options-final@198.51.100.31:5060>"}, "X-IMS": {"options-redirect-ok"}},
		},
		{StatusCode: 200, Reason: "OK"},
	}}
	agent := &IMSOutboundAgent{
		Transport: transport,
		Profile:   voiceclient.IMSProfile{IMPU: "sip:user@ims.example", Domain: "ims.example"},
		Registration: voiceclient.RegistrationBinding{
			ContactURI:     "sip:user@192.0.2.10:5060",
			PublicIdentity: "sip:user@ims.example",
		},
	}
	if _, err := agent.StartOutboundCall(context.Background(), OutboundCallRequest{
		CallID: "call-prack-options-redirect",
		Callee: "+18005551212",
		RawSDP: []byte(sampleSDP("192.0.2.50", 4002)),
	}); err != nil {
		t.Fatalf("StartOutboundCall() error = %v", err)
	}
	prackResult, err := agent.SendDialogPrack(context.Background(), DialogPrackRequest{
		CallID: "call-prack-options-redirect",
		RAck:   "1 1 INVITE",
	})
	if err != nil || !prackResult.Accepted || prackResult.Headers["X-IMS"] != "prack-redirect-ok" {
		t.Fatalf("SendDialogPrack() result=%+v err=%v", prackResult, err)
	}
	optionsResult, err := agent.SendDialogOptions(context.Background(), DialogOptionsRequest{
		CallID: "call-prack-options-redirect",
	})
	if err != nil || !optionsResult.Accepted || optionsResult.Headers["X-IMS"] != "options-redirect-ok" {
		t.Fatalf("SendDialogOptions() result=%+v err=%v", optionsResult, err)
	}
	if len(transport.requests) != 5 {
		t.Fatalf("dialog requests=%+v", transport.requests)
	}
	check := func(index int, method, uri, cseq string) {
		t.Helper()
		if transport.requests[index].Method != method || transport.requests[index].URI != uri || transport.requests[index].Headers["CSeq"] != cseq {
			t.Fatalf("request[%d]=%+v", index, transport.requests[index])
		}
	}
	check(1, "PRACK", "sip:carrier@198.51.100.1:5060", "2 PRACK")
	check(2, "PRACK", "sip:prack-redirect@198.51.100.20:5060", "3 PRACK")
	check(3, "OPTIONS", "sip:prack-final@198.51.100.21:5060", "4 OPTIONS")
	check(4, "OPTIONS", "sip:options-redirect@198.51.100.30:5060", "5 OPTIONS")
	if err := agent.EndVoiceCall(context.Background(), DialogInfo{CallID: "call-prack-options-redirect"}); err != nil {
		t.Fatalf("EndVoiceCall() error = %v", err)
	}
	if len(transport.requests) != 6 || transport.requests[5].Method != "BYE" ||
		transport.requests[5].URI != "sip:options-final@198.51.100.31:5060" ||
		transport.requests[5].Headers["CSeq"] != "6 BYE" {
		t.Fatalf("BYE after redirects=%+v", transport.requests)
	}
}

func TestIMSOutboundAgentSendsDialogRefer(t *testing.T) {
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
		{StatusCode: 202, Reason: "Accepted", Headers: map[string][]string{"Refer-Sub": {"false"}, "X-IMS": {"refer-ok"}}},
		{StatusCode: 200, Reason: "OK"},
	}}
	agent := &IMSOutboundAgent{
		Transport: transport,
		Profile:   voiceclient.IMSProfile{IMPU: "sip:user@ims.example", Domain: "ims.example"},
		Registration: voiceclient.RegistrationBinding{
			ContactURI:     "sip:user@192.0.2.10:5060",
			PublicIdentity: "sip:user@ims.example",
			ServiceRoutes:  []string{"<sip:pcscf.ims.example;lr>"},
		},
	}
	if _, err := agent.StartOutboundCall(context.Background(), OutboundCallRequest{
		CallID: "call-refer",
		Callee: "+18005551212",
		RawSDP: []byte(sampleSDP("192.0.2.50", 4002)),
	}); err != nil {
		t.Fatalf("StartOutboundCall() error = %v", err)
	}
	result, err := agent.SendDialogRefer(context.Background(), DialogReferRequest{
		CallID:     "call-refer",
		ReferTo:    "sip:+18005551313@ims.example",
		ReferredBy: "sip:user@ims.example",
		ReferSub:   "true",
		Headers:    map[string]string{"X-Test": "refer", "Refer-To": "<sip:wrong@ims.example>", "Refer-Sub": "false"},
	})
	if err != nil || !result.Accepted || result.StatusCode != 202 || result.Headers["X-IMS"] != "refer-ok" {
		t.Fatalf("SendDialogRefer() result=%+v err=%v", result, err)
	}
	if len(transport.requests) != 2 || transport.requests[1].Method != "REFER" {
		t.Fatalf("requests=%+v", transport.requests)
	}
	refer := transport.requests[1]
	if refer.URI != "sip:carrier@198.51.100.1:5060" || refer.Headers["CSeq"] != "2 REFER" ||
		refer.Headers["Refer-To"] != "<sip:+18005551313@ims.example>" ||
		refer.Headers["Referred-By"] != "<sip:user@ims.example>" ||
		refer.Headers["Refer-Sub"] != "true" || refer.Headers["Supported"] == "" ||
		refer.Headers["X-Test"] != "refer" || len(refer.Body) != 0 {
		t.Fatalf("REFER=%+v body=%q", refer, refer.Body)
	}
	if err := agent.EndVoiceCall(context.Background(), DialogInfo{CallID: "call-refer"}); err != nil {
		t.Fatalf("EndVoiceCall() error = %v", err)
	}
	if len(transport.requests) != 3 || transport.requests[2].Method != "BYE" || transport.requests[2].Headers["CSeq"] != "3 BYE" {
		t.Fatalf("BYE after REFER=%+v", transport.requests)
	}
}

func TestIMSOutboundAgentSendsDialogNotify(t *testing.T) {
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
			StatusCode: 200,
			Reason:     "OK",
			Headers: map[string][]string{
				"Contact": {"<sip:carrier@198.51.100.2:5060>"},
				"X-IMS":   {"notify-ok"},
			},
		},
		{StatusCode: 200, Reason: "OK"},
	}}
	agent := &IMSOutboundAgent{
		Transport: transport,
		Profile:   voiceclient.IMSProfile{IMPU: "sip:user@ims.example", Domain: "ims.example"},
		Registration: voiceclient.RegistrationBinding{
			ContactURI:     "sip:user@192.0.2.10:5060",
			PublicIdentity: "sip:user@ims.example",
			ServiceRoutes:  []string{"<sip:pcscf.ims.example;lr>"},
		},
	}
	if _, err := agent.StartOutboundCall(context.Background(), OutboundCallRequest{
		CallID: "call-notify",
		Callee: "+18005551212",
		RawSDP: []byte(sampleSDP("192.0.2.50", 4002)),
	}); err != nil {
		t.Fatalf("StartOutboundCall() error = %v", err)
	}
	result, err := agent.SendDialogNotify(context.Background(), DialogNotifyRequest{
		CallID:            "call-notify",
		Event:             "refer",
		SubscriptionState: "terminated;reason=noresource",
		ContentType:       "message/sipfrag",
		Body:              []byte("SIP/2.0 200 OK\r\n"),
		Headers: map[string]string{
			"Event":              "presence",
			"Subscription-State": "active",
			"X-Test":             "notify",
		},
	})
	if err != nil || !result.Accepted || result.Headers["X-IMS"] != "notify-ok" {
		t.Fatalf("SendDialogNotify() result=%+v err=%v", result, err)
	}
	if len(transport.requests) != 2 || transport.requests[1].Method != "NOTIFY" {
		t.Fatalf("requests=%+v", transport.requests)
	}
	notify := transport.requests[1]
	if notify.URI != "sip:carrier@198.51.100.1:5060" || notify.Headers["CSeq"] != "2 NOTIFY" ||
		notify.Headers["Event"] != "refer" ||
		notify.Headers["Subscription-State"] != "terminated;reason=noresource" ||
		notify.Headers["Allow-Events"] != "refer" ||
		notify.Headers["Content-Type"] != "message/sipfrag" ||
		notify.Headers["X-Test"] != "notify" ||
		string(notify.Body) != "SIP/2.0 200 OK\r\n" {
		t.Fatalf("NOTIFY=%+v body=%q", notify, notify.Body)
	}
	if err := agent.EndVoiceCall(context.Background(), DialogInfo{CallID: "call-notify"}); err != nil {
		t.Fatalf("EndVoiceCall() error = %v", err)
	}
	if len(transport.requests) != 3 || transport.requests[2].Method != "BYE" ||
		transport.requests[2].URI != "sip:carrier@198.51.100.2:5060" ||
		transport.requests[2].Headers["CSeq"] != "3 BYE" {
		t.Fatalf("BYE after NOTIFY=%+v", transport.requests)
	}
}

func TestIMSOutboundAgentSendsDialogSubscribe(t *testing.T) {
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
			StatusCode: 202,
			Reason:     "Accepted",
			Headers: map[string][]string{
				"Contact": {"<sip:carrier@198.51.100.3:5060>"},
				"Expires": {"300"},
				"X-IMS":   {"subscribe-ok"},
			},
		},
		{StatusCode: 200, Reason: "OK"},
	}}
	agent := &IMSOutboundAgent{
		Transport: transport,
		Profile:   voiceclient.IMSProfile{IMPU: "sip:user@ims.example", Domain: "ims.example"},
		Registration: voiceclient.RegistrationBinding{
			ContactURI:     "sip:user@192.0.2.10:5060",
			PublicIdentity: "sip:user@ims.example",
			ServiceRoutes:  []string{"<sip:pcscf.ims.example;lr>"},
		},
	}
	if _, err := agent.StartOutboundCall(context.Background(), OutboundCallRequest{
		CallID: "call-subscribe",
		Callee: "+18005551212",
		RawSDP: []byte(sampleSDP("192.0.2.50", 4002)),
	}); err != nil {
		t.Fatalf("StartOutboundCall() error = %v", err)
	}
	result, err := agent.SendDialogSubscribe(context.Background(), DialogSubscribeRequest{
		CallID:      "call-subscribe",
		Event:       "refer",
		Expires:     "300",
		ContentType: "application/resource-lists+xml",
		Body:        []byte("<resource-lists/>"),
		Headers: map[string]string{
			"Event":   "presence",
			"Expires": "0",
			"X-Test":  "subscribe",
		},
	})
	if err != nil || !result.Accepted || result.StatusCode != 202 || result.Headers["X-IMS"] != "subscribe-ok" || result.Headers["Expires"] != "300" {
		t.Fatalf("SendDialogSubscribe() result=%+v err=%v", result, err)
	}
	if len(transport.requests) != 2 || transport.requests[1].Method != "SUBSCRIBE" {
		t.Fatalf("requests=%+v", transport.requests)
	}
	subscribe := transport.requests[1]
	if subscribe.URI != "sip:carrier@198.51.100.1:5060" || subscribe.Headers["CSeq"] != "2 SUBSCRIBE" ||
		subscribe.Headers["Event"] != "refer" ||
		subscribe.Headers["Expires"] != "300" ||
		subscribe.Headers["Accept"] != "message/sipfrag" ||
		subscribe.Headers["Allow-Events"] != "refer" ||
		subscribe.Headers["Content-Type"] != "application/resource-lists+xml" ||
		subscribe.Headers["X-Test"] != "subscribe" ||
		string(subscribe.Body) != "<resource-lists/>" {
		t.Fatalf("SUBSCRIBE=%+v body=%q", subscribe, subscribe.Body)
	}
	if err := agent.EndVoiceCall(context.Background(), DialogInfo{CallID: "call-subscribe"}); err != nil {
		t.Fatalf("EndVoiceCall() error = %v", err)
	}
	if len(transport.requests) != 3 || transport.requests[2].Method != "BYE" ||
		transport.requests[2].URI != "sip:carrier@198.51.100.3:5060" ||
		transport.requests[2].Headers["CSeq"] != "3 BYE" {
		t.Fatalf("BYE after SUBSCRIBE=%+v", transport.requests)
	}
}

func TestIMSOutboundAgentRetriesDialogSubscribeMinExpires(t *testing.T) {
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
			StatusCode: 423,
			Reason:     "Interval Too Brief",
			Headers: map[string][]string{
				"Contact":     {"<sip:carrier-subscribe@198.51.100.40:5060>"},
				"Min-Expires": {"900"},
			},
		},
		{
			StatusCode: 202,
			Reason:     "Accepted",
			Headers:    map[string][]string{"Expires": {"900"}, "X-IMS": {"subscribe-retry-ok"}},
		},
	}}
	agent := &IMSOutboundAgent{
		Transport: transport,
		Profile:   voiceclient.IMSProfile{IMPU: "sip:user@ims.example", Domain: "ims.example"},
		Registration: voiceclient.RegistrationBinding{
			ContactURI:     "sip:user@192.0.2.10:5060",
			PublicIdentity: "sip:user@ims.example",
		},
	}
	if _, err := agent.StartOutboundCall(context.Background(), OutboundCallRequest{
		CallID: "call-subscribe-min-expires",
		Callee: "+18005551212",
		RawSDP: []byte(sampleSDP("192.0.2.50", 4002)),
	}); err != nil {
		t.Fatalf("StartOutboundCall() error = %v", err)
	}
	result, err := agent.SendDialogSubscribe(context.Background(), DialogSubscribeRequest{
		CallID:  "call-subscribe-min-expires",
		Event:   "refer",
		Expires: "300",
	})
	if err != nil || !result.Accepted || result.StatusCode != 202 || result.Headers["Expires"] != "900" || result.Headers["X-IMS"] != "subscribe-retry-ok" {
		t.Fatalf("SendDialogSubscribe() result=%+v err=%v", result, err)
	}
	if len(transport.requests) != 3 || transport.requests[1].Method != "SUBSCRIBE" || transport.requests[2].Method != "SUBSCRIBE" {
		t.Fatalf("requests=%+v", transport.requests)
	}
	first := transport.requests[1]
	retry := transport.requests[2]
	if first.Headers["CSeq"] != "2 SUBSCRIBE" || first.Headers["Expires"] != "300" {
		t.Fatalf("first SUBSCRIBE=%+v", first)
	}
	if retry.URI != "sip:carrier-subscribe@198.51.100.40:5060" ||
		retry.Headers["CSeq"] != "3 SUBSCRIBE" || retry.Headers["Expires"] != "900" || retry.Headers["Event"] != "refer" {
		t.Fatalf("retry SUBSCRIBE=%+v", retry)
	}
}

func TestIMSOutboundAgentSendsDefaultDialogSubscribeExpires(t *testing.T) {
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
			StatusCode: 202,
			Reason:     "Accepted",
			Headers:    map[string][]string{"Expires": {voiceclient.DefaultSubscribeExpires}},
		},
	}}
	agent := &IMSOutboundAgent{
		Transport: transport,
		Profile:   voiceclient.IMSProfile{IMPU: "sip:user@ims.example", Domain: "ims.example"},
		Registration: voiceclient.RegistrationBinding{
			ContactURI:     "sip:user@192.0.2.10:5060",
			PublicIdentity: "sip:user@ims.example",
		},
	}
	if _, err := agent.StartOutboundCall(context.Background(), OutboundCallRequest{
		CallID: "call-subscribe-default-expires",
		Callee: "+18005551212",
		RawSDP: []byte(sampleSDP("192.0.2.50", 4002)),
	}); err != nil {
		t.Fatalf("StartOutboundCall() error = %v", err)
	}
	result, err := agent.SendDialogSubscribe(context.Background(), DialogSubscribeRequest{
		CallID: "call-subscribe-default-expires",
		Event:  "refer",
	})
	if err != nil || !result.Accepted || result.Headers["Expires"] != voiceclient.DefaultSubscribeExpires {
		t.Fatalf("SendDialogSubscribe() result=%+v err=%v", result, err)
	}
	if len(transport.requests) != 2 || transport.requests[1].Method != "SUBSCRIBE" || transport.requests[1].Headers["Expires"] != voiceclient.DefaultSubscribeExpires {
		t.Fatalf("SUBSCRIBE requests=%+v", transport.requests)
	}
}

func TestIMSOutboundAgentFollowsSupplementaryDialogRedirectContacts(t *testing.T) {
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
			StatusCode: 302,
			Reason:     "Moved Temporarily",
			Headers:    map[string][]string{"Contact": {"<sip:refer-redirect@198.51.100.20:5060>"}},
		},
		{
			StatusCode: 202,
			Reason:     "Accepted",
			Headers:    map[string][]string{"Contact": {"<sip:refer-final@198.51.100.21:5060>"}, "X-IMS": {"refer-redirect-ok"}},
		},
		{
			StatusCode: 302,
			Reason:     "Moved Temporarily",
			Headers:    map[string][]string{"Contact": {"<sip:notify-redirect@198.51.100.30:5060>"}},
		},
		{
			StatusCode: 200,
			Reason:     "OK",
			Headers:    map[string][]string{"Contact": {"<sip:notify-final@198.51.100.31:5060>"}, "X-IMS": {"notify-redirect-ok"}},
		},
		{
			StatusCode: 302,
			Reason:     "Moved Temporarily",
			Headers:    map[string][]string{"Contact": {"<sip:subscribe-redirect@198.51.100.40:5060>"}},
		},
		{
			StatusCode: 202,
			Reason:     "Accepted",
			Headers:    map[string][]string{"Contact": {"<sip:subscribe-final@198.51.100.41:5060>"}, "X-IMS": {"subscribe-redirect-ok"}},
		},
		{StatusCode: 200, Reason: "OK"},
	}}
	agent := &IMSOutboundAgent{
		Transport: transport,
		Profile:   voiceclient.IMSProfile{IMPU: "sip:user@ims.example", Domain: "ims.example"},
		Registration: voiceclient.RegistrationBinding{
			ContactURI:     "sip:user@192.0.2.10:5060",
			PublicIdentity: "sip:user@ims.example",
		},
	}
	if _, err := agent.StartOutboundCall(context.Background(), OutboundCallRequest{
		CallID: "call-supplementary-redirect",
		Callee: "+18005551212",
		RawSDP: []byte(sampleSDP("192.0.2.50", 4002)),
	}); err != nil {
		t.Fatalf("StartOutboundCall() error = %v", err)
	}
	referResult, err := agent.SendDialogRefer(context.Background(), DialogReferRequest{
		CallID:     "call-supplementary-redirect",
		ReferTo:    "sip:+18005551313@ims.example",
		ReferredBy: "sip:user@ims.example",
	})
	if err != nil || !referResult.Accepted || referResult.Headers["X-IMS"] != "refer-redirect-ok" {
		t.Fatalf("SendDialogRefer() result=%+v err=%v", referResult, err)
	}
	notifyResult, err := agent.SendDialogNotify(context.Background(), DialogNotifyRequest{
		CallID:            "call-supplementary-redirect",
		Event:             "refer",
		SubscriptionState: "terminated;reason=noresource",
		ContentType:       "message/sipfrag",
		Body:              []byte("SIP/2.0 200 OK\r\n"),
	})
	if err != nil || !notifyResult.Accepted || notifyResult.Headers["X-IMS"] != "notify-redirect-ok" {
		t.Fatalf("SendDialogNotify() result=%+v err=%v", notifyResult, err)
	}
	subscribeResult, err := agent.SendDialogSubscribe(context.Background(), DialogSubscribeRequest{
		CallID:      "call-supplementary-redirect",
		Event:       "refer",
		Expires:     "300",
		ContentType: "application/resource-lists+xml",
		Body:        []byte("<resource-lists/>"),
	})
	if err != nil || !subscribeResult.Accepted || subscribeResult.Headers["X-IMS"] != "subscribe-redirect-ok" {
		t.Fatalf("SendDialogSubscribe() result=%+v err=%v", subscribeResult, err)
	}
	if len(transport.requests) != 7 {
		t.Fatalf("dialog requests=%+v", transport.requests)
	}
	check := func(index int, method, uri, cseq string) {
		t.Helper()
		if transport.requests[index].Method != method || transport.requests[index].URI != uri || transport.requests[index].Headers["CSeq"] != cseq {
			t.Fatalf("request[%d]=%+v", index, transport.requests[index])
		}
	}
	check(1, "REFER", "sip:carrier@198.51.100.1:5060", "2 REFER")
	check(2, "REFER", "sip:refer-redirect@198.51.100.20:5060", "3 REFER")
	check(3, "NOTIFY", "sip:refer-final@198.51.100.21:5060", "4 NOTIFY")
	check(4, "NOTIFY", "sip:notify-redirect@198.51.100.30:5060", "5 NOTIFY")
	check(5, "SUBSCRIBE", "sip:notify-final@198.51.100.31:5060", "6 SUBSCRIBE")
	check(6, "SUBSCRIBE", "sip:subscribe-redirect@198.51.100.40:5060", "7 SUBSCRIBE")
	if err := agent.EndVoiceCall(context.Background(), DialogInfo{CallID: "call-supplementary-redirect"}); err != nil {
		t.Fatalf("EndVoiceCall() error = %v", err)
	}
	if len(transport.requests) != 8 || transport.requests[7].Method != "BYE" ||
		transport.requests[7].URI != "sip:subscribe-final@198.51.100.41:5060" ||
		transport.requests[7].Headers["CSeq"] != "8 BYE" {
		t.Fatalf("BYE after redirects=%+v", transport.requests)
	}
}

func TestIMSOutboundAgentSendsDialogHoldAndResume(t *testing.T) {
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
		{StatusCode: 200, Reason: "OK", Headers: map[string][]string{"X-IMS": {"hold-ok"}}},
		{StatusCode: 200, Reason: "OK", Headers: map[string][]string{"X-IMS": {"resume-ok"}}},
		{StatusCode: 200, Reason: "OK"},
	}}
	agent := &IMSOutboundAgent{
		Transport: transport,
		Profile:   voiceclient.IMSProfile{IMPU: "sip:user@ims.example", Domain: "ims.example"},
		Registration: voiceclient.RegistrationBinding{
			ContactURI:     "sip:user@192.0.2.10:5060",
			PublicIdentity: "sip:user@ims.example",
			ServiceRoutes:  []string{"<sip:pcscf.ims.example;lr>"},
		},
	}
	if _, err := agent.StartOutboundCall(context.Background(), OutboundCallRequest{
		CallID: "call-hold",
		Callee: "+18005551212",
		RawSDP: []byte(sampleSDP("192.0.2.50", 4002)),
	}); err != nil {
		t.Fatalf("StartOutboundCall() error = %v", err)
	}
	hold, err := agent.SendDialogHold(context.Background(), DialogHoldRequest{
		CallID:  "call-hold",
		Headers: map[string]string{"X-Hold": "yes"},
	})
	if err != nil || !hold.Accepted || hold.Headers["X-IMS"] != "hold-ok" {
		t.Fatalf("SendDialogHold() result=%+v err=%v", hold, err)
	}
	if len(transport.requests) != 2 || transport.requests[1].Method != "UPDATE" {
		t.Fatalf("requests after hold=%+v", transport.requests)
	}
	holdReq := transport.requests[1]
	if holdReq.Headers["CSeq"] != "2 UPDATE" || holdReq.Headers["Content-Type"] != "application/sdp" ||
		holdReq.Headers["X-Hold"] != "yes" || !strings.Contains(string(holdReq.Body), "a=sendonly\r\n") ||
		strings.Contains(string(holdReq.Body), "a=sendrecv") {
		t.Fatalf("hold UPDATE=%+v body=%q", holdReq, holdReq.Body)
	}
	resume, err := agent.SendDialogResume(context.Background(), DialogResumeRequest{CallID: "call-hold"})
	if err != nil || !resume.Accepted || resume.Headers["X-IMS"] != "resume-ok" {
		t.Fatalf("SendDialogResume() result=%+v err=%v", resume, err)
	}
	if len(transport.requests) != 3 || transport.requests[2].Method != "UPDATE" {
		t.Fatalf("requests after resume=%+v", transport.requests)
	}
	resumeReq := transport.requests[2]
	if resumeReq.Headers["CSeq"] != "3 UPDATE" || resumeReq.Headers["Content-Type"] != "application/sdp" ||
		!strings.Contains(string(resumeReq.Body), "a=sendrecv\r\n") || strings.Contains(string(resumeReq.Body), "a=sendonly") {
		t.Fatalf("resume UPDATE=%+v body=%q", resumeReq, resumeReq.Body)
	}
	if err := agent.EndVoiceCall(context.Background(), DialogInfo{CallID: "call-hold"}); err != nil {
		t.Fatalf("EndVoiceCall() error = %v", err)
	}
	if len(transport.requests) != 4 || transport.requests[3].Method != "BYE" || transport.requests[3].Headers["CSeq"] != "4 BYE" {
		t.Fatalf("BYE after hold/resume=%+v", transport.requests)
	}
}

func TestIMSOutboundAgentDialogInfo481RequestsRegistrationRecovery(t *testing.T) {
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
			StatusCode: 481,
			Reason:     "Call/Transaction Does Not Exist",
			Headers:    map[string][]string{"Retry-After": {"6"}},
		},
	}}
	agent := &IMSOutboundAgent{
		Transport: transport,
		Profile:   voiceclient.IMSProfile{IMPU: "sip:user@ims.example", Domain: "ims.example"},
		Registration: voiceclient.RegistrationBinding{
			ContactURI:     "sip:user@192.0.2.10:5060",
			PublicIdentity: "sip:user@ims.example",
		},
	}
	if _, err := agent.StartOutboundCall(context.Background(), OutboundCallRequest{
		CallID: "call-info-recover",
		Callee: "+18005551212",
		RawSDP: []byte(sampleSDP("192.0.2.50", 4002)),
	}); err != nil {
		t.Fatalf("StartOutboundCall() error = %v", err)
	}
	result, err := agent.SendDialogInfo(context.Background(), DialogInfoRequest{
		CallID:      "call-info-recover",
		ContentType: "application/dtmf-relay",
		InfoPackage: "dtmf",
		Body:        []byte("Signal=1\r\nDuration=160\r\n"),
	})
	if err != nil {
		t.Fatalf("SendDialogInfo() error = %v", err)
	}
	if result.Accepted || result.StatusCode != 481 || !result.RegistrationRecoveryNeeded || result.RetryAfter != 6*time.Second {
		t.Fatalf("SendDialogInfo() result=%+v", result)
	}
}

func TestIMSOutboundAgentSendsInDialogUpdateAndAdvancesCSeq(t *testing.T) {
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
			StatusCode: 200,
			Reason:     "OK",
			Headers: map[string][]string{
				"Content-Type": {"application/sdp"},
				"Contact":      {"<sip:updated@198.51.100.2:5060>"},
				"X-IMS":        {"update-ok"},
			},
			Body: []byte(sampleSDP("203.0.113.20", 49180)),
		},
		{StatusCode: 200, Reason: "OK"},
	}}
	agent := &IMSOutboundAgent{
		Transport: transport,
		Profile:   voiceclient.IMSProfile{IMPU: "sip:user@ims.example", Domain: "ims.example"},
		Registration: voiceclient.RegistrationBinding{
			ContactURI:     "sip:user@192.0.2.10:5060",
			PublicIdentity: "sip:user@ims.example",
			ServiceRoutes:  []string{"<sip:pcscf.ims.example;lr>"},
		},
	}
	if _, err := agent.StartOutboundCall(context.Background(), OutboundCallRequest{
		CallID: "call-update",
		Callee: "+18005551212",
		RawSDP: []byte(sampleSDP("192.0.2.50", 4002)),
	}); err != nil {
		t.Fatalf("StartOutboundCall() error = %v", err)
	}
	result, err := agent.SendDialogUpdate(context.Background(), DialogUpdateRequest{
		CallID:      "call-update",
		ContentType: "application/sdp",
		Body:        []byte(sampleSDP("192.0.2.60", 4010)),
		Headers:     map[string]string{"Session-Expires": "1800"},
	})
	if err != nil || !result.Accepted || result.Headers["X-IMS"] != "update-ok" || !strings.Contains(string(result.Body), "m=audio 49180") {
		t.Fatalf("SendDialogUpdate() result=%+v err=%v", result, err)
	}
	if result.RegistrationRecoveryNeeded {
		t.Fatalf("successful UPDATE requested registration recovery: %+v", result)
	}
	if len(transport.requests) != 2 || transport.requests[1].Method != "UPDATE" {
		t.Fatalf("requests=%+v", transport.requests)
	}
	update := transport.requests[1]
	if update.URI != "sip:carrier@198.51.100.1:5060" || update.Headers["CSeq"] != "2 UPDATE" ||
		update.Headers["Content-Type"] != "application/sdp" || update.Headers["Session-Expires"] != "1800" ||
		!strings.Contains(string(update.Body), "m=audio 4010 RTP/AVP") {
		t.Fatalf("UPDATE=%+v body=%q", update, update.Body)
	}
	if err := agent.EndVoiceCall(context.Background(), DialogInfo{CallID: "call-update"}); err != nil {
		t.Fatalf("EndVoiceCall() error = %v", err)
	}
	if len(transport.requests) != 3 || transport.requests[2].Method != "BYE" ||
		transport.requests[2].URI != "sip:updated@198.51.100.2:5060" || transport.requests[2].Headers["CSeq"] != "3 BYE" {
		t.Fatalf("BYE after UPDATE=%+v", transport.requests)
	}
}

func TestIMSOutboundAgentDialogUpdate503RequestsRegistrationRecovery(t *testing.T) {
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
			StatusCode: 503,
			Reason:     "Service Unavailable",
			Headers:    map[string][]string{"Retry-After": {"8"}},
		},
	}}
	agent := &IMSOutboundAgent{
		Transport: transport,
		Profile:   voiceclient.IMSProfile{IMPU: "sip:user@ims.example", Domain: "ims.example"},
		Registration: voiceclient.RegistrationBinding{
			ContactURI:     "sip:user@192.0.2.10:5060",
			PublicIdentity: "sip:user@ims.example",
		},
	}
	if _, err := agent.StartOutboundCall(context.Background(), OutboundCallRequest{
		CallID: "call-update-recover",
		Callee: "+18005551212",
		RawSDP: []byte(sampleSDP("192.0.2.50", 4002)),
	}); err != nil {
		t.Fatalf("StartOutboundCall() error = %v", err)
	}
	result, err := agent.SendDialogUpdate(context.Background(), DialogUpdateRequest{
		CallID: "call-update-recover",
	})
	if err != nil {
		t.Fatalf("SendDialogUpdate() error = %v", err)
	}
	if result.Accepted || result.StatusCode != 503 || !result.RegistrationRecoveryNeeded || result.RetryAfter != 8*time.Second {
		t.Fatalf("SendDialogUpdate() result=%+v", result)
	}
}

func TestIMSOutboundAgentRetriesDialogUpdateOnGlare(t *testing.T) {
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
			StatusCode: 491,
			Reason:     "Request Pending",
			Headers:    map[string][]string{"Retry-After": {"0"}},
		},
		{
			StatusCode: 200,
			Reason:     "OK",
			Headers: map[string][]string{
				"Contact": {"<sip:updated@198.51.100.8:5060>"},
				"X-IMS":   {"update-glare-ok"},
			},
		},
		{StatusCode: 200, Reason: "OK"},
	}}
	agent := &IMSOutboundAgent{
		Transport: transport,
		Profile:   voiceclient.IMSProfile{IMPU: "sip:user@ims.example", Domain: "ims.example"},
		Registration: voiceclient.RegistrationBinding{
			ContactURI:     "sip:user@192.0.2.10:5060",
			PublicIdentity: "sip:user@ims.example",
		},
	}
	if _, err := agent.StartOutboundCall(context.Background(), OutboundCallRequest{
		CallID: "call-update-glare",
		Callee: "+18005551212",
		RawSDP: []byte(sampleSDP("192.0.2.50", 4002)),
	}); err != nil {
		t.Fatalf("StartOutboundCall() error = %v", err)
	}
	result, err := agent.SendDialogUpdate(context.Background(), DialogUpdateRequest{
		CallID:      "call-update-glare",
		ContentType: "application/sdp",
		Body:        []byte(sampleSDP("192.0.2.60", 4010)),
	})
	if err != nil || !result.Accepted || result.Headers["X-IMS"] != "update-glare-ok" {
		t.Fatalf("SendDialogUpdate() result=%+v err=%v", result, err)
	}
	if len(transport.requests) != 3 || transport.requests[1].Method != "UPDATE" || transport.requests[2].Method != "UPDATE" {
		t.Fatalf("requests=%+v", transport.requests)
	}
	firstUpdate := transport.requests[1]
	retryUpdate := transport.requests[2]
	if firstUpdate.URI != "sip:carrier@198.51.100.1:5060" || firstUpdate.Headers["CSeq"] != "2 UPDATE" {
		t.Fatalf("first UPDATE=%+v", firstUpdate)
	}
	if retryUpdate.URI != "sip:carrier@198.51.100.1:5060" ||
		retryUpdate.Headers["CSeq"] != "3 UPDATE" ||
		retryUpdate.Headers["Content-Type"] != "application/sdp" ||
		!strings.Contains(string(retryUpdate.Body), "m=audio 4010 RTP/AVP") {
		t.Fatalf("retry UPDATE=%+v body=%q", retryUpdate, retryUpdate.Body)
	}
	if err := agent.EndVoiceCall(context.Background(), DialogInfo{CallID: "call-update-glare"}); err != nil {
		t.Fatalf("EndVoiceCall() error = %v", err)
	}
	if len(transport.requests) != 4 || transport.requests[3].Method != "BYE" ||
		transport.requests[3].URI != "sip:updated@198.51.100.8:5060" ||
		transport.requests[3].Headers["CSeq"] != "4 BYE" {
		t.Fatalf("BYE after UPDATE glare retry=%+v", transport.requests)
	}
}

func TestIMSOutboundAgentRetriesDialogUpdateWithMinSE(t *testing.T) {
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
			StatusCode: 422,
			Reason:     "Session Interval Too Small",
			Headers:    map[string][]string{"Min-SE": {"1200"}},
		},
		{
			StatusCode: 200,
			Reason:     "OK",
			Headers: map[string][]string{
				"Contact": {"<sip:updated@198.51.100.3:5060>"},
				"X-IMS":   {"update-retry-ok"},
			},
			Body: []byte(sampleSDP("203.0.113.30", 49200)),
		},
		{StatusCode: 200, Reason: "OK"},
	}}
	agent := &IMSOutboundAgent{
		Transport:      transport,
		SessionExpires: 600,
		Profile:        voiceclient.IMSProfile{IMPU: "sip:user@ims.example", Domain: "ims.example"},
		Registration: voiceclient.RegistrationBinding{
			ContactURI:     "sip:user@192.0.2.10:5060",
			PublicIdentity: "sip:user@ims.example",
		},
	}
	if _, err := agent.StartOutboundCall(context.Background(), OutboundCallRequest{
		CallID: "call-update-minse",
		Callee: "+18005551212",
		RawSDP: []byte(sampleSDP("192.0.2.50", 4002)),
	}); err != nil {
		t.Fatalf("StartOutboundCall() error = %v", err)
	}
	result, err := agent.SendDialogUpdate(context.Background(), DialogUpdateRequest{
		CallID:      "call-update-minse",
		ContentType: "application/sdp",
		Body:        []byte(sampleSDP("192.0.2.60", 4010)),
		Headers:     map[string]string{"Session-Expires": "600;refresher=uas"},
	})
	if err != nil || !result.Accepted || result.Headers["X-IMS"] != "update-retry-ok" {
		t.Fatalf("SendDialogUpdate() result=%+v err=%v", result, err)
	}
	if len(transport.requests) != 3 || transport.requests[1].Method != "UPDATE" || transport.requests[2].Method != "UPDATE" {
		t.Fatalf("requests=%+v", transport.requests)
	}
	firstUpdate := transport.requests[1]
	retryUpdate := transport.requests[2]
	if firstUpdate.Headers["CSeq"] != "2 UPDATE" || firstUpdate.Headers["Session-Expires"] != "600;refresher=uas" || firstUpdate.Headers["Min-SE"] != "" {
		t.Fatalf("first UPDATE=%+v", firstUpdate)
	}
	if retryUpdate.Headers["CSeq"] != "3 UPDATE" || retryUpdate.Headers["Session-Expires"] != "1200;refresher=uas" || retryUpdate.Headers["Min-SE"] != "1200" {
		t.Fatalf("retry UPDATE=%+v", retryUpdate)
	}
	if err := agent.EndVoiceCall(context.Background(), DialogInfo{CallID: "call-update-minse"}); err != nil {
		t.Fatalf("EndVoiceCall() error = %v", err)
	}
	if len(transport.requests) != 4 || transport.requests[3].Method != "BYE" ||
		transport.requests[3].URI != "sip:updated@198.51.100.3:5060" ||
		transport.requests[3].Headers["CSeq"] != "4 BYE" {
		t.Fatalf("BYE after UPDATE retry=%+v", transport.requests)
	}
}

func TestIMSOutboundAgentFollowsDialogUpdateRedirectContact(t *testing.T) {
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
			StatusCode: 302,
			Reason:     "Moved Temporarily",
			Headers: map[string][]string{
				"Contact": {"<sip:redirect@198.51.100.30:5060>"},
			},
		},
		{
			StatusCode: 200,
			Reason:     "OK",
			Headers: map[string][]string{
				"Contact":      {"<sip:updated@198.51.100.3:5060>"},
				"Content-Type": {"application/sdp"},
				"X-IMS":        {"update-redirect-ok"},
			},
			Body: []byte(sampleSDP("203.0.113.30", 49200)),
		},
		{StatusCode: 200, Reason: "OK"},
	}}
	agent := &IMSOutboundAgent{
		Transport:      transport,
		SessionExpires: 600,
		Profile:        voiceclient.IMSProfile{IMPU: "sip:user@ims.example", Domain: "ims.example"},
		Registration: voiceclient.RegistrationBinding{
			ContactURI:     "sip:user@192.0.2.10:5060",
			PublicIdentity: "sip:user@ims.example",
		},
	}
	if _, err := agent.StartOutboundCall(context.Background(), OutboundCallRequest{
		CallID: "call-update-redirect",
		Callee: "+18005551212",
		RawSDP: []byte(sampleSDP("192.0.2.50", 4002)),
	}); err != nil {
		t.Fatalf("StartOutboundCall() error = %v", err)
	}
	result, err := agent.SendDialogUpdate(context.Background(), DialogUpdateRequest{
		CallID:      "call-update-redirect",
		ContentType: "application/sdp",
		Body:        []byte(sampleSDP("192.0.2.60", 4010)),
		Headers:     map[string]string{"Session-Expires": "600;refresher=uas"},
	})
	if err != nil || !result.Accepted || result.Headers["X-IMS"] != "update-redirect-ok" {
		t.Fatalf("SendDialogUpdate() result=%+v err=%v", result, err)
	}
	if len(transport.requests) != 3 || transport.requests[1].Method != "UPDATE" ||
		transport.requests[2].Method != "UPDATE" {
		t.Fatalf("UPDATE requests=%+v", transport.requests)
	}
	firstUpdate := transport.requests[1]
	redirectUpdate := transport.requests[2]
	if firstUpdate.URI != "sip:carrier@198.51.100.1:5060" ||
		firstUpdate.Headers["CSeq"] != "2 UPDATE" ||
		firstUpdate.Headers["Session-Expires"] != "600;refresher=uas" {
		t.Fatalf("first UPDATE=%+v", firstUpdate)
	}
	if redirectUpdate.URI != "sip:redirect@198.51.100.30:5060" ||
		redirectUpdate.Headers["CSeq"] != "3 UPDATE" ||
		redirectUpdate.Headers["Session-Expires"] != "600;refresher=uas" {
		t.Fatalf("redirect UPDATE=%+v", redirectUpdate)
	}
	if err := agent.EndVoiceCall(context.Background(), DialogInfo{CallID: "call-update-redirect"}); err != nil {
		t.Fatalf("EndVoiceCall() error = %v", err)
	}
	if len(transport.requests) != 4 || transport.requests[3].Method != "BYE" ||
		transport.requests[3].URI != "sip:updated@198.51.100.3:5060" ||
		transport.requests[3].Headers["CSeq"] != "4 BYE" {
		t.Fatalf("BYE after UPDATE redirect=%+v", transport.requests)
	}
}

func TestIMSOutboundAgentCarriesNegotiatedSessionRefresher(t *testing.T) {
	transport := &fakeIMSVoiceTransport{responses: []voiceclient.SIPResponse{
		{
			StatusCode: 200,
			Reason:     "OK",
			Headers: map[string][]string{
				"To":              {"<sip:+18005551212@ims.example>;tag=remote-tag"},
				"Contact":         {"<sip:carrier@198.51.100.1:5060>"},
				"Session-Expires": {"1800;refresher=uas"},
			},
			Body: []byte(sampleSDP("203.0.113.10", 49170)),
		},
		{
			StatusCode: 200,
			Reason:     "OK",
			Headers: map[string][]string{
				"Session-Expires": {"1200;refresher=uac"},
			},
		},
		{
			StatusCode: 200,
			Reason:     "OK",
			Headers:    map[string][]string{"To": {"<sip:+18005551212@ims.example>;tag=remote-tag"}},
		},
		{StatusCode: 200, Reason: "OK"},
		{StatusCode: 200, Reason: "OK"},
	}}
	agent := &IMSOutboundAgent{
		Transport:        transport,
		SessionExpires:   600,
		SessionRefresher: "uac",
		Profile:          voiceclient.IMSProfile{IMPU: "sip:user@ims.example", Domain: "ims.example"},
		Registration: voiceclient.RegistrationBinding{
			ContactURI:     "sip:user@192.0.2.10:5060",
			PublicIdentity: "sip:user@ims.example",
		},
	}
	result, err := agent.StartOutboundCall(context.Background(), OutboundCallRequest{
		CallID: "call-session-refresher",
		Callee: "+18005551212",
		RawSDP: []byte(sampleSDP("192.0.2.50", 4002)),
	})
	if err != nil || !result.Accepted || result.Headers["Session-Expires"] != "1800;refresher=uas" {
		t.Fatalf("StartOutboundCall() result=%+v err=%v", result, err)
	}
	updateResult, err := agent.SendDialogUpdate(context.Background(), DialogUpdateRequest{
		CallID: "call-session-refresher",
	})
	if err != nil || !updateResult.Accepted {
		t.Fatalf("SendDialogUpdate() result=%+v err=%v", updateResult, err)
	}
	reinviteResult, err := agent.SendDialogReinvite(context.Background(), DialogReinviteRequest{
		CallID: "call-session-refresher",
	})
	if err != nil || !reinviteResult.Accepted {
		t.Fatalf("SendDialogReinvite() result=%+v err=%v", reinviteResult, err)
	}
	secondUpdateResult, err := agent.SendDialogUpdate(context.Background(), DialogUpdateRequest{
		CallID: "call-session-refresher",
	})
	if err != nil || !secondUpdateResult.Accepted {
		t.Fatalf("second SendDialogUpdate() result=%+v err=%v", secondUpdateResult, err)
	}
	if len(transport.requests) != 4 || transport.requests[0].Method != "INVITE" ||
		transport.requests[1].Method != "UPDATE" || transport.requests[2].Method != "INVITE" ||
		transport.requests[3].Method != "UPDATE" {
		t.Fatalf("requests=%+v", transport.requests)
	}
	if transport.requests[0].Headers["Session-Expires"] != "600;refresher=uac" {
		t.Fatalf("initial INVITE Session-Expires=%q", transport.requests[0].Headers["Session-Expires"])
	}
	if transport.requests[1].Headers["Session-Expires"] != "1800;refresher=uas" {
		t.Fatalf("UPDATE Session-Expires=%q", transport.requests[1].Headers["Session-Expires"])
	}
	if transport.requests[2].Headers["Session-Expires"] != "1200;refresher=uac" {
		t.Fatalf("re-INVITE Session-Expires=%q", transport.requests[2].Headers["Session-Expires"])
	}
	if transport.requests[3].Headers["Session-Expires"] != "" {
		t.Fatalf("second UPDATE Session-Expires=%q, want timer disabled after 2xx without header", transport.requests[3].Headers["Session-Expires"])
	}
	if err := agent.EndVoiceCall(context.Background(), DialogInfo{CallID: "call-session-refresher"}); err != nil {
		t.Fatalf("EndVoiceCall() error = %v", err)
	}
}

func TestIMSOutboundAgentAutoRefreshesUACSessionTimer(t *testing.T) {
	transport := &fakeIMSVoiceTransport{responses: []voiceclient.SIPResponse{
		{
			StatusCode: 200,
			Reason:     "OK",
			Headers: map[string][]string{
				"To":              {"<sip:+18005551212@ims.example>;tag=remote-tag"},
				"Contact":         {"<sip:carrier@198.51.100.1:5060>"},
				"Session-Expires": {"1;refresher=uac"},
			},
			Body: []byte(sampleSDP("203.0.113.10", 49170)),
		},
		{
			StatusCode: 200,
			Reason:     "OK",
			Headers:    map[string][]string{"X-IMS": {"refresh-ok"}},
		},
		{StatusCode: 200, Reason: "OK"},
	}}
	agent := &IMSOutboundAgent{
		Transport:          transport,
		SessionRefreshLead: 950 * time.Millisecond,
		Profile:            voiceclient.IMSProfile{IMPU: "sip:user@ims.example", Domain: "ims.example"},
		Registration: voiceclient.RegistrationBinding{
			ContactURI:     "sip:user@192.0.2.10:5060",
			PublicIdentity: "sip:user@ims.example",
		},
	}
	if _, err := agent.StartOutboundCall(context.Background(), OutboundCallRequest{
		CallID: "call-auto-refresh",
		Callee: "+18005551212",
		RawSDP: []byte(sampleSDP("192.0.2.50", 4002)),
	}); err != nil {
		t.Fatalf("StartOutboundCall() error = %v", err)
	}
	requests := waitForIMSRequests(t, transport, 2)
	agent.StopSessionTimers()
	if requests[1].Method != "UPDATE" || requests[1].Headers["CSeq"] != "2 UPDATE" ||
		requests[1].Headers["Session-Expires"] != "1;refresher=uac" || len(requests[1].Body) != 0 {
		t.Fatalf("refresh UPDATE=%+v body=%q", requests[1], requests[1].Body)
	}
	if err := agent.EndVoiceCall(context.Background(), DialogInfo{CallID: "call-auto-refresh"}); err != nil {
		t.Fatalf("EndVoiceCall() error = %v", err)
	}
	requests = transport.requestSnapshot()
	if len(requests) < 3 || requests[len(requests)-1].Method != "BYE" || requests[len(requests)-1].Headers["CSeq"] != "3 BYE" {
		t.Fatalf("BYE after refresh requests=%+v", requests)
	}
}

func TestIMSOutboundAgentAutoRefreshIgnoresQuotedSessionExpiresParams(t *testing.T) {
	transport := &fakeIMSVoiceTransport{responses: []voiceclient.SIPResponse{
		{
			StatusCode: 200,
			Reason:     "OK",
			Headers: map[string][]string{
				"To":              {"<sip:+18005551212@ims.example>;tag=remote-tag"},
				"Contact":         {"<sip:carrier@198.51.100.1:5060>"},
				"Session-Expires": {`1;refresher=uac;opaque="quoted;refresher=uas"`},
			},
			Body: []byte(sampleSDP("203.0.113.10", 49170)),
		},
		{
			StatusCode: 200,
			Reason:     "OK",
			Headers:    map[string][]string{"X-IMS": {"refresh-ok"}},
		},
		{StatusCode: 200, Reason: "OK"},
	}}
	agent := &IMSOutboundAgent{
		Transport:          transport,
		SessionRefreshLead: 950 * time.Millisecond,
		Profile:            voiceclient.IMSProfile{IMPU: "sip:user@ims.example", Domain: "ims.example"},
		Registration: voiceclient.RegistrationBinding{
			ContactURI:     "sip:user@192.0.2.10:5060",
			PublicIdentity: "sip:user@ims.example",
		},
	}
	if _, err := agent.StartOutboundCall(context.Background(), OutboundCallRequest{
		CallID: "call-auto-refresh-quoted-param",
		Callee: "+18005551212",
		RawSDP: []byte(sampleSDP("192.0.2.50", 4002)),
	}); err != nil {
		t.Fatalf("StartOutboundCall() error = %v", err)
	}
	requests := waitForIMSRequests(t, transport, 2)
	agent.StopSessionTimers()
	if requests[1].Method != "UPDATE" || requests[1].Headers["CSeq"] != "2 UPDATE" ||
		requests[1].Headers["Session-Expires"] != "1;refresher=uac" || len(requests[1].Body) != 0 {
		t.Fatalf("refresh UPDATE=%+v body=%q", requests[1], requests[1].Body)
	}
	if err := agent.EndVoiceCall(context.Background(), DialogInfo{CallID: "call-auto-refresh-quoted-param"}); err != nil {
		t.Fatalf("EndVoiceCall() error = %v", err)
	}
	requests = transport.requestSnapshot()
	if len(requests) < 3 || requests[len(requests)-1].Method != "BYE" || requests[len(requests)-1].Headers["CSeq"] != "3 BYE" {
		t.Fatalf("BYE after quoted-param refresh requests=%+v", requests)
	}
}

func TestIMSOutboundAgentDoesNotAutoRefreshUASSessionTimer(t *testing.T) {
	agent := &IMSOutboundAgent{}
	agent.storeDialog("call-uas-refresh", imsDialogState{cfg: voiceclient.DialogRequestConfig{
		SessionExpires:   1,
		SessionRefresher: "uas",
	}})
	agent.scheduleDialogSessionRefresh("call-uas-refresh")
	agent.mu.Lock()
	state := agent.dialogs["call-uas-refresh"]
	agent.mu.Unlock()
	if state.refreshTimer != nil {
		state.refreshTimer.Stop()
		t.Fatal("scheduled local refresh for refresher=uas")
	}
}

func TestIMSOutboundAgentStopsAutoRefreshWhileTerminating(t *testing.T) {
	transport := newBlockingMethodTransport("BYE", voiceclient.SIPResponse{StatusCode: 200, Reason: "OK"})
	agent := &IMSOutboundAgent{
		Transport:          transport,
		SessionRefreshLead: 800 * time.Millisecond,
	}
	agent.storeDialog("call-terminating-refresh", imsDialogState{cfg: sessionTimerDialogConfig("call-terminating-refresh", 2)})
	agent.scheduleDialogSessionRefresh("call-terminating-refresh")

	done := make(chan error, 1)
	go func() {
		_, err := agent.EndVoiceCallWithResult(context.Background(), DialogInfo{CallID: "call-terminating-refresh"})
		done <- err
	}()
	transport.waitBlocked(t)
	time.Sleep(300 * time.Millisecond)
	requests := transport.requestSnapshot()
	if len(requests) != 1 || requests[0].Method != "BYE" {
		t.Fatalf("requests while BYE blocked=%+v, want only BYE", requests)
	}
	transport.release()
	if err := <-done; err != nil {
		t.Fatalf("EndVoiceCallWithResult() error = %v", err)
	}
	if _, ok := agent.dialogs["call-terminating-refresh"]; ok {
		t.Fatal("dialog should close after accepted BYE")
	}
}

func TestIMSOutboundAgentResumesAutoRefreshAfterRejectedBye(t *testing.T) {
	transport := &fakeIMSVoiceTransport{responses: []voiceclient.SIPResponse{
		{StatusCode: 503, Reason: "Service Unavailable"},
		{StatusCode: 200, Reason: "OK"},
	}}
	agent := &IMSOutboundAgent{Transport: transport}
	cfg := sessionTimerDialogConfig("call-rejected-bye-refresh", 2)
	cfg.SessionExpires = 3600
	agent.storeDialog("call-rejected-bye-refresh", imsDialogState{cfg: cfg})
	agent.scheduleDialogSessionRefresh("call-rejected-bye-refresh")

	result, err := agent.EndVoiceCallWithResult(context.Background(), DialogInfo{CallID: "call-rejected-bye-refresh"})
	if err == nil || result.StatusCode != 503 {
		t.Fatalf("EndVoiceCallWithResult() result=%+v err=%v, want rejected BYE", result, err)
	}
	agent.mu.Lock()
	state := agent.dialogs["call-rejected-bye-refresh"]
	agent.mu.Unlock()
	if state.terminating || state.refreshTimer == nil {
		t.Fatalf("state after rejected BYE terminating=%t refreshTimer=%v", state.terminating, state.refreshTimer)
	}
	agent.StopSessionTimers()
	if err := agent.EndVoiceCall(context.Background(), DialogInfo{CallID: "call-rejected-bye-refresh"}); err != nil {
		t.Fatalf("EndVoiceCall() retry error = %v", err)
	}
	if len(transport.requests) != 2 || transport.requests[0].Headers["CSeq"] != "2 BYE" ||
		transport.requests[1].Headers["CSeq"] != "3 BYE" {
		t.Fatalf("BYE requests=%+v", transport.requests)
	}
}

func TestIMSOutboundAgentRewritesInDialogUpdateThroughRelay(t *testing.T) {
	transport := &fakeIMSVoiceTransport{responses: []voiceclient.SIPResponse{
		{
			StatusCode: 200,
			Reason:     "OK",
			Headers: map[string][]string{
				"To":      {"<sip:+18005551212@ims.example>;tag=remote-tag"},
				"Contact": {"<sip:carrier@127.0.0.1:5060>"},
			},
			Body: []byte(sampleSDP("127.0.0.1", 49170)),
		},
		{
			StatusCode: 200,
			Reason:     "OK",
			Headers:    map[string][]string{"Content-Type": {"application/sdp"}},
			Body:       []byte(sampleSDP("127.0.0.1", 49180)),
		},
		{StatusCode: 200, Reason: "OK"},
	}}
	agent := &IMSOutboundAgent{
		Transport: transport,
		Profile:   voiceclient.IMSProfile{IMPU: "sip:user@ims.example", Domain: "ims.example"},
		Registration: voiceclient.RegistrationBinding{
			ContactURI:     "sip:user@127.0.0.1:5060",
			PublicIdentity: "sip:user@ims.example",
		},
		MediaRelay: &RTPRelayConfig{
			ClientListenIP:    "127.0.0.1",
			ClientAdvertiseIP: "127.0.0.1",
			IMSListenIP:       "127.0.0.1",
			IMSAdvertiseIP:    "127.0.0.1",
		},
	}
	if _, err := agent.StartOutboundCall(context.Background(), OutboundCallRequest{
		CallID:    "call-update-relay",
		Callee:    "+18005551212",
		RemoteSDP: SDPInfo{ConnectionIP: "127.0.0.1", MediaPort: 4002, Payloads: []int{0, 101}, Direction: "sendrecv"},
		RawSDP:    []byte(sampleSDP("127.0.0.1", 4002)),
	}); err != nil {
		t.Fatalf("StartOutboundCall() error = %v", err)
	}
	result, err := agent.SendDialogUpdate(context.Background(), DialogUpdateRequest{
		CallID:      "call-update-relay",
		ContentType: "application/sdp",
		Body:        []byte(sampleSDP("127.0.0.1", 4010)),
	})
	if err != nil || !result.Accepted {
		t.Fatalf("SendDialogUpdate() result=%+v err=%v", result, err)
	}
	if len(transport.requests) != 2 || transport.requests[1].Method != "UPDATE" {
		t.Fatalf("requests=%+v", transport.requests)
	}
	imsOffer, err := ParseSDP(transport.requests[1].Body)
	if err != nil {
		t.Fatalf("ParseSDP(IMS UPDATE offer) error = %v", err)
	}
	if imsOffer.MediaPort == 4010 || imsOffer.MediaPort <= 0 {
		t.Fatalf("IMS UPDATE offer was not rewritten: %+v", imsOffer)
	}
	clientAnswer, err := ParseSDP(result.Body)
	if err != nil {
		t.Fatalf("ParseSDP(client UPDATE answer) error = %v", err)
	}
	if clientAnswer.MediaPort == 49180 || clientAnswer.MediaPort <= 0 {
		t.Fatalf("client UPDATE answer was not rewritten: %+v", clientAnswer)
	}
	if err := agent.EndVoiceCall(context.Background(), DialogInfo{CallID: "call-update-relay"}); err != nil {
		t.Fatalf("EndVoiceCall() error = %v", err)
	}
}

func TestIMSOutboundAgentSendsInDialogReinviteAndAdvancesCSeq(t *testing.T) {
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
			StatusCode: 200,
			Reason:     "OK",
			Headers: map[string][]string{
				"To":           {"<sip:+18005551212@ims.example>;tag=remote-tag"},
				"Contact":      {"<sip:updated@198.51.100.2:5060>"},
				"Content-Type": {"application/sdp"},
				"X-IMS":        {"reinvite-ok"},
			},
			Body: []byte(sampleSDP("203.0.113.20", 49180)),
		},
		{StatusCode: 200, Reason: "OK"},
	}}
	agent := &IMSOutboundAgent{
		Transport: transport,
		Profile:   voiceclient.IMSProfile{IMPU: "sip:user@ims.example", Domain: "ims.example"},
		Registration: voiceclient.RegistrationBinding{
			ContactURI:     "sip:user@192.0.2.10:5060",
			PublicIdentity: "sip:user@ims.example",
			ServiceRoutes:  []string{"<sip:pcscf.ims.example;lr>"},
		},
	}
	if _, err := agent.StartOutboundCall(context.Background(), OutboundCallRequest{
		CallID: "call-reinvite",
		Callee: "+18005551212",
		RawSDP: []byte(sampleSDP("192.0.2.50", 4002)),
	}); err != nil {
		t.Fatalf("StartOutboundCall() error = %v", err)
	}
	result, err := agent.SendDialogReinvite(context.Background(), DialogReinviteRequest{
		CallID:      "call-reinvite",
		ContentType: "application/sdp",
		Body:        []byte(sampleSDP("192.0.2.60", 4010)),
		Headers:     map[string]string{"Session-Expires": "1800"},
	})
	if err != nil || !result.Accepted || result.Headers["X-IMS"] != "reinvite-ok" || !strings.Contains(string(result.Body), "m=audio 49180") {
		t.Fatalf("SendDialogReinvite() result=%+v err=%v", result, err)
	}
	if result.RegistrationRecoveryNeeded {
		t.Fatalf("successful re-INVITE requested registration recovery: %+v", result)
	}
	if len(transport.requests) != 2 || transport.requests[1].Method != "INVITE" {
		t.Fatalf("requests=%+v", transport.requests)
	}
	reinvite := transport.requests[1]
	if reinvite.URI != "sip:carrier@198.51.100.1:5060" || reinvite.Headers["CSeq"] != "2 INVITE" ||
		reinvite.Headers["Content-Type"] != "application/sdp" || reinvite.Headers["Session-Expires"] != "1800" ||
		!strings.Contains(string(reinvite.Body), "m=audio 4010 RTP/AVP") {
		t.Fatalf("re-INVITE=%+v body=%q", reinvite, reinvite.Body)
	}
	if len(transport.writes) != 2 || transport.writes[1].Method != "ACK" ||
		transport.writes[1].URI != "sip:updated@198.51.100.2:5060" ||
		transport.writes[1].Headers["CSeq"] != "2 ACK" {
		t.Fatalf("ACK writes=%+v", transport.writes)
	}
	if err := agent.EndVoiceCall(context.Background(), DialogInfo{CallID: "call-reinvite"}); err != nil {
		t.Fatalf("EndVoiceCall() error = %v", err)
	}
	if len(transport.requests) != 3 || transport.requests[2].Method != "BYE" ||
		transport.requests[2].URI != "sip:updated@198.51.100.2:5060" ||
		transport.requests[2].Headers["CSeq"] != "3 BYE" {
		t.Fatalf("BYE after re-INVITE=%+v", transport.requests)
	}
}

func TestIMSOutboundAgentFollowsDialogReinviteRedirectContact(t *testing.T) {
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
			StatusCode: 302,
			Reason:     "Moved Temporarily",
			Headers: map[string][]string{
				"To":      {"<sip:+18005551212@ims.example>;tag=remote-tag"},
				"Contact": {"<sip:redirect@198.51.100.30:5060>"},
			},
		},
		{
			StatusCode: 200,
			Reason:     "OK",
			Headers: map[string][]string{
				"To":           {"<sip:+18005551212@ims.example>;tag=remote-tag"},
				"Contact":      {"<sip:updated@198.51.100.2:5060>"},
				"Content-Type": {"application/sdp"},
				"X-IMS":        {"reinvite-redirect-ok"},
			},
			Body: []byte(sampleSDP("203.0.113.20", 49180)),
		},
		{StatusCode: 200, Reason: "OK"},
	}}
	agent := &IMSOutboundAgent{
		Transport: transport,
		Profile:   voiceclient.IMSProfile{IMPU: "sip:user@ims.example", Domain: "ims.example"},
		Registration: voiceclient.RegistrationBinding{
			ContactURI:     "sip:user@192.0.2.10:5060",
			PublicIdentity: "sip:user@ims.example",
			ServiceRoutes:  []string{"<sip:pcscf.ims.example;lr>"},
		},
	}
	if _, err := agent.StartOutboundCall(context.Background(), OutboundCallRequest{
		CallID: "call-reinvite-redirect",
		Callee: "+18005551212",
		RawSDP: []byte(sampleSDP("192.0.2.50", 4002)),
	}); err != nil {
		t.Fatalf("StartOutboundCall() error = %v", err)
	}

	result, err := agent.SendDialogReinvite(context.Background(), DialogReinviteRequest{
		CallID:      "call-reinvite-redirect",
		ContentType: "application/sdp",
		Body:        []byte(sampleSDP("192.0.2.60", 4010)),
		Headers:     map[string]string{"Session-Expires": "1800"},
	})
	if err != nil || !result.Accepted || result.Headers["X-IMS"] != "reinvite-redirect-ok" {
		t.Fatalf("SendDialogReinvite() result=%+v err=%v", result, err)
	}
	if len(transport.requests) != 3 ||
		transport.requests[0].Method != "INVITE" ||
		transport.requests[1].Method != "INVITE" ||
		transport.requests[2].Method != "INVITE" {
		t.Fatalf("requests=%+v", transport.requests)
	}
	firstReinvite := transport.requests[1]
	redirectReinvite := transport.requests[2]
	if firstReinvite.URI != "sip:carrier@198.51.100.1:5060" ||
		firstReinvite.Headers["CSeq"] != "2 INVITE" {
		t.Fatalf("first re-INVITE=%+v", firstReinvite)
	}
	if redirectReinvite.URI != "sip:redirect@198.51.100.30:5060" ||
		redirectReinvite.Headers["CSeq"] != "3 INVITE" ||
		redirectReinvite.Headers["To"] != firstReinvite.Headers["To"] ||
		redirectReinvite.Headers["Session-Expires"] != "1800" {
		t.Fatalf("redirect re-INVITE=%+v first=%+v", redirectReinvite, firstReinvite)
	}
	if len(transport.writes) != 3 ||
		transport.writes[0].Method != "ACK" ||
		transport.writes[1].Method != "ACK" ||
		transport.writes[2].Method != "ACK" {
		t.Fatalf("ACK writes=%+v", transport.writes)
	}
	if transport.writes[1].Headers["CSeq"] != "2 ACK" ||
		transport.writes[1].Headers["Via"] != firstReinvite.Headers["Via"] ||
		transport.writes[1].URI != "sip:carrier@198.51.100.1:5060" {
		t.Fatalf("redirect ACK=%+v first=%+v", transport.writes[1], firstReinvite)
	}
	if transport.writes[2].Headers["CSeq"] != "3 ACK" ||
		transport.writes[2].URI != "sip:updated@198.51.100.2:5060" {
		t.Fatalf("final ACK=%+v", transport.writes[2])
	}

	if err := agent.EndVoiceCall(context.Background(), DialogInfo{CallID: "call-reinvite-redirect"}); err != nil {
		t.Fatalf("EndVoiceCall() error = %v", err)
	}
	if len(transport.requests) != 4 || transport.requests[3].Method != "BYE" ||
		transport.requests[3].URI != "sip:updated@198.51.100.2:5060" ||
		transport.requests[3].Headers["CSeq"] != "4 BYE" {
		t.Fatalf("BYE after re-INVITE redirect=%+v", transport.requests)
	}
}

func TestIMSOutboundAgentDialogReinvite481RequestsRegistrationRecovery(t *testing.T) {
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
			StatusCode: 481,
			Reason:     "Call/Transaction Does Not Exist",
			Headers: map[string][]string{
				"To":          {"<sip:+18005551212@ims.example>;tag=gone-tag"},
				"Retry-After": {"9"},
			},
		},
	}}
	agent := &IMSOutboundAgent{
		Transport: transport,
		Profile:   voiceclient.IMSProfile{IMPU: "sip:user@ims.example", Domain: "ims.example"},
		Registration: voiceclient.RegistrationBinding{
			ContactURI:     "sip:user@192.0.2.10:5060",
			PublicIdentity: "sip:user@ims.example",
		},
	}
	if _, err := agent.StartOutboundCall(context.Background(), OutboundCallRequest{
		CallID: "call-reinvite-recover",
		Callee: "+18005551212",
		RawSDP: []byte(sampleSDP("192.0.2.50", 4002)),
	}); err != nil {
		t.Fatalf("StartOutboundCall() error = %v", err)
	}
	result, err := agent.SendDialogReinvite(context.Background(), DialogReinviteRequest{
		CallID:      "call-reinvite-recover",
		ContentType: "application/sdp",
		Body:        []byte(sampleSDP("192.0.2.60", 4010)),
	})
	if err != nil {
		t.Fatalf("SendDialogReinvite() error = %v", err)
	}
	if result.Accepted || result.StatusCode != 481 || !result.RegistrationRecoveryNeeded || result.RetryAfter != 9*time.Second {
		t.Fatalf("SendDialogReinvite() result=%+v", result)
	}
	if len(transport.writes) != 2 || transport.writes[1].Method != "ACK" ||
		transport.writes[1].Headers["CSeq"] != "2 ACK" ||
		!strings.Contains(transport.writes[1].Headers["To"], "gone-tag") {
		t.Fatalf("ACK writes=%+v", transport.writes)
	}
}

func TestIMSOutboundAgentRetriesDialogReinviteOnRetryAfterGlare(t *testing.T) {
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
			StatusCode: 500,
			Reason:     "Server Internal Error",
			Headers: map[string][]string{
				"To":          {"<sip:+18005551212@ims.example>;tag=glare-tag"},
				"Retry-After": {"0"},
			},
		},
		{
			StatusCode: 200,
			Reason:     "OK",
			Headers: map[string][]string{
				"To":      {"<sip:+18005551212@ims.example>;tag=remote-tag"},
				"Contact": {"<sip:updated@198.51.100.9:5060>"},
				"X-IMS":   {"reinvite-glare-ok"},
			},
			Body: []byte(sampleSDP("203.0.113.20", 49180)),
		},
		{StatusCode: 200, Reason: "OK"},
	}}
	agent := &IMSOutboundAgent{
		Transport: transport,
		Profile:   voiceclient.IMSProfile{IMPU: "sip:user@ims.example", Domain: "ims.example"},
		Registration: voiceclient.RegistrationBinding{
			ContactURI:     "sip:user@192.0.2.10:5060",
			PublicIdentity: "sip:user@ims.example",
		},
	}
	if _, err := agent.StartOutboundCall(context.Background(), OutboundCallRequest{
		CallID: "call-reinvite-glare",
		Callee: "+18005551212",
		RawSDP: []byte(sampleSDP("192.0.2.50", 4002)),
	}); err != nil {
		t.Fatalf("StartOutboundCall() error = %v", err)
	}
	result, err := agent.SendDialogReinvite(context.Background(), DialogReinviteRequest{
		CallID:      "call-reinvite-glare",
		ContentType: "application/sdp",
		Body:        []byte(sampleSDP("192.0.2.60", 4010)),
	})
	if err != nil || !result.Accepted || result.Headers["X-IMS"] != "reinvite-glare-ok" ||
		!strings.Contains(string(result.Body), "m=audio 49180") {
		t.Fatalf("SendDialogReinvite() result=%+v err=%v", result, err)
	}
	if len(transport.requests) != 3 ||
		transport.requests[1].Method != "INVITE" ||
		transport.requests[2].Method != "INVITE" {
		t.Fatalf("requests=%+v", transport.requests)
	}
	firstReinvite := transport.requests[1]
	retryReinvite := transport.requests[2]
	if firstReinvite.URI != "sip:carrier@198.51.100.1:5060" || firstReinvite.Headers["CSeq"] != "2 INVITE" {
		t.Fatalf("first re-INVITE=%+v", firstReinvite)
	}
	if retryReinvite.URI != "sip:carrier@198.51.100.1:5060" ||
		retryReinvite.Headers["CSeq"] != "3 INVITE" ||
		retryReinvite.Headers["Content-Type"] != "application/sdp" ||
		!strings.Contains(string(retryReinvite.Body), "m=audio 4010 RTP/AVP") {
		t.Fatalf("retry re-INVITE=%+v body=%q", retryReinvite, retryReinvite.Body)
	}
	if len(transport.writes) != 3 ||
		transport.writes[1].Method != "ACK" ||
		transport.writes[1].Headers["CSeq"] != "2 ACK" ||
		!strings.Contains(transport.writes[1].Headers["To"], "glare-tag") ||
		transport.writes[1].Headers["Via"] != firstReinvite.Headers["Via"] ||
		transport.writes[2].Method != "ACK" ||
		transport.writes[2].Headers["CSeq"] != "3 ACK" {
		t.Fatalf("ACK writes=%+v", transport.writes)
	}
	if err := agent.EndVoiceCall(context.Background(), DialogInfo{CallID: "call-reinvite-glare"}); err != nil {
		t.Fatalf("EndVoiceCall() error = %v", err)
	}
	if len(transport.requests) != 4 || transport.requests[3].Method != "BYE" ||
		transport.requests[3].URI != "sip:updated@198.51.100.9:5060" ||
		transport.requests[3].Headers["CSeq"] != "4 BYE" {
		t.Fatalf("BYE after re-INVITE glare retry=%+v", transport.requests)
	}
}

func TestIMSOutboundAgentRetriesDialogReinviteWithMinSE(t *testing.T) {
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
			StatusCode: 422,
			Reason:     "Session Interval Too Small",
			Headers: map[string][]string{
				"To":     {"<sip:+18005551212@ims.example>;tag=minse-tag"},
				"Min-SE": {"1200"},
			},
		},
		{
			StatusCode: 200,
			Reason:     "OK",
			Headers: map[string][]string{
				"To":      {"<sip:+18005551212@ims.example>;tag=remote-tag"},
				"Contact": {"<sip:updated@198.51.100.4:5060>"},
				"X-IMS":   {"reinvite-retry-ok"},
			},
			Body: []byte(sampleSDP("203.0.113.40", 49220)),
		},
		{StatusCode: 200, Reason: "OK"},
	}}
	agent := &IMSOutboundAgent{
		Transport:      transport,
		SessionExpires: 600,
		Profile:        voiceclient.IMSProfile{IMPU: "sip:user@ims.example", Domain: "ims.example"},
		Registration: voiceclient.RegistrationBinding{
			ContactURI:     "sip:user@192.0.2.10:5060",
			PublicIdentity: "sip:user@ims.example",
		},
	}
	if _, err := agent.StartOutboundCall(context.Background(), OutboundCallRequest{
		CallID: "call-reinvite-minse",
		Callee: "+18005551212",
		RawSDP: []byte(sampleSDP("192.0.2.50", 4002)),
	}); err != nil {
		t.Fatalf("StartOutboundCall() error = %v", err)
	}
	result, err := agent.SendDialogReinvite(context.Background(), DialogReinviteRequest{
		CallID:      "call-reinvite-minse",
		ContentType: "application/sdp",
		Body:        []byte(sampleSDP("192.0.2.60", 4010)),
		Headers:     map[string]string{"Session-Expires": "600"},
	})
	if err != nil || !result.Accepted || result.Headers["X-IMS"] != "reinvite-retry-ok" {
		t.Fatalf("SendDialogReinvite() result=%+v err=%v", result, err)
	}
	if len(transport.requests) != 3 || transport.requests[1].Method != "INVITE" || transport.requests[2].Method != "INVITE" {
		t.Fatalf("requests=%+v", transport.requests)
	}
	firstReinvite := transport.requests[1]
	retryReinvite := transport.requests[2]
	if firstReinvite.Headers["CSeq"] != "2 INVITE" || firstReinvite.Headers["Session-Expires"] != "600" || firstReinvite.Headers["Min-SE"] != "" {
		t.Fatalf("first re-INVITE=%+v", firstReinvite)
	}
	if retryReinvite.Headers["CSeq"] != "3 INVITE" || retryReinvite.Headers["Session-Expires"] != "1200" || retryReinvite.Headers["Min-SE"] != "1200" {
		t.Fatalf("retry re-INVITE=%+v", retryReinvite)
	}
	if len(transport.writes) != 3 || transport.writes[1].Method != "ACK" || transport.writes[2].Method != "ACK" {
		t.Fatalf("ACK writes=%+v", transport.writes)
	}
	if transport.writes[1].Headers["CSeq"] != "2 ACK" || !strings.Contains(transport.writes[1].Headers["To"], "minse-tag") ||
		transport.writes[1].Headers["Via"] != firstReinvite.Headers["Via"] {
		t.Fatalf("422 ACK=%+v first=%+v", transport.writes[1], firstReinvite)
	}
	if transport.writes[2].Headers["CSeq"] != "3 ACK" || transport.writes[2].URI != "sip:updated@198.51.100.4:5060" {
		t.Fatalf("final ACK=%+v", transport.writes[2])
	}
	if err := agent.EndVoiceCall(context.Background(), DialogInfo{CallID: "call-reinvite-minse"}); err != nil {
		t.Fatalf("EndVoiceCall() error = %v", err)
	}
	if len(transport.requests) != 4 || transport.requests[3].Method != "BYE" ||
		transport.requests[3].URI != "sip:updated@198.51.100.4:5060" ||
		transport.requests[3].Headers["CSeq"] != "4 BYE" {
		t.Fatalf("BYE after re-INVITE retry=%+v", transport.requests)
	}
}

func TestIMSOutboundAgentPracksReliableProvisional(t *testing.T) {
	transport := &fakeIMSVoiceTransport{
		provisionals: []voiceclient.SIPResponse{
			{
				StatusCode: 183,
				Reason:     "Session Progress",
				Headers: map[string][]string{
					"To":           {"<sip:+18005551212@ims.example>;tag=early-tag"},
					"Contact":      {"<sip:early@198.51.100.1:5060>"},
					"Require":      {"100rel"},
					"RSeq":         {"42"},
					"Record-Route": {"<sip:early-proxy1.ims.example;lr>, <sip:early-proxy2.ims.example;lr>"},
				},
			},
		},
		responses: []voiceclient.SIPResponse{
			{StatusCode: 200, Reason: "OK"},
			{
				StatusCode: 200,
				Reason:     "OK",
				Headers: map[string][]string{
					"To":           {"<sip:+18005551212@ims.example>;tag=remote-tag"},
					"Contact":      {"<sip:carrier@198.51.100.1:5060>"},
					"Record-Route": {"<sip:dialog-proxy.ims.example;lr>"},
				},
				Body: []byte(sampleSDP("203.0.113.10", 49170)),
			},
			{StatusCode: 200, Reason: "OK"},
		},
	}
	agent := &IMSOutboundAgent{
		Transport: transport,
		Profile:   voiceclient.IMSProfile{IMPU: "sip:user@ims.example", Domain: "ims.example"},
		Registration: voiceclient.RegistrationBinding{
			ContactURI:     "sip:user@192.0.2.10:5060",
			PublicIdentity: "sip:user@ims.example",
			ServiceRoutes:  []string{"<sip:register-proxy.ims.example;lr>"},
		},
	}
	result, err := agent.StartOutboundCall(context.Background(), OutboundCallRequest{
		CallID:    "call-100rel",
		Callee:    "+18005551212",
		RawSDP:    []byte(sampleSDP("192.0.2.50", 4002)),
		RemoteSDP: SDPInfo{ConnectionIP: "192.0.2.50", MediaPort: 4002},
	})
	if err != nil || !result.Accepted {
		t.Fatalf("StartOutboundCall() result=%+v err=%v", result, err)
	}
	if len(transport.requests) != 2 || transport.requests[0].Method != "INVITE" || transport.requests[1].Method != "PRACK" {
		t.Fatalf("requests=%+v", transport.requests)
	}
	prack := transport.requests[1]
	if prack.Headers["RAck"] != "42 1 INVITE" || prack.Headers["CSeq"] != "2 PRACK" {
		t.Fatalf("PRACK=%+v", prack)
	}
	if prack.URI != "sip:early@198.51.100.1:5060" || !strings.Contains(prack.Headers["To"], "early-tag") {
		t.Fatalf("PRACK target/dialog=%+v", prack)
	}
	if route := prack.Headers["Route"]; route != "<sip:early-proxy2.ims.example;lr>, <sip:early-proxy1.ims.example;lr>" {
		t.Fatalf("PRACK Route=%q", route)
	}
	if len(transport.writes) != 1 || transport.writes[0].Method != "ACK" {
		t.Fatalf("writes=%+v", transport.writes)
	}
	if err := agent.EndVoiceCall(context.Background(), DialogInfo{CallID: "call-100rel"}); err != nil {
		t.Fatalf("EndVoiceCall() error = %v", err)
	}
	if len(transport.requests) != 3 || transport.requests[2].Method != "BYE" || transport.requests[2].Headers["CSeq"] != "3 BYE" {
		t.Fatalf("BYE requests=%+v", transport.requests)
	}
	if route := transport.requests[2].Headers["Route"]; route != "<sip:dialog-proxy.ims.example;lr>" {
		t.Fatalf("BYE Route=%q", route)
	}
}

func TestIMSOutboundAgentPrackUsesActualToTagWithQuotedDisplayName(t *testing.T) {
	cfg := voiceclient.DialogRequestConfig{
		Profile:         voiceclient.IMSProfile{IMPU: "sip:user@ims.example", Domain: "ims.example"},
		LocalURI:        "sip:user@ims.example",
		ContactURI:      "sip:user@192.0.2.10:5060",
		RemoteURI:       "sip:+18005551212@ims.example",
		RemoteTargetURI: "sip:+18005551212@ims.example",
		CallID:          "call-prack-quoted-tag",
		LocalTag:        "local-tag",
		CSeq:            1,
	}
	prack, ok, err := buildReliableProvisionalPRACK(cfg, voiceclient.SIPResponse{
		StatusCode: 183,
		Reason:     "Session Progress",
		Headers: map[string][]string{
			"To":      {`"ringing;tag=bogus" <sip:+18005551212@ims.example>;tag=early-tag`},
			"Contact": {"<sip:early@198.51.100.1:5060>"},
			"Require": {"100rel"},
			"RSeq":    {"42"},
		},
	}, 2)
	if err != nil || !ok {
		t.Fatalf("buildReliableProvisionalPRACK() ok=%t err=%v", ok, err)
	}
	if prack.Headers["RAck"] != "42 1 INVITE" || !strings.Contains(prack.Headers["To"], "tag=early-tag") ||
		strings.Contains(prack.Headers["To"], "tag=bogus") {
		t.Fatalf("PRACK headers=%+v", prack.Headers)
	}
}

func TestIMSOutboundAgentUsesReliableProvisionalSDPWhenFinalHasNoBody(t *testing.T) {
	transport := &fakeIMSVoiceTransport{
		provisionals: []voiceclient.SIPResponse{
			{
				StatusCode: 183,
				Reason:     "Session Progress",
				Headers: map[string][]string{
					"To":      {"<sip:+18005551212@ims.example>;tag=early-tag"},
					"Contact": {"<sip:early@198.51.100.1:5060>"},
					"Require": {"100rel"},
					"RSeq":    {"9"},
				},
				Body: []byte(sampleSDP("203.0.113.90", 49190)),
			},
		},
		responses: []voiceclient.SIPResponse{
			{StatusCode: 200, Reason: "OK"},
			{
				StatusCode: 200,
				Reason:     "OK",
				Headers: map[string][]string{
					"To":      {"<sip:+18005551212@ims.example>;tag=remote-tag"},
					"Contact": {"<sip:carrier@198.51.100.1:5060>"},
				},
			},
			{StatusCode: 200, Reason: "OK"},
		},
	}
	agent := &IMSOutboundAgent{
		Transport: transport,
		Profile:   voiceclient.IMSProfile{IMPU: "sip:user@ims.example", Domain: "ims.example"},
		Registration: voiceclient.RegistrationBinding{
			ContactURI:     "sip:user@192.0.2.10:5060",
			PublicIdentity: "sip:user@ims.example",
		},
	}
	result, err := agent.StartOutboundCall(context.Background(), OutboundCallRequest{
		CallID:    "call-early-sdp",
		Callee:    "+18005551212",
		RawSDP:    []byte(sampleSDP("192.0.2.50", 4002)),
		RemoteSDP: SDPInfo{ConnectionIP: "192.0.2.50", MediaPort: 4002},
	})
	if err != nil || !result.Accepted {
		t.Fatalf("StartOutboundCall() result=%+v err=%v", result, err)
	}
	if result.LocalSDP.ConnectionIP != "203.0.113.90" || result.LocalSDP.MediaPort != 49190 {
		t.Fatalf("LocalSDP=%+v", result.LocalSDP)
	}
	if !strings.Contains(string(result.RawSDP), "m=audio 49190 RTP/AVP") {
		t.Fatalf("RawSDP=%q", result.RawSDP)
	}
	if len(transport.requests) != 2 || transport.requests[1].Method != "PRACK" || transport.requests[1].Headers["RAck"] != "9 1 INVITE" {
		t.Fatalf("requests=%+v", transport.requests)
	}
	if len(transport.writes) != 1 || transport.writes[0].Method != "ACK" {
		t.Fatalf("writes=%+v", transport.writes)
	}
	if err := agent.EndVoiceCall(context.Background(), DialogInfo{CallID: "call-early-sdp"}); err != nil {
		t.Fatalf("EndVoiceCall() error = %v", err)
	}
	if transport.requests[2].Headers["CSeq"] != "3 BYE" {
		t.Fatalf("BYE=%+v", transport.requests[2])
	}
}

func TestIMSOutboundAgentRejectedInviteAcksFinalResponse(t *testing.T) {
	transport := &fakeIMSVoiceTransport{responses: []voiceclient.SIPResponse{{
		StatusCode: 486,
		Reason:     "Busy Here",
		Headers:    map[string][]string{"To": {"<sip:+18005551212@ims.example>;tag=busy-tag"}},
	}}}
	agent := &IMSOutboundAgent{
		Transport: transport,
		Profile:   voiceclient.IMSProfile{IMPU: "sip:user@ims.example", Domain: "ims.example"},
		Registration: voiceclient.RegistrationBinding{
			ContactURI:     "sip:user@192.0.2.10:5060",
			PublicIdentity: "sip:user@ims.example",
		},
	}
	result, err := agent.StartOutboundCall(context.Background(), OutboundCallRequest{
		CallID: "call-2",
		Callee: "+18005551212",
		RawSDP: []byte(sampleSDP("192.0.2.50", 4002)),
	})
	if err != nil {
		t.Fatalf("StartOutboundCall() error = %v", err)
	}
	if result.Accepted || result.StatusCode != 486 || result.Reason != "Busy Here" {
		t.Fatalf("result=%+v", result)
	}
	if result.RegistrationRecoveryNeeded {
		t.Fatalf("busy rejection requested registration recovery: %+v", result)
	}
	if len(transport.requests) != 1 || transport.requests[0].Method != "INVITE" {
		t.Fatalf("requests=%+v", transport.requests)
	}
	if len(transport.writes) != 1 || transport.writes[0].Method != "ACK" {
		t.Fatalf("ACK writes=%+v", transport.writes)
	}
	ack := transport.writes[0]
	if ack.Headers["CSeq"] != "1 ACK" || !strings.Contains(ack.Headers["To"], "busy-tag") {
		t.Fatalf("ACK=%+v", ack)
	}
	if ack.Headers["Via"] == "" || ack.Headers["Via"] != transport.requests[0].Headers["Via"] {
		t.Fatalf("ACK Via=%q INVITE Via=%q", ack.Headers["Via"], transport.requests[0].Headers["Via"])
	}
}

func TestIMSOutboundAgentInvite503RequestsRegistrationRecovery(t *testing.T) {
	transport := &fakeIMSVoiceTransport{responses: []voiceclient.SIPResponse{{
		StatusCode: 503,
		Reason:     "Service Unavailable",
		Headers: map[string][]string{
			"To":          {"<sip:+18005551212@ims.example>;tag=unavailable-tag"},
			"Retry-After": {"7"},
		},
	}}}
	agent := &IMSOutboundAgent{
		Transport: transport,
		Profile:   voiceclient.IMSProfile{IMPU: "sip:user@ims.example", Domain: "ims.example"},
		Registration: voiceclient.RegistrationBinding{
			ContactURI:     "sip:user@192.0.2.10:5060",
			PublicIdentity: "sip:user@ims.example",
		},
	}
	result, err := agent.StartOutboundCall(context.Background(), OutboundCallRequest{
		CallID: "call-invite-recover",
		Callee: "+18005551212",
		RawSDP: []byte(sampleSDP("192.0.2.50", 4002)),
	})
	if err != nil {
		t.Fatalf("StartOutboundCall() error = %v", err)
	}
	if result.Accepted || result.StatusCode != 503 || !result.RegistrationRecoveryNeeded || result.RetryAfter != 7*time.Second {
		t.Fatalf("StartOutboundCall() result=%+v", result)
	}
	if len(transport.writes) != 1 || transport.writes[0].Method != "ACK" {
		t.Fatalf("ACK writes=%+v", transport.writes)
	}
}

func TestIMSOutboundAgentRetriesInviteWithMinSE(t *testing.T) {
	transport := &fakeIMSVoiceTransport{responses: []voiceclient.SIPResponse{
		{
			StatusCode: 422,
			Reason:     "Session Interval Too Small",
			Headers: map[string][]string{
				"To":     {"<sip:+18005551212@ims.example>;tag=minse-tag"},
				"Min-SE": {"1800"},
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
		Transport:      transport,
		SessionExpires: 600,
		Profile:        voiceclient.IMSProfile{IMPU: "sip:user@ims.example", Domain: "ims.example"},
		Registration: voiceclient.RegistrationBinding{
			ContactURI:     "sip:user@192.0.2.10:5060",
			PublicIdentity: "sip:user@ims.example",
		},
	}
	result, err := agent.StartOutboundCall(context.Background(), OutboundCallRequest{
		CallID:    "call-min-se",
		Callee:    "+18005551212",
		RawSDP:    []byte(sampleSDP("192.0.2.50", 4002)),
		RemoteSDP: SDPInfo{ConnectionIP: "192.0.2.50", MediaPort: 4002},
	})
	if err != nil || !result.Accepted {
		t.Fatalf("StartOutboundCall() result=%+v err=%v", result, err)
	}
	if len(transport.requests) != 2 || transport.requests[0].Method != "INVITE" || transport.requests[1].Method != "INVITE" {
		t.Fatalf("requests=%+v", transport.requests)
	}
	firstInvite := transport.requests[0]
	retryInvite := transport.requests[1]
	if firstInvite.Headers["CSeq"] != "1 INVITE" || firstInvite.Headers["Session-Expires"] != "600" || firstInvite.Headers["Min-SE"] != "" {
		t.Fatalf("first INVITE=%+v", firstInvite)
	}
	if retryInvite.Headers["CSeq"] != "2 INVITE" || retryInvite.Headers["Session-Expires"] != "1800" || retryInvite.Headers["Min-SE"] != "1800" {
		t.Fatalf("retry INVITE=%+v", retryInvite)
	}
	if len(transport.writes) != 2 || transport.writes[0].Method != "ACK" || transport.writes[1].Method != "ACK" {
		t.Fatalf("writes=%+v", transport.writes)
	}
	if transport.writes[0].Headers["CSeq"] != "1 ACK" || !strings.Contains(transport.writes[0].Headers["To"], "minse-tag") {
		t.Fatalf("422 ACK=%+v", transport.writes[0])
	}
	if transport.writes[1].Headers["CSeq"] != "2 ACK" || !strings.Contains(transport.writes[1].Headers["To"], "remote-tag") {
		t.Fatalf("final ACK=%+v", transport.writes[1])
	}

	if err := agent.EndVoiceCall(context.Background(), DialogInfo{CallID: "call-min-se"}); err != nil {
		t.Fatalf("EndVoiceCall() error = %v", err)
	}
	if len(transport.requests) != 3 || transport.requests[2].Method != "BYE" || transport.requests[2].Headers["CSeq"] != "3 BYE" {
		t.Fatalf("BYE requests=%+v", transport.requests)
	}
}

func TestIMSOutboundAgentCancelVoiceCallSendsCancelForEarlyDialog(t *testing.T) {
	transport := &fakeIMSVoiceTransport{responses: []voiceclient.SIPResponse{{StatusCode: 200, Reason: "OK"}}}
	agent := &IMSOutboundAgent{Transport: transport}
	inviteVia := "SIP/2.0/UDP 192.0.2.10:5060;branch=z9hG4bK-invite;rport"
	agent.storeDialog("call-cancel", imsDialogState{
		early: true,
		invite: voiceclient.SIPRequestMessage{
			Headers: map[string]string{"Via": inviteVia},
		},
		cfg: voiceclient.DialogRequestConfig{
			Profile:         voiceclient.IMSProfile{IMPU: "sip:user@ims.example", Domain: "ims.example"},
			LocalURI:        "sip:user@ims.example",
			ContactURI:      "sip:user@192.0.2.10:5060",
			RemoteURI:       "sip:+18005551212@ims.example",
			RemoteTargetURI: "sip:+18005551212@ims.example",
			CallID:          "call-cancel",
			LocalTag:        "local-tag",
			CSeq:            1,
		},
	})

	if err := agent.CancelVoiceCall(context.Background(), DialogInfo{
		CallID:      "call-cancel",
		ContentType: "message/sipfrag",
		Body:        []byte("SIP/2.0 487 Request Terminated\r\n"),
		Headers: map[string]string{
			"Reason": "SIP;cause=487;text=\"client canceled\"",
			"X-Test": "cancel",
			"Via":    "SIP/2.0/UDP 198.51.100.20:5060;branch=z9hG4bK-bad",
		},
	}); err != nil {
		t.Fatalf("CancelVoiceCall() error = %v", err)
	}
	if len(transport.requests) != 1 || transport.requests[0].Method != "CANCEL" {
		t.Fatalf("requests=%+v", transport.requests)
	}
	cancel := transport.requests[0]
	if cancel.Headers["CSeq"] != "1 CANCEL" || cancel.Headers["Call-ID"] != "call-cancel" || !strings.Contains(cancel.Headers["From"], "local-tag") {
		t.Fatalf("CANCEL=%+v", cancel)
	}
	if cancel.Headers["Via"] != inviteVia {
		t.Fatalf("CANCEL Via=%q, want original INVITE Via %q", cancel.Headers["Via"], inviteVia)
	}
	if cancel.Headers["Reason"] != "SIP;cause=487;text=\"client canceled\"" ||
		cancel.Headers["X-Test"] != "cancel" ||
		cancel.Headers["Content-Type"] != "message/sipfrag" ||
		string(cancel.Body) != "SIP/2.0 487 Request Terminated\r\n" {
		t.Fatalf("CANCEL payload=%+v body=%q", cancel, cancel.Body)
	}
	if _, ok := agent.dialogs["call-cancel"]; ok {
		t.Fatal("early dialog still stored after successful CANCEL")
	}
}

func TestIMSOutboundAgentCancelVoiceCallIgnoresEstablishedDialog(t *testing.T) {
	transport := &fakeIMSVoiceTransport{responses: []voiceclient.SIPResponse{{StatusCode: 200, Reason: "OK"}}}
	agent := &IMSOutboundAgent{Transport: transport}
	agent.storeDialog("call-established", imsDialogState{
		cfg: voiceclient.DialogRequestConfig{
			LocalURI:        "sip:user@ims.example",
			RemoteURI:       "sip:+18005551212@ims.example",
			RemoteTargetURI: "sip:+18005551212@ims.example",
			CallID:          "call-established",
			LocalTag:        "local-tag",
			CSeq:            2,
		},
	})

	if err := agent.CancelVoiceCall(context.Background(), DialogInfo{CallID: "call-established"}); err != nil {
		t.Fatalf("CancelVoiceCall() error = %v", err)
	}
	if len(transport.requests) != 0 {
		t.Fatalf("requests=%+v, want no CANCEL for established dialog", transport.requests)
	}
	if _, ok := agent.dialogs["call-established"]; !ok {
		t.Fatal("established dialog should remain stored")
	}
}

func TestIMSOutboundAgentCancelVoiceCallWithResultReturnsIMSResponse(t *testing.T) {
	transport := &fakeIMSVoiceTransport{responses: []voiceclient.SIPResponse{
		{
			StatusCode: 503,
			Reason:     "Service Unavailable",
			Headers: map[string][]string{
				"Content-Type": {"message/sipfrag"},
				"Retry-After":  {"5"},
				"X-IMS":        {"cancel-failed"},
			},
			Body: []byte("SIP/2.0 503 Service Unavailable\r\n"),
		},
		{StatusCode: 200, Reason: "OK"},
	}}
	agent := &IMSOutboundAgent{Transport: transport}
	inviteVia := "SIP/2.0/UDP 192.0.2.10:5060;branch=z9hG4bK-invite;rport"
	agent.storeDialog("call-cancel-result", imsDialogState{
		early: true,
		invite: voiceclient.SIPRequestMessage{
			Headers: map[string]string{"Via": inviteVia},
		},
		cfg: voiceclient.DialogRequestConfig{
			Profile:         voiceclient.IMSProfile{IMPU: "sip:user@ims.example", Domain: "ims.example"},
			LocalURI:        "sip:user@ims.example",
			ContactURI:      "sip:user@192.0.2.10:5060",
			RemoteURI:       "sip:+18005551212@ims.example",
			RemoteTargetURI: "sip:+18005551212@ims.example",
			CallID:          "call-cancel-result",
			LocalTag:        "local-tag",
			CSeq:            1,
		},
	})

	result, err := agent.CancelVoiceCallWithResult(context.Background(), DialogInfo{CallID: "call-cancel-result"})
	if err == nil || !strings.Contains(err.Error(), "IMS CANCEL rejected") {
		t.Fatalf("CancelVoiceCallWithResult() err=%v, want IMS CANCEL rejection", err)
	}
	if result.Accepted || result.StatusCode != 503 || result.Reason != "Service Unavailable" ||
		result.ContentType != "message/sipfrag" ||
		string(result.Body) != "SIP/2.0 503 Service Unavailable\r\n" ||
		result.Headers["X-IMS"] != "cancel-failed" ||
		result.RetryAfter != 5*time.Second ||
		!result.RegistrationRecoveryNeeded {
		t.Fatalf("result=%+v body=%q", result, result.Body)
	}
	if _, ok := agent.dialogs["call-cancel-result"]; !ok {
		t.Fatal("early dialog should remain after rejected IMS CANCEL")
	}
	if len(transport.requests) != 1 || transport.requests[0].Method != "CANCEL" ||
		transport.requests[0].Headers["CSeq"] != "1 CANCEL" ||
		transport.requests[0].Headers["Via"] != inviteVia {
		t.Fatalf("CANCEL requests=%+v", transport.requests)
	}
	if err := agent.CancelVoiceCall(context.Background(), DialogInfo{CallID: "call-cancel-result"}); err != nil {
		t.Fatalf("CancelVoiceCall() retry error = %v", err)
	}
	if _, ok := agent.dialogs["call-cancel-result"]; ok {
		t.Fatal("early dialog should close after accepted IMS CANCEL")
	}
	if len(transport.requests) != 2 || transport.requests[1].Headers["CSeq"] != "1 CANCEL" {
		t.Fatalf("CANCEL retry requests=%+v", transport.requests)
	}
}

func TestIMSOutboundAgentKeepsDialogWhenByeFails(t *testing.T) {
	transport := &fakeIMSVoiceTransport{responses: []voiceclient.SIPResponse{
		{
			StatusCode: 200,
			Reason:     "OK",
			Headers:    map[string][]string{"To": {"<sip:+18005551212@ims.example>;tag=remote-tag"}},
			Body:       []byte(sampleSDP("203.0.113.10", 49170)),
		},
		{StatusCode: 503, Reason: "Try Later"},
		{StatusCode: 200, Reason: "OK"},
	}}
	agent := &IMSOutboundAgent{
		Transport: transport,
		Profile:   voiceclient.IMSProfile{IMPU: "sip:user@ims.example", Domain: "ims.example"},
		Registration: voiceclient.RegistrationBinding{
			ContactURI:     "sip:user@192.0.2.10:5060",
			PublicIdentity: "sip:user@ims.example",
		},
	}
	if _, err := agent.StartOutboundCall(context.Background(), OutboundCallRequest{
		CallID: "call-3",
		Callee: "+18005551212",
		RawSDP: []byte(sampleSDP("192.0.2.50", 4002)),
	}); err != nil {
		t.Fatalf("StartOutboundCall() error = %v", err)
	}
	if err := agent.EndVoiceCall(context.Background(), DialogInfo{CallID: "call-3"}); err == nil {
		t.Fatal("EndVoiceCall() err=nil, want failed BYE")
	}
	if err := agent.EndVoiceCall(context.Background(), DialogInfo{CallID: "call-3"}); err != nil {
		t.Fatalf("EndVoiceCall() retry error = %v", err)
	}
	if len(transport.requests) != 3 || transport.requests[1].Method != "BYE" || transport.requests[2].Method != "BYE" {
		t.Fatalf("requests=%+v", transport.requests)
	}
	if transport.requests[1].Headers["CSeq"] != "2 BYE" || transport.requests[2].Headers["CSeq"] != "3 BYE" {
		t.Fatalf("BYE CSeqs=%q/%q", transport.requests[1].Headers["CSeq"], transport.requests[2].Headers["CSeq"])
	}
}

func TestIMSOutboundAgentEndVoiceCallWithResultReturnsIMSResponse(t *testing.T) {
	transport := &fakeIMSVoiceTransport{responses: []voiceclient.SIPResponse{
		{
			StatusCode: 503,
			Reason:     "Service Unavailable",
			Headers: map[string][]string{
				"Content-Type": {"message/sipfrag"},
				"Retry-After":  {"7"},
				"X-IMS":        {"bye-failed"},
			},
			Body: []byte("SIP/2.0 503 Service Unavailable\r\n"),
		},
		{StatusCode: 200, Reason: "OK"},
	}}
	agent := &IMSOutboundAgent{Transport: transport}
	agent.storeDialog("call-bye-result", imsDialogState{
		cfg: voiceclient.DialogRequestConfig{
			Profile:         voiceclient.IMSProfile{IMPU: "sip:user@ims.example", Domain: "ims.example"},
			LocalURI:        "sip:user@ims.example",
			ContactURI:      "sip:user@192.0.2.10:5060",
			RemoteURI:       "sip:+18005551212@ims.example",
			RemoteTargetURI: "sip:+18005551212@ims.example",
			CallID:          "call-bye-result",
			LocalTag:        "local-tag",
			RemoteTag:       "remote-tag",
			CSeq:            2,
		},
	})

	result, err := agent.EndVoiceCallWithResult(context.Background(), DialogInfo{CallID: "call-bye-result"})
	if err == nil || !strings.Contains(err.Error(), "IMS BYE rejected") {
		t.Fatalf("EndVoiceCallWithResult() err=%v, want IMS BYE rejection", err)
	}
	if result.Accepted || result.StatusCode != 503 || result.Reason != "Service Unavailable" ||
		result.ContentType != "message/sipfrag" ||
		string(result.Body) != "SIP/2.0 503 Service Unavailable\r\n" ||
		result.Headers["X-IMS"] != "bye-failed" ||
		result.RetryAfter != 7*time.Second ||
		!result.RegistrationRecoveryNeeded {
		t.Fatalf("result=%+v body=%q", result, result.Body)
	}
	if _, ok := agent.dialogs["call-bye-result"]; !ok {
		t.Fatal("dialog should remain after rejected IMS BYE")
	}
	if len(transport.requests) != 1 || transport.requests[0].Method != "BYE" || transport.requests[0].Headers["CSeq"] != "2 BYE" {
		t.Fatalf("BYE requests=%+v", transport.requests)
	}
	if err := agent.EndVoiceCall(context.Background(), DialogInfo{CallID: "call-bye-result"}); err != nil {
		t.Fatalf("EndVoiceCall() retry error = %v", err)
	}
	if _, ok := agent.dialogs["call-bye-result"]; ok {
		t.Fatal("dialog should close after accepted IMS BYE")
	}
	if len(transport.requests) != 2 || transport.requests[1].Headers["CSeq"] != "3 BYE" {
		t.Fatalf("BYE retry requests=%+v", transport.requests)
	}
}

func TestIMSOutboundAgentUsesRTPRelayWhenConfigured(t *testing.T) {
	transport := &fakeIMSVoiceTransport{responses: []voiceclient.SIPResponse{
		{
			StatusCode: 200,
			Reason:     "OK",
			Headers:    map[string][]string{"To": {"<sip:+18005551212@ims.example>;tag=remote-tag"}},
			Body:       []byte(sampleSDP("203.0.113.10", 49170)),
		},
		{StatusCode: 200, Reason: "OK"},
	}}
	agent := &IMSOutboundAgent{
		Transport: transport,
		Profile:   voiceclient.IMSProfile{IMPU: "sip:user@ims.example", Domain: "ims.example"},
		Registration: voiceclient.RegistrationBinding{
			ContactURI:     "sip:user@192.0.2.10:5060",
			PublicIdentity: "sip:user@ims.example",
		},
		MediaRelay: &RTPRelayConfig{
			ClientListenIP:    "127.0.0.1",
			ClientAdvertiseIP: "127.0.0.1",
			IMSListenIP:       "127.0.0.1",
			IMSAdvertiseIP:    "127.0.0.1",
		},
	}
	result, err := agent.StartOutboundCall(context.Background(), OutboundCallRequest{
		CallID:    "call-relay",
		Callee:    "+18005551212",
		RemoteSDP: SDPInfo{ConnectionIP: "127.0.0.1", MediaPort: 4002, Payloads: []int{0, 101}, Direction: "sendrecv"},
		RawSDP:    []byte(sampleSDP("127.0.0.1", 4002)),
	})
	if err != nil {
		t.Fatalf("StartOutboundCall() error = %v", err)
	}
	if len(transport.requests) != 1 || transport.requests[0].Method != "INVITE" {
		t.Fatalf("requests=%+v", transport.requests)
	}
	imsOffer, err := ParseSDP(transport.requests[0].Body)
	if err != nil {
		t.Fatalf("ParseSDP(IMS offer) error = %v", err)
	}
	if imsOffer.ConnectionIP != "127.0.0.1" || imsOffer.MediaPort == 4002 || imsOffer.MediaPort <= 0 || imsOffer.RTCPPort <= 0 {
		t.Fatalf("IMS offer=%+v", imsOffer)
	}
	if result.LocalSDP.ConnectionIP != "127.0.0.1" || result.LocalSDP.MediaPort == 49170 || result.LocalSDP.MediaPort <= 0 || result.LocalSDP.RTCPPort <= 0 {
		t.Fatalf("client answer=%+v", result.LocalSDP)
	}
	if answer := string(result.RawSDP); !strings.Contains(answer, "c=IN IP4 127.0.0.1") || !strings.Contains(answer, "a=rtcp:") || strings.Contains(answer, "m=audio 49170") {
		t.Fatalf("client answer body=%q", answer)
	}
	if err := agent.EndVoiceCall(context.Background(), DialogInfo{CallID: "call-relay"}); err != nil {
		t.Fatalf("EndVoiceCall() error = %v", err)
	}
}

func TestIMSOutboundAgentNegotiatesOutboundSDESRelay(t *testing.T) {
	clientPeer := listenTestUDP(t)
	defer clientPeer.Close()
	imsPeer := listenTestUDP(t)
	defer imsPeer.Close()
	profile := SRTPProfileAes128CmHmacSha1_80
	clientKeys := testSRTPKeys(0x11, 0x21)
	imsKeys := testSRTPKeys(0x31, 0x41)
	clientOffer := sampleSDPWithCrypto(t, "127.0.0.1", clientPeer.LocalAddr().(*net.UDPAddr).Port, profile, clientKeys)
	imsAnswer := sampleSDPWithCrypto(t, "127.0.0.1", imsPeer.LocalAddr().(*net.UDPAddr).Port, profile, imsKeys)
	remoteSDP, err := ParseSDP([]byte(clientOffer))
	if err != nil {
		t.Fatalf("ParseSDP(clientOffer) error = %v", err)
	}
	relayRandom := append(bytes.Repeat([]byte{0x55}, 30), bytes.Repeat([]byte{0x66}, 30)...)
	transport := &fakeIMSVoiceTransport{responses: []voiceclient.SIPResponse{
		{
			StatusCode: 200,
			Reason:     "OK",
			Headers: map[string][]string{
				"To":      {"<sip:+18005551212@ims.example>;tag=remote-tag"},
				"Contact": {"<sip:carrier@127.0.0.1:5060>"},
			},
			Body: []byte(imsAnswer),
		},
		{StatusCode: 200, Reason: "OK"},
	}}
	agent := &IMSOutboundAgent{
		Transport: transport,
		Profile:   voiceclient.IMSProfile{IMPU: "sip:user@ims.example", Domain: "ims.example"},
		Registration: voiceclient.RegistrationBinding{
			ContactURI:     "sip:user@127.0.0.1:5060",
			PublicIdentity: "sip:user@ims.example",
		},
		MediaRelay: &RTPRelayConfig{
			ClientListenIP:    "127.0.0.1",
			ClientAdvertiseIP: "127.0.0.1",
			IMSListenIP:       "127.0.0.1",
			IMSAdvertiseIP:    "127.0.0.1",
			SRTP: &RTPRelaySRTPConfig{
				Random: bytes.NewReader(relayRandom),
			},
		},
	}
	result, err := agent.StartOutboundCall(context.Background(), OutboundCallRequest{
		CallID:    "call-relay-sdes",
		Callee:    "+18005551212",
		RemoteSDP: remoteSDP,
		RawSDP:    []byte(clientOffer),
	})
	if err != nil || !result.Accepted {
		t.Fatalf("StartOutboundCall() result=%+v err=%v", result, err)
	}
	if len(transport.requests) != 1 || transport.requests[0].Method != "INVITE" {
		t.Fatalf("requests=%+v", transport.requests)
	}
	if body := string(transport.requests[0].Body); !strings.Contains(body, "RTP/SAVP") || !strings.Contains(body, "a=crypto:") ||
		strings.Contains(body, "m=audio "+strconv.Itoa(remoteSDP.MediaPort)+" ") {
		t.Fatalf("IMS offer body=%q", body)
	}
	if body := string(result.RawSDP); !strings.Contains(body, "RTP/SAVP") || !strings.Contains(body, "a=crypto:") ||
		strings.Contains(body, "m=audio "+strconv.Itoa(imsPeer.LocalAddr().(*net.UDPAddr).Port)+" ") {
		t.Fatalf("client answer body=%q", body)
	}
	relayToIMSKeys := firstSDPCryptoKeys(t, transport.requests[0].Body)
	relayToClientKeys := firstSDPCryptoKeys(t, result.RawSDP)
	if bytes.Equal(relayToIMSKeys.MasterKey, clientKeys.MasterKey) || bytes.Equal(relayToClientKeys.MasterKey, imsKeys.MasterKey) ||
		bytes.Equal(relayToIMSKeys.MasterKey, relayToClientKeys.MasterKey) {
		t.Fatalf("unexpected relay keys ims=%x client=%x", relayToIMSKeys.MasterKey, relayToClientKeys.MasterKey)
	}
	state, ok := agent.dialog("call-relay-sdes")
	if !ok || state.relay == nil || state.relay.Transforms().ClientToIMSRTP == nil {
		t.Fatalf("dialog state=%+v ok=%v", state, ok)
	}

	clientSender := newTestSRTPMediaSession(t, SRTPMediaConfig{Profile: profile, ClientKeys: clientKeys, IMSKeys: relayToIMSKeys})
	imsReceiver := newTestSRTPMediaSession(t, SRTPMediaConfig{Profile: profile, ClientKeys: relayToClientKeys, IMSKeys: relayToIMSKeys})
	clientPlain := testRTPPacket(77, 0x11111111, []byte{0x77})
	clientProtected, err := clientSender.ProtectClientRTP(clientPlain)
	if err != nil {
		t.Fatalf("ProtectClientRTP() error = %v", err)
	}
	if _, err := clientPeer.WriteToUDP(clientProtected, udpAddrFromSDP(t, result.LocalSDP)); err != nil {
		t.Fatalf("client WriteToUDP() error = %v", err)
	}
	got, _ := readTestUDP(t, imsPeer)
	gotPlain, err := imsReceiver.UnprotectIMSRTP(got)
	if err != nil {
		t.Fatalf("IMS UnprotectIMSRTP() error = %v", err)
	}
	if !bytes.Equal(gotPlain, clientPlain) {
		t.Fatalf("IMS plain=%x, want %x", gotPlain, clientPlain)
	}

	imsSender := newTestSRTPMediaSession(t, SRTPMediaConfig{Profile: profile, ClientKeys: relayToClientKeys, IMSKeys: imsKeys})
	clientReceiver := newTestSRTPMediaSession(t, SRTPMediaConfig{Profile: profile, ClientKeys: relayToClientKeys, IMSKeys: relayToIMSKeys})
	imsPlain := testRTPPacket(78, 0x22222222, []byte{0x78})
	imsProtected, err := imsSender.ProtectIMSRTP(imsPlain)
	if err != nil {
		t.Fatalf("ProtectIMSRTP() error = %v", err)
	}
	if _, err := imsPeer.WriteToUDP(imsProtected, udpAddrFromSDP(t, state.relay.IMSEndpoint())); err != nil {
		t.Fatalf("IMS WriteToUDP() error = %v", err)
	}
	got, _ = readTestUDP(t, clientPeer)
	gotPlain, err = clientReceiver.UnprotectClientRTP(got)
	if err != nil {
		t.Fatalf("client UnprotectClientRTP() error = %v", err)
	}
	if !bytes.Equal(gotPlain, imsPlain) {
		t.Fatalf("client plain=%x, want %x", gotPlain, imsPlain)
	}

	if err := agent.EndVoiceCall(context.Background(), DialogInfo{CallID: "call-relay-sdes"}); err != nil {
		t.Fatalf("EndVoiceCall() error = %v", err)
	}
}

func TestIMSOutboundAgentRewritesReliableProvisionalSDPThroughRelay(t *testing.T) {
	transport := &fakeIMSVoiceTransport{
		provisionals: []voiceclient.SIPResponse{
			{
				StatusCode: 183,
				Reason:     "Session Progress",
				Headers: map[string][]string{
					"To":      {"<sip:+18005551212@ims.example>;tag=early-tag"},
					"Require": {"100rel"},
					"RSeq":    {"11"},
				},
				Body: []byte(sampleSDP("127.0.0.1", 49192)),
			},
		},
		responses: []voiceclient.SIPResponse{
			{StatusCode: 200, Reason: "OK"},
			{
				StatusCode: 200,
				Reason:     "OK",
				Headers:    map[string][]string{"To": {"<sip:+18005551212@ims.example>;tag=remote-tag"}},
			},
			{StatusCode: 200, Reason: "OK"},
		},
	}
	agent := &IMSOutboundAgent{
		Transport: transport,
		Profile:   voiceclient.IMSProfile{IMPU: "sip:user@ims.example", Domain: "ims.example"},
		Registration: voiceclient.RegistrationBinding{
			ContactURI:     "sip:user@192.0.2.10:5060",
			PublicIdentity: "sip:user@ims.example",
		},
		MediaRelay: &RTPRelayConfig{
			ClientListenIP:    "127.0.0.1",
			ClientAdvertiseIP: "127.0.0.1",
			IMSListenIP:       "127.0.0.1",
			IMSAdvertiseIP:    "127.0.0.1",
		},
	}
	result, err := agent.StartOutboundCall(context.Background(), OutboundCallRequest{
		CallID:    "call-relay-early",
		Callee:    "+18005551212",
		RemoteSDP: SDPInfo{ConnectionIP: "127.0.0.1", MediaPort: 4002, Payloads: []int{0, 101}, Direction: "sendrecv"},
		RawSDP:    []byte(sampleSDP("127.0.0.1", 4002)),
	})
	if err != nil || !result.Accepted {
		t.Fatalf("StartOutboundCall() result=%+v err=%v", result, err)
	}
	if result.LocalSDP.ConnectionIP != "127.0.0.1" || result.LocalSDP.MediaPort <= 0 || result.LocalSDP.MediaPort == 49192 {
		t.Fatalf("LocalSDP=%+v", result.LocalSDP)
	}
	if body := string(result.RawSDP); !strings.Contains(body, "c=IN IP4 127.0.0.1") || strings.Contains(body, "m=audio 49192") {
		t.Fatalf("RawSDP=%q", body)
	}
	if err := agent.EndVoiceCall(context.Background(), DialogInfo{CallID: "call-relay-early"}); err != nil {
		t.Fatalf("EndVoiceCall() error = %v", err)
	}
}

func sampleSDPWithCrypto(t *testing.T, ip string, port int, profile SRTPProtectionProfile, keys SRTPKeys) string {
	t.Helper()
	attr, err := BuildSDPCryptoAttribute("1", profile, SDPCryptoInlineKeyParams{
		MasterKey:  append([]byte(nil), keys.MasterKey...),
		MasterSalt: append([]byte(nil), keys.MasterSalt...),
	}, "")
	if err != nil {
		t.Fatalf("BuildSDPCryptoAttribute() error = %v", err)
	}
	return string(applySDPSecurity([]byte(sampleSDP(ip, port)), SDPSecurityInfo{
		RTPProfile: "RTP/SAVP",
		Crypto:     []SDPCryptoAttribute{attr},
	}))
}

func firstSDPCryptoKeys(t *testing.T, body []byte) SRTPKeys {
	t.Helper()
	_, security, err := ParseSDPWithSecurity(body)
	if err != nil {
		t.Fatalf("ParseSDPWithSecurity() error = %v", err)
	}
	if len(security.Crypto) == 0 {
		t.Fatalf("missing SDP crypto in %q", body)
	}
	_, params, err := ParseSDPCryptoAttributeKeys(security.Crypto[0])
	if err != nil {
		t.Fatalf("ParseSDPCryptoAttributeKeys() error = %v", err)
	}
	return srtpKeysFromSDPCryptoParams(params)
}

type fakeIMSVoiceTransport struct {
	mu           sync.Mutex
	requests     []voiceclient.SIPRequestMessage
	writes       []voiceclient.SIPRequestMessage
	provisionals []voiceclient.SIPResponse
	responses    []voiceclient.SIPResponse
}

func (t *fakeIMSVoiceTransport) RoundTripRequest(ctx context.Context, msg voiceclient.SIPRequestMessage) (voiceclient.SIPResponse, error) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.requests = append(t.requests, msg)
	return t.nextResponseLocked(), nil
}

func (t *fakeIMSVoiceTransport) RoundTripInvite(ctx context.Context, msg voiceclient.SIPRequestMessage, onProvisional voiceclient.ProvisionalResponseHandler) (voiceclient.SIPResponse, error) {
	if msg.Headers != nil && msg.Headers["Via"] == "" {
		msg.Headers["Via"] = "SIP/2.0/UDP 192.0.2.10:5060;branch=z9hG4bK-fake;rport"
	}
	t.mu.Lock()
	t.requests = append(t.requests, msg)
	provisionals := append([]voiceclient.SIPResponse(nil), t.provisionals...)
	t.provisionals = nil
	t.mu.Unlock()
	for _, resp := range provisionals {
		if onProvisional != nil {
			if err := onProvisional(ctx, msg, resp); err != nil {
				return voiceclient.SIPResponse{}, err
			}
		}
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.nextResponseLocked(), nil
}

func (t *fakeIMSVoiceTransport) nextResponseLocked() voiceclient.SIPResponse {
	if len(t.responses) == 0 {
		return voiceclient.SIPResponse{StatusCode: 500, Reason: "empty"}
	}
	resp := t.responses[0]
	t.responses = t.responses[1:]
	return resp
}

func (t *fakeIMSVoiceTransport) WriteRequest(ctx context.Context, msg voiceclient.SIPRequestMessage) error {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.writes = append(t.writes, msg)
	return nil
}

func (t *fakeIMSVoiceTransport) requestSnapshot() []voiceclient.SIPRequestMessage {
	t.mu.Lock()
	defer t.mu.Unlock()
	return append([]voiceclient.SIPRequestMessage(nil), t.requests...)
}

func waitForIMSRequests(t *testing.T, transport *fakeIMSVoiceTransport, n int) []voiceclient.SIPRequestMessage {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for {
		requests := transport.requestSnapshot()
		if len(requests) >= n {
			return requests
		}
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %d IMS requests, got %+v", n, requests)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func sessionTimerDialogConfig(callID string, cseq int) voiceclient.DialogRequestConfig {
	return voiceclient.DialogRequestConfig{
		Profile:          voiceclient.IMSProfile{IMPU: "sip:user@ims.example", Domain: "ims.example"},
		LocalURI:         "sip:user@ims.example",
		ContactURI:       "sip:user@192.0.2.10:5060",
		RemoteURI:        "sip:+18005551212@ims.example",
		RemoteTargetURI:  "sip:+18005551212@ims.example",
		CallID:           callID,
		LocalTag:         "local-tag",
		RemoteTag:        "remote-tag",
		CSeq:             cseq,
		SessionExpires:   1,
		SessionRefresher: "uac",
	}
}

type blockingMethodTransport struct {
	mu          sync.Mutex
	requests    []voiceclient.SIPRequestMessage
	method      string
	response    voiceclient.SIPResponse
	blocked     chan struct{}
	released    chan struct{}
	blockedOnce sync.Once
}

func newBlockingMethodTransport(method string, response voiceclient.SIPResponse) *blockingMethodTransport {
	return &blockingMethodTransport{
		method:   method,
		response: response,
		blocked:  make(chan struct{}),
		released: make(chan struct{}),
	}
}

func (t *blockingMethodTransport) RoundTripRequest(ctx context.Context, msg voiceclient.SIPRequestMessage) (voiceclient.SIPResponse, error) {
	t.mu.Lock()
	t.requests = append(t.requests, msg)
	shouldBlock := strings.EqualFold(msg.Method, t.method)
	t.mu.Unlock()
	if shouldBlock {
		t.blockedOnce.Do(func() { close(t.blocked) })
		select {
		case <-ctx.Done():
			return voiceclient.SIPResponse{}, ctx.Err()
		case <-t.released:
		}
	}
	return t.response, nil
}

func (t *blockingMethodTransport) WriteRequest(ctx context.Context, msg voiceclient.SIPRequestMessage) error {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.requests = append(t.requests, msg)
	return nil
}

func (t *blockingMethodTransport) waitBlocked(testingT *testing.T) {
	testingT.Helper()
	select {
	case <-t.blocked:
	case <-time.After(2 * time.Second):
		testingT.Fatal("timed out waiting for blocked request")
	}
}

func (t *blockingMethodTransport) release() {
	close(t.released)
}

func (t *blockingMethodTransport) requestSnapshot() []voiceclient.SIPRequestMessage {
	t.mu.Lock()
	defer t.mu.Unlock()
	return append([]voiceclient.SIPRequestMessage(nil), t.requests...)
}
