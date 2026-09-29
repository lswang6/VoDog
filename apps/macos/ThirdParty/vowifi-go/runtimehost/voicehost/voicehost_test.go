package voicehost

import (
	"context"
	"errors"
	"strconv"
	"strings"
	"testing"

	"github.com/emiago/sipgo/sip"
)

type fakeOutboundAgent struct {
	requests        []OutboundCallRequest
	infos           []DialogInfoRequest
	messages        []DialogMessageRequest
	pracks          []DialogPrackRequest
	options         []DialogOptionsRequest
	refers          []DialogReferRequest
	notifies        []DialogNotifyRequest
	subscribes      []DialogSubscribeRequest
	updates         []DialogUpdateRequest
	reinvites       []DialogReinviteRequest
	terminated      []DialogInfo
	canceled        []DialogInfo
	result          OutboundCallResult
	infoResult      DialogInfoResult
	messageResult   DialogMessageResult
	prackResult     DialogPrackResult
	optionsResult   DialogOptionsResult
	referResult     DialogReferResult
	notifyResult    DialogNotifyResult
	subscribeResult DialogSubscribeResult
	updateResult    DialogUpdateResult
	reinviteResult  DialogReinviteResult
	terminateResult DialogInfoResult
	cancelResult    DialogInfoResult
	err             error
	infoErr         error
	messageErr      error
	prackErr        error
	optionsErr      error
	referErr        error
	notifyErr       error
	subscribeErr    error
	updateErr       error
	reinviteErr     error
	terminateErr    error
	cancelErr       error
}

func (a *fakeOutboundAgent) StartOutboundCall(ctx context.Context, req OutboundCallRequest) (OutboundCallResult, error) {
	a.requests = append(a.requests, req)
	if a.err != nil {
		return OutboundCallResult{}, a.err
	}
	if !a.result.Accepted {
		return a.result, nil
	}
	return a.result, nil
}

func (a *fakeOutboundAgent) EndVoiceCall(ctx context.Context, info DialogInfo) error {
	a.terminated = append(a.terminated, info)
	return a.terminateErr
}

func (a *fakeOutboundAgent) CancelVoiceCall(ctx context.Context, info DialogInfo) error {
	a.canceled = append(a.canceled, info)
	return a.cancelErr
}

func (a *fakeOutboundAgent) EndVoiceCallWithResult(ctx context.Context, info DialogInfo) (DialogInfoResult, error) {
	a.terminated = append(a.terminated, info)
	if a.terminateErr != nil {
		return a.terminateResult, a.terminateErr
	}
	if isZeroFakeDialogInfoResult(a.terminateResult) {
		return DialogInfoResult{Accepted: true, StatusCode: 200, Reason: "OK"}, nil
	}
	return a.terminateResult, nil
}

func (a *fakeOutboundAgent) CancelVoiceCallWithResult(ctx context.Context, info DialogInfo) (DialogInfoResult, error) {
	a.canceled = append(a.canceled, info)
	if a.cancelErr != nil {
		return a.cancelResult, a.cancelErr
	}
	if isZeroFakeDialogInfoResult(a.cancelResult) {
		return DialogInfoResult{Accepted: true, StatusCode: 200, Reason: "OK"}, nil
	}
	return a.cancelResult, nil
}

func (a *fakeOutboundAgent) SendDialogInfo(ctx context.Context, req DialogInfoRequest) (DialogInfoResult, error) {
	a.infos = append(a.infos, req)
	if a.infoErr != nil {
		return DialogInfoResult{}, a.infoErr
	}
	return a.infoResult, nil
}

func (a *fakeOutboundAgent) SendDialogMessage(ctx context.Context, req DialogMessageRequest) (DialogMessageResult, error) {
	a.messages = append(a.messages, req)
	if a.messageErr != nil {
		return DialogMessageResult{}, a.messageErr
	}
	return a.messageResult, nil
}

func (a *fakeOutboundAgent) SendDialogPrack(ctx context.Context, req DialogPrackRequest) (DialogPrackResult, error) {
	a.pracks = append(a.pracks, req)
	if a.prackErr != nil {
		return DialogPrackResult{}, a.prackErr
	}
	return a.prackResult, nil
}

func (a *fakeOutboundAgent) SendDialogOptions(ctx context.Context, req DialogOptionsRequest) (DialogOptionsResult, error) {
	a.options = append(a.options, req)
	if a.optionsErr != nil {
		return DialogOptionsResult{}, a.optionsErr
	}
	return a.optionsResult, nil
}

func (a *fakeOutboundAgent) SendDialogRefer(ctx context.Context, req DialogReferRequest) (DialogReferResult, error) {
	a.refers = append(a.refers, req)
	if a.referErr != nil {
		return DialogReferResult{}, a.referErr
	}
	return a.referResult, nil
}

func (a *fakeOutboundAgent) SendDialogNotify(ctx context.Context, req DialogNotifyRequest) (DialogNotifyResult, error) {
	a.notifies = append(a.notifies, req)
	if a.notifyErr != nil {
		return DialogNotifyResult{}, a.notifyErr
	}
	return a.notifyResult, nil
}

func (a *fakeOutboundAgent) SendDialogSubscribe(ctx context.Context, req DialogSubscribeRequest) (DialogSubscribeResult, error) {
	a.subscribes = append(a.subscribes, req)
	if a.subscribeErr != nil {
		return DialogSubscribeResult{}, a.subscribeErr
	}
	return a.subscribeResult, nil
}

func (a *fakeOutboundAgent) SendDialogUpdate(ctx context.Context, req DialogUpdateRequest) (DialogUpdateResult, error) {
	a.updates = append(a.updates, req)
	if a.updateErr != nil {
		return DialogUpdateResult{}, a.updateErr
	}
	return a.updateResult, nil
}

func (a *fakeOutboundAgent) SendDialogReinvite(ctx context.Context, req DialogReinviteRequest) (DialogReinviteResult, error) {
	a.reinvites = append(a.reinvites, req)
	if a.reinviteErr != nil {
		return DialogReinviteResult{}, a.reinviteErr
	}
	return a.reinviteResult, nil
}

type fakeAutoDTMFAgent struct {
	*fakeOutboundAgent
	autoDTMFs     []DialogDTMFRequest
	autoResult    DialogAutoDTMFResult
	autoErr       error
	autoCallCount int
}

func (a *fakeAutoDTMFAgent) SendDialogAutoDTMF(ctx context.Context, req DialogDTMFRequest) (DialogAutoDTMFResult, error) {
	a.autoCallCount++
	a.autoDTMFs = append(a.autoDTMFs, req)
	return a.autoResult, a.autoErr
}

