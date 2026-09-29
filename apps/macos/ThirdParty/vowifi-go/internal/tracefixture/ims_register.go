package tracefixture

import (
	"errors"
	"fmt"
)

const (
	DefaultIMSRegisterReplayMaxEvents    = 64
	DefaultIMSRegisterReplayMaxWireBytes = 256 * 1024
)

var ErrInvalidIMSRegisterReplay = errors.New("invalid IMS register replay")

type IMSRegisterReplayState string

const (
	IMSRegisterReplayStateIncomplete IMSRegisterReplayState = "incomplete"
	IMSRegisterReplayStateChallenged IMSRegisterReplayState = "challenged"
	IMSRegisterReplayStateRegistered IMSRegisterReplayState = "registered"
	IMSRegisterReplayStateRejected   IMSRegisterReplayState = "rejected"
)

type IMSRegisterReplayBounds struct {
	MaxEvents    int
	MaxWireBytes int
}

type IMSRegisterReplaySummary struct {
	Name               string
	EventCount         int
	WireBytes          int
	CallID             string
	State              IMSRegisterReplayState
	Registered         bool
	Challenged         bool
	Authenticated      bool
	SecurityNegotiated bool
	FinalStatusCode    int
	FinalReason        string
	StatusCodes        []int
	AccessNetworkInfo  []string
	AssociatedURIs     []string
	Contacts           []string
	ServiceRoutes      []string
	Paths              []string
	Transactions       []IMSRegisterReplayTransaction
}

type IMSRegisterReplayTransaction struct {
	RequestIndex          int
	ResponseIndex         int
	RequestLabel          string
	ResponseLabel         string
	RequestTransport      string
	ResponseTransport     string
	CSeq                  int
	StatusCode            int
	Reason                string
	Challenge             bool
	HasAuthorization      bool
	HasProxyAuthorization bool
	HasWWWAuthenticate    bool
	HasProxyAuthenticate  bool
	HasContact            bool
	HasPAccessNetworkInfo bool
	HasSecurityServer     bool
	HasSecurityVerify     bool
}

func ClassifyIMSRegisterReplay(transcript Transcript) (IMSRegisterReplaySummary, error) {
	return ClassifyIMSRegisterReplayBounded(transcript, IMSRegisterReplayBounds{})
}

func ClassifyIMSRegisterReplayBounded(transcript Transcript, bounds IMSRegisterReplayBounds) (IMSRegisterReplaySummary, error) {
	events, err := ReplayEvents(transcript)
	if err != nil {
		return IMSRegisterReplaySummary{}, err
	}
	return ClassifyIMSRegisterReplayEvents(transcript.Name, events, bounds)
}

