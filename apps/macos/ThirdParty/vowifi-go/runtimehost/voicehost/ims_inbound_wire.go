package voicehost

import (
	"bufio"
	"context"
	"errors"
	"net"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/boa-z/vowifi-go/runtimehost/voiceclient"
)

type IMSInboundWireServer struct {
	Agent           *IMSInboundAgent
	MessageHandler  IMSMessageHandler
	InfoHandler     IMSInfoHandler
	ByeHandler      IMSByeHandler
	ContactURI      string
	LocalTag        string
	UserAgent       string
	ResponseHeaders map[string]string
	ReadTimeout     time.Duration
	TransactionTTL  time.Duration
	InviteFinalT1   time.Duration
	InviteFinalT2   time.Duration
	Reliable1xxT1   time.Duration
	Reliable1xxT2   time.Duration

	mu                    sync.Mutex
	transactions          map[string]imsInboundWireTransaction
	inviteRetransmits     map[string]imsInboundResponseRetransmit
	inviteFinalAcks       map[string]time.Time
	reliable1xxPending    map[string]time.Time
	reliable1xxRetransmit map[string]imsInboundResponseRetransmit
	reliable1xxAcks       map[string]time.Time
}

type IMSInboundWireResponse struct {
	StatusCode int
	Reason     string
	Headers    map[string]string
	Body       []byte
	NoResponse bool
}

// IMSInboundRequireOptionClassification partitions inbound Require option-tags by local support.
type IMSInboundRequireOptionClassification struct {
	Required    []string
	Supported   []string
	Unsupported []string
}

// IMSInboundWireTransactionSnapshot describes the cached server transaction
// state for an inbound SIP request without exposing cached response bodies.
type IMSInboundWireTransactionSnapshot struct {
	Method       string
	Invite       bool
	State        voiceclient.SIPServerTransactionState
	StatusCodes  []int
	Provisional  bool
	Final        bool
	Pending      bool
	CleanupAfter time.Duration
	TimeoutAfter time.Duration
	ExpiresAt    time.Time
}

// UnsupportedHeader renders unsupported option-tags for a SIP Unsupported response header.
func (c IMSInboundRequireOptionClassification) UnsupportedHeader() string {
	return strings.Join(c.Unsupported, ", ")
}

type imsInboundWireTransaction struct {
	method       string
	invite       bool
	state        voiceclient.SIPServerTransactionState
	responses    []IMSInboundWireResponse
	expires      time.Time
	cleanupAfter time.Duration
	timeoutAfter time.Duration
}

type imsInboundResponseRetransmit struct {
	cancel context.CancelFunc
	done   chan struct{}
}

type imsInboundWireResponseEmitter func(IMSInboundWireResponse) error

func (s *IMSInboundWireServer) ServePacket(ctx context.Context, pc net.PacketConn) error {
	if ctx == nil {
		ctx = context.Background()
	}
	if pc == nil {
		return ErrIMSInboundAgentNotReady
	}
	buf := make([]byte, 65535)
	for {
		if err := pc.SetReadDeadline(time.Now().Add(s.readTimeout())); err != nil {
			return err
		}
		n, addr, err := pc.ReadFrom(buf)
		if err != nil {
			if ctx.Err() != nil {
				return nil
			}
			if isTimeout(err) {
				continue
			}
			return err
		}
		raw := append([]byte(nil), buf[:n]...)
		go s.handlePacket(ctx, pc, addr, raw)
	}
}

func (s *IMSInboundWireServer) ServeListener(ctx context.Context, ln net.Listener) error {
	if ctx == nil {
		ctx = context.Background()
	}
	if ln == nil {
		return ErrIMSInboundAgentNotReady
	}
	for {
		if deadline, ok := ln.(interface{ SetDeadline(time.Time) error }); ok {
			if err := deadline.SetDeadline(time.Now().Add(s.readTimeout())); err != nil {
				return err
			}
		}
		conn, err := ln.Accept()
		if err != nil {
			if ctx.Err() != nil {
				return nil
			}
			if isTimeout(err) {
				continue
			}
			return err
		}
		go s.handleConn(ctx, conn)
	}
}

func (s *IMSInboundWireServer) HandleRequest(ctx context.Context, req voiceclient.SIPIncomingRequest) ([]IMSInboundWireResponse, error) {
	return s.handleRequest(ctx, req, nil)
}

func (s *IMSInboundWireServer) handleRequest(ctx context.Context, req voiceclient.SIPIncomingRequest, emit imsInboundWireResponseEmitter) ([]IMSInboundWireResponse, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	method := strings.ToUpper(strings.TrimSpace(req.Method))
	if method != "ACK" {
		if !wireValidRequestCSeq(req) {
			return []IMSInboundWireResponse{s.withResponseHeaders(wireResponse(400, "Bad CSeq"))}, nil
		}
		if !wireHasRequiredRequestHeaders(req) {
			return []IMSInboundWireResponse{s.withResponseHeaders(wireResponse(400, "Bad Request"))}, nil
		}
		if code, reason, reject := wireMaxForwardsRejection(req); reject {
			return []IMSInboundWireResponse{s.withResponseHeaders(wireResponse(code, reason))}, nil
		}
		if unsupported := wireUnsupportedRequiredOptions(req); len(unsupported) > 0 {
			resp := wireResponse(420, "Bad Extension")
			resp.Headers["Unsupported"] = strings.Join(unsupported, ", ")
			return []IMSInboundWireResponse{s.withResponseHeaders(resp)}, nil
		}
	}
	key := wireTransactionKey(req)
	if method != "ACK" && key != "" {
		if responses, ok := s.cachedTransaction(key); ok {
			return responses, nil
		}
	}
	var responses []IMSInboundWireResponse
	var err error
	switch method {
	case "INVITE":
		responses, err = s.handleInvite(ctx, req, key, emit)
	case "ACK":
		s.stopInviteFinalRetransmission(req)
		if s == nil || s.Agent == nil {
			return nil, ErrIMSInboundAgentNotReady
		}
		return nil, s.Agent.AckInboundCall(ctx, DialogInfo{CallID: wireCallID(req)})
	case "UPDATE":
		responses, err = s.handleUpdate(ctx, req)
	case "PRACK":
		if !wireValidRAckHeader(firstVoiceHeader(req.Headers, "RAck")) {
			responses = []IMSInboundWireResponse{s.withResponseHeaders(wireResponse(400, "Bad RAck"))}
			break
		}
		if !s.hasPendingReliableProvisionalForPrack(req) {
			responses = []IMSInboundWireResponse{s.withResponseHeaders(wireResponse(481, "Call/Transaction Does Not Exist"))}
			break
		}
		s.stopReliableProvisionalRetransmission(req)
		responses, err = s.handlePrack(ctx, req)
	case "INFO":
		responses, err = s.handleInfo(ctx, req)
	case "MESSAGE":
		responses, err = s.handleMessage(ctx, req)
	case "REFER":
		responses, err = s.handleRefer(ctx, req)
	case "NOTIFY":
		responses, err = s.handleNotify(ctx, req)
	case "SUBSCRIBE":
		responses, err = s.handleSubscribe(ctx, req)
	case "OPTIONS":
		responses = []IMSInboundWireResponse{s.withResponseHeaders(s.optionsResponse())}
	case "BYE":
		if handledResponses, handledErr, handled := s.tryHandleBye(ctx, req); handled {
			responses, err = handledResponses, handledErr
			break
		}
		if s == nil || s.Agent == nil {
			responses, err = []IMSInboundWireResponse{s.withResponseHeaders(wireResponse(503, "Service Unavailable"))}, ErrIMSInboundAgentNotReady
			break
		}
		result, callErr := s.Agent.EndInboundCallWithResult(ctx, DialogInfo{
			CallID:      wireCallID(req),
			CSeq:        wireCSeq(req),
			ContentType: firstVoiceHeader(req.Headers, "Content-Type"),
			Body:        append([]byte(nil), req.Body...),
			Headers:     firstValueSIPHeaders(req.Headers),
		})
		responses, err = s.dialogInfoResultResponse(result, callErr), callErr
	case "CANCEL":
		if s == nil || s.Agent == nil {
			responses, err = []IMSInboundWireResponse{s.withResponseHeaders(wireResponse(503, "Service Unavailable"))}, ErrIMSInboundAgentNotReady
			break
		}
		if !s.hasPendingInviteTransactionForCancel(req) {
			responses = []IMSInboundWireResponse{s.withResponseHeaders(wireResponse(481, "Call/Transaction Does Not Exist"))}
			break
		}
		result, callErr := s.Agent.CancelInboundCallWithResult(ctx, DialogInfo{
			CallID:      wireCallID(req),
			ContentType: firstVoiceHeader(req.Headers, "Content-Type"),
			Body:        append([]byte(nil), req.Body...),
			Headers:     firstValueSIPHeaders(req.Headers),
		})
		responses, err = s.dialogInfoResultResponse(result, callErr), callErr
	default:
		resp := wireResponse(405, "Method Not Allowed")
		resp.Headers["Allow"] = s.allowHeader()
		responses = []IMSInboundWireResponse{s.withResponseHeaders(resp)}
	}
	if method != "INVITE" && key != "" && len(responses) > 0 {
		s.storeTransactionForRequest(req, key, responses)
	}
	return responses, err
}