func isZeroFakeDialogInfoResult(result DialogInfoResult) bool {
	return !result.Accepted &&
		result.StatusCode == 0 &&
		result.Reason == "" &&
		!result.RegistrationRecoveryNeeded &&
		result.RetryAfter == 0 &&
		result.ContentType == "" &&
		len(result.Body) == 0 &&
		len(result.Headers) == 0
}

type fakeServerTransaction struct {
	responses []*sip.Response
}

func (tx *fakeServerTransaction) Respond(res *sip.Response) error {
	tx.responses = append(tx.responses, res)
	return nil
}

func (tx *fakeServerTransaction) Terminate()                         {}
func (tx *fakeServerTransaction) Done() <-chan struct{}              { return make(chan struct{}) }
func (tx *fakeServerTransaction) Err() error                         { return nil }
func (tx *fakeServerTransaction) Acks() <-chan *sip.Request          { return make(chan *sip.Request) }
func (tx *fakeServerTransaction) OnTerminate(sip.FnTxTerminate) bool { return true }
func (tx *fakeServerTransaction) OnCancel(sip.FnTxCancel) bool       { return true }

func TestGatewayHandleClientInviteStartsOutboundAgent(t *testing.T) {
	g := NewGateway()
	agent := &fakeOutboundAgent{result: OutboundCallResult{
		Accepted: true,
		LocalSDP: SDPInfo{
			ConnectionIP: "192.0.2.20",
			MediaPort:    5004,
			Payloads:     []int{0, 101},
			Direction:    "sendrecv",
		},
		Headers: map[string]string{"Session-Expires": "1800;refresher=uas"},
	}}
	g.RegisterAgent("dev-1", agent)
	tx := &fakeServerTransaction{}
	req := newInviteRequest("call-1", "18005551212", sampleSDP("198.51.100.10", 4002))

	g.HandleClientInvite("dev-1", req, tx)

	if len(tx.responses) != 2 {
		t.Fatalf("responses=%d, want 100 and 200", len(tx.responses))
	}
	if tx.responses[0].StatusCode != 100 || tx.responses[1].StatusCode != 200 {
		t.Fatalf("status codes=%d/%d", tx.responses[0].StatusCode, tx.responses[1].StatusCode)
	}
	if len(agent.requests) != 1 {
		t.Fatalf("agent requests=%d", len(agent.requests))
	}
	gotReq := agent.requests[0]
	if gotReq.Callee != "18005551212" || gotReq.RemoteSDP.ConnectionIP != "198.51.100.10" || gotReq.RemoteSDP.MediaPort != 4002 {
		t.Fatalf("outbound request=%+v", gotReq)
	}
	if body := string(tx.responses[1].Body()); !strings.Contains(body, "m=audio 5004 RTP/AVP 0 101") {
		t.Fatalf("200 OK SDP body=%q", body)
	}
	if got := tx.responses[1].GetHeader("Session-Expires"); got == nil || got.Value() != "1800;refresher=uas" {
		t.Fatalf("Session-Expires response header=%v", got)
	}
	status := g.DeviceStatus("dev-1")
	if status["active_dialogs"] != 1 {
		t.Fatalf("DeviceStatus=%+v, want one active dialog", status)
	}
}

func TestGatewayHandleClientInviteWithoutOutboundAgentReturns503(t *testing.T) {
	g := NewGateway()
	g.RegisterAgent("dev-1", struct{}{})
	tx := &fakeServerTransaction{}
	g.HandleClientInvite("dev-1", newInviteRequest("call-1", "18005551212", sampleSDP("198.51.100.10", 4002)), tx)
	if len(tx.responses) != 1 || tx.responses[0].StatusCode != 503 {
		t.Fatalf("responses=%v", responseCodes(tx.responses))
	}
}

func TestGatewayHandleClientInvitePropagatesOutboundRejectStatus(t *testing.T) {
	g := NewGateway()
	agent := &fakeOutboundAgent{result: OutboundCallResult{
		Accepted:   false,
		StatusCode: 404,
		Reason:     "Not Found",
	}}
	g.RegisterAgent("dev-1", agent)
	tx := &fakeServerTransaction{}

	g.HandleClientInvite("dev-1", newInviteRequest("call-404", "18005551212", sampleSDP("198.51.100.10", 4002)), tx)

	if len(tx.responses) != 2 {
		t.Fatalf("responses=%v, want 100 and 404", responseCodes(tx.responses))
	}
	if tx.responses[0].StatusCode != 100 || tx.responses[1].StatusCode != 404 || tx.responses[1].Reason != "Not Found" {
		t.Fatalf("responses=%d/%d reason=%q", tx.responses[0].StatusCode, tx.responses[1].StatusCode, tx.responses[1].Reason)
	}
	if status := g.DeviceStatus("dev-1"); status["active_dialogs"] != 0 {
		t.Fatalf("DeviceStatus=%+v, want no active dialog", status)
	}
}

func TestGatewayHandleClientInviteRoutesEstablishedDialogReinvite(t *testing.T) {
	g := NewGateway()
	agent := &fakeOutboundAgent{
		result: OutboundCallResult{
			Accepted: true,
			LocalSDP: SDPInfo{ConnectionIP: "192.0.2.20", MediaPort: 5004, Payloads: []int{0, 101}},
		},
		reinviteResult: DialogReinviteResult{
			Accepted:    true,
			StatusCode:  200,
			Reason:      "OK",
			ContentType: "application/sdp",
			Body:        []byte(sampleSDP("203.0.113.40", 49180)),
			Headers:     map[string]string{"X-IMS": "reinvite-ok"},
		},
	}
	g.RegisterAgent("dev-1", agent)
	g.HandleClientInvite("dev-1", newInviteRequest("call-reinvite", "18005551212", sampleSDP("198.51.100.10", 4002)), &fakeServerTransaction{})

	tx := &fakeServerTransaction{}
	req := newInviteRequest("call-reinvite", "18005551212", sampleSDP("198.51.100.20", 4010))
	req.AppendHeader(sip.NewHeader("Session-Expires", "1800"))
	g.HandleClientInvite("dev-1", req, tx)

	if len(agent.requests) != 1 {
		t.Fatalf("StartOutboundCall requests=%d, want only initial INVITE", len(agent.requests))
	}
	if len(agent.reinvites) != 1 {
		t.Fatalf("reinvites=%d", len(agent.reinvites))
	}
	got := agent.reinvites[0]
	if got.DeviceID != "dev-1" || got.CallID != "call-reinvite" || got.ContentType != "application/sdp" ||
		got.Headers["Session-Expires"] != "1800" || !strings.Contains(string(got.Body), "m=audio 4010") {
		t.Fatalf("DialogReinviteRequest=%+v body=%q", got, got.Body)
	}
	if len(tx.responses) != 1 || tx.responses[0].StatusCode != 200 ||
		tx.responses[0].GetHeader("Content-Type").Value() != "application/sdp" ||
		tx.responses[0].GetHeader("X-IMS").Value() != "reinvite-ok" ||
		!strings.Contains(string(tx.responses[0].Body()), "m=audio 49180") {
		t.Fatalf("responses=%+v", tx.responses)
	}
}