func ClassifyIMSRegisterReplayEvents(name string, events []ReplayEvent, bounds IMSRegisterReplayBounds) (IMSRegisterReplaySummary, error) {
	bounds = normalizeIMSRegisterReplayBounds(bounds)
	if len(events) == 0 {
		return IMSRegisterReplaySummary{}, fmt.Errorf("%w: no events", ErrInvalidIMSRegisterReplay)
	}
	if len(events) > bounds.MaxEvents {
		return IMSRegisterReplaySummary{}, fmt.Errorf("%w: %d events exceeds limit %d", ErrInvalidIMSRegisterReplay, len(events), bounds.MaxEvents)
	}
	if len(events)%2 != 0 {
		return IMSRegisterReplaySummary{}, fmt.Errorf("%w: unmatched register transaction event", ErrInvalidIMSRegisterReplay)
	}
	if err := validateIMSRegisterReplayEventRedaction(name, events); err != nil {
		return IMSRegisterReplaySummary{}, err
	}

	msgs := make([]SIPMessage, len(events))
	wireBytes := 0
	for i, event := range events {
		if len(event.Wire) > bounds.MaxWireBytes-wireBytes {
			return IMSRegisterReplaySummary{}, fmt.Errorf("%w: wire bytes exceed limit %d", ErrInvalidIMSRegisterReplay, bounds.MaxWireBytes)
		}
		wireBytes += len(event.Wire)
		msg, err := event.SIPMessage()
		if err != nil {
			return IMSRegisterReplaySummary{}, fmt.Errorf("%w: %v", ErrInvalidIMSRegisterReplay, err)
		}
		msgs[i] = msg
	}

	summary := IMSRegisterReplaySummary{
		Name:       name,
		EventCount: len(events),
		WireBytes:  wireBytes,
		State:      IMSRegisterReplayStateIncomplete,
	}
	securityServerSeen := false
	securityVerifySeen := false
	for i := 0; i < len(events); i += 2 {
		reqEvent := events[i]
		respEvent := events[i+1]
		reqMsg := msgs[i]
		respMsg := msgs[i+1]
		if reqEvent.Direction != "outbound" {
			return IMSRegisterReplaySummary{}, fmt.Errorf("%w: event %d direction is %q, want outbound", ErrInvalidIMSRegisterReplay, reqEvent.Index, reqEvent.Direction)
		}
		if respEvent.Direction != "inbound" {
			return IMSRegisterReplaySummary{}, fmt.Errorf("%w: event %d direction is %q, want inbound", ErrInvalidIMSRegisterReplay, respEvent.Index, respEvent.Direction)
		}
		if reqEvent.Transport != respEvent.Transport {
			return IMSRegisterReplaySummary{}, fmt.Errorf("%w: events %d/%d transport mismatch", ErrInvalidIMSRegisterReplay, reqEvent.Index, respEvent.Index)
		}
		if !reqMsg.IsRequest || reqMsg.Method != "REGISTER" {
			return IMSRegisterReplaySummary{}, fmt.Errorf("%w: event %d is not a REGISTER request", ErrInvalidIMSRegisterReplay, reqEvent.Index)
		}
		if !respMsg.IsStatus {
			return IMSRegisterReplaySummary{}, fmt.Errorf("%w: event %d is not a SIP status response", ErrInvalidIMSRegisterReplay, respEvent.Index)
		}

		cseq, method, ok := reqMsg.CSeq()
		if !ok || method != "REGISTER" {
			return IMSRegisterReplaySummary{}, fmt.Errorf("%w: event %d missing REGISTER CSeq", ErrInvalidIMSRegisterReplay, reqEvent.Index)
		}
		respCSeq, respMethod, ok := respMsg.CSeq()
		if !ok || respCSeq != cseq || respMethod != "REGISTER" {
			return IMSRegisterReplaySummary{}, fmt.Errorf("%w: event %d CSeq does not match REGISTER request", ErrInvalidIMSRegisterReplay, respEvent.Index)
		}

		callID := reqMsg.Header("Call-ID")
		if callID == "" {
			return IMSRegisterReplaySummary{}, fmt.Errorf("%w: event %d missing Call-ID", ErrInvalidIMSRegisterReplay, reqEvent.Index)
		}
		if err := summary.observeCallID(reqEvent.Index, callID); err != nil {
			return IMSRegisterReplaySummary{}, err
		}
		if err := summary.observeCallID(respEvent.Index, respMsg.Header("Call-ID")); err != nil {
			return IMSRegisterReplaySummary{}, err
		}

		tx := IMSRegisterReplayTransaction{
			RequestIndex:          reqEvent.Index,
			ResponseIndex:         respEvent.Index,
			RequestLabel:          reqEvent.Label,
			ResponseLabel:         respEvent.Label,
			RequestTransport:      reqEvent.Transport,
			ResponseTransport:     respEvent.Transport,
			CSeq:                  cseq,
			StatusCode:            respMsg.StatusCode,
			Reason:                respMsg.Reason,
			Challenge:             respMsg.StatusCode == 401 || respMsg.StatusCode == 407,
			HasAuthorization:      headerPresent(reqMsg, "Authorization"),
			HasProxyAuthorization: headerPresent(reqMsg, "Proxy-Authorization"),
			HasWWWAuthenticate:    headerPresent(respMsg, "WWW-Authenticate"),
			HasProxyAuthenticate:  headerPresent(respMsg, "Proxy-Authenticate"),
			HasContact:            headerPresent(reqMsg, "Contact"),
			HasPAccessNetworkInfo: headerPresent(reqMsg, "P-Access-Network-Info"),
			HasSecurityServer:     headerPresent(respMsg, "Security-Server"),
			HasSecurityVerify:     headerPresent(reqMsg, "Security-Verify"),
		}
		summary.Transactions = append(summary.Transactions, tx)
		summary.StatusCodes = append(summary.StatusCodes, tx.StatusCode)
		summary.AccessNetworkInfo = appendHeaderValues(summary.AccessNetworkInfo, reqMsg, "P-Access-Network-Info")
		summary.FinalStatusCode = tx.StatusCode
		summary.FinalReason = tx.Reason
		summary.Challenged = summary.Challenged || tx.Challenge
		summary.Authenticated = summary.Authenticated || tx.HasAuthorization || tx.HasProxyAuthorization
		securityServerSeen = securityServerSeen || tx.HasSecurityServer
		securityVerifySeen = securityVerifySeen || tx.HasSecurityVerify

		if tx.StatusCode >= 200 && tx.StatusCode < 300 {
			summary.AssociatedURIs = appendHeaderValues(summary.AssociatedURIs, respMsg, "P-Associated-URI")
			summary.Contacts = appendHeaderValues(summary.Contacts, respMsg, "Contact")
			summary.ServiceRoutes = appendHeaderValues(summary.ServiceRoutes, respMsg, "Service-Route")
			summary.Paths = appendHeaderValues(summary.Paths, respMsg, "Path")
		}
	}

	summary.Registered = summary.FinalStatusCode >= 200 && summary.FinalStatusCode < 300
	summary.SecurityNegotiated = securityServerSeen && securityVerifySeen
	summary.State = imsRegisterReplayState(summary.FinalStatusCode)
	return summary, nil
}