func (s *IMSInboundWireServer) handleInfo(ctx context.Context, req voiceclient.SIPIncomingRequest) ([]IMSInboundWireResponse, error) {
	infoReq := IMSInfoRequest{
		URI:         strings.TrimSpace(req.URI),
		FromURI:     wireHeaderURI(req, "From"),
		ToURI:       wireCalleeURI(req),
		CallID:      wireCallID(req),
		CSeq:        wireCSeq(req),
		ContentType: firstVoiceHeader(req.Headers, "Content-Type"),
		InfoPackage: firstVoiceHeader(req.Headers, "Info-Package"),
		Body:        append([]byte(nil), req.Body...),
		Headers:     cloneSIPHeaders(req.Headers),
	}
	if s != nil && s.InfoHandler != nil {
		result, err := s.InfoHandler.HandleIMSInfo(ctx, infoReq)
		if result.Handled || err != nil {
			return s.infoResultResponse(result, err), err
		}
		if isUSSDInfoRequest(infoReq) {
			resp := wireResponse(415, "Unsupported Media Type")
			return []IMSInboundWireResponse{s.withResponseHeaders(resp)}, nil
		}
	}
	if s != nil && s.Agent != nil {
		result, err := s.Agent.HandleInboundInfo(ctx, infoReq)
		return s.infoResultResponse(result, err), err
	}
	resp := wireResponse(415, "Unsupported Media Type")
	if s == nil || s.InfoHandler == nil {
		resp = wireResponse(405, "Method Not Allowed")
		resp.Headers["Allow"] = s.allowHeader()
	}
	return []IMSInboundWireResponse{s.withResponseHeaders(resp)}, nil
}

func (s *IMSInboundWireServer) infoResultResponse(result IMSInfoResult, err error) []IMSInboundWireResponse {
	resp := wireResponse(inboundStatusCode(result.StatusCode, 200), firstVoiceNonEmpty(result.Reason, "OK"))
	if err != nil && result.StatusCode <= 0 {
		resp = wireResponse(500, firstVoiceNonEmpty(result.Reason, err.Error(), "Server Internal Error"))
	}
	for key, value := range result.Headers {
		if strings.TrimSpace(key) != "" && strings.TrimSpace(value) != "" {
			resp.Headers[strings.TrimSpace(key)] = strings.TrimSpace(value)
		}
	}
	if len(result.Body) > 0 {
		resp.Body = append([]byte(nil), result.Body...)
		resp.Headers["Content-Type"] = firstVoiceNonEmpty(result.ContentType, "application/octet-stream")
	}
	return []IMSInboundWireResponse{s.withResponseHeaders(resp)}
}

func (s *IMSInboundWireServer) dialogInfoResultResponse(result DialogInfoResult, err error) []IMSInboundWireResponse {
	resp := wireResponse(inboundStatusCode(result.StatusCode, 200), firstVoiceNonEmpty(result.Reason, "OK"))
	if err != nil && result.StatusCode <= 0 {
		resp = wireResponse(500, firstVoiceNonEmpty(result.Reason, err.Error(), "Server Internal Error"))
	}
	for key, value := range result.Headers {
		if strings.TrimSpace(key) != "" && strings.TrimSpace(value) != "" {
			resp.Headers[strings.TrimSpace(key)] = strings.TrimSpace(value)
		}
	}
	if len(result.Body) > 0 {
		resp.Body = append([]byte(nil), result.Body...)
		resp.Headers["Content-Type"] = firstVoiceNonEmpty(result.ContentType, "application/octet-stream")
	}
	return []IMSInboundWireResponse{s.withResponseHeaders(resp)}
}

func isUSSDInfoRequest(req IMSInfoRequest) bool {
	return strings.Contains(strings.ToLower(strings.TrimSpace(req.ContentType)), "vnd.3gpp.ussd") ||
		strings.EqualFold(strings.TrimSpace(req.InfoPackage), "g.3gpp.ussd")
}

func (s *IMSInboundWireServer) tryHandleBye(ctx context.Context, req voiceclient.SIPIncomingRequest) ([]IMSInboundWireResponse, error, bool) {
	if s == nil || s.ByeHandler == nil {
		return nil, nil, false
	}
	result, err := s.ByeHandler.HandleIMSBye(ctx, IMSByeRequest{
		URI:         strings.TrimSpace(req.URI),
		FromURI:     wireHeaderURI(req, "From"),
		ToURI:       wireCalleeURI(req),
		CallID:      wireCallID(req),
		CSeq:        wireCSeq(req),
		ContentType: firstVoiceHeader(req.Headers, "Content-Type"),
		Body:        append([]byte(nil), req.Body...),
		Headers:     cloneSIPHeaders(req.Headers),
	})
	if !result.Handled && err == nil {
		return nil, nil, false
	}
	resp := wireResponse(inboundStatusCode(result.StatusCode, 200), firstVoiceNonEmpty(result.Reason, "OK"))
	if err != nil && result.StatusCode <= 0 {
		resp = wireResponse(500, firstVoiceNonEmpty(result.Reason, err.Error(), "Server Internal Error"))
	}
	for key, value := range result.Headers {
		if strings.TrimSpace(key) != "" && strings.TrimSpace(value) != "" {
			resp.Headers[strings.TrimSpace(key)] = strings.TrimSpace(value)
		}
	}
	if len(result.Body) > 0 {
		resp.Body = append([]byte(nil), result.Body...)
		resp.Headers["Content-Type"] = firstVoiceNonEmpty(result.ContentType, "application/octet-stream")
	}
	return []IMSInboundWireResponse{s.withResponseHeaders(resp)}, err, true
}