func TestGatewayHandleClientByeTerminatesDialog(t *testing.T) {
	g := NewGateway()
	agent := &fakeOutboundAgent{
		result: OutboundCallResult{Accepted: true, LocalSDP: SDPInfo{ConnectionIP: "192.0.2.20", MediaPort: 5004}},
		terminateResult: DialogInfoResult{
			Accepted:    true,
			StatusCode:  202,
			Reason:      "Accepted",
			ContentType: "message/sipfrag",
			Body:        []byte("SIP/2.0 202 Accepted\r\n"),
			Headers:     map[string]string{"Content-Type": "ignored", "X-IMS": "bye-ok"},
		},
	}
	g.RegisterAgent("dev-1", agent)
	g.HandleClientInvite("dev-1", newInviteRequest("call-1", "18005551212", sampleSDP("198.51.100.10", 4002)), &fakeServerTransaction{})

	tx := &fakeServerTransaction{}
	byeReq := newByeRequest("call-1")
	byeReq.AppendHeader(sip.NewHeader("Reason", "SIP;cause=200;text=\"completed\""))
	byeReq.AppendHeader(sip.NewHeader("X-Client", "bye"))
	byeReq.AppendHeader(sip.NewHeader("Content-Type", "message/sipfrag"))
	byeReq.SetBody([]byte("SIP/2.0 200 OK\r\n"))
	g.HandleClientBye("dev-1", byeReq, tx)

	if len(tx.responses) != 1 || tx.responses[0].StatusCode != 202 || tx.responses[0].Reason != "Accepted" ||
		tx.responses[0].GetHeader("Content-Type").Value() != "message/sipfrag" ||
		tx.responses[0].GetHeader("X-IMS").Value() != "bye-ok" ||
		string(tx.responses[0].Body()) != "SIP/2.0 202 Accepted\r\n" {
		t.Fatalf("BYE responses=%v", responseCodes(tx.responses))
	}
	if len(agent.terminated) != 1 || agent.terminated[0].State != DialogStateTerminated {
		t.Fatalf("terminated=%+v", agent.terminated)
	}
	terminated := agent.terminated[0]
	if terminated.ContentType != "message/sipfrag" || string(terminated.Body) != "SIP/2.0 200 OK\r\n" ||
		terminated.Headers["Reason"] != "SIP;cause=200;text=\"completed\"" ||
		terminated.Headers["X-Client"] != "bye" ||
		terminated.Headers["Content-Type"] != "" {
		t.Fatalf("terminated BYE payload=%+v body=%q", terminated, terminated.Body)
	}
	if status := g.DeviceStatus("dev-1"); status["active_dialogs"] != 0 {
		t.Fatalf("DeviceStatus=%+v, want no active dialog", status)
	}
}

func TestGatewayHandleClientByeKeepsDialogOnIMSFailure(t *testing.T) {
	g := NewGateway()
	agent := &fakeOutboundAgent{
		terminateResult: DialogInfoResult{
			Accepted:    false,
			StatusCode:  503,
			Reason:      "Service Unavailable",
			ContentType: "message/sipfrag",
			Body:        []byte("SIP/2.0 503 Service Unavailable\r\n"),
			Headers:     map[string]string{"X-IMS": "bye-failed"},
		},
		terminateErr: errors.New("IMS BYE rejected"),
	}
	g.RegisterAgent("dev-1", agent)
	g.recordDialog(DialogInfo{DeviceID: "dev-1", CallID: "call-bye-failed", Callee: "18005551212", State: DialogStateEstablished})

	tx := &fakeServerTransaction{}
	g.HandleClientBye("dev-1", newByeRequest("call-bye-failed"), tx)

	if len(tx.responses) != 1 || tx.responses[0].StatusCode != 503 ||
		tx.responses[0].Reason != "Service Unavailable" ||
		tx.responses[0].GetHeader("Content-Type").Value() != "message/sipfrag" ||
		tx.responses[0].GetHeader("X-IMS").Value() != "bye-failed" ||
		string(tx.responses[0].Body()) != "SIP/2.0 503 Service Unavailable\r\n" {
		t.Fatalf("BYE failure responses=%+v", tx.responses)
	}
	if len(agent.terminated) != 1 {
		t.Fatalf("terminated=%+v", agent.terminated)
	}
	if status := g.DeviceStatus("dev-1"); status["active_dialogs"] != 1 {
		t.Fatalf("DeviceStatus=%+v, want dialog kept for retry", status)
	}
}

func TestGatewayHandleClientCancelCancelsEarlyDialog(t *testing.T) {
	g := NewGateway()
	agent := &fakeOutboundAgent{}
	g.RegisterAgent("dev-1", agent)
	g.recordDialog(DialogInfo{DeviceID: "dev-1", CallID: "call-cancel", Callee: "18005551212", State: DialogStateEarly})

	tx := &fakeServerTransaction{}
	cancelReq := newCancelRequest("call-cancel")
	cancelReq.AppendHeader(sip.NewHeader("Reason", "SIP;cause=487;text=\"client canceled\""))
	cancelReq.AppendHeader(sip.NewHeader("X-Client", "cancel"))
	cancelReq.AppendHeader(sip.NewHeader("Content-Type", "message/sipfrag"))
	cancelReq.SetBody([]byte("SIP/2.0 487 Request Terminated\r\n"))
	g.HandleClientCancel("dev-1", cancelReq, tx)

	if len(tx.responses) != 1 || tx.responses[0].StatusCode != 200 {
		t.Fatalf("CANCEL responses=%v", responseCodes(tx.responses))
	}
	if len(agent.canceled) != 1 || agent.canceled[0].CallID != "call-cancel" || agent.canceled[0].State != DialogStateTerminated {
		t.Fatalf("canceled=%+v", agent.canceled)
	}
	canceled := agent.canceled[0]
	if canceled.ContentType != "message/sipfrag" || string(canceled.Body) != "SIP/2.0 487 Request Terminated\r\n" ||
		canceled.Headers["Reason"] != "SIP;cause=487;text=\"client canceled\"" ||
		canceled.Headers["X-Client"] != "cancel" ||
		canceled.Headers["Content-Type"] != "" {
		t.Fatalf("canceled payload=%+v body=%q", canceled, canceled.Body)
	}
	if status := g.DeviceStatus("dev-1"); status["active_dialogs"] != 0 {
		t.Fatalf("DeviceStatus=%+v, want no active dialog", status)
	}
}

