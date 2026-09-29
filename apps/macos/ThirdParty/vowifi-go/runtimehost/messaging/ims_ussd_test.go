package messaging

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/boa-z/vowifi-go/runtimehost/eventhost"
	"github.com/boa-z/vowifi-go/runtimehost/voiceclient"
)

func TestIMSUSSDTransportExecuteAndContinue(t *testing.T) {
	replyXML, err := BuildIMSUSSDXML(IMSUSSDPayload{Text: "Balance: 10", Operation: IMSUSSDOperationNotify})
	if err != nil {
		t.Fatalf("BuildIMSUSSDXML() error = %v", err)
	}
	transport := &fakeSIPRequestTransport{responses: []voiceclient.SIPResponse{
		{
			StatusCode: 200,
			Reason:     "OK",
			Headers: map[string][]string{
				"To":           {"<sip:*100%23@ims.example;user=dialstring>;tag=as-tag"},
				"Contact":      {"<sip:ussd-as@ims.example>"},
				"Record-Route": {"<sip:dialog1.ims.example;lr>, <sip:dialog2.ims.example;lr>"},
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
		Transport: transport,
		Profile:   voiceclient.IMSProfile{IMPU: "sip:user@ims.example", Domain: "ims.example", LocalIP: "192.0.2.10"},
		Registration: voiceclient.RegistrationBinding{
			ContactURI:     "sip:user@192.0.2.10:5060",
			PublicIdentity: "sip:user@ims.example",
			ServiceRoutes:  []string{"<sip:pcscf.ims.example;lr>"},
		},
	}
	first, err := ussd.ExecuteUSSD(context.Background(), USSDRequest{SessionID: "session-1", Command: "*100#"})
	if err != nil {
		t.Fatalf("ExecuteUSSD() error = %v", err)
	}
	if first.Done || first.SessionID != "session-1" || first.Status != 200 {
		t.Fatalf("first=%+v", first)
	}
	if len(transport.requests) != 1 {
		t.Fatalf("requests=%d", len(transport.requests))
	}
	invite := transport.requests[0]
	if invite.Method != "INVITE" || invite.URI != "sip:*100%23@ims.example;user=dialstring" || invite.Headers["Recv-Info"] != IMSUSSDInfoPackage {
		t.Fatalf("invite=%+v", invite)
	}
	if invite.Headers["Route"] != "<sip:pcscf.ims.example;lr>" || !strings.Contains(invite.Headers["Content-Type"], "multipart/mixed") {
		t.Fatalf("invite headers=%+v", invite.Headers)
	}
	payload, ok, err := DecodeIMSUSSDDocument(invite.Headers["Content-Type"], invite.Body)
	if err != nil || !ok || payload.Text != "*100#" || payload.Operation != IMSUSSDOperationRequest {
		t.Fatalf("payload=%+v ok=%v err=%v", payload, ok, err)
	}
	if len(transport.writes) != 1 || transport.writes[0].Method != "ACK" || transport.writes[0].Headers["CSeq"] != "1 ACK" {
		t.Fatalf("ACK writes=%+v", transport.writes)
	}
	if route := transport.writes[0].Headers["Route"]; route != "<sip:dialog2.ims.example;lr>, <sip:dialog1.ims.example;lr>" {
		t.Fatalf("ACK Route=%q", route)
	}

	next, err := ussd.ContinueUSSD(context.Background(), USSDRequest{SessionID: "session-1", Input: "1"})
	if err != nil {
		t.Fatalf("ContinueUSSD() error = %v", err)
	}
	if !next.Done || next.Text != "Balance: 10" || next.Status != 200 {
		t.Fatalf("next=%+v", next)
	}
	if len(transport.requests) != 2 {
		t.Fatalf("requests=%d", len(transport.requests))
	}
	info := transport.requests[1]
	if info.Method != "INFO" || info.Headers["CSeq"] != "2 INFO" || info.Headers["Info-Package"] != IMSUSSDInfoPackage || info.Headers["Content-Disposition"] != IMSUSSDContentDisposition {
		t.Fatalf("info=%+v", info)
	}
	if info.URI != "sip:ussd-as@ims.example" || info.Headers["Route"] != "<sip:dialog2.ims.example;lr>, <sip:dialog1.ims.example;lr>" {
		t.Fatalf("INFO route/target=%+v", info)
	}
	if _, err := ussd.ContinueUSSD(context.Background(), USSDRequest{SessionID: "session-1", Input: "1"}); err == nil {
		t.Fatal("ContinueUSSD() err=nil after terminal notify, want inactive session")
	}
}

func TestIMSUSSDTransportFollowsInviteRedirectContact(t *testing.T) {
	replyXML, err := BuildIMSUSSDXML(IMSUSSDPayload{Text: "Balance: 10", Operation: IMSUSSDOperationNotify})
	if err != nil {
		t.Fatalf("BuildIMSUSSDXML() error = %v", err)
	}
	transport := &fakeSIPRequestTransport{responses: []voiceclient.SIPResponse{
		{
			StatusCode: 302,
			Reason:     "Moved Temporarily",
			Headers: map[string][]string{
				"To":      {"<sip:*100%23@ims.example;user=dialstring>;tag=redirect-tag"},
				"Contact": {"<sip:ussd-expired@ims.example>;expires=0, <sip:ussd-low@ims.example>;q=0.2, <sip:ussd-redirect@ims.example>;q=0.8"},
			},
		},
		{
			StatusCode: 200,
			Reason:     "OK",
			Headers: map[string][]string{
				"To":           {"<sip:*100%23@ims.example;user=dialstring>;tag=final-tag"},
				"Contact":      {"<sip:ussd-dialog@ims.example>"},
				"Content-Type": {IMSUSSDContentType},
			},
			Body: replyXML,
		},
	}}
	ussd := &IMSUSSDTransport{
		Transport: transport,
		Profile:   voiceclient.IMSProfile{IMPU: "sip:user@ims.example", Domain: "ims.example", LocalIP: "192.0.2.10"},
		Registration: voiceclient.RegistrationBinding{
			ContactURI:     "sip:user@192.0.2.10:5060",
			PublicIdentity: "sip:user@ims.example",
		},
	}

	result, err := ussd.ExecuteUSSD(context.Background(), USSDRequest{SessionID: "session-invite-redirect", Command: "*100#"})
	if err != nil || !result.Done || result.Text != "Balance: 10" || result.Status != 200 {
		t.Fatalf("ExecuteUSSD() result=%+v err=%v", result, err)
	}
	if len(transport.requests) != 2 {
		t.Fatalf("requests=%+v", transport.requests)
	}
	first := transport.requests[0]
	redirect := transport.requests[1]
	if first.Method != "INVITE" || first.URI != "sip:*100%23@ims.example;user=dialstring" || first.Headers["CSeq"] != "1 INVITE" {
		t.Fatalf("first INVITE=%+v", first)
	}
	if redirect.Method != "INVITE" || redirect.URI != "sip:ussd-redirect@ims.example" || redirect.Headers["CSeq"] != "2 INVITE" {
		t.Fatalf("redirect INVITE=%+v", redirect)
	}
	if len(transport.writes) != 2 || transport.writes[0].Method != "ACK" || transport.writes[1].Method != "ACK" {
		t.Fatalf("ACK writes=%+v", transport.writes)
	}
	if transport.writes[0].Headers["CSeq"] != "1 ACK" || !strings.Contains(transport.writes[0].Headers["To"], "redirect-tag") {
		t.Fatalf("redirect ACK=%+v", transport.writes[0])
	}
	if transport.writes[1].Headers["CSeq"] != "2 ACK" || transport.writes[1].URI != "sip:ussd-dialog@ims.example" {
		t.Fatalf("final ACK=%+v", transport.writes[1])
	}
}

func TestIMSUSSDTransportFollowsInfoRedirectContact(t *testing.T) {
	menuXML, err := BuildIMSUSSDXML(IMSUSSDPayload{Text: "1. Balance", Operation: IMSUSSDOperationRequest})
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
			StatusCode: 302,
			Reason:     "Moved Temporarily",
			Headers:    map[string][]string{"Contact": {"<sip:ussd-info-redirect@ims.example>"}},
		},
		{
			StatusCode: 200,
			Reason:     "OK",
			Headers: map[string][]string{
				"Contact":      {"<sip:ussd-info-final@ims.example>"},
				"Content-Type": {IMSUSSDContentType},
			},
			Body: menuXML,
		},
		{StatusCode: 200, Reason: "OK"},
	}}
	ussd := &IMSUSSDTransport{
		Transport: transport,
		Profile:   voiceclient.IMSProfile{IMPU: "sip:user@ims.example", Domain: "ims.example", LocalIP: "192.0.2.10"},
		Registration: voiceclient.RegistrationBinding{
			ContactURI:     "sip:user@192.0.2.10:5060",
			PublicIdentity: "sip:user@ims.example",
		},
	}
	if _, err := ussd.ExecuteUSSD(context.Background(), USSDRequest{SessionID: "session-info-redirect", Command: "*100#"}); err != nil {
		t.Fatalf("ExecuteUSSD() error = %v", err)
	}
	result, err := ussd.ContinueUSSD(context.Background(), USSDRequest{SessionID: "session-info-redirect", Input: "1"})
	if err != nil || result.Done || result.Text != "1. Balance" {
		t.Fatalf("ContinueUSSD() result=%+v err=%v", result, err)
	}
	if err := ussd.CancelUSSD(context.Background(), USSDRequest{SessionID: "session-info-redirect"}); err != nil {
		t.Fatalf("CancelUSSD() error = %v", err)
	}
	if len(transport.requests) != 4 {
		t.Fatalf("requests=%+v", transport.requests)
	}
	info := transport.requests[1]
	redirect := transport.requests[2]
	bye := transport.requests[3]
	if info.Method != "INFO" || info.URI != "sip:ussd-as@ims.example" || info.Headers["CSeq"] != "2 INFO" {
		t.Fatalf("INFO=%+v", info)
	}
	if redirect.Method != "INFO" || redirect.URI != "sip:ussd-info-redirect@ims.example" || redirect.Headers["CSeq"] != "3 INFO" {
		t.Fatalf("redirect INFO=%+v", redirect)
	}
	if bye.Method != "BYE" || bye.URI != "sip:ussd-info-final@ims.example" || bye.Headers["CSeq"] != "4 BYE" {
		t.Fatalf("BYE after INFO redirect=%+v", bye)
	}
}