func normalizeIMSRegisterReplayBounds(bounds IMSRegisterReplayBounds) IMSRegisterReplayBounds {
	if bounds.MaxEvents <= 0 {
		bounds.MaxEvents = DefaultIMSRegisterReplayMaxEvents
	}
	if bounds.MaxWireBytes <= 0 {
		bounds.MaxWireBytes = DefaultIMSRegisterReplayMaxWireBytes
	}
	return bounds
}

func validateIMSRegisterReplayEventRedaction(name string, events []ReplayEvent) error {
	transcript := Transcript{
		Name:   name,
		Events: make([]TranscriptEvent, len(events)),
	}
	for i, event := range events {
		transcript.Events[i] = TranscriptEvent{
			Label: event.Label,
			Wire:  string(event.Wire),
		}
	}
	return ValidateTranscriptRedaction(transcript)
}

func (s *IMSRegisterReplaySummary) observeCallID(index int, callID string) error {
	if callID == "" {
		return fmt.Errorf("%w: event %d missing Call-ID", ErrInvalidIMSRegisterReplay, index)
	}
	if s.CallID == "" {
		s.CallID = callID
		return nil
	}
	if s.CallID != callID {
		return fmt.Errorf("%w: event %d Call-ID mismatch", ErrInvalidIMSRegisterReplay, index)
	}
	return nil
}

func imsRegisterReplayState(statusCode int) IMSRegisterReplayState {
	switch {
	case statusCode >= 200 && statusCode < 300:
		return IMSRegisterReplayStateRegistered
	case statusCode == 401 || statusCode == 407:
		return IMSRegisterReplayStateChallenged
	case statusCode >= 300:
		return IMSRegisterReplayStateRejected
	default:
		return IMSRegisterReplayStateIncomplete
	}
}

func headerPresent(msg SIPMessage, names ...string) bool {
	for _, name := range names {
		if len(msg.HeaderValues(name)) > 0 {
			return true
		}
	}
	return false
}

func appendHeaderValues(out []string, msg SIPMessage, names ...string) []string {
	for _, name := range names {
		out = append(out, msg.HeaderValues(name)...)
	}
	return out
}