func (s *IMSInboundWireServer) handleMessage(ctx context.Context, req voiceclient.SIPIncomingRequest) ([]IMSInboundWireResponse, error) {
	if s != nil && s.Agent != nil && s.Agent.hasInboundDialog(wireCallID(req)) {
		result, err := s.Agent.HandleInboundMessage(ctx, IMSMessageRequest{
			URI:         strings.TrimSpace(req.URI),
			FromURI:     wireHeaderURI(req, "From"),
			ToURI:       wireCalleeURI(req),
			CallID:      wireCallID(req),
			CSeq:        wireCSeq(req),
			ContentType: firstVoiceHeader(req.Headers, "Content-Type"),
			Body:        append([]byte(nil), req.Body...),
			Headers:     cloneSIPHeaders(req.Headers),
		})
		return s.infoResultResponse(result, err), err
	}
	if s == nil || s.MessageHandler == nil {
		resp := wireResponse(405, "Method Not Allowed")
		resp.Headers["Allow"] = s.allowHeader()
		return []IMSInboundWireResponse{s.withResponseHeaders(resp)}, nil
	}
	result, err := s.MessageHandler.HandleIMSMessage(ctx, IMSMessageRequest{
		URI:         strings.TrimSpace(req.URI),
		FromURI:     wireHeaderURI(req, "From"),
		ToURI:       wireCalleeURI(req),
		CallID:      wireCallID(req),
		CSeq:        wireCSeq(req),
		ContentType: firstVoiceHeader(req.Headers, "Content-Type"),
		Body:        append([]byte(nil), req.Body...),
		Headers:     cloneSIPHeaders(req.Headers),
	})
	statusCode := inboundStatusCode(result.StatusCode, 200)
	reason := firstVoiceNonEmpty(result.Reason, "OK")
	if err != nil && result.StatusCode <= 0 {
		statusCode = 500
		reason = firstVoiceNonEmpty(result.Reason, err.Error(), "Server Internal Error")
	}
	resp := wireResponse(statusCode, reason)
	for key, value := range result.Headers {
		if strings.TrimSpace(key) != "" && strings.TrimSpace(value) != "" {
			resp.Headers[strings.TrimSpace(key)] = strings.TrimSpace(value)
		}
	}
	if len(result.Body) > 0 {
		resp.Body = append([]byte(nil), result.Body...)
		resp.Headers["Content-Type"] = firstVoiceNonEmpty(result.ContentType, "application/octet-stream")
	}
	return []IMSInboundWireResponse{s.withResponseHeaders(resp)}, err
}

func (s *IMSInboundWireServer) handleUpdate(ctx context.Context, req voiceclient.SIPIncomingRequest) ([]IMSInboundWireResponse, error) {
	if s == nil || s.Agent == nil {
		return []IMSInboundWireResponse{s.withResponseHeaders(wireResponse(503, "Service Unavailable"))}, ErrIMSInboundAgentNotReady
	}
	result, err := s.Agent.HandleInboundUpdate(ctx, InboundDialogRequest{
		CallID:  wireCallID(req),
		CSeq:    wireCSeq(req),
		RawSDP:  append([]byte(nil), req.Body...),
		Headers: cloneSIPHeaders(req.Headers),
		RAck:    firstVoiceHeader(req.Headers, "RAck"),
	})
	final := wireResponse(inboundStatusCode(result.StatusCode, 500), firstVoiceNonEmpty(result.Reason, "Server Internal Error"))
	if result.Accepted {
		final.StatusCode = inboundStatusCode(result.StatusCode, 200)
		final.Reason = firstVoiceNonEmpty(result.Reason, "OK")
		final.Body = append([]byte(nil), result.RawSDP...)
		if len(final.Body) > 0 {
			final.Headers["Content-Type"] = "application/sdp"
		}
		final.Headers["Contact"] = "<" + s.contactURI() + ">"
	}
	applyInboundWireResultHeaders(final.Headers, result.Headers)
	return []IMSInboundWireResponse{s.withResponseHeaders(final)}, err
}

func (s *IMSInboundWireServer) handlePrack(ctx context.Context, req voiceclient.SIPIncomingRequest) ([]IMSInboundWireResponse, error) {
	if s == nil || s.Agent == nil {
		return []IMSInboundWireResponse{s.withResponseHeaders(wireResponse(503, "Service Unavailable"))}, ErrIMSInboundAgentNotReady
	}
	result, err := s.Agent.HandleInboundPrack(ctx, InboundDialogRequest{
		CallID:      wireCallID(req),
		CSeq:        wireCSeq(req),
		Headers:     cloneSIPHeaders(req.Headers),
		RAck:        firstVoiceHeader(req.Headers, "RAck"),
		ContentType: firstVoiceHeader(req.Headers, "Content-Type"),
		RawSDP:      append([]byte(nil), req.Body...),
		Body:        append([]byte(nil), req.Body...),
	})
	final := wireResponse(inboundStatusCode(result.StatusCode, 500), firstVoiceNonEmpty(result.Reason, "Server Internal Error"))
	if result.Accepted {
		final.StatusCode = inboundStatusCode(result.StatusCode, 200)
		final.Reason = firstVoiceNonEmpty(result.Reason, "OK")
		final.Body = append([]byte(nil), result.RawSDP...)
		if len(final.Body) > 0 {
			final.Headers["Content-Type"] = "application/sdp"
		}
	}
	applyInboundWireResultHeaders(final.Headers, result.Headers)
	return []IMSInboundWireResponse{s.withResponseHeaders(final)}, err
}

func (s *IMSInboundWireServer) handleRefer(ctx context.Context, req voiceclient.SIPIncomingRequest) ([]IMSInboundWireResponse, error) {
	if s == nil || s.Agent == nil {
		return []IMSInboundWireResponse{s.withResponseHeaders(wireResponse(503, "Service Unavailable"))}, ErrIMSInboundAgentNotReady
	}
	result, err := s.Agent.HandleInboundRefer(ctx, InboundDialogRequest{
		CallID:     wireCallID(req),
		CSeq:       wireCSeq(req),
		Headers:    cloneSIPHeaders(req.Headers),
		ReferTo:    firstVoiceHeader(req.Headers, "Refer-To"),
		ReferredBy: firstVoiceHeader(req.Headers, "Referred-By"),
		ReferSub:   firstVoiceHeader(req.Headers, "Refer-Sub"),
	})
	final := wireResponse(inboundStatusCode(result.StatusCode, 500), firstVoiceNonEmpty(result.Reason, "Server Internal Error"))
	if result.Accepted {
		final.StatusCode = inboundStatusCode(result.StatusCode, 202)
		final.Reason = firstVoiceNonEmpty(result.Reason, "Accepted")
		final.Headers["Contact"] = "<" + s.contactURI() + ">"
	}
	applyInboundWireResultHeaders(final.Headers, result.Headers)
	return []IMSInboundWireResponse{s.withResponseHeaders(final)}, err
}

func (s *IMSInboundWireServer) handleNotify(ctx context.Context, req voiceclient.SIPIncomingRequest) ([]IMSInboundWireResponse, error) {
	if s == nil || s.Agent == nil {
		return []IMSInboundWireResponse{s.withResponseHeaders(wireResponse(503, "Service Unavailable"))}, ErrIMSInboundAgentNotReady
	}
	result, err := s.Agent.HandleInboundNotify(ctx, InboundDialogRequest{
		CallID:            wireCallID(req),
		CSeq:              wireCSeq(req),
		ContentType:       firstVoiceHeader(req.Headers, "Content-Type"),
		Body:              append([]byte(nil), req.Body...),
		Headers:           cloneSIPHeaders(req.Headers),
		Event:             firstVoiceHeader(req.Headers, "Event"),
		SubscriptionState: firstVoiceHeader(req.Headers, "Subscription-State"),
	})
	return s.infoResultResponse(result, err), err
}

func (s *IMSInboundWireServer) handleSubscribe(ctx context.Context, req voiceclient.SIPIncomingRequest) ([]IMSInboundWireResponse, error) {
	if s == nil || s.Agent == nil {
		return []IMSInboundWireResponse{s.withResponseHeaders(wireResponse(503, "Service Unavailable"))}, ErrIMSInboundAgentNotReady
	}
	result, err := s.Agent.HandleInboundSubscribe(ctx, InboundDialogRequest{
		CallID:      wireCallID(req),
		CSeq:        wireCSeq(req),
		ContentType: firstVoiceHeader(req.Headers, "Content-Type"),
		Body:        append([]byte(nil), req.Body...),
		Headers:     cloneSIPHeaders(req.Headers),
		Event:       firstVoiceHeader(req.Headers, "Event"),
		Expires:     firstVoiceHeader(req.Headers, "Expires"),
	})
	ensureSubscribeResultExpires(&result, req, err)
	return s.infoResultResponse(result, err), err
}

const defaultSubscribeExpires = "3600"