func TestIMSUSSDTransportCancelSendsBye(t *testing.T) {
	transport := &fakeSIPRequestTransport{responses: []voiceclient.SIPResponse{
		{
			StatusCode: 200,
			Reason:     "OK",
			Headers: map[string][]string{
				"To":           {"<sip:*100%23@ims.example;user=dialstring>;tag=as-tag"},
				"Contact":      {"<sip:ussd-as@ims.example>"},
				"Record-Route": {"<sip:dialog-proxy.ims.example;lr>"},
			},
		},
		{StatusCode: 200, Reason: "OK"},
	}}
	ussd := &IMSUSSDTransport{
		Transport: transport,
		Profile:   voiceclient.IMSProfile{IMPU: "sip:user@ims.example", Domain: "ims.example"},
		Registration: voiceclient.RegistrationBinding{
			ContactURI:     "sip:user@192.0.2.10:5060",
			PublicIdentity: "sip:user@ims.example",
		},
	}
	if _, err := ussd.ExecuteUSSD(context.Background(), USSDRequest{SessionID: "session-cancel", Command: "*100#"}); err != nil {
		t.Fatalf("ExecuteUSSD() error = %v", err)
	}
	if err := ussd.CancelUSSD(context.Background(), USSDRequest{SessionID: "session-cancel"}); err != nil {
		t.Fatalf("CancelUSSD() error = %v", err)
	}
	if len(transport.requests) != 2 {
		t.Fatalf("requests=%d", len(transport.requests))
	}
	bye := transport.requests[1]
	if bye.Method != "BYE" || bye.Headers["CSeq"] != "2 BYE" || bye.URI != "sip:ussd-as@ims.example" {
		t.Fatalf("bye=%+v", bye)
	}
	if bye.Headers["Route"] != "<sip:dialog-proxy.ims.example;lr>" {
		t.Fatalf("BYE Route=%q", bye.Headers["Route"])
	}
}

