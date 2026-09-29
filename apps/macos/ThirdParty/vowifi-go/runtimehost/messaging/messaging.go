package messaging

import (
	"context"
	"errors"
	"fmt"
	"math"
	"strings"
	"sync"
	"sync/atomic"
	"time"
	"unicode/utf16"
	"unicode/utf8"

	"github.com/boa-z/vowifi-go/runtimehost/eventhost"
)

var ErrDeliveryNotFound = errors.New("delivery not found")
var ErrSMSTransportUnavailable = errors.New("sms transport unavailable")
var ErrUSSDTransportUnavailable = errors.New("ussd transport unavailable")

type suppressKey struct{}

func WithSuppressSendTGSuccess(ctx context.Context) context.Context {
	if ctx == nil {
		ctx = context.Background()
	}
	return context.WithValue(ctx, suppressKey{}, true)
}

type SendOptions struct {
	Encoding              string
	ValidityPeriod        time.Duration
	ValidityDeadline      time.Time
	ProtocolID            byte
	DataCodingScheme      byte
	UseProtocolID         bool
	UseDataCodingScheme   bool
	ReplyPath             bool
	RejectDuplicates      bool
	ConcatRef             int
	ConcatRefBits         int
	ApplicationDestPort   int
	ApplicationSourcePort int
	ApplicationPortBits   int
	SingleShiftLang       int
	LockingShiftLang      int
}

type SendOutcome struct {
	MessageID     string `json:"message_id,omitempty"`
	Parts         int    `json:"parts,omitempty"`
	PartsTotal    int    `json:"parts_total,omitempty"`
	State         string `json:"state,omitempty"`
	DeliveryState string `json:"delivery_state,omitempty"`
}

type USSDResult struct {
	SessionID                  string        `json:"session_id,omitempty"`
	Text                       string        `json:"text,omitempty"`
	RawText                    string        `json:"raw_text,omitempty"`
	Status                     int           `json:"status,omitempty"`
	DCS                        int           `json:"dcs,omitempty"`
	Done                       bool          `json:"done"`
	RegistrationRecoveryNeeded bool          `json:"registration_recovery_needed,omitempty"`
	RetryAfter                 time.Duration `json:"retry_after,omitempty"`
}

type IncomingSMS struct {
	Sender                 string
	Recipient              string
	Content                string
	Timestamp              time.Time
	ProtocolID             byte
	DataCodingScheme       byte
	DataCoding             SMSDataCodingInfo
	UserDataHeader         bool
	UserDataHeaderInfo     SMSUserDataHeaderInfo
	MoreMessagesToSend     bool
	StatusReportIndication bool
	ReplyPath              bool
}

type SMSDeliveryReport struct {
	InReplyTo             string
	CallID                string
	RPMR                  int
	State                 string
	SIPCode               int
	RPCause               int
	ErrorText             string
	ReportAt              time.Time
	Recipient             string
	SentAt                time.Time
	FirstOctet            byte
	MoreMessagesToSend    bool
	StatusReportQualifier bool
	UserDataHeader        bool
	UserDataHeaderInfo    SMSUserDataHeaderInfo
	ParameterIndicator    byte
	ProtocolID            byte
	DataCodingScheme      byte
	DataCoding            SMSDataCodingInfo
	UserData              string
}

type SMSPart struct {
	PartNo                int
	TotalParts            int
	Text                  string
	Encoding              string
	UDH                   []byte
	ValidityPeriod        time.Duration
	ValidityDeadline      time.Time
	ProtocolID            byte
	DataCodingScheme      byte
	UseProtocolID         bool
	UseDataCodingScheme   bool
	ReplyPath             bool
	RejectDuplicates      bool
	ConcatRef             int
	ConcatRefBits         int
	ApplicationDestPort   int
	ApplicationSourcePort int
	ApplicationPortBits   int
	SingleShiftLang       int
	LockingShiftLang      int
	RequestStatusReport   bool
}

type SMSSendRequest struct {
	DeviceID  string
	IMSI      string
	Peer      string
	MessageID string
	Part      SMSPart
}

type SMSSendResult struct {
	CallID                     string
	RPMR                       int
	State                      string
	SIPCode                    int
	ErrorText                  string
	RegistrationRecoveryNeeded bool
	RetryAfter                 time.Duration
}

type SMSTransport interface {
	SendSMSPart(context.Context, SMSSendRequest) (SMSSendResult, error)
}

type USSDTransport interface {
	ExecuteUSSD(context.Context, USSDRequest) (USSDResult, error)
	ContinueUSSD(context.Context, USSDRequest) (USSDResult, error)
	CancelUSSD(context.Context, USSDRequest) error
}

type USSDRequest struct {
	DeviceID  string
	IMSI      string
	SessionID string
	Command   string
	Input     string
}

type DeliveryPartMatch struct {
	MessageID string
	PartNo    int
	State     string
}

type DeliveryPartStatus struct {
	PartNo      int
	CallID      string
	InReplyTo   string
	RPMR        int
	State       string
	SIPCode     int
	RPCause     int
	RPCauseText string
	ErrorText   string
	SentAt      time.Time
	ReportAt    *time.Time
	CreatedAt   time.Time
	UpdatedAt   time.Time
}