func TestGatewayHandleClientCancelPropagatesIMSResponse(t *testing.T) {
	g := NewGateway()
	agent := &fakeOutboundAgent{
		cancelResult: DialogInfoResult{
			Accepted:    false,
			StatusCode:  481,
			Reason:      "Call/Transaction Does Not Exist",
			ContentType: "message/sipfrag",
			Body:        []byte("SIP/2.0 481 Call/Transaction Does Not Exist\r\n"),
			Headers:     map[string]string{"Content-Type": "ignored", "X-IMS": "cancel-miss"},
		},
		cancelErr: errors.New("IMS CANCEL rejected"),
	}
	g.RegisterAgent("dev-1", agent)
	g.recordDialog(DialogInfo{DeviceID: "dev-1", CallID: "call-cancel-miss", Callee: "18005551212", State: DialogStateEarly})

	tx := &fakeServerTransaction{}
	g.HandleClientCancel("dev-1", newCancelRequest("call-cancel-miss"), tx)

	if len(tx.responses) != 1 || tx.responses[0].StatusCode != 481 ||
		tx.responses[0].Reason != "Call/Transaction Does Not Exist" ||
		tx.responses[0].GetHeader("Content-Type").Value() != "message/sipfrag" ||
		tx.responses[0].GetHeader("X-IMS").Value() != "cancel-miss" ||
		string(tx.responses[0].Body()) != "SIP/2.0 481 Call/Transaction Does Not Exist\r\n" {
		t.Fatalf("CANCEL responses=%+v", tx.responses)
	}
	if len(agent.canceled) != 1 || agent.canceled[0].CallID != "call-cancel-miss" {
		t.Fatalf("canceled=%+v", agent.canceled)
	}
	if status := g.DeviceStatus("dev-1"); status["active_dialogs"] != 0 {
		t.Fatalf("DeviceStatus=%+v, want 481 to terminate local dialog", status)
	}
}

func TestGatewayHandleClientInfoSendsDialogInfo(t *testing.T) {
	g := NewGateway()
	agent := &fakeOutboundAgent{infoResult: DialogInfoResult{
		Accepted:    true,
		StatusCode:  202,
		Reason:      "Accepted",
		ContentType: "application/dtmf-relay",
		Body:        []byte("ok"),
		Headers:     map[string]string{"X-IMS": "info-ok"},
	}}
	g.RegisterAgent("dev-1", agent)
	tx := &fakeServerTransaction{}
	req := newInfoRequest("call-info", "application/dtmf-relay", "Signal=2\r\nDuration=100\r\n")
	req.AppendHeader(sip.NewHeader("Info-Package", "dtmf"))
	req.AppendHeader(sip.NewHeader("X-Client", "info"))

	g.HandleClientInfo("dev-1", req, tx)

	if len(agent.infos) != 1 {
		t.Fatalf("infos=%d", len(agent.infos))
	}
	got := agent.infos[0]
	if got.DeviceID != "dev-1" || got.CallID != "call-info" || got.ContentType != "application/dtmf-relay" ||
		got.InfoPackage != "dtmf" || got.Headers["X-Client"] != "info" || !strings.Contains(string(got.Body), "Signal=2") {
		t.Fatalf("DialogInfoRequest=%+v body=%q", got, got.Body)
	}
	if len(tx.responses) != 1 || tx.responses[0].StatusCode != 202 || tx.responses[0].Reason != "Accepted" ||
		string(tx.responses[0].Body()) != "ok" || tx.responses[0].GetHeader("X-IMS").Value() != "info-ok" {
		t.Fatalf("responses=%+v", tx.responses)
	}
}

func TestGatewayHandleClientInfoUsesAutoDTMFRoute(t *testing.T) {
	g := NewGateway()
	agent := &fakeAutoDTMFAgent{
		fakeOutboundAgent: &fakeOutboundAgent{infoResult: DialogInfoResult{Accepted: true, StatusCode: 202, Reason: "INFO Accepted"}},
		autoResult: DialogAutoDTMFResult{
			Accepted:   true,
			StatusCode: 200,
			Reason:     "OK",
			Route:      DialogDTMFRouteRTP,
			RTP:        DialogRTPDTMFResult{Accepted: true, StatusCode: 200, Reason: "OK"},
		},
	}
	g.RegisterAgent("dev-1", agent)
	tx := &fakeServerTransaction{}
	req := newInfoRequest("call-dtmf-auto", "application/dtmf-relay; charset=utf-8", "Signal=3\r\nDuration=120\r\n")
	req.AppendHeader(sip.NewHeader("Info-Package", "dtmf"))
	req.AppendHeader(sip.NewHeader("X-Client", "dtmf"))

	g.HandleClientInfo("dev-1", req, tx)

	if agent.autoCallCount != 1 || len(agent.autoDTMFs) != 1 {
		t.Fatalf("auto DTMF calls=%d requests=%+v", agent.autoCallCount, agent.autoDTMFs)
	}
	if len(agent.infos) != 0 {
		t.Fatalf("infos=%+v, want none when auto DTMF handles request", agent.infos)
	}
	got := agent.autoDTMFs[0]
	if got.DeviceID != "dev-1" || got.CallID != "call-dtmf-auto" ||
		got.Signal != "3" || got.DurationMS != 120 || got.Headers["X-Client"] != "dtmf" {
		t.Fatalf("auto DTMF request=%+v", got)
	}
	if len(tx.responses) != 1 || tx.responses[0].StatusCode != 200 ||
		tx.responses[0].Reason != "OK" || len(tx.responses[0].Body()) != 0 {
		t.Fatalf("responses=%+v", tx.responses)
	}
}

func TestGatewayHandleClientInfoAutoDTMFInfoFallbackResponse(t *testing.T) {
	g := NewGateway()
	agent := &fakeAutoDTMFAgent{
		fakeOutboundAgent: &fakeOutboundAgent{},
		autoResult: DialogAutoDTMFResult{
			Accepted:   true,
			StatusCode: 202,
			Reason:     "Accepted",
			Route:      DialogDTMFRouteInfo,
			INFO: DialogDTMFResult{
				Accepted:    true,
				StatusCode:  202,
				Reason:      "Accepted",
				ContentType: "application/dtmf-relay",
				Body:        []byte("Signal=4\r\nDuration=90\r\n"),
				Headers:     map[string]string{"X-IMS": "info-fallback"},
			},
		},
	}
	g.RegisterAgent("dev-1", agent)
	tx := &fakeServerTransaction{}
	req := newInfoRequest("call-dtmf-info", "application/dtmf-relay", "Signal=4\r\nDuration=90\r\n")

	g.HandleClientInfo("dev-1", req, tx)

	if len(agent.autoDTMFs) != 1 || len(agent.infos) != 0 {
		t.Fatalf("autoDTMFs=%+v infos=%+v", agent.autoDTMFs, agent.infos)
	}
	if len(tx.responses) != 1 || tx.responses[0].StatusCode != 202 ||
		tx.responses[0].GetHeader("Content-Type").Value() != "application/dtmf-relay" ||
		tx.responses[0].GetHeader("X-IMS").Value() != "info-fallback" ||
		!strings.Contains(string(tx.responses[0].Body()), "Signal=4") {
		t.Fatalf("responses=%+v", tx.responses)
	}
}