func TestIMSUSSDTransportCancelRecoveryErrorCarriesRetryAfter(t *testing.T) {
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
			StatusCode: 503,
			Reason:     "Service Unavailable",
			Headers:    map[string][]string{"Retry-After": {"5"}},
		},
	}}
	ussd := &IMSUSSDTransport{
		Transport: transport,
		Profile:   voiceclient.IMSProfile{IMPU: "sip:user@ims.example", Domain: "ims.example"},
		Registration: voiceclient.RegistrationBinding{
			ContactURI:     "sip:user@192.0.2.10:5060",
			PublicIdentity: "sip:user@ims.example",
		},
	}
	if _, err := ussd.ExecuteUSSD(context.Background(), USSDRequest{SessionID: "session-bye-503", Command: "*100#"}); err != nil {
		t.Fatalf("ExecuteUSSD() error = %v", err)
	}
	err := ussd.CancelUSSD(context.Background(), USSDRequest{SessionID: "session-bye-503"})
	if err == nil || !IsIMSRegistrationRecoveryError(err) || IMSRegistrationRecoveryRetryAfter(err) != 5*time.Second {
		t.Fatalf("CancelUSSD() err=%v retryAfter=%v, want recovery 5s", err, IMSRegistrationRecoveryRetryAfter(err))
	}
}

