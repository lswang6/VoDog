package messaging

import (
	"context"
	"errors"
	"strings"

	"github.com/boa-z/vowifi-go/runtimehost/voiceclient"
)

type IMSUSSDDialogRequest struct {
	URI         string
	FromURI     string
	ToURI       string
	CallID      string
	CSeq        int
	ContentType string
	InfoPackage string
	Body        []byte
	Headers     map[string][]string
}

type IMSUSSDDialogResult struct {
	Handled     bool
	StatusCode  int
	Reason      string
	ContentType string
	Body        []byte
	Headers     map[string]string
	USSD        USSDResult
}

type IMSUSSDDialogTransport interface {
	HandleIMSInfo(context.Context, IMSUSSDDialogRequest) (IMSUSSDDialogResult, error)
	HandleIMSBye(context.Context, IMSUSSDDialogRequest) (IMSUSSDDialogResult, error)
}

func (s *Service) HandleIMSUSSDInfo(ctx context.Context, req IMSUSSDDialogRequest) (IMSUSSDDialogResult, error) {
	if s == nil || s.ussdTransport == nil {
		if isIMSUSSDDialogRequest(req) {
			err := ErrUSSDTransportUnavailable
			return IMSUSSDDialogResult{Handled: true, StatusCode: 503, Reason: err.Error()}, err
		}
		return IMSUSSDDialogResult{}, nil
	}
	transport, ok := s.ussdTransport.(IMSUSSDDialogTransport)
	if !ok {
		if isIMSUSSDDialogRequest(req) {
			err := errors.New("USSD transport does not handle IMS dialog requests")
			return IMSUSSDDialogResult{Handled: true, StatusCode: 501, Reason: err.Error()}, err
		}
		return IMSUSSDDialogResult{}, nil
	}
	result, err := transport.HandleIMSInfo(ctx, req)
	if strings.TrimSpace(result.USSD.SessionID) != "" {
		result.USSD = normalizeUSSDResult(result.USSD, result.USSD.SessionID)
		s.recordUSSDSession(result.USSD)
		s.dispatchUSSDUpdated(ctx, result.USSD)
	}
	return result, err
}

func (s *Service) HandleIMSUSSDBye(ctx context.Context, req IMSUSSDDialogRequest) (IMSUSSDDialogResult, error) {
	if s == nil || s.ussdTransport == nil {
		if isIMSUSSDDialogRequest(req) {
			err := ErrUSSDTransportUnavailable
			return IMSUSSDDialogResult{Handled: true, StatusCode: 503, Reason: err.Error()}, err
		}
		return IMSUSSDDialogResult{}, nil
	}
	transport, ok := s.ussdTransport.(IMSUSSDDialogTransport)
	if !ok {
		if isIMSUSSDDialogRequest(req) {
			err := errors.New("USSD transport does not handle IMS dialog requests")
			return IMSUSSDDialogResult{Handled: true, StatusCode: 501, Reason: err.Error()}, err
		}
		return IMSUSSDDialogResult{}, nil
	}
	result, err := transport.HandleIMSBye(ctx, req)
	if strings.TrimSpace(result.USSD.SessionID) != "" {
		result.USSD = normalizeUSSDResult(result.USSD, result.USSD.SessionID)
		s.recordUSSDSession(result.USSD)
		s.dispatchUSSDUpdated(ctx, result.USSD)
	}
	return result, err
}

func (t *IMSUSSDTransport) HandleIMSInfo(ctx context.Context, req IMSUSSDDialogRequest) (IMSUSSDDialogResult, error) {
	if !isIMSUSSDDialogRequest(req) {
		return IMSUSSDDialogResult{}, nil
	}
	contentType := imsUSSDDialogContentType(req)
	payload, parsed, err := DecodeIMSUSSDDocument(contentType, req.Body)
	if err != nil {
		return IMSUSSDDialogResult{Handled: true, StatusCode: 400, Reason: err.Error()}, err
	}
	if !parsed {
		err := errors.New("IMS USSD INFO body is missing USSD XML")
		return IMSUSSDDialogResult{Handled: true, StatusCode: 400, Reason: err.Error()}, err
	}
	sessionID, state, ok := t.sessionByCallID(req.CallID)
	if !ok {
		if !isExplicitIMSUSSDDialogRequest(req) {
			return IMSUSSDDialogResult{Handled: true, StatusCode: 481, Reason: "USSD dialog not found"}, nil
		}
		sessionID, state, err = t.inboundUSSDSession(req)
		if err != nil {
			status := 400
			if errors.Is(err, ErrUSSDTransportUnavailable) {
				status = 503
			}
			return IMSUSSDDialogResult{Handled: true, StatusCode: status, Reason: err.Error()}, err
		}
	}
	result := ussdResultFromPayload(sessionID, payload, 200)
	if result.Done {
		t.clearSession(sessionID)
	} else {
		t.storeSession(sessionID, state)
	}
	return IMSUSSDDialogResult{Handled: true, StatusCode: 200, Reason: "OK", USSD: result}, nil
}