func TestGatewayHandleClientInfoRejectsInvalidAutoDTMFBody(t *testing.T) {
	g := NewGateway()
	agent := &fakeAutoDTMFAgent{fakeOutboundAgent: &fakeOutboundAgent{}}
	g.RegisterAgent("dev-1", agent)
	tx := &fakeServerTransaction{}
	req := newInfoRequest("call-dtmf-invalid", "application/dtmf-relay", "Signal=12\r\nDuration=100\r\n")

	g.HandleClientInfo("dev-1", req, tx)

	if len(agent.autoDTMFs) != 0 || len(agent.infos) != 0 {
		t.Fatalf("autoDTMFs=%+v infos=%+v, want no backend send", agent.autoDTMFs, agent.infos)
	}
	if len(tx.responses) != 1 || tx.responses[0].StatusCode != 400 || tx.responses[0].Reason != "Invalid DTMF relay" {
		t.Fatalf("responses=%+v", tx.responses)
	}
}

func TestGatewayHandleClientMessageSendsDialogMessage(t *testing.T) {
	g := NewGateway()
	agent := &fakeOutboundAgent{messageResult: DialogMessageResult{
		Accepted:    true,
		StatusCode:  200,
		Reason:      "OK",
		ContentType: "text/plain",
		Body:        []byte("ack"),
		Headers:     map[string]string{"X-IMS": "message-ok"},
	}}
	g.RegisterAgent("dev-1", agent)
	tx := &fakeServerTransaction{}
	req := newMessageRequest("call-message", "text/plain", "hello")
	req.AppendHeader(sip.NewHeader("X-Client", "message"))

	g.HandleClientMessage("dev-1", req, tx)

	if len(agent.messages) != 1 {
		t.Fatalf("messages=%d", len(agent.messages))
	}
	got := agent.messages[0]
	if got.DeviceID != "dev-1" || got.CallID != "call-message" ||
		got.ContentType != "text/plain" || got.Headers["X-Client"] != "message" ||
		string(got.Body) != "hello" {
		t.Fatalf("DialogMessageRequest=%+v body=%q", got, got.Body)
	}
	if len(tx.responses) != 1 || tx.responses[0].StatusCode != 200 ||
		tx.responses[0].GetHeader("Content-Type").Value() != "text/plain" ||
		tx.responses[0].GetHeader("X-IMS").Value() != "message-ok" ||
		string(tx.responses[0].Body()) != "ack" {
		t.Fatalf("responses=%+v", tx.responses)
	}
}

func TestGatewayHandleClientPrackSendsDialogPrack(t *testing.T) {
	g := NewGateway()
	agent := &fakeOutboundAgent{prackResult: DialogPrackResult{
		Accepted:    true,
		StatusCode:  200,
		Reason:      "OK",
		ContentType: "application/sdp",
		Body:        []byte(sampleSDP("203.0.113.45", 49182)),
		Headers:     map[string]string{"X-IMS": "prack-ok"},
	}}
	g.RegisterAgent("dev-1", agent)
	tx := &fakeServerTransaction{}
	req := newPrackRequest("call-prack", "1 1 INVITE", sampleSDP("198.51.100.30", 4012))
	req.AppendHeader(sip.NewHeader("X-Client", "prack"))

	g.HandleClientPrack("dev-1", req, tx)

	if len(agent.pracks) != 1 {
		t.Fatalf("pracks=%d", len(agent.pracks))
	}
	got := agent.pracks[0]
	if got.DeviceID != "dev-1" || got.CallID != "call-prack" || got.RAck != "1 1 INVITE" ||
		got.ContentType != "application/sdp" || got.Headers["X-Client"] != "prack" ||
		got.Headers["RAck"] != "" || !strings.Contains(string(got.Body), "m=audio 4012") {
		t.Fatalf("DialogPrackRequest=%+v body=%q", got, got.Body)
	}
	if len(tx.responses) != 1 || tx.responses[0].StatusCode != 200 ||
		tx.responses[0].GetHeader("Content-Type").Value() != "application/sdp" ||
		tx.responses[0].GetHeader("X-IMS").Value() != "prack-ok" ||
		!strings.Contains(string(tx.responses[0].Body()), "m=audio 49182") {
		t.Fatalf("responses=%+v", tx.responses)
	}
}

func TestGatewayHandleClientPrackRequiresRAck(t *testing.T) {
	g := NewGateway()
	g.RegisterAgent("dev-1", &fakeOutboundAgent{})
	tx := &fakeServerTransaction{}
	req := newPrackRequest("call-prack", "", "")

	g.HandleClientPrack("dev-1", req, tx)

	if len(tx.responses) != 1 || tx.responses[0].StatusCode != 400 {
		t.Fatalf("PRACK responses=%v", responseCodes(tx.responses))
	}
}

func TestGatewayHandleClientOptionsSendsDialogOptions(t *testing.T) {
	g := NewGateway()
	agent := &fakeOutboundAgent{optionsResult: DialogOptionsResult{
		Accepted:    true,
		StatusCode:  200,
		Reason:      "OK",
		ContentType: "application/sdp",
		Body:        []byte(sampleSDP("203.0.113.46", 49184)),
		Headers:     map[string]string{"Allow": "INVITE, UPDATE, INFO", "X-IMS": "options-ok"},
	}}
	g.RegisterAgent("dev-1", agent)
	tx := &fakeServerTransaction{}
	req := newOptionsRequest("call-options")
	req.AppendHeader(sip.NewHeader("Accept", "application/sdp"))
	req.AppendHeader(sip.NewHeader("X-Client", "options"))

	g.HandleClientOptions("dev-1", req, tx)

	if len(agent.options) != 1 {
		t.Fatalf("options=%d", len(agent.options))
	}
	got := agent.options[0]
	if got.DeviceID != "dev-1" || got.CallID != "call-options" ||
		got.Headers["Accept"] != "application/sdp" || got.Headers["X-Client"] != "options" {
		t.Fatalf("DialogOptionsRequest=%+v", got)
	}
	if len(tx.responses) != 1 || tx.responses[0].StatusCode != 200 ||
		tx.responses[0].GetHeader("Content-Type").Value() != "application/sdp" ||
		tx.responses[0].GetHeader("Allow").Value() != "INVITE, UPDATE, INFO" ||
		tx.responses[0].GetHeader("X-IMS").Value() != "options-ok" ||
		!strings.Contains(string(tx.responses[0].Body()), "m=audio 49184") {
		t.Fatalf("responses=%+v", tx.responses)
	}
}