type DeliveryStatus struct {
	MessageID  string
	IMSI       string
	DeviceID   string
	Peer       string
	Content    string
	PartsTotal int
	Acks       int
	State      string
	LastError  string
	CreatedAt  time.Time
	UpdatedAt  time.Time
	Parts      []DeliveryPartStatus
}

type DeliveryStore interface {
	CreateSMSDelivery(messageID, imsi, deviceID, peer, content string, partsTotal int, at time.Time) error
	UpsertSMSDeliveryPart(messageID string, partNo int, callID string, rpMR int, state string, sentAt time.Time) error
	MarkSMSDeliveryPartReport(inReplyTo, callID, deviceID string, rpMR int, state string, sipCode int, rpCause int, errText string, at time.Time) (DeliveryPartMatch, error)
	RecomputeSMSDelivery(messageID string, at time.Time) error
	UpdateSMSDeliveryState(messageID, state, lastError string, acks int, at time.Time) error
	GetSMSDeliveryStatus(messageID string) (*DeliveryStatus, error)
}

type IMSMessagingRetryStore interface {
	UpsertIMSMessagingRetry(IMSMessagingRetryEnvelope) error
	DeleteIMSMessagingRetry(operation IMSMessagingRetryOperation, key string) error
}

type IMSMessagingRetryDueStore interface {
	ListDueIMSMessagingRetries(now time.Time, limit int) ([]IMSMessagingRetryEnvelope, error)
}

type IMSMessagingRetryReplayResult struct {
	Envelope      IMSMessagingRetryEnvelope
	NextEnvelope  IMSMessagingRetryEnvelope
	Replayed      bool
	Upserted      bool
	Deleted       bool
	DuplicateRisk bool
	SMSResult     SMSSendResult
	USSDResult    USSDResult
	Err           error
}

func RPCauseText(code int) string {
	if code == 0 {
		return ""
	}
	if text := smsRPCauseText(code); text != "" {
		return text
	}
	return fmt.Sprintf("RP cause %d", code)
}

type Service struct {
	deviceID      string
	imsi          string
	store         DeliveryStore
	dispatch      eventhost.Dispatcher
	transport     SMSTransport
	ussdTransport USSDTransport
	mu            sync.Mutex
	ussdSessions  map[string]USSDResult
	smsConcat     map[smsConcatKey]*smsConcatState
}

var smsConcatRefCounter atomic.Uint32

func NewService(deviceID, imsi string, store DeliveryStore, dispatch eventhost.Dispatcher) *Service {
	return &Service{deviceID: deviceID, imsi: imsi, store: store, dispatch: dispatch}
}