func ensureSubscribeResultExpires(result *IMSInfoResult, req voiceclient.SIPIncomingRequest, err error) {
	if result == nil || err != nil {
		return
	}
	statusCode := inboundStatusCode(result.StatusCode, 200)
	if statusCode < 200 || statusCode >= 300 || stringMapHeader(result.Headers, "Expires") != "" {
		return
	}
	expires := strings.TrimSpace(firstVoiceHeader(req.Headers, "Expires"))
	if expires == "" {
		expires = defaultSubscribeExpires
	}
	if result.Headers == nil {
		result.Headers = make(map[string]string)
	}
	result.Headers["Expires"] = expires
}

func stringMapHeader(headers map[string]string, name string) string {
	for key, value := range headers {
		if strings.EqualFold(strings.TrimSpace(key), name) {
			return strings.TrimSpace(value)
		}
	}
	return ""
}

func (s *IMSInboundWireServer) handleInvite(ctx context.Context, req voiceclient.SIPIncomingRequest, key string, emit imsInboundWireResponseEmitter) ([]IMSInboundWireResponse, error) {
	trying := s.withResponseHeaders(wireResponse(100, "Trying"))
	responses := []IMSInboundWireResponse{trying}
	if key != "" {
		s.storeTransactionForRequest(req, key, []IMSInboundWireResponse{trying})
	}
	if emit != nil {
		if err := emit(trying); err != nil {
			return nil, err
		}
		responses[0].NoResponse = true
	}
	pendingResponses := []IMSInboundWireResponse{trying}
	provisionals := []IMSInboundWireResponse{}
	final, err := s.handleInviteFinal(ctx, req, func(result InboundCallResult) error {
		provisional := s.inviteResultResponse(result, 180, "Ringing")
		if key != "" {
			pendingResponses = append(pendingResponses, provisional)
			s.storeTransactionForRequest(req, key, pendingResponses)
		}
		if emit != nil {
			if err := emit(provisional); err != nil {
				return err
			}
			s.trackReliableProvisional(req, provisional)
			return nil
		}
		provisionals = append(provisionals, provisional)
		s.trackReliableProvisional(req, provisional)
		return nil
	})
	responses = append(responses, provisionals...)
	responses = append(responses, final)
	if key != "" {
		s.storeTransactionForRequest(req, key, append(append([]IMSInboundWireResponse(nil), pendingResponses...), final))
	}
	return responses, err
}

func (s *IMSInboundWireServer) handleInviteFinal(ctx context.Context, req voiceclient.SIPIncomingRequest, onProvisional func(InboundCallResult) error) (IMSInboundWireResponse, error) {
	if s == nil || s.Agent == nil {
		return s.withResponseHeaders(wireResponse(503, "Service Unavailable")), ErrIMSInboundAgentNotReady
	}
	result, err := s.Agent.HandleInboundInvite(ctx, InboundCallRequest{
		CallID:          wireCallID(req),
		CallerURI:       wireHeaderURI(req, "From"),
		CalleeURI:       wireCalleeURI(req),
		RemoteTag:       sipHeaderTag(firstVoiceHeader(req.Headers, "From")),
		RemoteTargetURI: wireHeaderURI(req, "Contact"),
		CSeq:            wireCSeq(req),
		RawSDP:          append([]byte(nil), req.Body...),
		Headers:         cloneSIPHeaders(req.Headers),
		onProvisional:   onProvisional,
	})
	return s.inviteResultResponse(result, 500, "Server Internal Error"), err
}

func (s *IMSInboundWireServer) inviteResultResponse(result InboundCallResult, fallbackStatus int, fallbackReason string) IMSInboundWireResponse {
	final := wireResponse(inboundStatusCode(result.StatusCode, fallbackStatus), firstVoiceNonEmpty(result.Reason, fallbackReason))
	if result.Accepted {
		final.StatusCode = inboundStatusCode(result.StatusCode, 200)
		final.Reason = firstVoiceNonEmpty(result.Reason, "OK")
	}
	if result.Accepted || (final.StatusCode > 100 && final.StatusCode < 200) {
		final.Headers["Contact"] = "<" + s.contactURI() + ">"
	}
	if !(result.Accepted && result.sdpFromProvisional) {
		final.Body = append([]byte(nil), result.RawSDP...)
	}
	if len(final.Body) == 0 && result.Accepted && !result.sdpFromProvisional {
		final.Body = BuildSDPAnswer(result.LocalSDP)
	}
	if len(final.Body) > 0 {
		final.Headers["Content-Type"] = "application/sdp"
	}
	applyInboundWireResultHeaders(final.Headers, result.Headers)
	return s.withResponseHeaders(final)
}

func applyInboundWireResultHeaders(dst map[string]string, src map[string]string) {
	if dst == nil {
		return
	}
	for key, value := range src {
		key = strings.TrimSpace(key)
		value = strings.TrimSpace(value)
		if key == "" || value == "" || isProtectedDialogHeader(key) {
			continue
		}
		dst[key] = value
	}
}

func (s *IMSInboundWireServer) handlePacket(ctx context.Context, pc net.PacketConn, addr net.Addr, raw []byte) {
	req, err := voiceclient.ParseSIPRequest(raw)
	if err != nil {
		_ = writePacketSIPResponse(pc, addr, voiceclient.SIPIncomingRequest{}, wireResponse(400, "Bad Request"))
		return
	}
	writeResponse := func(resp IMSInboundWireResponse) error {
		if resp.NoResponse {
			return nil
		}
		taggedReq := taggedWireRequest(req, s.localTag())
		if err := writePacketSIPResponse(pc, addr, taggedReq, resp); err != nil {
			return err
		}
		s.afterPacketResponse(ctx, pc, addr, taggedReq, resp)
		return nil
	}
	responses, _ := s.handleRequest(ctx, req, func(resp IMSInboundWireResponse) error {
		return writeResponse(resp)
	})
	for _, resp := range responses {
		_ = writeResponse(resp)
	}
}

func (s *IMSInboundWireServer) afterPacketResponse(ctx context.Context, pc net.PacketConn, addr net.Addr, req voiceclient.SIPIncomingRequest, resp IMSInboundWireResponse) {
	if shouldRetransmitReliableProvisional(req, resp) {
		s.startReliableProvisionalRetransmission(ctx, pc, addr, req, resp)
	}
	if shouldRetransmitInviteFinal(req, resp) {
		s.stopReliableProvisionalsForInvite(req)
		s.startInviteFinalRetransmission(ctx, pc, addr, req, resp)
	}
}

func (s *IMSInboundWireServer) handleConn(ctx context.Context, conn net.Conn) {
	defer conn.Close()
	reader := bufio.NewReader(conn)
	for {
		if err := conn.SetDeadline(time.Now().Add(s.readTimeout())); err != nil {
			return
		}
		raw, err := voiceclient.ReadSIPStreamMessage(reader)
		if err != nil {
			return
		}
		req, err := voiceclient.ParseSIPRequest(raw)
		if err != nil {
			_ = writeStreamSIPResponse(conn, voiceclient.SIPIncomingRequest{}, wireResponse(400, "Bad Request"))
			return
		}
		responses, _ := s.handleRequest(ctx, req, func(resp IMSInboundWireResponse) error {
			if resp.NoResponse {
				return nil
			}
			return writeStreamSIPResponse(conn, taggedWireRequest(req, s.localTag()), resp)
		})
		for _, resp := range responses {
			if resp.NoResponse {
				continue
			}
			if err := writeStreamSIPResponse(conn, taggedWireRequest(req, s.localTag()), resp); err != nil {
				return
			}
		}
	}
}

func writePacketSIPResponse(pc net.PacketConn, addr net.Addr, req voiceclient.SIPIncomingRequest, resp IMSInboundWireResponse) error {
	wire, err := voiceclient.BuildSIPResponseWire(req, resp.StatusCode, resp.Reason, resp.Headers, resp.Body)
	if err != nil {
		return err
	}
	_, err = pc.WriteTo(wire, addr)
	return err
}

func writeStreamSIPResponse(conn net.Conn, req voiceclient.SIPIncomingRequest, resp IMSInboundWireResponse) error {
	wire, err := voiceclient.BuildSIPResponseWire(req, resp.StatusCode, resp.Reason, resp.Headers, resp.Body)
	if err != nil {
		return err
	}
	_, err = conn.Write(wire)
	return err
}