func TestGatewayHandleClientReferSendsDialogRefer(t *testing.T) {
	g := NewGateway()
	agent := &fakeOutboundAgent{referResult: DialogReferResult{
		Accepted:   true,
		StatusCode: 202,
		Reason:     "Accepted",
		Headers:    map[string]string{"Refer-Sub": "false", "X-IMS": "refer-ok"},
	}}
	g.RegisterAgent("dev-1", agent)
	tx := &fakeServerTransaction{}
	req := newReferRequest("call-refer", "<sip:+18005551313@ims.example>", "<sip:user@example>")
	req.AppendHeader(sip.NewHeader("X-Client", "refer"))
	req.AppendHeader(sip.NewHeader("Refer-Sub", "true"))

	g.HandleClientRefer("dev-1", req, tx)

	if len(agent.refers) != 1 {
		t.Fatalf("refers=%d", len(agent.refers))
	}
	got := agent.refers[0]
	if got.DeviceID != "dev-1" || got.CallID != "call-refer" ||
		got.ReferTo != "<sip:+18005551313@ims.example>" || got.ReferredBy != "<sip:user@example>" ||
		got.ReferSub != "true" || got.Headers["X-Client"] != "refer" ||
		got.Headers["Refer-To"] != "" || got.Headers["Referred-By"] != "" || got.Headers["Refer-Sub"] != "" {
		t.Fatalf("DialogReferRequest=%+v", got)
	}
	if len(tx.responses) != 1 || tx.responses[0].StatusCode != 202 ||
		tx.responses[0].GetHeader("Refer-Sub").Value() != "false" ||
		tx.responses[0].GetHeader("X-IMS").Value() != "refer-ok" {
		t.Fatalf("responses=%+v", tx.responses)
	}
}

func TestGatewayHandleClientReferRequiresReferTo(t *testing.T) {
	g := NewGateway()
	g.RegisterAgent("dev-1", &fakeOutboundAgent{})
	tx := &fakeServerTransaction{}
	req := newReferRequest("call-refer", "", "")

	g.HandleClientRefer("dev-1", req, tx)

	if len(tx.responses) != 1 || tx.responses[0].StatusCode != 400 {
		t.Fatalf("REFER responses=%v", responseCodes(tx.responses))
	}
}

func TestGatewayHandleClientNotifySendsDialogNotify(t *testing.T) {
	g := NewGateway()
	agent := &fakeOutboundAgent{notifyResult: DialogNotifyResult{
		Accepted:    true,
		StatusCode:  200,
		Reason:      "OK",
		ContentType: "message/sipfrag",
		Body:        []byte("SIP/2.0 200 OK\r\n"),
		Headers:     map[string]string{"X-IMS": "notify-ok"},
	}}
	g.RegisterAgent("dev-1", agent)
	tx := &fakeServerTransaction{}
	req := newNotifyRequest("call-notify", "refer", "terminated;reason=noresource", "message/sipfrag", "SIP/2.0 200 OK\r\n")
	req.AppendHeader(sip.NewHeader("X-Client", "notify"))

	g.HandleClientNotify("dev-1", req, tx)

	if len(agent.notifies) != 1 {
		t.Fatalf("notifies=%d", len(agent.notifies))
	}
	got := agent.notifies[0]
	if got.DeviceID != "dev-1" || got.CallID != "call-notify" ||
		got.Event != "refer" || got.SubscriptionState != "terminated;reason=noresource" ||
		got.ContentType != "message/sipfrag" || got.Headers["X-Client"] != "notify" ||
		got.Headers["Event"] != "" || got.Headers["Subscription-State"] != "" ||
		string(got.Body) != "SIP/2.0 200 OK\r\n" {
		t.Fatalf("DialogNotifyRequest=%+v body=%q", got, got.Body)
	}
	if len(tx.responses) != 1 || tx.responses[0].StatusCode != 200 ||
		tx.responses[0].GetHeader("Content-Type").Value() != "message/sipfrag" ||
		tx.responses[0].GetHeader("X-IMS").Value() != "notify-ok" ||
		string(tx.responses[0].Body()) != "SIP/2.0 200 OK\r\n" {
		t.Fatalf("responses=%+v", tx.responses)
	}
}

func TestGatewayHandleClientNotifyRequiresEventAndSubscriptionState(t *testing.T) {
	g := NewGateway()
	g.RegisterAgent("dev-1", &fakeOutboundAgent{})

	missingEvent := &fakeServerTransaction{}
	g.HandleClientNotify("dev-1", newNotifyRequest("call-notify", "", "terminated", "", ""), missingEvent)
	if len(missingEvent.responses) != 1 || missingEvent.responses[0].StatusCode != 400 {
		t.Fatalf("NOTIFY missing Event responses=%v", responseCodes(missingEvent.responses))
	}

	missingState := &fakeServerTransaction{}
	g.HandleClientNotify("dev-1", newNotifyRequest("call-notify", "refer", "", "", ""), missingState)
	if len(missingState.responses) != 1 || missingState.responses[0].StatusCode != 400 {
		t.Fatalf("NOTIFY missing Subscription-State responses=%v", responseCodes(missingState.responses))
	}
}

func TestGatewayHandleClientSubscribeSendsDialogSubscribe(t *testing.T) {
	g := NewGateway()
	agent := &fakeOutboundAgent{subscribeResult: DialogSubscribeResult{
		Accepted:   true,
		StatusCode: 202,
		Reason:     "Accepted",
		Headers:    map[string]string{"Expires": "300", "X-IMS": "subscribe-ok"},
	}}
	g.RegisterAgent("dev-1", agent)
	tx := &fakeServerTransaction{}
	req := newSubscribeRequest("call-subscribe", "refer", "300", "application/resource-lists+xml", "<resource-lists/>")
	req.AppendHeader(sip.NewHeader("X-Client", "subscribe"))

	g.HandleClientSubscribe("dev-1", req, tx)

	if len(agent.subscribes) != 1 {
		t.Fatalf("subscribes=%d", len(agent.subscribes))
	}
	got := agent.subscribes[0]
	if got.DeviceID != "dev-1" || got.CallID != "call-subscribe" ||
		got.Event != "refer" || got.Expires != "300" ||
		got.ContentType != "application/resource-lists+xml" ||
		got.Headers["X-Client"] != "subscribe" ||
		got.Headers["Event"] != "" || got.Headers["Expires"] != "" ||
		string(got.Body) != "<resource-lists/>" {
		t.Fatalf("DialogSubscribeRequest=%+v body=%q", got, got.Body)
	}
	if len(tx.responses) != 1 || tx.responses[0].StatusCode != 202 ||
		tx.responses[0].GetHeader("Expires").Value() != "300" ||
		tx.responses[0].GetHeader("X-IMS").Value() != "subscribe-ok" {
		t.Fatalf("responses=%+v", tx.responses)
	}
}