func TestIMSUSSDTransportACKsRejectedInvite(t *testing.T) {
	transport := &fakeSIPRequestTransport{responses: []voiceclient.SIPResponse{{
		StatusCode: 486,
		Reason:     "Busy Here",
		Headers: map[string][]string{
			"To":           {"<sip:*100%23@ims.example;user=dialstring>;tag=busy-tag"},
			"Contact":      {"<sip:ussd-as@ims.example>"},
			"Record-Route": {"<sip:reject-proxy1.ims.example;lr>, <sip:reject-proxy2.ims.example;lr>"},
		},
	}}}
	ussd := &IMSUSSDTransport{
		Transport: transport,
		Profile:   voiceclient.IMSProfile{IMPU: "sip:user@ims.example", Domain: "ims.example"},
		Registration: voiceclient.RegistrationBinding{
			ContactURI:     "sip:user@192.0.2.10:5060",
			PublicIdentity: "sip:user@ims.example",
		},
	}

	result, err := ussd.ExecuteUSSD(context.Background(), USSDRequest{SessionID: "session-reject", Command: "*100#"})
	if err == nil || !strings.Contains(err.Error(), "IMS USSD INVITE rejected: 486 Busy Here") {
		t.Fatalf("ExecuteUSSD() result=%+v err=%v, want rejected error", result, err)
	}
	if result.Status != 486 || !result.Done {
		t.Fatalf("result=%+v", result)
	}
	if len(transport.writes) != 1 || transport.writes[0].Method != "ACK" {
		t.Fatalf("ACK writes=%+v", transport.writes)
	}
	ack := transport.writes[0]
	if ack.Headers["CSeq"] != "1 ACK" || !strings.Contains(ack.Headers["To"], "busy-tag") {
		t.Fatalf("ACK=%+v", ack)
	}
	if ack.URI != "sip:ussd-as@ims.example" {
		t.Fatalf("ACK URI=%q", ack.URI)
	}
	if route := ack.Headers["Route"]; route != "<sip:reject-proxy2.ims.example;lr>, <sip:reject-proxy1.ims.example;lr>" {
		t.Fatalf("ACK Route=%q", route)
	}
	if _, ok := ussd.session("session-reject"); ok {
		t.Fatal("rejected USSD INVITE must not leave an active session")
	}
}