func wireResponse(statusCode int, reason string) IMSInboundWireResponse {
	return IMSInboundWireResponse{StatusCode: statusCode, Reason: reason, Headers: make(map[string]string)}
}

var wireSupportedOptionTags = []string{"100rel", "timer", "replaces", "outbound", "norefersub"}

const wireMMTelAcceptContact = `*;+g.3gpp.icsi-ref="urn%3Aurn-7%3A3gpp-service.ims.icsi.mmtel"`

func wireSupportedOptionsHeader() string {
	return strings.Join(wireSupportedOptionTags, ", ")
}

// ClassifyIMSInboundRequireOptions classifies Require option-tags against inbound IMS wire support.
func ClassifyIMSInboundRequireOptions(headers map[string][]string) IMSInboundRequireOptionClassification {
	var out IMSInboundRequireOptionClassification
	seenRequired := make(map[string]struct{})
	for key, values := range headers {
		if !strings.EqualFold(strings.TrimSpace(key), "Require") {
			continue
		}
		for _, value := range values {
			for _, part := range strings.Split(value, ",") {
				tag := strings.TrimSpace(part)
				if tag == "" {
					continue
				}
				lower := strings.ToLower(tag)
				if _, ok := seenRequired[lower]; ok {
					continue
				}
				seenRequired[lower] = struct{}{}
				out.Required = append(out.Required, tag)
				if wireOptionTagSupported(tag) {
					out.Supported = append(out.Supported, tag)
				} else {
					out.Unsupported = append(out.Unsupported, tag)
				}
			}
		}
	}
	return out
}

func (s *IMSInboundWireServer) optionsResponse() IMSInboundWireResponse {
	resp := wireResponse(200, "OK")
	resp.Headers["Allow"] = s.allowHeader()
	resp.Headers["Supported"] = wireSupportedOptionsHeader()
	resp.Headers["Allow-Events"] = "refer"
	resp.Headers["Accept"] = "application/sdp"
	resp.Headers["Accept-Contact"] = wireMMTelAcceptContact
	resp.Headers["User-Agent"] = "vowifi-go"
	if s != nil && (s.MessageHandler != nil || s.InfoHandler != nil || s.Agent != nil) {
		accept := []string{"application/sdp"}
		if s.InfoHandler != nil {
			accept = append(accept, "application/vnd.3gpp.ussd+xml")
		}
		if s.MessageHandler != nil || s.Agent != nil {
			accept = append(accept, "application/vnd.3gpp.sms", "text/plain")
		}
		resp.Headers["Accept"] = strings.Join(accept, ", ")
	}
	if s != nil && strings.TrimSpace(s.UserAgent) != "" {
		resp.Headers["User-Agent"] = strings.TrimSpace(s.UserAgent)
	}
	resp.Headers["Contact"] = "<" + s.contactURI() + ">"
	return resp
}

func (s *IMSInboundWireServer) allowHeader() string {
	allow := "INVITE, ACK, CANCEL, BYE, PRACK, UPDATE, REFER, NOTIFY, SUBSCRIBE, OPTIONS"
	if s != nil && s.InfoHandler != nil {
		allow += ", INFO"
	}
	if s != nil && (s.MessageHandler != nil || s.Agent != nil) {
		allow += ", MESSAGE"
	}
	return allow
}

func (s *IMSInboundWireServer) withResponseHeaders(resp IMSInboundWireResponse) IMSInboundWireResponse {
	if resp.Headers == nil {
		resp.Headers = make(map[string]string)
	}
	if s == nil {
		return resp
	}
	for key, value := range s.ResponseHeaders {
		if strings.TrimSpace(key) != "" && strings.TrimSpace(value) != "" {
			resp.Headers[strings.TrimSpace(key)] = strings.TrimSpace(value)
		}
	}
	if strings.TrimSpace(s.UserAgent) != "" {
		resp.Headers["Server"] = strings.TrimSpace(s.UserAgent)
	}
	return resp
}

func (s *IMSInboundWireServer) contactURI() string {
	if s == nil {
		return "sip:vowifi-go@127.0.0.1:5060"
	}
	contact := firstVoiceNonEmpty(s.ContactURI)
	if contact == "" && s.Agent != nil {
		contact = firstVoiceNonEmpty(s.Agent.LocalContactURI, s.Agent.Registration.ContactURI, s.Agent.Profile.IMPU)
	}
	if contact == "" {
		contact = "sip:vowifi-go@127.0.0.1:5060"
	}
	return strings.Trim(contact, "<>")
}

func (s *IMSInboundWireServer) localTag() string {
	if s == nil {
		return "vowifi-go"
	}
	tag := firstVoiceNonEmpty(s.LocalTag)
	if tag == "" && s.Agent != nil {
		tag = firstVoiceNonEmpty(s.Agent.LocalTag)
	}
	return firstVoiceNonEmpty(tag, "vowifi-go")
}

func (s *IMSInboundWireServer) readTimeout() time.Duration {
	if s == nil || s.ReadTimeout <= 0 {
		return time.Second
	}
	return s.ReadTimeout
}

func (s *IMSInboundWireServer) transactionTTL() time.Duration {
	if s == nil || s.TransactionTTL <= 0 {
		return 32 * time.Second
	}
	return s.TransactionTTL
}

func (s *IMSInboundWireServer) inviteFinalT1() time.Duration {
	if s == nil || s.InviteFinalT1 <= 0 {
		return 500 * time.Millisecond
	}
	return s.InviteFinalT1
}

func (s *IMSInboundWireServer) inviteFinalT2() time.Duration {
	if s == nil || s.InviteFinalT2 <= 0 {
		return 4 * time.Second
	}
	return s.InviteFinalT2
}

func (s *IMSInboundWireServer) reliable1xxT1() time.Duration {
	if s == nil || s.Reliable1xxT1 <= 0 {
		return 500 * time.Millisecond
	}
	return s.Reliable1xxT1
}

func (s *IMSInboundWireServer) reliable1xxT2() time.Duration {
	if s == nil || s.Reliable1xxT2 <= 0 {
		return 4 * time.Second
	}
	return s.Reliable1xxT2
}

func shouldRetransmitInviteFinal(req voiceclient.SIPIncomingRequest, resp IMSInboundWireResponse) bool {
	return strings.EqualFold(strings.TrimSpace(req.Method), "INVITE") && resp.StatusCode >= 200 && !resp.NoResponse
}

func shouldRetransmitReliableProvisional(req voiceclient.SIPIncomingRequest, resp IMSInboundWireResponse) bool {
	if !strings.EqualFold(strings.TrimSpace(req.Method), "INVITE") || resp.NoResponse || resp.StatusCode <= 100 || resp.StatusCode >= 200 {
		return false
	}
	return strings.TrimSpace(wireResponseHeader(resp, "RSeq")) != "" && wireResponseHeaderHasToken(resp, "Require", "100rel")
}

func (s *IMSInboundWireServer) startInviteFinalRetransmission(ctx context.Context, pc net.PacketConn, addr net.Addr, req voiceclient.SIPIncomingRequest, resp IMSInboundWireResponse) {
	if s == nil || pc == nil || addr == nil {
		return
	}
	if ctx == nil {
		ctx = context.Background()
	}
	key := wireInviteRetransmissionKey(req)
	if key == "" {
		return
	}
	childCtx, cancel := context.WithCancel(ctx)
	entry := imsInboundResponseRetransmit{cancel: cancel, done: make(chan struct{})}
	s.mu.Lock()
	now := time.Now()
	s.pruneWireStateLocked(now)
	if expires, ok := s.inviteFinalAcks[key]; ok && now.Before(expires) {
		s.mu.Unlock()
		cancel()
		return
	}
	if s.inviteRetransmits == nil {
		s.inviteRetransmits = make(map[string]imsInboundResponseRetransmit)
	}
	if _, exists := s.inviteRetransmits[key]; exists {
		s.mu.Unlock()
		cancel()
		return
	}
	s.inviteRetransmits[key] = entry
	s.mu.Unlock()
	go s.runWireResponseRetransmission(childCtx, key, entry.done, pc, addr, req, resp, s.inviteFinalT1(), s.inviteFinalT2(), s.removeInviteFinalRetransmission)
}