func TestGatewayHandleClientSubscribeRequiresEvent(t *testing.T) {
	g := NewGateway()
	g.RegisterAgent("dev-1", &fakeOutboundAgent{})
	tx := &fakeServerTransaction{}

	g.HandleClientSubscribe("dev-1", newSubscribeRequest("call-subscribe", "", "", "", ""), tx)

	if len(tx.responses) != 1 || tx.responses[0].StatusCode != 400 {
		t.Fatalf("SUBSCRIBE responses=%v", responseCodes(tx.responses))
	}
}

func TestGatewayHandleClientUpdateSendsDialogUpdate(t *testing.T) {
	g := NewGateway()
	agent := &fakeOutboundAgent{updateResult: DialogUpdateResult{
		Accepted:    true,
		StatusCode:  200,
		Reason:      "OK",
		ContentType: "application/sdp",
		Body:        []byte(sampleSDP("203.0.113.44", 49180)),
		Headers:     map[string]string{"X-IMS": "update-ok"},
	}}
	g.RegisterAgent("dev-1", agent)
	tx := &fakeServerTransaction{}
	req := newUpdateRequest("call-update", sampleSDP("198.51.100.20", 4010))
	req.AppendHeader(sip.NewHeader("Session-Expires", "1800"))

	g.HandleClientUpdate("dev-1", req, tx)

	if len(agent.updates) != 1 {
		t.Fatalf("updates=%d", len(agent.updates))
	}
	got := agent.updates[0]
	if got.DeviceID != "dev-1" || got.CallID != "call-update" || got.ContentType != "application/sdp" ||
		got.Headers["Session-Expires"] != "1800" || !strings.Contains(string(got.Body), "m=audio 4010") {
		t.Fatalf("DialogUpdateRequest=%+v body=%q", got, got.Body)
	}
	if len(tx.responses) != 1 || tx.responses[0].StatusCode != 200 ||
		tx.responses[0].GetHeader("Content-Type").Value() != "application/sdp" ||
		tx.responses[0].GetHeader("X-IMS").Value() != "update-ok" ||
		!strings.Contains(string(tx.responses[0].Body()), "m=audio 49180") {
		t.Fatalf("responses=%+v", tx.responses)
	}
}

func TestParseAndBuildSDP(t *testing.T) {
	info, err := ParseSDP([]byte(sampleSDP("203.0.113.8", 49170) + "a=rtcp:49171 IN IP4 203.0.113.8\r\n"))
	if err != nil {
		t.Fatalf("ParseSDP() error = %v", err)
	}
	if info.ConnectionIP != "203.0.113.8" || info.MediaPort != 49170 || info.RTCPIP != "203.0.113.8" || info.RTCPPort != 49171 || info.Direction != "sendrecv" {
		t.Fatalf("info=%+v", info)
	}
	if len(info.Payloads) != 3 || info.Payloads[0] != 0 || info.Payloads[2] != 101 {
		t.Fatalf("payloads=%+v", info.Payloads)
	}
	if info.TelephoneEventPayloads[101] != 8000 {
		t.Fatalf("telephone-event payloads=%+v", info.TelephoneEventPayloads)
	}
	answer := string(BuildSDPAnswer(SDPInfo{ConnectionIP: "192.0.2.2", MediaPort: 6000, RTCPPort: 6001, Payloads: []int{8}, Direction: "recvonly"}))
	if !strings.Contains(answer, "m=audio 6000 RTP/AVP 8") || !strings.Contains(answer, "a=rtcp:6001 IN IP4 192.0.2.2") || !strings.Contains(answer, "a=recvonly") {
		t.Fatalf("answer=%q", answer)
	}
}

func TestParseAndBuildSDPDynamicTelephoneEventPayload(t *testing.T) {
	info, err := ParseSDP([]byte("v=0\r\nc=IN IP4 203.0.113.8\r\nm=audio 49170 RTP/AVP 96 110\r\na=rtpmap:96 AMR/8000\r\na=rtpmap:110 telephone-event/16000\r\na=fmtp:110 0-16\r\n"))
	if err != nil {
		t.Fatalf("ParseSDP() error = %v", err)
	}
	if info.TelephoneEventPayloads[110] != 16000 {
		t.Fatalf("telephone-event payloads=%+v", info.TelephoneEventPayloads)
	}
	answer := string(BuildSDPAnswer(SDPInfo{
		ConnectionIP:           "192.0.2.2",
		MediaPort:              6000,
		Payloads:               []int{96, 110},
		TelephoneEventPayloads: map[uint8]int{110: 16000},
		Direction:              "sendrecv",
	}))
	if !strings.Contains(answer, "m=audio 6000 RTP/AVP 96 110") || !strings.Contains(answer, "a=rtpmap:110 telephone-event/16000\r\n") || !strings.Contains(answer, "a=fmtp:110 0-16\r\n") {
		t.Fatalf("answer=%q", answer)
	}
}

func TestParseSDPUnspecifiedConnectionMeansInactive(t *testing.T) {
	info, err := ParseSDP([]byte("v=0\r\nc=IN IP4 0.0.0.0\r\nm=audio 4002 RTP/AVP 0\r\n"))
	if err != nil {
		t.Fatalf("ParseSDP() error = %v", err)
	}
	if info.ConnectionIP != "0.0.0.0" || info.Direction != "inactive" {
		t.Fatalf("info=%+v", info)
	}
}

func TestParseAndBuildSDPDisabledAudioPort(t *testing.T) {
	info, err := ParseSDP([]byte("v=0\r\nc=IN IP4 192.0.2.10\r\nm=audio 0 RTP/AVP 0 101\r\n"))
	if err != nil {
		t.Fatalf("ParseSDP() error = %v", err)
	}
	if info.ConnectionIP != "192.0.2.10" || info.MediaPort != 0 || info.Direction != "inactive" {
		t.Fatalf("info=%+v", info)
	}
	answer := string(BuildSDPAnswer(SDPInfo{ConnectionIP: "192.0.2.10", MediaPort: 0, Payloads: []int{0}, Direction: "inactive"}))
	if !strings.Contains(answer, "m=audio 0 RTP/AVP 0") || !strings.Contains(answer, "a=inactive") {
		t.Fatalf("answer=%q", answer)
	}
}