func (s *Service) SetSMSTransport(t SMSTransport) {
	if s == nil {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.transport = t
}

func (s *Service) SetUSSDTransport(t USSDTransport) {
	if s == nil {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.ussdTransport = t
}

func (s *Service) smsTransport() SMSTransport {
	if s == nil {
		return nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.transport
}

func (s *Service) currentUSSDTransport() USSDTransport {
	if s == nil {
		return nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.ussdTransport
}

func (s *Service) retryStore() IMSMessagingRetryStore {
	if s == nil || s.store == nil {
		return nil
	}
	store, _ := s.store.(IMSMessagingRetryStore)
	return store
}

func (s *Service) recordIMSMessagingRetry(envelope IMSMessagingRetryEnvelope) (upserted, deleted bool) {
	store := s.retryStore()
	if store == nil || strings.TrimSpace(envelope.Key) == "" {
		return false, false
	}
	if envelope.Pending() {
		_ = store.UpsertIMSMessagingRetry(envelope)
		return true, false
	}
	_ = store.DeleteIMSMessagingRetry(envelope.Operation, envelope.Key)
	return false, true
}

func (s *Service) ReplayIMSMessagingRetry(ctx context.Context, envelope IMSMessagingRetryEnvelope, now time.Time) (IMSMessagingRetryReplayResult, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	if now.IsZero() {
		now = time.Now()
	}
	result := IMSMessagingRetryReplayResult{
		Envelope:      envelope,
		DuplicateRisk: envelope.Plan.DuplicateRisk,
	}
	if !envelope.ReplayReady(now) {
		return result, nil
	}
	switch envelope.Operation {
	case IMSMessagingRetryOperationSMSSubmit:
		return s.replayIMSSMSSubmitRetry(ctx, envelope, now, result)
	case IMSMessagingRetryOperationUSSDSession:
		return s.replayIMSUSSDSessionRetry(ctx, envelope, now, result)
	default:
		err := fmt.Errorf("unsupported IMS messaging retry operation: %s", envelope.Operation)
		result.Err = err
		return result, err
	}
}

func (s *Service) ReplayDueIMSMessagingRetries(ctx context.Context, envelopes []IMSMessagingRetryEnvelope, now time.Time, limit int) ([]IMSMessagingRetryReplayResult, error) {
	if now.IsZero() {
		now = time.Now()
	}
	due := SelectDueIMSMessagingRetryEnvelopes(envelopes, now, limit)
	if len(due) == 0 {
		return nil, nil
	}
	results := make([]IMSMessagingRetryReplayResult, 0, len(due))
	var joined error
	for _, envelope := range due {
		result, err := s.ReplayIMSMessagingRetry(ctx, envelope, now)
		results = append(results, result)
		if err != nil {
			joined = errors.Join(joined, err)
		}
	}
	return results, joined
}

func (s *Service) ReplayDueIMSMessagingRetriesFromStore(ctx context.Context, now time.Time, limit int) ([]IMSMessagingRetryReplayResult, error) {
	if s == nil || s.store == nil {
		return nil, nil
	}
	if now.IsZero() {
		now = time.Now()
	}
	store, ok := s.store.(IMSMessagingRetryDueStore)
	if !ok {
		return nil, nil
	}
	envelopes, err := store.ListDueIMSMessagingRetries(now, limit)
	if err != nil {
		return nil, err
	}
	return s.ReplayDueIMSMessagingRetries(ctx, envelopes, now, limit)
}

func (s *Service) replayIMSSMSSubmitRetry(ctx context.Context, envelope IMSMessagingRetryEnvelope, now time.Time, result IMSMessagingRetryReplayResult) (IMSMessagingRetryReplayResult, error) {
	req, ok := envelope.SMSSubmitRequest()
	if !ok {
		err := errors.New("IMS SMS retry envelope is missing SMS submit payload")
		result.Err = err
		return result, err
	}
	transport := s.smsTransport()
	if transport == nil {
		result.Err = ErrSMSTransportUnavailable
		return result, ErrSMSTransportUnavailable
	}
	res, err := transport.SendSMSPart(ctx, req)
	result.Replayed = true
	if err != nil {
		res.State = "failed"
		if strings.TrimSpace(res.ErrorText) == "" {
			res.ErrorText = err.Error()
		}
	} else if strings.TrimSpace(res.State) == "" {
		res.State = "sent"
	}
	result.SMSResult = res
	if s != nil && s.store != nil && strings.TrimSpace(req.MessageID) != "" {
		_ = s.store.UpsertSMSDeliveryPart(req.MessageID, req.Part.PartNo, res.CallID, res.RPMR, res.State, now)
		_ = s.store.RecomputeSMSDelivery(req.MessageID, now)
	}
	next := NewIMSSMSSubmitRetryEnvelope(req, res, err, IMSMessagingRetryOptions{
		Attempt:        imsMessagingRetryReplayAttempt(envelope),
		Now:            now,
		IdempotencyKey: firstNonEmpty(envelope.IdempotencyKey, envelope.Key),
	})
	result.NextEnvelope = next
	result.Upserted, result.Deleted = s.recordIMSMessagingRetry(next)
	result.Err = err
	return result, err
}

func (s *Service) replayIMSUSSDSessionRetry(ctx context.Context, envelope IMSMessagingRetryEnvelope, now time.Time, result IMSMessagingRetryReplayResult) (IMSMessagingRetryReplayResult, error) {
	req, ok := envelope.USSDRequest()
	if !ok {
		err := errors.New("IMS USSD retry envelope is missing USSD payload")
		result.Err = err
		return result, err
	}
	transport := s.currentUSSDTransport()
	if transport == nil {
		result.Err = ErrUSSDTransportUnavailable
		return result, ErrUSSDTransportUnavailable
	}
	method := normalizeIMSMessagingRetryMethod(envelope.Method, envelope.Operation)
	var res USSDResult
	var err error
	if strings.EqualFold(method, "INFO") || strings.TrimSpace(req.Input) != "" {
		res, err = transport.ContinueUSSD(ctx, req)
	} else {
		res, err = transport.ExecuteUSSD(ctx, req)
	}
	result.Replayed = true
	res = normalizeUSSDResult(res, req.SessionID)
	result.USSDResult = res
	if err == nil {
		s.recordUSSDSession(res)
		s.dispatchUSSDUpdated(ctx, res)
	}
	next := NewIMSUSSDSessionRetryEnvelope(req, res, err, IMSMessagingRetryOptions{
		Method:     method,
		Attempt:    imsMessagingRetryReplayAttempt(envelope),
		Now:        now,
		SessionKey: firstNonEmpty(envelope.SessionKey, envelope.Key),
	})
	result.NextEnvelope = next
	result.Upserted, result.Deleted = s.recordIMSMessagingRetry(next)
	result.Err = err
	return result, err
}

func imsMessagingRetryReplayAttempt(envelope IMSMessagingRetryEnvelope) int {
	if envelope.NextAttempt > 0 {
		return envelope.NextAttempt
	}
	if envelope.Plan.NextAttempt > 0 {
		return envelope.Plan.NextAttempt
	}
	if envelope.Attempt > 0 {
		return envelope.Attempt + 1
	}
	if envelope.Plan.Attempt > 0 {
		return envelope.Plan.Attempt + 1
	}
	return 1
}

func (s *Service) SendSMSWithOptions(ctx context.Context, to, text string, opts SendOptions) (SendOutcome, error) {
	to = strings.TrimSpace(to)
	if to == "" {
		return SendOutcome{}, errors.New("sms target is empty")
	}
	parts, err := segmentSMS(text, opts)
	if err != nil {
		return SendOutcome{}, err
	}
	if len(parts) == 0 {
		return SendOutcome{}, errors.New("sms content is empty")
	}
	id := fmt.Sprintf("vowifi-%d", time.Now().UnixNano())
	now := time.Now()
	if s != nil && s.store != nil {
		_ = s.store.CreateSMSDelivery(id, s.imsi, s.deviceID, to, text, len(parts), now)
	}
	acks := 0
	state := "sent"
	deliveryState := "sent"
	lastErr := ""
	for _, part := range parts {
		partNow := time.Now()
		res := SMSSendResult{State: "sent"}
		var sendErr error
		req := SMSSendRequest{
			DeviceID:  s.deviceID,
			IMSI:      s.imsi,
			Peer:      to,
			MessageID: id,
			Part:      part,
		}
		if transport := s.smsTransport(); transport != nil {
			res, sendErr = transport.SendSMSPart(ctx, req)
			s.recordIMSMessagingRetry(NewIMSSMSSubmitRetryEnvelope(req, res, sendErr, IMSMessagingRetryOptions{
				Attempt: 1,
				Now:     time.Now(),
			}))
		}
		if res.State == "" {
			res.State = "sent"
		}
		if sendErr != nil {
			res.State = "failed"
			if res.ErrorText == "" {
				res.ErrorText = sendErr.Error()
			}
		}
		if s != nil && s.store != nil {
			_ = s.store.UpsertSMSDeliveryPart(id, part.PartNo, res.CallID, res.RPMR, res.State, partNow)
		}
		if res.State == "sent" || res.State == "delivered" || res.State == "accepted" {
			acks++
		}
		if sendErr != nil {
			state = "failed"
			deliveryState = "failed"
			lastErr = res.ErrorText
			break
		}
		if res.State == "failed" {
			state = "failed"
			deliveryState = "failed"
			lastErr = res.ErrorText
			break
		}
	}
	if s != nil && s.store != nil {
		_ = s.store.UpdateSMSDeliveryState(id, state, lastErr, acks, time.Now())
	}
	if s != nil && s.dispatch != nil {
		s.dispatch.Dispatch(ctx, eventhost.SMSSent{DevID: s.deviceID, TargetURI: to, Content: text, Time: now, TotalParts: len(parts)})
	}
	out := SendOutcome{MessageID: id, Parts: acks, PartsTotal: len(parts), State: state, DeliveryState: deliveryState}
	if state == "failed" {
		return out, errors.New(firstNonEmpty(lastErr, "sms send failed"))
	}
	return out, nil
}

func (s *Service) SendUSSD(ctx context.Context, command string) (*USSDResult, error) {
	command = strings.TrimSpace(command)
	if command == "" {
		return nil, errors.New("ussd command is empty")
	}
	sessionID := fmt.Sprintf("ussd-%d", time.Now().UnixNano())
	transport := s.currentUSSDTransport()
	if transport == nil {
		return &USSDResult{SessionID: sessionID, Text: "", Done: true}, nil
	}
	req := USSDRequest{
		DeviceID:  s.deviceID,
		IMSI:      s.imsi,
		SessionID: sessionID,
		Command:   command,
	}
	res, err := transport.ExecuteUSSD(ctx, req)
	s.recordIMSMessagingRetry(NewIMSUSSDSessionRetryEnvelope(req, res, err, IMSMessagingRetryOptions{
		Attempt: 1,
		Now:     time.Now(),
	}))
	if err != nil {
		return nil, err
	}
	res = normalizeUSSDResult(res, sessionID)
	s.recordUSSDSession(res)
	s.dispatchUSSDUpdated(ctx, res)
	return &res, nil
}

func (s *Service) ContinueUSSD(ctx context.Context, sessionID, input string) (*USSDResult, error) {
	sessionID = strings.TrimSpace(sessionID)
	if sessionID == "" {
		return nil, errors.New("ussd session_id is empty")
	}
	input = strings.TrimSpace(input)
	transport := s.currentUSSDTransport()
	if transport == nil {
		return &USSDResult{SessionID: sessionID, Text: "", Done: true}, nil
	}
	if !s.hasUSSDSession(sessionID) {
		return nil, fmt.Errorf("ussd session %s is not active", sessionID)
	}
	req := USSDRequest{
		DeviceID:  s.deviceID,
		IMSI:      s.imsi,
		SessionID: sessionID,
		Input:     input,
	}
	res, err := transport.ContinueUSSD(ctx, req)
	s.recordIMSMessagingRetry(NewIMSUSSDSessionRetryEnvelope(req, res, err, IMSMessagingRetryOptions{
		Attempt: 1,
		Now:     time.Now(),
	}))
	if err != nil {
		return nil, err
	}
	res = normalizeUSSDResult(res, sessionID)
	s.recordUSSDSession(res)
	s.dispatchUSSDUpdated(ctx, res)
	return &res, nil
}

func (s *Service) CancelUSSD(ctx context.Context, sessionID string) error {
	sessionID = strings.TrimSpace(sessionID)
	if sessionID == "" {
		return errors.New("ussd session_id is empty")
	}
	transport := s.currentUSSDTransport()
	if transport == nil {
		return nil
	}
	if err := transport.CancelUSSD(ctx, USSDRequest{
		DeviceID:  s.deviceID,
		IMSI:      s.imsi,
		SessionID: sessionID,
	}); err != nil {
		return err
	}
	s.clearUSSDSession(sessionID)
	return nil
}

func (s *Service) GetSMSDeliveryStatus(messageID string) (*DeliveryStatus, error) {
	if s == nil || s.store == nil {
		return nil, ErrDeliveryNotFound
	}
	return s.store.GetSMSDeliveryStatus(messageID)
}

func (s *Service) HandleIncomingSMS(ctx context.Context, msg IncomingSMS) error {
	sender := strings.TrimSpace(msg.Sender)
	content := msg.Content
	if sender == "" {
		return errors.New("incoming sms sender is empty")
	}
	if content == "" && !incomingSMSHasUserDataHeader(msg) {
		return errors.New("incoming sms content is empty")
	}
	at := msg.Timestamp
	if at.IsZero() {
		at = time.Now()
	}
	if content != "" && s != nil && s.dispatch != nil {
		s.dispatch.Dispatch(ctx, eventhost.SMSReceived{
			DevID:   s.deviceID,
			Sender:  sender,
			Content: content,
			Time:    at,
		})
	}
	return nil
}

func incomingSMSHasUserDataHeader(msg IncomingSMS) bool {
	if msg.UserDataHeader {
		return true
	}
	return len(msg.UserDataHeaderInfo.Raw) > 0 || len(msg.UserDataHeaderInfo.Elements) > 0
}

func (s *Service) HandleSMSDeliveryReport(ctx context.Context, report SMSDeliveryReport) (DeliveryPartMatch, error) {
	if s == nil || s.store == nil {
		return DeliveryPartMatch{}, ErrDeliveryNotFound
	}
	at := report.ReportAt
	if at.IsZero() {
		at = time.Now()
	}
	state := normalizeDeliveryReportState(report.State, report.SIPCode, report.RPCause)
	errText := strings.TrimSpace(report.ErrorText)
	if errText == "" && report.RPCause != 0 {
		errText = RPCauseText(report.RPCause)
	}
	match, err := s.store.MarkSMSDeliveryPartReport(
		strings.TrimSpace(report.InReplyTo),
		strings.TrimSpace(report.CallID),
		s.deviceID,
		report.RPMR,
		state,
		report.SIPCode,
		report.RPCause,
		errText,
		at,
	)
	if err != nil {
		return DeliveryPartMatch{}, err
	}
	if match.MessageID != "" {
		_ = s.store.RecomputeSMSDelivery(match.MessageID, at)
	}
	return match, nil
}

func SegmentSMS(text, encoding string) []SMSPart {
	return SegmentSMSWithOptions(text, SendOptions{Encoding: encoding})
}

func SegmentSMSWithOptions(text string, opts SendOptions) []SMSPart {
	parts, _ := segmentSMS(text, opts)
	return parts
}

func segmentSMS(text string, opts SendOptions) ([]SMSPart, error) {
	if text == "" {
		return nil, nil
	}
	if _, _, err := encodeSMSSubmitValidityPeriod(opts.ValidityPeriod, opts.ValidityDeadline); err != nil {
		return nil, err
	}
	if err := validateSMSNationalLanguageOptions(opts.SingleShiftLang, opts.LockingShiftLang); err != nil {
		return nil, err
	}
	enc, err := normalizeSMSSubmitEncodingWithLanguage(text, opts.Encoding, opts.DataCodingScheme, opts.UseDataCodingScheme || opts.DataCodingScheme != 0, opts.LockingShiftLang, opts.SingleShiftLang)
	if err != nil {
		return nil, err
	}
	portBits, hasPorts, err := validateSMSApplicationPortOptions(opts.ApplicationDestPort, opts.ApplicationSourcePort, opts.ApplicationPortBits)
	if err != nil {
		return nil, err
	}
	singleUDHLen := smsSubmitUDHLength(hasPorts, portBits, false, 0, opts.SingleShiftLang, opts.LockingShiftLang)
	singleLimit := smsPartLimitForUDH(enc, singleUDHLen)
	if messageLenWithLanguage(text, enc, opts.LockingShiftLang, opts.SingleShiftLang) <= singleLimit {
		udh, err := buildSMSSubmitUDH(hasPorts, opts.ApplicationDestPort, opts.ApplicationSourcePort, portBits, 0, 0, 1, 1, opts.SingleShiftLang, opts.LockingShiftLang)
		if err != nil {
			return nil, err
		}
		return []SMSPart{{PartNo: 1, TotalParts: 1, Text: text, Encoding: enc, UDH: udh, ValidityPeriod: opts.ValidityPeriod, ValidityDeadline: opts.ValidityDeadline, ProtocolID: opts.ProtocolID, DataCodingScheme: opts.DataCodingScheme, UseProtocolID: opts.UseProtocolID, UseDataCodingScheme: opts.UseDataCodingScheme, ReplyPath: opts.ReplyPath, RejectDuplicates: opts.RejectDuplicates, ApplicationDestPort: opts.ApplicationDestPort, ApplicationSourcePort: opts.ApplicationSourcePort, ApplicationPortBits: portBits, SingleShiftLang: opts.SingleShiftLang, LockingShiftLang: opts.LockingShiftLang}}, nil
	}
	refBits, err := validateSMSConcatOptions(opts.ConcatRef, opts.ConcatRefBits)
	if err != nil {
		return nil, err
	}
	ref := opts.ConcatRef
	if ref == 0 {
		ref = nextSMSConcatRef(refBits)
	}
	concatUDHLen := smsSubmitUDHLength(hasPorts, portBits, true, refBits, opts.SingleShiftLang, opts.LockingShiftLang)
	concat := smsPartLimitForUDH(enc, concatUDHLen)
	if concat <= 0 {
		return nil, fmt.Errorf("sms UDH leaves no room for %s payload", enc)
	}
	total := int(math.Ceil(float64(messageLenWithLanguage(text, enc, opts.LockingShiftLang, opts.SingleShiftLang)) / float64(concat)))
	if total <= 0 {
		total = 1
	}
	if total > 255 {
		return nil, fmt.Errorf("sms message requires %d parts; maximum is 255", total)
	}
	out := make([]SMSPart, 0, total)
	remaining := text
	for partNo := 1; remaining != ""; partNo++ {
		chunk, rest := takeSMSChunkWithLanguage(remaining, enc, concat, opts.LockingShiftLang, opts.SingleShiftLang)
		udh, err := buildSMSSubmitUDH(hasPorts, opts.ApplicationDestPort, opts.ApplicationSourcePort, portBits, ref, refBits, total, partNo, opts.SingleShiftLang, opts.LockingShiftLang)
		if err != nil {
			return nil, err
		}
		out = append(out, SMSPart{PartNo: partNo, TotalParts: total, Text: chunk, Encoding: enc, UDH: udh, ValidityPeriod: opts.ValidityPeriod, ValidityDeadline: opts.ValidityDeadline, ProtocolID: opts.ProtocolID, DataCodingScheme: opts.DataCodingScheme, UseProtocolID: opts.UseProtocolID, UseDataCodingScheme: opts.UseDataCodingScheme, ReplyPath: opts.ReplyPath, RejectDuplicates: opts.RejectDuplicates, ConcatRef: ref, ConcatRefBits: refBits, ApplicationDestPort: opts.ApplicationDestPort, ApplicationSourcePort: opts.ApplicationSourcePort, ApplicationPortBits: portBits, SingleShiftLang: opts.SingleShiftLang, LockingShiftLang: opts.LockingShiftLang})
		remaining = rest
	}
	for i := range out {
		out[i].TotalParts = len(out)
		udh, err := buildSMSSubmitUDH(hasPorts, opts.ApplicationDestPort, opts.ApplicationSourcePort, portBits, ref, refBits, len(out), out[i].PartNo, opts.SingleShiftLang, opts.LockingShiftLang)
		if err != nil {
			return nil, err
		}
		out[i].UDH = udh
	}
	return out, nil
}

func normalizeEncoding(text, requested string) string {
	req := strings.ToLower(strings.TrimSpace(requested))
	switch req {
	case "gsm7", "7bit", "gsm-7":
		return "gsm7"
	case "ucs2", "utf16":
		return "ucs2"
	case "utf8":
		return "utf8"
	}
	if isGSM7Text(text) {
		return "gsm7"
	}
	return "ucs2"
}

func normalizeSMSSubmitEncodingWithLanguage(text, requested string, dcs byte, hasDCS bool, lockingLang, singleLang int) (string, error) {
	encodingRequested := strings.TrimSpace(requested) != ""
	if encodingRequested || hasDCS {
		return normalizeSMSSubmitEncoding(text, requested, dcs, hasDCS)
	}
	if _, ok := gsm7SeptetLenWithLanguage(text, lockingLang, singleLang); ok {
		return "gsm7", nil
	}
	return normalizeSMSSubmitEncoding(text, requested, dcs, hasDCS)
}

func smsPartLimits(encoding string) (single int, concat int) {
	return smsPartLimitsForUDH(encoding, 6)
}

func smsPartLimitsForUDH(encoding string, udhBytes int) (single int, concat int) {
	return smsPartLimitForUDH(encoding, 0), smsPartLimitForUDH(encoding, udhBytes)
}

func smsPartLimitForUDH(encoding string, udhBytes int) int {
	if udhBytes <= 0 {
		switch encoding {
		case "utf8":
			return 140
		case "ucs2":
			return 70
		default:
			return 160
		}
	}
	switch encoding {
	case "gsm7":
		headerSeptets := (udhBytes*8 + 6) / 7
		return 160 - headerSeptets
	case "utf8":
		return 140 - udhBytes
	default:
		return (140 - udhBytes) / 2
	}
}

func messageLen(text, encoding string) int {
	return messageLenWithLanguage(text, encoding, 0, 0)
}

func messageLenWithLanguage(text, encoding string, lockingLang, singleLang int) int {
	if encoding == "utf8" {
		return len([]byte(text))
	}
	if encoding == "gsm7" {
		if septets, ok := gsm7SeptetLenWithLanguage(text, lockingLang, singleLang); ok {
			return septets
		}
		return utf8.RuneCountInString(text)
	}
	return len(utf16.Encode([]rune(text)))
}

func takeSMSChunk(text, encoding string, limit int) (string, string) {
	return takeSMSChunkWithLanguage(text, encoding, limit, 0, 0)
}

func takeSMSChunkWithLanguage(text, encoding string, limit int, lockingLang, singleLang int) (string, string) {
	if encoding == "utf8" {
		if len(text) <= limit {
			return text, ""
		}
		i := 0
		for pos := range text {
			if pos > limit {
				break
			}
			i = pos
		}
		if i <= 0 {
			_, size := utf8.DecodeRuneInString(text)
			i = size
		}
		return text[:i], text[i:]
	}
	if encoding == "gsm7" {
		return takeGSM7ChunkWithLanguage(text, limit, lockingLang, singleLang)
	}
	if encoding == "ucs2" {
		return takeUCS2Chunk(text, limit)
	}
	runes := []rune(text)
	if len(runes) <= limit {
		return text, ""
	}
	return string(runes[:limit]), string(runes[limit:])
}

func takeUCS2Chunk(text string, limit int) (string, string) {
	if text == "" || limit <= 0 {
		return "", text
	}
	used := 0
	end := 0
	for pos, r := range text {
		units := 1
		if r > 0xffff {
			units = 2
		}
		if used > 0 && used+units > limit {
			break
		}
		used += units
		_, size := utf8.DecodeRuneInString(text[pos:])
		end = pos + size
		if used >= limit {
			break
		}
	}
	if end <= 0 {
		_, size := utf8.DecodeRuneInString(text)
		end = size
	}
	return text[:end], text[end:]
}

func concatUDH(total, partNo int) []byte {
	udh, _ := concatUDHWithRef(1, 8, total, partNo)
	return udh
}

func concatUDHWithRef(ref, refBits, total, partNo int) ([]byte, error) {
	elem, err := smsConcatUDHElement(ref, refBits, total, partNo)
	if err != nil || elem == nil {
		return elem, err
	}
	return smsUDHFromElements(elem), nil
}

func smsConcatUDHElement(ref, refBits, total, partNo int) ([]byte, error) {
	if total <= 1 {
		return nil, nil
	}
	if total > 255 {
		return nil, fmt.Errorf("sms concat total parts out of range: %d", total)
	}
	if partNo <= 0 || partNo > total {
		return nil, fmt.Errorf("sms concat part number %d out of range for %d parts", partNo, total)
	}
	switch refBits {
	case 8:
		if ref < 0 || ref > 0xff {
			return nil, fmt.Errorf("sms 8-bit concat reference out of range: %d", ref)
		}
		return []byte{0x00, 0x03, byte(ref), byte(total), byte(partNo)}, nil
	case 16:
		if ref < 0 || ref > 0xffff {
			return nil, fmt.Errorf("sms 16-bit concat reference out of range: %d", ref)
		}
		return []byte{0x08, 0x04, byte(ref >> 8), byte(ref), byte(total), byte(partNo)}, nil
	default:
		return nil, fmt.Errorf("unsupported sms concat reference size: %d", refBits)
	}
}

func smsUDHFromElements(elements ...[]byte) []byte {
	total := 0
	for _, elem := range elements {
		total += len(elem)
	}
	if total == 0 {
		return nil
	}
	udh := make([]byte, 0, 1+total)
	udh = append(udh, byte(total))
	for _, elem := range elements {
		udh = append(udh, elem...)
	}
	return udh
}

func buildSMSSubmitUDHForPart(part SMSPart) ([]byte, error) {
	if err := validateSMSNationalLanguageOptions(part.SingleShiftLang, part.LockingShiftLang); err != nil {
		return nil, err
	}
	portBits, hasPorts, err := validateSMSApplicationPortOptions(part.ApplicationDestPort, part.ApplicationSourcePort, part.ApplicationPortBits)
	if err != nil {
		return nil, err
	}
	if !hasPorts && part.SingleShiftLang == 0 && part.LockingShiftLang == 0 {
		return nil, nil
	}
	return buildSMSSubmitUDH(hasPorts, part.ApplicationDestPort, part.ApplicationSourcePort, portBits, 0, 0, 1, 1, part.SingleShiftLang, part.LockingShiftLang)
}

func buildSMSSubmitUDH(hasPorts bool, destPort, sourcePort, portBits, ref, refBits, total, partNo, singleLang, lockingLang int) ([]byte, error) {
	var elements [][]byte
	if err := validateSMSNationalLanguageOptions(singleLang, lockingLang); err != nil {
		return nil, err
	}
	if singleLang != 0 {
		elements = append(elements, []byte{smsUDHIEINationalLanguageSingleShift, 0x01, byte(singleLang)})
	}
	if lockingLang != 0 {
		elements = append(elements, []byte{smsUDHIEINationalLanguageLockingShift, 0x01, byte(lockingLang)})
	}
	if hasPorts {
		elem, err := smsApplicationPortUDHElement(destPort, sourcePort, portBits)
		if err != nil {
			return nil, err
		}
		elements = append(elements, elem)
	}
	if total > 1 {
		elem, err := smsConcatUDHElement(ref, refBits, total, partNo)
		if err != nil {
			return nil, err
		}
		elements = append(elements, elem)
	}
	return smsUDHFromElements(elements...), nil
}

func smsSubmitUDHLength(hasPorts bool, portBits int, hasConcat bool, concatRefBits, singleLang, lockingLang int) int {
	bodyLen := 0
	if singleLang != 0 {
		bodyLen += 3
	}
	if lockingLang != 0 {
		bodyLen += 3
	}
	if hasPorts {
		if portBits == 8 {
			bodyLen += 4
		} else {
			bodyLen += 6
		}
	}
	if hasConcat {
		if concatRefBits == 16 {
			bodyLen += 6
		} else {
			bodyLen += 5
		}
	}
	if bodyLen == 0 {
		return 0
	}
	return 1 + bodyLen
}

func validateSMSNationalLanguageOptions(singleLang, lockingLang int) error {
	if singleLang < 0 || lockingLang < 0 {
		return fmt.Errorf("sms national language identifier out of range: single=%d locking=%d", singleLang, lockingLang)
	}
	if singleLang != 0 && !smsNationalLanguageIdentifierKnown(singleLang) {
		return fmt.Errorf("unsupported sms national single shift language identifier: %d", singleLang)
	}
	if lockingLang != 0 && !smsNationalLanguageIdentifierKnown(lockingLang) {
		return fmt.Errorf("unsupported sms national locking shift language identifier: %d", lockingLang)
	}
	return nil
}

func smsApplicationPortUDHElement(destPort, sourcePort, portBits int) ([]byte, error) {
	portBits, hasPorts, err := validateSMSApplicationPortOptions(destPort, sourcePort, portBits)
	if err != nil || !hasPorts {
		return nil, err
	}
	if portBits == 8 {
		return []byte{0x04, 0x02, byte(destPort), byte(sourcePort)}, nil
	}
	return []byte{0x05, 0x04, byte(destPort >> 8), byte(destPort), byte(sourcePort >> 8), byte(sourcePort)}, nil
}

func validateSMSApplicationPortOptions(destPort, sourcePort, portBits int) (int, bool, error) {
	hasPorts := destPort != 0 || sourcePort != 0 || portBits != 0
	if !hasPorts {
		return 0, false, nil
	}
	if destPort < 0 || sourcePort < 0 {
		return 0, false, fmt.Errorf("sms application port out of range: dest=%d source=%d", destPort, sourcePort)
	}
	switch portBits {
	case 0:
		if destPort <= 0xff && sourcePort <= 0xff {
			portBits = 8
		} else {
			portBits = 16
		}
	case 8, 16:
	default:
		return 0, false, fmt.Errorf("unsupported sms application port size: %d", portBits)
	}
	maxPort := 0xffff
	if portBits == 8 {
		maxPort = 0xff
	}
	if destPort > maxPort || sourcePort > maxPort {
		return 0, false, fmt.Errorf("sms %d-bit application port out of range: dest=%d source=%d", portBits, destPort, sourcePort)
	}
	return portBits, true, nil
}

func concatUDHLength(refBits int) int {
	if refBits == 16 {
		return 7
	}
	return 6
}

func validateSMSConcatOptions(ref, refBits int) (int, error) {
	if ref < 0 {
		return 0, fmt.Errorf("sms concat reference out of range: %d", ref)
	}
	bits := normalizeSMSConcatRefBits(ref, refBits)
	switch bits {
	case 8:
		if ref > 0xff {
			return 0, fmt.Errorf("sms 8-bit concat reference out of range: %d", ref)
		}
	case 16:
		if ref > 0xffff {
			return 0, fmt.Errorf("sms 16-bit concat reference out of range: %d", ref)
		}
	default:
		return 0, fmt.Errorf("unsupported sms concat reference size: %d", refBits)
	}
	return bits, nil
}

func normalizeSMSConcatRefBits(ref, refBits int) int {
	switch refBits {
	case 8, 16:
		return refBits
	case 0:
		if ref > 0xff {
			return 16
		}
		return 8
	default:
		return refBits
	}
}

func nextSMSConcatRef(refBits int) int {
	n := smsConcatRefCounter.Add(1)
	if refBits == 16 {
		return int(n%0xffff) + 1
	}
	return int(n%0xff) + 1
}

func isGSM7Text(text string) bool {
	_, ok := gsm7SeptetLen(text)
	return ok
}

const gsm7Alphabet = "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞ !\"#¤%&'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà"

func firstNonEmpty(items ...string) string {
	for _, item := range items {
		if strings.TrimSpace(item) != "" {
			return strings.TrimSpace(item)
		}
	}
	return ""
}

func normalizeDeliveryReportState(state string, sipCode int, rpCause int) string {
	state = strings.ToLower(strings.TrimSpace(state))
	switch state {
	case "delivered", "failed", "sent", "accepted":
		return state
	}
	if rpCause != 0 {
		return "failed"
	}
	if sipCode >= 200 && sipCode < 300 {
		return "delivered"
	}
	if sipCode >= 300 {
		return "failed"
	}
	return "delivered"
}

func normalizeUSSDResult(res USSDResult, sessionID string) USSDResult {
	if strings.TrimSpace(res.SessionID) == "" {
		res.SessionID = sessionID
	}
	if res.Text == "" && res.RawText != "" {
		res.Text = res.RawText
	}
	return res
}

func (s *Service) recordUSSDSession(res USSDResult) {
	if s == nil || strings.TrimSpace(res.SessionID) == "" {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if res.Done {
		delete(s.ussdSessions, res.SessionID)
		return
	}
	if s.ussdSessions == nil {
		s.ussdSessions = make(map[string]USSDResult)
	}
	s.ussdSessions[res.SessionID] = res
}

func (s *Service) dispatchUSSDUpdated(ctx context.Context, res USSDResult) {
	if s == nil || s.dispatch == nil || strings.TrimSpace(res.SessionID) == "" {
		return
	}
	s.dispatch.Dispatch(ctx, eventhost.USSDUpdated{
		DevID:     s.deviceID,
		SessionID: res.SessionID,
		Text:      res.Text,
		RawText:   res.RawText,
		Status:    res.Status,
		DCS:       res.DCS,
		Done:      res.Done,
		Time:      time.Now(),
	})
}

func (s *Service) hasUSSDSession(sessionID string) bool {
	if s == nil {
		return false
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	_, ok := s.ussdSessions[sessionID]
	return ok
}

func (s *Service) clearUSSDSession(sessionID string) {
	if s == nil {
		return
	}
	s.mu.Lock()
	delete(s.ussdSessions, sessionID)
	s.mu.Unlock()
}