func (s *IMSInboundWireServer) runWireResponseRetransmission(ctx context.Context, key string, done chan struct{}, pc net.PacketConn, addr net.Addr, req voiceclient.SIPIncomingRequest, resp IMSInboundWireResponse, firstInterval time.Duration, maxInterval time.Duration, remove func(string, chan struct{})) {
	defer close(done)
	defer remove(key, done)
	interval := firstInterval
	if interval <= 0 {
		interval = 500 * time.Millisecond
	}
	if maxInterval <= 0 {
		maxInterval = 4 * time.Second
	}
	if maxInterval < interval {
		maxInterval = interval
	}
	lifetime := s.transactionTTL()
	deadline := time.NewTimer(lifetime)
	defer deadline.Stop()
	timer := time.NewTimer(interval)
	defer timer.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-deadline.C:
			return
		case <-timer.C:
			_ = writePacketSIPResponse(pc, addr, req, resp)
			interval *= 2
			if interval > maxInterval {
				interval = maxInterval
			}
			timer.Reset(interval)
		}
	}
}

func (s *IMSInboundWireServer) removeInviteFinalRetransmission(key string, done chan struct{}) {
	if s == nil || key == "" {
		return
	}
	s.mu.Lock()
	if entry, ok := s.inviteRetransmits[key]; ok && entry.done == done {
		delete(s.inviteRetransmits, key)
	}
	s.mu.Unlock()
}

func (s *IMSInboundWireServer) startReliableProvisionalRetransmission(ctx context.Context, pc net.PacketConn, addr net.Addr, req voiceclient.SIPIncomingRequest, resp IMSInboundWireResponse) {
	if s == nil || pc == nil || addr == nil {
		return
	}
	if ctx == nil {
		ctx = context.Background()
	}
	key := wireReliableProvisionalKey(req, resp)
	if key == "" {
		return
	}
	childCtx, cancel := context.WithCancel(ctx)
	entry := imsInboundResponseRetransmit{cancel: cancel, done: make(chan struct{})}
	s.mu.Lock()
	now := time.Now()
	s.pruneWireStateLocked(now)
	if expires, ok := s.reliable1xxAcks[key]; ok && now.Before(expires) {
		s.mu.Unlock()
		cancel()
		return
	}
	if s.reliable1xxRetransmit == nil {
		s.reliable1xxRetransmit = make(map[string]imsInboundResponseRetransmit)
	}
	if _, exists := s.reliable1xxRetransmit[key]; exists {
		s.mu.Unlock()
		cancel()
		return
	}
	s.reliable1xxRetransmit[key] = entry
	s.mu.Unlock()
	go s.runWireResponseRetransmission(childCtx, key, entry.done, pc, addr, req, resp, s.reliable1xxT1(), s.reliable1xxT2(), s.removeReliableProvisionalRetransmission)
}

func (s *IMSInboundWireServer) trackReliableProvisional(req voiceclient.SIPIncomingRequest, resp IMSInboundWireResponse) {
	if s == nil || !shouldRetransmitReliableProvisional(req, resp) {
		return
	}
	key := wireReliableProvisionalKey(req, resp)
	if key == "" {
		return
	}
	now := time.Now()
	s.mu.Lock()
	s.pruneWireStateLocked(now)
	if s.reliable1xxPending == nil {
		s.reliable1xxPending = make(map[string]time.Time)
	}
	if expires, ok := s.reliable1xxAcks[key]; !ok || !now.Before(expires) {
		s.reliable1xxPending[key] = now.Add(s.transactionTTL())
	}
	s.mu.Unlock()
}

func (s *IMSInboundWireServer) hasPendingReliableProvisionalForPrack(req voiceclient.SIPIncomingRequest) bool {
	if s == nil {
		return false
	}
	key := wireReliableProvisionalKeyFromRAck(req)
	if key == "" {
		return false
	}
	now := time.Now()
	s.mu.Lock()
	defer s.mu.Unlock()
	s.pruneWireStateLocked(now)
	expires, ok := s.reliable1xxPending[key]
	return ok && (expires.IsZero() || now.Before(expires))
}

func (s *IMSInboundWireServer) removeReliableProvisionalRetransmission(key string, done chan struct{}) {
	if s == nil || key == "" {
		return
	}
	s.mu.Lock()
	if entry, ok := s.reliable1xxRetransmit[key]; ok && entry.done == done {
		delete(s.reliable1xxRetransmit, key)
	}
	s.mu.Unlock()
}

func (s *IMSInboundWireServer) stopReliableProvisionalRetransmission(req voiceclient.SIPIncomingRequest) {
	if s == nil {
		return
	}
	key := wireReliableProvisionalKeyFromRAck(req)
	if key == "" {
		return
	}
	s.mu.Lock()
	if s.reliable1xxAcks == nil {
		s.reliable1xxAcks = make(map[string]time.Time)
	}
	s.reliable1xxAcks[key] = time.Now().Add(s.transactionTTL())
	delete(s.reliable1xxPending, key)
	entry, ok := s.reliable1xxRetransmit[key]
	if ok {
		delete(s.reliable1xxRetransmit, key)
	}
	s.mu.Unlock()
	if ok && entry.cancel != nil {
		entry.cancel()
	}
}

func (s *IMSInboundWireServer) stopReliableProvisionalsForInvite(req voiceclient.SIPIncomingRequest) {
	if s == nil {
		return
	}
	prefix := wireReliableProvisionalKeyPrefix(req)
	if prefix == "" {
		return
	}
	var entries []imsInboundResponseRetransmit
	s.mu.Lock()
	if s.reliable1xxAcks == nil {
		s.reliable1xxAcks = make(map[string]time.Time)
	}
	expires := time.Now().Add(s.transactionTTL())
	for key := range s.reliable1xxPending {
		if strings.HasPrefix(key, prefix) {
			delete(s.reliable1xxPending, key)
		}
	}
	for key, entry := range s.reliable1xxRetransmit {
		if strings.HasPrefix(key, prefix) {
			s.reliable1xxAcks[key] = expires
			entries = append(entries, entry)
			delete(s.reliable1xxRetransmit, key)
		}
	}
	s.mu.Unlock()
	for _, entry := range entries {
		if entry.cancel != nil {
			entry.cancel()
		}
	}
}

func (s *IMSInboundWireServer) stopInviteFinalRetransmission(req voiceclient.SIPIncomingRequest) {
	if s == nil {
		return
	}
	key := wireInviteRetransmissionKey(req)
	if key == "" {
		return
	}
	s.mu.Lock()
	if s.inviteFinalAcks == nil {
		s.inviteFinalAcks = make(map[string]time.Time)
	}
	s.inviteFinalAcks[key] = time.Now().Add(s.transactionTTL())
	entry, ok := s.inviteRetransmits[key]
	if ok {
		delete(s.inviteRetransmits, key)
	}
	s.mu.Unlock()
	if ok && entry.cancel != nil {
		entry.cancel()
	}
}

func (s *IMSInboundWireServer) cachedTransaction(key string) ([]IMSInboundWireResponse, bool) {
	if s == nil || strings.TrimSpace(key) == "" {
		return nil, false
	}
	now := time.Now()
	s.mu.Lock()
	defer s.mu.Unlock()
	s.pruneWireStateLocked(now)
	tx, ok := s.transactions[key]
	if !ok || (!tx.expires.IsZero() && now.After(tx.expires)) {
		return nil, false
	}
	return cloneWireResponses(tx.responses), true
}