func newInviteRequest(callID, callee, sdp string) *sip.Request {
	req := sip.NewRequest(sip.INVITE, sip.Uri{Scheme: "sip", User: callee, Host: "ims.example"})
	appendCommonHeaders(req, callID, callee)
	req.SetBody([]byte(sdp))
	req.AppendHeader(sip.NewHeader("Content-Type", "application/sdp"))
	return req
}

func newByeRequest(callID string) *sip.Request {
	req := sip.NewRequest(sip.BYE, sip.Uri{Scheme: "sip", User: "18005551212", Host: "ims.example"})
	appendCommonHeaders(req, callID, "18005551212")
	return req
}

func newCancelRequest(callID string) *sip.Request {
	req := sip.NewRequest(sip.CANCEL, sip.Uri{Scheme: "sip", User: "18005551212", Host: "ims.example"})
	appendCommonHeaders(req, callID, "18005551212")
	return req
}

func newInfoRequest(callID, contentType, body string) *sip.Request {
	req := sip.NewRequest(sip.INFO, sip.Uri{Scheme: "sip", User: "18005551212", Host: "ims.example"})
	appendCommonHeaders(req, callID, "18005551212")
	req.SetBody([]byte(body))
	if strings.TrimSpace(contentType) != "" {
		req.AppendHeader(sip.NewHeader("Content-Type", contentType))
	}
	return req
}

func newMessageRequest(callID, contentType, body string) *sip.Request {
	req := sip.NewRequest(sip.MESSAGE, sip.Uri{Scheme: "sip", User: "18005551212", Host: "ims.example"})
	appendCommonHeaders(req, callID, "18005551212")
	if strings.TrimSpace(body) != "" {
		req.SetBody([]byte(body))
	}
	if strings.TrimSpace(contentType) != "" {
		req.AppendHeader(sip.NewHeader("Content-Type", contentType))
	}
	return req
}

func newUpdateRequest(callID, sdp string) *sip.Request {
	req := sip.NewRequest(sip.UPDATE, sip.Uri{Scheme: "sip", User: "18005551212", Host: "ims.example"})
	appendCommonHeaders(req, callID, "18005551212")
	if strings.TrimSpace(sdp) != "" {
		req.SetBody([]byte(sdp))
		req.AppendHeader(sip.NewHeader("Content-Type", "application/sdp"))
	}
	return req
}

func newPrackRequest(callID, rack, sdp string) *sip.Request {
	req := sip.NewRequest(sip.PRACK, sip.Uri{Scheme: "sip", User: "18005551212", Host: "ims.example"})
	appendCommonHeaders(req, callID, "18005551212")
	if strings.TrimSpace(rack) != "" {
		req.AppendHeader(sip.NewHeader("RAck", rack))
	}
	if strings.TrimSpace(sdp) != "" {
		req.SetBody([]byte(sdp))
		req.AppendHeader(sip.NewHeader("Content-Type", "application/sdp"))
	}
	return req
}

func newOptionsRequest(callID string) *sip.Request {
	req := sip.NewRequest(sip.OPTIONS, sip.Uri{Scheme: "sip", User: "18005551212", Host: "ims.example"})
	appendCommonHeaders(req, callID, "18005551212")
	return req
}

func newReferRequest(callID, referTo, referredBy string) *sip.Request {
	req := sip.NewRequest(sip.REFER, sip.Uri{Scheme: "sip", User: "18005551212", Host: "ims.example"})
	appendCommonHeaders(req, callID, "18005551212")
	if strings.TrimSpace(referTo) != "" {
		req.AppendHeader(sip.NewHeader("Refer-To", referTo))
	}
	if strings.TrimSpace(referredBy) != "" {
		req.AppendHeader(sip.NewHeader("Referred-By", referredBy))
	}
	return req
}

func newNotifyRequest(callID, event, subscriptionState, contentType, body string) *sip.Request {
	req := sip.NewRequest(sip.NOTIFY, sip.Uri{Scheme: "sip", User: "18005551212", Host: "ims.example"})
	appendCommonHeaders(req, callID, "18005551212")
	if strings.TrimSpace(event) != "" {
		req.AppendHeader(sip.NewHeader("Event", event))
	}
	if strings.TrimSpace(subscriptionState) != "" {
		req.AppendHeader(sip.NewHeader("Subscription-State", subscriptionState))
	}
	if strings.TrimSpace(body) != "" {
		req.SetBody([]byte(body))
	}
	if strings.TrimSpace(contentType) != "" {
		req.AppendHeader(sip.NewHeader("Content-Type", contentType))
	}
	return req
}

func newSubscribeRequest(callID, event, expires, contentType, body string) *sip.Request {
	req := sip.NewRequest(sip.SUBSCRIBE, sip.Uri{Scheme: "sip", User: "18005551212", Host: "ims.example"})
	appendCommonHeaders(req, callID, "18005551212")
	if strings.TrimSpace(event) != "" {
		req.AppendHeader(sip.NewHeader("Event", event))
	}
	if strings.TrimSpace(expires) != "" {
		req.AppendHeader(sip.NewHeader("Expires", expires))
	}
	if strings.TrimSpace(body) != "" {
		req.SetBody([]byte(body))
	}
	if strings.TrimSpace(contentType) != "" {
		req.AppendHeader(sip.NewHeader("Content-Type", contentType))
	}
	return req
}

func appendCommonHeaders(req *sip.Request, callID, user string) {
	req.AppendHeader(sip.NewHeader("Via", "SIP/2.0/UDP 127.0.0.1:5060;branch=z9hG4bK-test"))
	req.AppendHeader(sip.NewHeader("From", "<sip:user@example>;tag=fromtag"))
	req.AppendHeader(sip.NewHeader("To", "<sip:"+user+"@ims.example>"))
	req.AppendHeader(sip.NewHeader("Call-ID", callID))
	req.AppendHeader(sip.NewHeader("CSeq", "1 "+string(req.Method)))
	req.AppendHeader(sip.NewHeader("Max-Forwards", "70"))
}

func sampleSDP(ip string, port int) string {
	return "v=0\r\n" +
		"o=user 0 0 IN IP4 " + ip + "\r\n" +
		"s=-\r\n" +
		"c=IN IP4 " + ip + "\r\n" +
		"t=0 0\r\n" +
		"m=audio " + strconv.Itoa(port) + " RTP/AVP 0 8 101\r\n" +
		"a=sendrecv\r\n"
}

func responseCodes(responses []*sip.Response) []int {
	out := make([]int, len(responses))
	for i, res := range responses {
		out[i] = res.StatusCode
	}
	return out
}