func TestIMSUSSDTransportFlagsRecoverableFailures(t *testing.T) {
	transport := &fakeSIPRequestTransport{responses: []voiceclient.SIPResponse{{
		StatusCode: 503,
		Reason:     "Service Unavailable",
		Headers: map[string][]string{
			"To":          {"<sip:*100%23@ims.example;user=dialstring>;tag=unavailable"},
			"Retry-After": {"4"},
		},
	}}}
	ussd := &IMSUSSDTransport{
		Transport: transport,
		Profile:   voiceclient.IMSProfile{IMPU: "sip:user@ims.example", Domain: "ims.example"},
		Registration: voiceclient.RegistrationBinding{
			ContactURI:     "sip:user@192.0.2.10:5060",
			PublicIdentity: "sip:user@ims.example",
		},
	}

	result, err := ussd.ExecuteUSSD(context.Background(), USSDRequest{SessionID: "session-503", Command: "*100#"})
	if err == nil || result.Status != 503 || !result.Done || !result.RegistrationRecoveryNeeded || result.RetryAfter != 4*time.Second {
		t.Fatalf("ExecuteUSSD() result=%+v err=%v, want recoverable 503", result, err)
	}

	transport = &fakeSIPRequestTransport{errors: []error{errors.New("pcscf flow reset")}}
	ussd.Transport = transport
	result, err = ussd.ExecuteUSSD(context.Background(), USSDRequest{SessionID: "session-transport", Command: "*100#"})
	if err == nil || result.Status != 0 || !result.Done || !result.RegistrationRecoveryNeeded {
		t.Fatalf("ExecuteUSSD() result=%+v err=%v, want recoverable transport error", result, err)
	}
}