// CachedTransactionSnapshot returns a diagnostic view of a cached inbound SIP
// server transaction keyed by req's Via branch, Call-ID, method, and CSeq.
func (s *IMSInboundWireServer) CachedTransactionSnapshot(req voiceclient.SIPIncomingRequest) (IMSInboundWireTransactionSnapshot, bool) {
	key := wireTransactionKey(req)
	if s == nil || key == "" {
		return IMSInboundWireTransactionSnapshot{}, false
	}
	now := time.Now()
	s.mu.Lock()
	defer s.mu.Unlock()
	s.pruneWireStateLocked(now)
	tx, ok := s.transactions[key]
	if !ok || (!tx.expires.IsZero() && now.After(tx.expires)) {
		return IMSInboundWireTransactionSnapshot{}, false
	}
	return tx.snapshot(), true
}

func (s *IMSInboundWireServer) storeTransaction(key string, responses []IMSInboundWireResponse) {
	if s == nil || strings.TrimSpace(key) == "" || len(responses) == 0 {
		return
	}
	s.storeTransactionEntry(key, imsInboundWireTransaction{
		responses: cloneWireResponses(responses),
		expires:   time.Now().Add(s.transactionTTL()),
	})
}

func (s *IMSInboundWireServer) storeTransactionForRequest(req voiceclient.SIPIncomingRequest, key string, responses []IMSInboundWireResponse) {
	if s == nil || strings.TrimSpace(key) == "" || len(responses) == 0 {
		return
	}
	s.storeTransactionEntry(key, s.transactionForRequest(req, responses))
}

func (s *IMSInboundWireServer) storeTransactionEntry(key string, tx imsInboundWireTransaction) {
	if s == nil || strings.TrimSpace(key) == "" || len(tx.responses) == 0 {
		return
	}
	s.mu.Lock()
	if s.transactions == nil {
		s.transactions = make(map[string]imsInboundWireTransaction)
	}
	s.transactions[key] = tx
	s.mu.Unlock()
}

func (s *IMSInboundWireServer) transactionForRequest(req voiceclient.SIPIncomingRequest, responses []IMSInboundWireResponse) imsInboundWireTransaction {
	method := strings.ToUpper(strings.TrimSpace(req.Method))
	tx := imsInboundWireTransaction{
		method:    method,
		invite:    strings.EqualFold(method, "INVITE"),
		state:     voiceclient.InitialSIPServerTransactionState(method),
		responses: cloneWireResponses(responses),
	}
	var lastStep voiceclient.SIPServerTransactionStep
	for _, resp := range responses {
		if resp.NoResponse || resp.StatusCode <= 0 {
			continue
		}
		lastStep = voiceclient.AdvanceSIPServerTransaction(voiceclient.SIPServerTransactionInput{
			Method: method,
			State:  tx.state,
			Event:  voiceclient.SIPServerTransactionEventResponse,
			Response: voiceclient.SIPResponse{
				StatusCode: resp.StatusCode,
				Reason:     resp.Reason,
				Headers:    stringToSliceHeaders(resp.Headers),
				Body:       append([]byte(nil), resp.Body...),
			},
			TimerConfig: s.serverTransactionTimerConfig(),
		})
		tx.state = lastStep.NextState
		if lastStep.CleanupAfter > 0 {
			tx.cleanupAfter = lastStep.CleanupAfter
		}
		if lastStep.TimeoutAfter > 0 {
			tx.timeoutAfter = lastStep.TimeoutAfter
		}
	}
	if tx.state == "" {
		tx.state = voiceclient.InitialSIPServerTransactionState(method)
	}
	tx.expires = time.Now().Add(s.transactionLifetime(tx))
	return tx
}

func (s *IMSInboundWireServer) serverTransactionTimerConfig() voiceclient.SIPTransactionTimerConfig {
	return voiceclient.SIPTransactionTimerConfig{
		T1: s.inviteFinalT1(),
		T2: s.inviteFinalT2(),
	}
}

func (s *IMSInboundWireServer) transactionLifetime(tx imsInboundWireTransaction) time.Duration {
	lifetime := s.transactionTTL()
	for _, candidate := range []time.Duration{tx.cleanupAfter, tx.timeoutAfter} {
		if candidate > 0 && candidate < lifetime {
			lifetime = candidate
		}
	}
	return lifetime
}

func (tx imsInboundWireTransaction) snapshot() IMSInboundWireTransactionSnapshot {
	snapshot := IMSInboundWireTransactionSnapshot{
		Method:       tx.method,
		Invite:       tx.invite,
		State:        tx.state,
		CleanupAfter: tx.cleanupAfter,
		TimeoutAfter: tx.timeoutAfter,
		ExpiresAt:    tx.expires,
	}
	for _, resp := range tx.responses {
		if resp.NoResponse || resp.StatusCode <= 0 {
			continue
		}
		snapshot.StatusCodes = append(snapshot.StatusCodes, resp.StatusCode)
		switch {
		case resp.StatusCode < 200:
			snapshot.Provisional = true
		default:
			snapshot.Final = true
		}
	}
	snapshot.Pending = snapshot.Provisional && !snapshot.Final
	return snapshot
}

func (s *IMSInboundWireServer) hasPendingInviteTransactionForCancel(req voiceclient.SIPIncomingRequest) bool {
	key := wireCancelInviteTransactionKey(req)
	if s == nil || key == "" {
		return false
	}
	now := time.Now()
	s.mu.Lock()
	defer s.mu.Unlock()
	s.pruneWireStateLocked(now)
	tx, ok := s.transactions[key]
	if !ok || (!tx.expires.IsZero() && now.After(tx.expires)) {
		return false
	}
	for i := len(tx.responses) - 1; i >= 0; i-- {
		if tx.responses[i].NoResponse {
			continue
		}
		return tx.responses[i].StatusCode > 0 && tx.responses[i].StatusCode < 200
	}
	return false
}

func (s *IMSInboundWireServer) pruneWireStateLocked(now time.Time) {
	for cachedKey, tx := range s.transactions {
		if !tx.expires.IsZero() && now.After(tx.expires) {
			delete(s.transactions, cachedKey)
		}
	}
	for key, expires := range s.inviteFinalAcks {
		if !expires.IsZero() && now.After(expires) {
			delete(s.inviteFinalAcks, key)
		}
	}
	for key, expires := range s.reliable1xxAcks {
		if !expires.IsZero() && now.After(expires) {
			delete(s.reliable1xxAcks, key)
		}
	}
	for key, expires := range s.reliable1xxPending {
		if !expires.IsZero() && now.After(expires) {
			delete(s.reliable1xxPending, key)
		}
	}
}

func cloneWireResponses(responses []IMSInboundWireResponse) []IMSInboundWireResponse {
	out := make([]IMSInboundWireResponse, len(responses))
	for i, resp := range responses {
		out[i] = resp
		out[i].Body = append([]byte(nil), resp.Body...)
		if resp.Headers != nil {
			out[i].Headers = make(map[string]string, len(resp.Headers))
			for key, value := range resp.Headers {
				out[i].Headers[key] = value
			}
		}
	}
	return out
}

func taggedWireRequest(req voiceclient.SIPIncomingRequest, tag string) voiceclient.SIPIncomingRequest {
	out := req
	out.Headers = cloneSIPHeaders(req.Headers)
	to := firstVoiceHeader(out.Headers, "To")
	if to == "" || sipHeaderTag(to) != "" {
		return out
	}
	out.Headers["To"] = []string{to + ";tag=" + firstVoiceNonEmpty(tag, "vowifi-go")}
	return out
}

func wireCallID(req voiceclient.SIPIncomingRequest) string {
	return firstVoiceHeader(req.Headers, "Call-ID")
}

func wireTransactionKey(req voiceclient.SIPIncomingRequest) string {
	method := strings.ToUpper(strings.TrimSpace(req.Method))
	callID := strings.TrimSpace(wireCallID(req))
	cseq := strings.TrimSpace(firstVoiceHeader(req.Headers, "CSeq"))
	branch := wireViaBranch(firstVoiceHeader(req.Headers, "Via"))
	if method == "" || callID == "" || cseq == "" {
		return ""
	}
	if branch == "" {
		branch = firstVoiceHeader(req.Headers, "Via")
	}
	return method + "|" + callID + "|" + cseq + "|" + branch
}