func (t *IMSUSSDTransport) HandleIMSBye(ctx context.Context, req IMSUSSDDialogRequest) (IMSUSSDDialogResult, error) {
	looksUSSD := isIMSUSSDDialogRequest(req)
	sessionID, _, ok := t.sessionByCallID(req.CallID)
	if !ok {
		if !looksUSSD {
			return IMSUSSDDialogResult{}, nil
		}
		return IMSUSSDDialogResult{Handled: true, StatusCode: 481, Reason: "USSD dialog not found"}, nil
	}
	result := USSDResult{SessionID: sessionID, Status: 200, Done: true}
	if len(req.Body) > 0 {
		payload, parsed, err := DecodeIMSUSSDDocument(imsUSSDDialogContentType(req), req.Body)
		if err != nil {
			return IMSUSSDDialogResult{Handled: true, StatusCode: 400, Reason: err.Error()}, err
		}
		if parsed {
			result = ussdResultFromPayload(sessionID, payload, 200)
			result.Done = true
		}
	}
	t.clearSession(sessionID)
	return IMSUSSDDialogResult{Handled: true, StatusCode: 200, Reason: "OK", USSD: result}, nil
}

func (t *IMSUSSDTransport) sessionByCallID(callID string) (string, imsUSSDSession, bool) {
	callID = strings.TrimSpace(callID)
	if t == nil || callID == "" {
		return "", imsUSSDSession{}, false
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	for sessionID, state := range t.sessions {
		if strings.EqualFold(strings.TrimSpace(state.cfg.CallID), callID) {
			return sessionID, state, true
		}
	}
	return "", imsUSSDSession{}, false
}

func (t *IMSUSSDTransport) inboundUSSDSession(req IMSUSSDDialogRequest) (string, imsUSSDSession, error) {
	if t == nil {
		return "", imsUSSDSession{}, ErrUSSDTransportUnavailable
	}
	callID := strings.TrimSpace(req.CallID)
	if callID == "" {
		return "", imsUSSDSession{}, errors.New("IMS USSD Call-ID is empty")
	}
	from := firstNonEmpty(req.FromURI, sipHeaderURIValue(firstHeaderValue(req.Headers, "From")))
	if from == "" {
		return "", imsUSSDSession{}, errors.New("IMS USSD remote URI is empty")
	}
	to := firstNonEmpty(req.ToURI, sipHeaderURIValue(firstHeaderValue(req.Headers, "To")), t.LocalURI, t.Registration.PublicIdentity, t.Profile.IMPU)
	if to == "" {
		return "", imsUSSDSession{}, errors.New("IMS USSD local identity is empty")
	}
	cseq := req.CSeq
	if cseq <= 0 {
		cseq = 1
	}
	cfg := voiceclient.DialogRequestConfig{
		Profile:         t.Profile,
		Registration:    t.Registration,
		LocalURI:        to,
		ContactURI:      firstNonEmpty(t.ContactURI, t.Registration.ContactURI),
		RemoteURI:       from,
		RemoteTargetURI: firstNonEmpty(sipHeaderURIValue(firstHeaderValue(req.Headers, "Contact")), from),
		CallID:          callID,
		LocalTag:        firstNonEmpty(sipHeaderTagValue(firstHeaderValue(req.Headers, "To")), t.LocalTag, "ussd"),
		RemoteTag:       sipHeaderTagValue(firstHeaderValue(req.Headers, "From")),
		CSeq:            cseq,
		UserAgent:       firstNonEmpty(t.UserAgent, t.Profile.UserAgent, "vowifi-go"),
		SessionExpires:  t.SessionExpires,
	}
	if routeSet := ussdRecordRouteSet(req.Headers); len(routeSet) > 0 {
		cfg.RouteSet = routeSet
	}
	sessionID := "ims-ussd-" + smsToken(callID)
	return sessionID, imsUSSDSession{cfg: cfg, cseq: cseq}, nil
}

func isIMSUSSDDialogRequest(req IMSUSSDDialogRequest) bool {
	if strings.EqualFold(strings.TrimSpace(imsUSSDDialogInfoPackage(req)), IMSUSSDInfoPackage) {
		return true
	}
	contentType := imsUSSDDialogContentType(req)
	if normalizeUSSDContentType(contentType) == IMSUSSDContentType {
		return true
	}
	normalized := strings.ToLower(strings.TrimSpace(contentType))
	if strings.HasPrefix(normalized, "multipart/") && len(req.Body) > 0 {
		if _, ok, _ := DecodeIMSUSSDDocument(contentType, req.Body); ok {
			return true
		}
	}
	return false
}

func isExplicitIMSUSSDDialogRequest(req IMSUSSDDialogRequest) bool {
	if strings.EqualFold(strings.TrimSpace(imsUSSDDialogInfoPackage(req)), IMSUSSDInfoPackage) {
		return true
	}
	contentType := imsUSSDDialogContentType(req)
	normalized := normalizeUSSDContentType(contentType)
	if normalized == IMSUSSDContentType {
		return true
	}
	if strings.HasPrefix(normalized, "multipart/") && len(req.Body) > 0 {
		_, parsed, err := DecodeIMSUSSDDocument(contentType, req.Body)
		return parsed && err == nil
	}
	return false
}

func imsUSSDDialogContentType(req IMSUSSDDialogRequest) string {
	return firstNonEmpty(req.ContentType, firstHeaderValue(req.Headers, "Content-Type"))
}

func imsUSSDDialogInfoPackage(req IMSUSSDDialogRequest) string {
	return firstNonEmpty(req.InfoPackage, firstHeaderValue(req.Headers, "Info-Package"))
}