func TestIMSUSSDTransportHandlesInboundInfoAndBye(t *testing.T) {
	transport := &fakeSIPRequestTransport{responses: []voiceclient.SIPResponse{{
		StatusCode: 200,
		Reason:     "OK",
		Headers: map[string][]string{
			"To":      {"<sip:*100%23@ims.example;user=dialstring>;tag=as-tag"},
			"Contact": {"<sip:ussd-as@ims.example>"},
		},
	}}}
	ussd := &IMSUSSDTransport{
		Transport: transport,
		Profile:   voiceclient.IMSProfile{IMPU: "sip:user@ims.example", Domain: "ims.example"},
		Registration: voiceclient.RegistrationBinding{
			ContactURI:     "sip:user@192.0.2.10:5060",
			PublicIdentity: "sip:user@ims.example",
		},
	}
	dispatch := &fakeDispatcher{}
	svc := NewService("dev-1", "310280000000001", nil, dispatch)
	svc.SetUSSDTransport(ussd)
	first, err := svc.SendUSSD(context.Background(), "*100#")
	if err != nil {
		t.Fatalf("SendUSSD() error = %v", err)
	}
	if first.Done || !svc.hasUSSDSession(first.SessionID) {
		t.Fatalf("first=%+v active=%v", first, svc.hasUSSDSession(first.SessionID))
	}

	menuXML, err := BuildIMSUSSDXML(IMSUSSDPayload{Text: "1. Balance\n2. Data", Operation: IMSUSSDOperationRequest})
	if err != nil {
		t.Fatalf("BuildIMSUSSDXML(menu) error = %v", err)
	}
	info, err := svc.HandleIMSUSSDInfo(context.Background(), IMSUSSDDialogRequest{
		CallID:      "ussd-" + smsToken(first.SessionID) + "@vowifi-go",
		CSeq:        2,
		ContentType: IMSUSSDContentType,
		InfoPackage: IMSUSSDInfoPackage,
		Body:        menuXML,
	})
	if err != nil {
		t.Fatalf("HandleIMSUSSDInfo() error = %v", err)
	}
	if !info.Handled || info.StatusCode != 200 || info.USSD.Text != "1. Balance\n2. Data" || info.USSD.Done || !svc.hasUSSDSession(first.SessionID) {
		t.Fatalf("info=%+v active=%v", info, svc.hasUSSDSession(first.SessionID))
	}
	if len(dispatch.events) != 2 {
		t.Fatalf("events=%d", len(dispatch.events))
	}
	infoEvent, ok := dispatch.events[1].(eventhost.USSDUpdated)
	if !ok || infoEvent.DevID != "dev-1" || infoEvent.SessionID != first.SessionID || infoEvent.Text != "1. Balance\n2. Data" || infoEvent.Done || infoEvent.Time.IsZero() {
		t.Fatalf("event=%+v", dispatch.events[1])
	}

	byeXML, err := BuildIMSUSSDXML(IMSUSSDPayload{Text: "Bye", Operation: IMSUSSDOperationNotify})
	if err != nil {
		t.Fatalf("BuildIMSUSSDXML(bye) error = %v", err)
	}
	bye, err := svc.HandleIMSUSSDBye(context.Background(), IMSUSSDDialogRequest{
		CallID:      "ussd-" + smsToken(first.SessionID) + "@vowifi-go",
		CSeq:        3,
		ContentType: IMSUSSDContentType,
		Body:        byeXML,
	})
	if err != nil {
		t.Fatalf("HandleIMSUSSDBye() error = %v", err)
	}
	if !bye.Handled || bye.StatusCode != 200 || bye.USSD.Text != "Bye" || !bye.USSD.Done || svc.hasUSSDSession(first.SessionID) {
		t.Fatalf("bye=%+v active=%v", bye, svc.hasUSSDSession(first.SessionID))
	}
	if len(dispatch.events) != 3 {
		t.Fatalf("events=%d", len(dispatch.events))
	}
	byeEvent, ok := dispatch.events[2].(eventhost.USSDUpdated)
	if !ok || byeEvent.SessionID != first.SessionID || byeEvent.Text != "Bye" || !byeEvent.Done || byeEvent.Time.IsZero() {
		t.Fatalf("event=%+v", dispatch.events[2])
	}
}