func wireInviteRetransmissionKey(req voiceclient.SIPIncomingRequest) string {
	callID := strings.TrimSpace(wireCallID(req))
	cseq := wireCSeq(req)
	fromTag := sipHeaderTag(firstVoiceHeader(req.Headers, "From"))
	if callID == "" || cseq <= 0 {
		return ""
	}
	return callID + "|" + strconv.Itoa(cseq) + "|" + fromTag
}

func wireCancelInviteTransactionKey(req voiceclient.SIPIncomingRequest) string {
	if !strings.EqualFold(strings.TrimSpace(req.Method), "CANCEL") {
		return ""
	}
	callID := strings.TrimSpace(wireCallID(req))
	cseq := wireCSeq(req)
	branch := wireViaBranch(firstVoiceHeader(req.Headers, "Via"))
	if callID == "" || cseq <= 0 {
		return ""
	}
	if branch == "" {
		branch = firstVoiceHeader(req.Headers, "Via")
	}
	return "INVITE|" + callID + "|" + strconv.Itoa(cseq) + " INVITE|" + branch
}

func wireReliableProvisionalKey(req voiceclient.SIPIncomingRequest, resp IMSInboundWireResponse) string {
	return wireReliableProvisionalKeyFromParts(wireCallID(req), sipHeaderTag(firstVoiceHeader(req.Headers, "From")), wireCSeq(req), wireResponseHeader(resp, "RSeq"))
}

func wireReliableProvisionalKeyFromRAck(req voiceclient.SIPIncomingRequest) string {
	rack := firstVoiceHeader(req.Headers, "RAck")
	if !wireValidRAckHeader(rack) {
		return ""
	}
	fields := strings.Fields(rack)
	if !strings.EqualFold(fields[2], "INVITE") {
		return ""
	}
	inviteCSeq, err := strconv.Atoi(fields[1])
	if err != nil || inviteCSeq <= 0 {
		return ""
	}
	return wireReliableProvisionalKeyFromParts(wireCallID(req), sipHeaderTag(firstVoiceHeader(req.Headers, "From")), inviteCSeq, fields[0])
}

func wireValidRAckHeader(rack string) bool {
	fields := strings.Fields(strings.TrimSpace(rack))
	if len(fields) != 3 || !strings.EqualFold(fields[2], "INVITE") {
		return false
	}
	rseq, err := strconv.Atoi(fields[0])
	if err != nil || rseq <= 0 {
		return false
	}
	cseq, err := strconv.Atoi(fields[1])
	return err == nil && cseq > 0
}

func wireReliableProvisionalKeyPrefix(req voiceclient.SIPIncomingRequest) string {
	callID := strings.TrimSpace(wireCallID(req))
	fromTag := sipHeaderTag(firstVoiceHeader(req.Headers, "From"))
	cseq := wireCSeq(req)
	if callID == "" || cseq <= 0 {
		return ""
	}
	return callID + "|" + strconv.Itoa(cseq) + "|" + fromTag + "|"
}

func wireReliableProvisionalKeyFromParts(callID string, fromTag string, inviteCSeq int, rseq string) string {
	callID = strings.TrimSpace(callID)
	rseq = strings.TrimSpace(rseq)
	if callID == "" || inviteCSeq <= 0 || rseq == "" {
		return ""
	}
	return callID + "|" + strconv.Itoa(inviteCSeq) + "|" + strings.TrimSpace(fromTag) + "|" + rseq
}

func wireResponseHeader(resp IMSInboundWireResponse, name string) string {
	for key, value := range resp.Headers {
		if strings.EqualFold(strings.TrimSpace(key), name) {
			return strings.TrimSpace(value)
		}
	}
	return ""
}

func wireResponseHeaderHasToken(resp IMSInboundWireResponse, name string, token string) bool {
	token = strings.ToLower(strings.TrimSpace(token))
	if token == "" {
		return false
	}
	for key, value := range resp.Headers {
		if !strings.EqualFold(strings.TrimSpace(key), name) {
			continue
		}
		for _, part := range strings.Split(value, ",") {
			if strings.EqualFold(strings.TrimSpace(part), token) {
				return true
			}
		}
	}
	return false
}

func wireViaBranch(via string) string {
	for _, part := range strings.Split(via, ";") {
		key, value, ok := strings.Cut(strings.TrimSpace(part), "=")
		if ok && strings.EqualFold(strings.TrimSpace(key), "branch") {
			return strings.TrimSpace(value)
		}
	}
	return ""
}

func wireCSeq(req voiceclient.SIPIncomingRequest) int {
	value := firstVoiceHeader(req.Headers, "CSeq")
	fields := strings.Fields(value)
	if len(fields) == 0 {
		return 1
	}
	cseq, err := strconv.Atoi(fields[0])
	if err != nil || cseq <= 0 {
		return 1
	}
	return cseq
}

func wireValidRequestCSeq(req voiceclient.SIPIncomingRequest) bool {
	method := strings.ToUpper(strings.TrimSpace(req.Method))
	fields := strings.Fields(firstVoiceHeader(req.Headers, "CSeq"))
	if method == "" || len(fields) != 2 {
		return false
	}
	cseq, err := strconv.Atoi(fields[0])
	if err != nil || cseq <= 0 {
		return false
	}
	return strings.EqualFold(fields[1], method)
}

func wireHasRequiredRequestHeaders(req voiceclient.SIPIncomingRequest) bool {
	for _, name := range []string{"Via", "From", "To", "Call-ID"} {
		if firstVoiceHeader(req.Headers, name) == "" {
			return false
		}
	}
	return true
}

func wireMaxForwardsRejection(req voiceclient.SIPIncomingRequest) (int, string, bool) {
	value, ok := wireFirstHeader(req.Headers, "Max-Forwards")
	if !ok {
		return 0, "", false
	}
	if value == "" {
		return 400, "Bad Max-Forwards", true
	}
	for _, r := range value {
		if r < '0' || r > '9' {
			return 400, "Bad Max-Forwards", true
		}
	}
	hops, err := strconv.Atoi(value)
	if err != nil {
		return 400, "Bad Max-Forwards", true
	}
	if hops == 0 {
		return 483, "Too Many Hops", true
	}
	return 0, "", false
}

func wireUnsupportedRequiredOptions(req voiceclient.SIPIncomingRequest) []string {
	return ClassifyIMSInboundRequireOptions(req.Headers).Unsupported
}

func wireOptionTagSupported(tag string) bool {
	tag = strings.ToLower(strings.TrimSpace(tag))
	if tag == "" {
		return false
	}
	for _, supported := range wireSupportedOptionTags {
		if tag == supported {
			return true
		}
	}
	return false
}

func wireFirstHeader(headers map[string][]string, name string) (string, bool) {
	for key, values := range headers {
		if strings.EqualFold(key, name) && len(values) > 0 {
			return strings.TrimSpace(values[0]), true
		}
	}
	return "", false
}

func wireHeaderURI(req voiceclient.SIPIncomingRequest, name string) string {
	return sipHeaderURI(firstVoiceHeader(req.Headers, name))
}

func wireCalleeURI(req voiceclient.SIPIncomingRequest) string {
	if uri := wireHeaderURI(req, "To"); uri != "" {
		return uri
	}
	return strings.TrimSpace(req.URI)
}

func cloneSIPHeaders(headers map[string][]string) map[string][]string {
	out := make(map[string][]string, len(headers))
	for key, values := range headers {
		out[key] = append([]string(nil), values...)
	}
	return out
}

func stringToSliceHeaders(headers map[string]string) map[string][]string {
	out := make(map[string][]string, len(headers))
	for key, value := range headers {
		if strings.TrimSpace(key) == "" {
			continue
		}
		out[key] = []string{value}
	}
	return out
}

func isTimeout(err error) bool {
	if err == nil {
		return false
	}
	var netErr net.Error
	return errors.As(err, &netErr) && netErr.Timeout()
}