func TestIMSUSSDTransportAcceptsNetworkInitiatedInfo(t *testing.T) {
	nextXML, err := BuildIMSUSSDXML(IMSUSSDPayload{Text: "More?", Operation: IMSUSSDOperationRequest})
	if err != nil {
		t.Fatalf("BuildIMSUSSDXML(next) error = %v", err)
	}
	transport := &fakeSIPRequestTransport{responses: []voiceclient.SIPResponse{{
		StatusCode: 200,
		Reason:     "OK",
		Headers:    map[string][]string{"Content-Type": {IMSUSSDContentType}},
		Body:       nextXML,
	}}}
	ussd := &IMSUSSDTransport{
		Transport: transport,
		Profile:   voiceclient.IMSProfile{IMPU: "sip:user@ims.example", Domain: "ims.example"},
		Registration: voiceclient.RegistrationBinding{
			ContactURI:     "sip:user@192.0.2.10:5060",
			PublicIdentity: "sip:user@ims.example",
		},
	}
	dispatch := &fakeDispatcher{}
	svc := NewService("dev-1", "310280000000001", nil, dispatch)
	svc.SetUSSDTransport(ussd)

	menuXML, err := BuildIMSUSSDXML(IMSUSSDPayload{Text: "1. Balance", Operation: IMSUSSDOperationRequest})
	if err != nil {
		t.Fatalf("BuildIMSUSSDXML(menu) error = %v", err)
	}
	info, err := svc.HandleIMSUSSDInfo(context.Background(), IMSUSSDDialogRequest{
		CallID: "net-ussd-call",
		CSeq:   4,
		Body:   menuXML,
		Headers: map[string][]string{
			"Content-Type": {"application/vnd.3gpp.ussd+xml;charset=UTF-8"},
			"Info-Package": {IMSUSSDInfoPackage},
			"From":         {"<sip:ussd-as@ims.example>;tag=as-tag"},
			"To":           {"<sip:user@ims.example>;tag=ue-tag"},
			"Contact":      {"<sip:ussd-as@198.51.100.7;transport=udp>"},
			"Record-Route": {"<sip:edge1.ims.example;lr>, <sip:edge2.ims.example;lr>"},
		},
	})
	if err != nil {
		t.Fatalf("HandleIMSUSSDInfo() error = %v", err)
	}
	sessionID := info.USSD.SessionID
	if !info.Handled || info.StatusCode != 200 || sessionID == "" || info.USSD.Text != "1. Balance" || info.USSD.Done || !svc.hasUSSDSession(sessionID) {
		t.Fatalf("info=%+v active=%v", info, svc.hasUSSDSession(sessionID))
	}
	state, ok := ussd.session(sessionID)
	if !ok {
		t.Fatalf("transport session %q not found", sessionID)
	}
	if state.cseq != 4 || state.cfg.CallID != "net-ussd-call" || state.cfg.LocalURI != "sip:user@ims.example" ||
		state.cfg.RemoteURI != "sip:ussd-as@ims.example" || state.cfg.RemoteTargetURI != "sip:ussd-as@198.51.100.7;transport=udp" ||
		state.cfg.LocalTag != "ue-tag" || state.cfg.RemoteTag != "as-tag" {
		t.Fatalf("state=%+v", state)
	}
	if len(state.cfg.RouteSet) != 2 || state.cfg.RouteSet[0] != "<sip:edge2.ims.example;lr>" || state.cfg.RouteSet[1] != "<sip:edge1.ims.example;lr>" {
		t.Fatalf("route set=%+v", state.cfg.RouteSet)
	}

	next, err := svc.ContinueUSSD(context.Background(), sessionID, "1")
	if err != nil {
		t.Fatalf("ContinueUSSD() error = %v", err)
	}
	if next.Done || next.Text != "More?" || !svc.hasUSSDSession(sessionID) {
		t.Fatalf("next=%+v active=%v", next, svc.hasUSSDSession(sessionID))
	}
	if len(transport.requests) != 1 {
		t.Fatalf("requests=%+v", transport.requests)
	}
	out := transport.requests[0]
	if out.Method != "INFO" || out.URI != "sip:ussd-as@198.51.100.7;transport=udp" || out.Headers["CSeq"] != "5 INFO" ||
		out.Headers["Info-Package"] != IMSUSSDInfoPackage || out.Headers["Content-Disposition"] != IMSUSSDContentDisposition {
		t.Fatalf("outbound INFO=%+v", out)
	}
	if !strings.Contains(out.Headers["From"], "tag=ue-tag") || !strings.Contains(out.Headers["To"], "tag=as-tag") {
		t.Fatalf("dialog headers=%+v", out.Headers)
	}
	if route := out.Headers["Route"]; route != "<sip:edge2.ims.example;lr>, <sip:edge1.ims.example;lr>" {
		t.Fatalf("Route=%q", route)
	}

	byeXML, err := BuildIMSUSSDXML(IMSUSSDPayload{Text: "Bye", Operation: IMSUSSDOperationNotify})
	if err != nil {
		t.Fatalf("BuildIMSUSSDXML(bye) error = %v", err)
	}
	bye, err := svc.HandleIMSUSSDBye(context.Background(), IMSUSSDDialogRequest{
		CallID:      "net-ussd-call",
		CSeq:        6,
		ContentType: IMSUSSDContentType,
		Body:        byeXML,
	})
	if err != nil {
		t.Fatalf("HandleIMSUSSDBye() error = %v", err)
	}
	if !bye.Handled || bye.StatusCode != 200 || bye.USSD.SessionID != sessionID || bye.USSD.Text != "Bye" || !bye.USSD.Done || svc.hasUSSDSession(sessionID) {
		t.Fatalf("bye=%+v active=%v", bye, svc.hasUSSDSession(sessionID))
	}
	if _, ok := ussd.session(sessionID); ok {
		t.Fatalf("transport session %q still active", sessionID)
	}
	if len(dispatch.events) != 3 {
		t.Fatalf("events=%d", len(dispatch.events))
	}
}

func TestIMSUSSDTransportRejectsUnknownInvalidOrNonUSSDInfo(t *testing.T) {
	ussd := &IMSUSSDTransport{
		Profile: voiceclient.IMSProfile{IMPU: "sip:user@ims.example", Domain: "ims.example"},
		Registration: voiceclient.RegistrationBinding{
			ContactURI:     "sip:user@192.0.2.10:5060",
			PublicIdentity: "sip:user@ims.example",
		},
	}

	invalid, err := ussd.HandleIMSInfo(context.Background(), IMSUSSDDialogRequest{
		CallID:      "bad-ussd-call",
		CSeq:        1,
		ContentType: IMSUSSDContentType,
		Body:        []byte("not xml"),
	})
	if err == nil || !invalid.Handled || invalid.StatusCode != 400 {
		t.Fatalf("invalid=%+v err=%v", invalid, err)
	}
	if _, ok := ussd.session("ims-ussd-" + smsToken("bad-ussd-call")); ok {
		t.Fatal("invalid INFO created a session")
	}

	missing, err := ussd.HandleIMSInfo(context.Background(), IMSUSSDDialogRequest{
		CallID:      "missing-body-call",
		CSeq:        1,
		ContentType: "text/plain",
		InfoPackage: IMSUSSDInfoPackage,
		Body:        []byte("plain text"),
	})
	if err == nil || !missing.Handled || missing.StatusCode != 400 {
		t.Fatalf("missing=%+v err=%v", missing, err)
	}

	plain, err := ussd.HandleIMSInfo(context.Background(), IMSUSSDDialogRequest{
		CallID:      "plain-call",
		CSeq:        1,
		ContentType: "text/plain",
		Body:        []byte("Signal=1\r\nDuration=100\r\n"),
	})
	if err != nil || plain.Handled || plain.StatusCode != 0 {
		t.Fatalf("plain=%+v err=%v", plain, err)
	}

	xml, err := BuildIMSUSSDXML(IMSUSSDPayload{Text: "1. Balance", Operation: IMSUSSDOperationRequest})
	if err != nil {
		t.Fatalf("BuildIMSUSSDXML() error = %v", err)
	}
	implicit, err := ussd.HandleIMSInfo(context.Background(), IMSUSSDDialogRequest{
		CallID:      "implicit-call",
		CSeq:        1,
		ContentType: "text/xml",
		Body:        xml,
	})
	if err != nil || implicit.Handled || implicit.StatusCode != 0 {
		t.Fatalf("implicit=%+v err=%v", implicit, err)
	}
	if _, ok := ussd.session("ims-ussd-" + smsToken("implicit-call")); ok {
		t.Fatal("implicit INFO created a session")
	}

	bye, err := ussd.HandleIMSBye(context.Background(), IMSUSSDDialogRequest{
		CallID:      "missing-call",
		CSeq:        2,
		ContentType: IMSUSSDContentType,
	})
	if err != nil || !bye.Handled || bye.StatusCode != 481 {
		t.Fatalf("bye=%+v err=%v", bye, err)
	}
}
