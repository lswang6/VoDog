package messaging

import (
	"sort"
	"strings"
	"time"

	"github.com/boa-z/vowifi-go/runtimehost/voiceclient"
)

type IMSMessagingRetryOperation string

const (
	IMSMessagingRetryOperationSMSSubmit   IMSMessagingRetryOperation = "sms-submit"
	IMSMessagingRetryOperationUSSDSession IMSMessagingRetryOperation = "ussd-session"
)

type IMSMessagingRetryClass string

const (
	IMSMessagingRetryClassAccepted         IMSMessagingRetryClass = "accepted"
	IMSMessagingRetryClassSuccess          IMSMessagingRetryClass = "success"
	IMSMessagingRetryClassRedirect         IMSMessagingRetryClass = "redirect"
	IMSMessagingRetryClassAuthentication   IMSMessagingRetryClass = "authentication"
	IMSMessagingRetryClassClientFailure    IMSMessagingRetryClass = "client-failure"
	IMSMessagingRetryClassThrottled        IMSMessagingRetryClass = "throttled"
	IMSMessagingRetryClassServerFailure    IMSMessagingRetryClass = "server-failure"
	IMSMessagingRetryClassSIPTimeout       IMSMessagingRetryClass = "sip-timeout"
	IMSMessagingRetryClassTransportFailure IMSMessagingRetryClass = "transport-failure"
	IMSMessagingRetryClassUnknown          IMSMessagingRetryClass = "unknown"
)

type IMSMessagingRetryAction string

const (
	IMSMessagingRetryActionNone                  IMSMessagingRetryAction = "none"
	IMSMessagingRetryActionRetry                 IMSMessagingRetryAction = "retry"
	IMSMessagingRetryActionRetryAfter            IMSMessagingRetryAction = "retry-after"
	IMSMessagingRetryActionRefreshAuthentication IMSMessagingRetryAction = "refresh-authentication"
	IMSMessagingRetryActionRecoverRegistration   IMSMessagingRetryAction = "recover-registration"
	IMSMessagingRetryActionFailoverTarget        IMSMessagingRetryAction = "failover-target"
)

type IMSMessagingRetryPolicy struct {
	MaxAttempts int           `json:"max_attempts,omitempty"`
	BaseDelay   time.Duration `json:"base_delay,omitempty"`
	MaxDelay    time.Duration `json:"max_delay,omitempty"`
}

type IMSMessagingRetryOptions struct {
	Method         string
	Attempt        int
	Policy         IMSMessagingRetryPolicy
	Now            time.Time
	IdempotencyKey string
	SessionKey     string
}

type IMSMessagingRetryInput struct {
	Operation      IMSMessagingRetryOperation
	Method         string
	Response       voiceclient.SIPResponse
	Err            error
	Attempt        int
	Policy         IMSMessagingRetryPolicy
	Now            time.Time
	IdempotencyKey string
	SessionKey     string
}

// IMSMessagingRetryPlan is intentionally durable: it contains no function
// pointers or transient transport state, so callers can JSON-encode and replay
// the decision from a local queue.
type IMSMessagingRetryPlan struct {
	Operation                         IMSMessagingRetryOperation `json:"operation"`
	Method                            string                     `json:"method,omitempty"`
	StatusCode                        int                        `json:"status_code,omitempty"`
	Class                             IMSMessagingRetryClass     `json:"class"`
	Action                            IMSMessagingRetryAction    `json:"action"`
	Retry                             bool                       `json:"retry"`
	Terminal                          bool                       `json:"terminal"`
	Durable                           bool                       `json:"durable"`
	Attempt                           int                        `json:"attempt"`
	NextAttempt                       int                        `json:"next_attempt,omitempty"`
	MaxAttempts                       int                        `json:"max_attempts"`
	Delay                             time.Duration              `json:"delay,omitempty"`
	RetryAfter                        time.Duration              `json:"retry_after,omitempty"`
	RetryAfterPresent                 bool                       `json:"retry_after_present,omitempty"`
	NextAttemptAt                     time.Time                  `json:"next_attempt_at,omitempty"`
	RetryKey                          string                     `json:"retry_key,omitempty"`
	IdempotencyKey                    string                     `json:"idempotency_key,omitempty"`
	SessionKey                        string                     `json:"session_key,omitempty"`
	TargetURI                         string                     `json:"target_uri,omitempty"`
	TargetFailover                    bool                       `json:"target_failover,omitempty"`
	RegistrationRecoveryNeeded        bool                       `json:"registration_recovery_needed,omitempty"`
	AuthenticationRefresh             bool                       `json:"authentication_refresh,omitempty"`
	AuthenticationChallengeHeader     string                     `json:"authentication_challenge_header,omitempty"`
	AuthenticationChallenge           string                     `json:"authentication_challenge,omitempty"`
	AuthenticationAuthorizationHeader string                     `json:"authentication_authorization_header,omitempty"`
	TransportFailure                  bool                       `json:"transport_failure,omitempty"`
	TimedOut                          bool                       `json:"timed_out,omitempty"`
	FinalResponseTimeout              bool                       `json:"final_response_timeout,omitempty"`
	DuplicateRisk                     bool                       `json:"duplicate_risk,omitempty"`
	Reason                            string                     `json:"reason,omitempty"`
}

type IMSMessagingRetryQueueState string

const (
	IMSMessagingRetryQueueStatePending  IMSMessagingRetryQueueState = "pending"
	IMSMessagingRetryQueueStateTerminal IMSMessagingRetryQueueState = "terminal"
)

type IMSMessagingRetryPayload struct {
	SMSSubmit *SMSSendRequest `json:"sms_submit,omitempty"`
	USSD      *USSDRequest    `json:"ussd,omitempty"`
}

type IMSMessagingRetryEnvelope struct {
	Version        int                         `json:"version"`
	Key            string                      `json:"key"`
	Operation      IMSMessagingRetryOperation  `json:"operation"`
	Method         string                      `json:"method,omitempty"`
	State          IMSMessagingRetryQueueState `json:"state"`
	Attempt        int                         `json:"attempt"`
	NextAttempt    int                         `json:"next_attempt,omitempty"`
	IdempotencyKey string                      `json:"idempotency_key,omitempty"`
	SessionKey     string                      `json:"session_key,omitempty"`
	DueAt          time.Time                   `json:"due_at,omitempty"`
	CreatedAt      time.Time                   `json:"created_at,omitempty"`
	UpdatedAt      time.Time                   `json:"updated_at,omitempty"`
	TerminalAt     time.Time                   `json:"terminal_at,omitempty"`
	LastError      string                      `json:"last_error,omitempty"`
	Plan           IMSMessagingRetryPlan       `json:"plan"`
	Payload        IMSMessagingRetryPayload    `json:"payload,omitempty"`
}

type IMSMessagingRetryQueue struct {
	Envelopes []IMSMessagingRetryEnvelope `json:"envelopes,omitempty"`
}

func DefaultIMSMessagingRetryPolicy() IMSMessagingRetryPolicy {
	return IMSMessagingRetryPolicy{
		MaxAttempts: 4,
		BaseDelay:   time.Second,
		MaxDelay:    5 * time.Minute,
	}
}

func NewIMSSMSSubmitRetryEnvelope(req SMSSendRequest, result SMSSendResult, err error, opts IMSMessagingRetryOptions) IMSMessagingRetryEnvelope {
	plan := PlanIMSSMSSubmitRetry(req, result, err, opts)
	return NewIMSMessagingRetryEnvelope(plan, IMSMessagingRetryPayload{SMSSubmit: &req}, opts.Now)
}

func NewIMSUSSDSessionRetryEnvelope(req USSDRequest, result USSDResult, err error, opts IMSMessagingRetryOptions) IMSMessagingRetryEnvelope {
	plan := PlanIMSUSSDSessionRetry(req, result, err, opts)
	return NewIMSMessagingRetryEnvelope(plan, IMSMessagingRetryPayload{USSD: &req}, opts.Now)
}

func NewIMSMessagingRetryEnvelope(plan IMSMessagingRetryPlan, payload IMSMessagingRetryPayload, now time.Time) IMSMessagingRetryEnvelope {
	operation := normalizeIMSMessagingRetryOperation(plan.Operation)
	method := normalizeIMSMessagingRetryMethod(plan.Method, operation)
	idempotencyKey := strings.TrimSpace(plan.IdempotencyKey)
	sessionKey := strings.TrimSpace(plan.SessionKey)
	key := strings.TrimSpace(plan.RetryKey)
	if operation == IMSMessagingRetryOperationSMSSubmit && payload.SMSSubmit != nil {
		if idempotencyKey == "" {
			idempotencyKey = IMSMessagingSMSSubmitIdempotencyKey(*payload.SMSSubmit)
		}
		if key == "" {
			key = idempotencyKey
		}
	}
	if operation == IMSMessagingRetryOperationUSSDSession && payload.USSD != nil {
		if sessionKey == "" {
			sessionKey = IMSMessagingUSSDSessionKey(*payload.USSD)
		}
		if key == "" {
			key = sessionKey
		}
	}
	state := IMSMessagingRetryQueueStateTerminal
	dueAt := time.Time{}
	terminalAt := time.Time{}
	if plan.Retry && !plan.Terminal && key != "" {
		state = IMSMessagingRetryQueueStatePending
		dueAt = plan.NextAttemptAt
		if dueAt.IsZero() && !now.IsZero() {
			dueAt = now.Add(plan.Delay)
		}
	} else if !now.IsZero() {
		terminalAt = now
	}
	return IMSMessagingRetryEnvelope{
		Version:        1,
		Key:            key,
		Operation:      operation,
		Method:         method,
		State:          state,
		Attempt:        plan.Attempt,
		NextAttempt:    plan.NextAttempt,
		IdempotencyKey: idempotencyKey,
		SessionKey:     sessionKey,
		DueAt:          dueAt,
		CreatedAt:      now,
		UpdatedAt:      now,
		TerminalAt:     terminalAt,
		LastError:      strings.TrimSpace(plan.Reason),
		Plan:           plan,
		Payload:        payload,
	}
}

func (e IMSMessagingRetryEnvelope) Pending() bool {
	return e.State == IMSMessagingRetryQueueStatePending && e.Plan.Retry && !e.Plan.Terminal && strings.TrimSpace(e.Key) != ""
}

func (e IMSMessagingRetryEnvelope) Terminal() bool {
	return e.State == IMSMessagingRetryQueueStateTerminal || e.Plan.Terminal || !e.Plan.Retry
}

func (e IMSMessagingRetryEnvelope) Due(now time.Time) bool {
	if !e.Pending() || !e.hasReplayPayload() {
		return false
	}
	if e.DueAt.IsZero() {
		return true
	}
	if now.IsZero() {
		return false
	}
	return !e.DueAt.After(now)
}

func (e IMSMessagingRetryEnvelope) ReplayReady(now time.Time) bool {
	return e.Due(now)
}

func (e IMSMessagingRetryEnvelope) SMSSubmitRequest() (SMSSendRequest, bool) {
	if e.Operation != IMSMessagingRetryOperationSMSSubmit || e.Payload.SMSSubmit == nil {
		return SMSSendRequest{}, false
	}
	return *e.Payload.SMSSubmit, true
}

func (e IMSMessagingRetryEnvelope) USSDRequest() (USSDRequest, bool) {
	if e.Operation != IMSMessagingRetryOperationUSSDSession || e.Payload.USSD == nil {
		return USSDRequest{}, false
	}
	return *e.Payload.USSD, true
}

func (q *IMSMessagingRetryQueue) Upsert(envelope IMSMessagingRetryEnvelope) {
	if q == nil || strings.TrimSpace(envelope.Key) == "" {
		return
	}
	q.Delete(envelope.Operation, envelope.Key)
	if envelope.Terminal() || !envelope.hasReplayPayload() {
		return
	}
	q.Envelopes = append(q.Envelopes, envelope)
	sort.SliceStable(q.Envelopes, func(i, j int) bool {
		return imsMessagingRetryEnvelopeLess(q.Envelopes[i], q.Envelopes[j])
	})
}

func (q *IMSMessagingRetryQueue) Delete(operation IMSMessagingRetryOperation, key string) {
	if q == nil {
		return
	}
	key = strings.TrimSpace(key)
	if key == "" {
		return
	}
	out := q.Envelopes[:0]
	for _, envelope := range q.Envelopes {
		if envelope.retryQueueKeyMatches(operation, key) {
			continue
		}
		out = append(out, envelope)
	}
	q.Envelopes = out
}

func (q IMSMessagingRetryQueue) Due(now time.Time, limit int) []IMSMessagingRetryEnvelope {
	return SelectDueIMSMessagingRetryEnvelopes(q.Envelopes, now, limit)
}

func SelectDueIMSMessagingRetryEnvelopes(envelopes []IMSMessagingRetryEnvelope, now time.Time, limit int) []IMSMessagingRetryEnvelope {
	if len(envelopes) == 0 {
		return nil
	}
	out := make([]IMSMessagingRetryEnvelope, 0, len(envelopes))
	for _, envelope := range envelopes {
		if envelope.Due(now) {
			out = append(out, envelope)
		}
	}
	sort.SliceStable(out, func(i, j int) bool {
		return imsMessagingRetryEnvelopeLess(out[i], out[j])
	})
	if limit > 0 && len(out) > limit {
		out = out[:limit]
	}
	return out
}

func PlanIMSSMSSubmitRetry(req SMSSendRequest, result SMSSendResult, err error, opts IMSMessagingRetryOptions) IMSMessagingRetryPlan {
	idempotencyKey := strings.TrimSpace(opts.IdempotencyKey)
	if idempotencyKey == "" {
		idempotencyKey = IMSMessagingSMSSubmitIdempotencyKey(req)
	}
	resp := voiceclient.SIPResponse{
		StatusCode: result.SIPCode,
		Reason:     result.ErrorText,
		RetryAfter: result.RetryAfter,
	}
	return PlanIMSMessagingRetry(IMSMessagingRetryInput{
		Operation:      IMSMessagingRetryOperationSMSSubmit,
		Method:         firstNonEmpty(opts.Method, "MESSAGE"),
		Response:       resp,
		Err:            err,
		Attempt:        opts.Attempt,
		Policy:         opts.Policy,
		Now:            opts.Now,
		IdempotencyKey: idempotencyKey,
		SessionKey:     opts.SessionKey,
	})
}

func PlanIMSUSSDSessionRetry(req USSDRequest, result USSDResult, err error, opts IMSMessagingRetryOptions) IMSMessagingRetryPlan {
	sessionKey := strings.TrimSpace(opts.SessionKey)
	if sessionKey == "" {
		sessionKey = IMSMessagingUSSDSessionKey(req)
	}
	resp := voiceclient.SIPResponse{
		StatusCode: result.Status,
		RetryAfter: result.RetryAfter,
	}
	method := firstNonEmpty(opts.Method, defaultUSSDRetryMethod(req))
	return PlanIMSMessagingRetry(IMSMessagingRetryInput{
		Operation:      IMSMessagingRetryOperationUSSDSession,
		Method:         method,
		Response:       resp,
		Err:            err,
		Attempt:        opts.Attempt,
		Policy:         opts.Policy,
		Now:            opts.Now,
		IdempotencyKey: opts.IdempotencyKey,
		SessionKey:     sessionKey,
	})
}

func PlanIMSMessagingRetry(input IMSMessagingRetryInput) IMSMessagingRetryPlan {
	policy := normalizeIMSMessagingRetryPolicy(input.Policy)
	attempt := input.Attempt
	if attempt <= 0 {
		attempt = 1
	}
	operation := normalizeIMSMessagingRetryOperation(input.Operation)
	method := normalizeIMSMessagingRetryMethod(input.Method, operation)
	plan := IMSMessagingRetryPlan{
		Operation:      operation,
		Method:         method,
		Class:          IMSMessagingRetryClassUnknown,
		Action:         IMSMessagingRetryActionNone,
		Terminal:       true,
		Attempt:        attempt,
		MaxAttempts:    policy.MaxAttempts,
		IdempotencyKey: strings.TrimSpace(input.IdempotencyKey),
		SessionKey:     strings.TrimSpace(input.SessionKey),
	}
	plan.RetryKey = firstNonEmpty(plan.IdempotencyKey, plan.SessionKey)

	if input.Response.StatusCode != 0 {
		recovery := ClassifyIMSMessagingSIPResponseRecovery(method, input.Response)
		plan.Method = firstNonEmpty(recovery.Method, method)
		plan.StatusCode = recovery.StatusCode
		plan.RetryAfter = recovery.RetryAfter
		plan.RetryAfterPresent = recovery.RetryAfterPresent
		plan.TargetURI = firstNonEmpty(recovery.RedirectURI, firstIMSMessagingRecoveryTarget(recovery.Candidates))
		plan.TargetFailover = recovery.TargetFailover
		plan.RegistrationRecoveryNeeded = recovery.RegistrationRecoveryNeeded
		plan.AuthenticationRefresh = recovery.AuthenticationRefresh
		plan.AuthenticationChallengeHeader = recovery.AuthenticationChallengeHeader
		plan.AuthenticationChallenge = recovery.AuthenticationChallenge
		plan.AuthenticationAuthorizationHeader = recovery.AuthenticationAuthorizationHeader
		plan.TimedOut = recovery.StatusCode == 408
		plan.Class = classifyIMSMessagingRetryResponse(recovery)
		plan.Reason = firstNonEmpty(recovery.FailureText, imsMessagingRetryErrorText(input.Err))
		completeIMSMessagingRetryPlan(&plan, imsMessagingRetryableResponse(plan.Class, recovery), policy, input.Now)
		return plan
	}

	if input.Err != nil {
		recovery := voiceclient.SIPTransportRecoveryPlan(method, input.Err)
		plan.Method = firstNonEmpty(recovery.Method, method)
		plan.TransportFailure = recovery.TransportFailure
		plan.TargetFailover = recovery.TargetFailover
		plan.RegistrationRecoveryNeeded = recovery.RegistrationRequired
		plan.TimedOut = recovery.TimedOut
		plan.FinalResponseTimeout = recovery.FinalResponseTimeout
		plan.Class = IMSMessagingRetryClassTransportFailure
		if recovery.TimedOut {
			plan.Class = IMSMessagingRetryClassSIPTimeout
		}
		plan.Reason = input.Err.Error()
		completeIMSMessagingRetryPlan(&plan, recovery.Recoverable, policy, input.Now)
		return plan
	}

	completeIMSMessagingRetryPlan(&plan, false, policy, input.Now)
	return plan
}

func IMSMessagingSMSSubmitIdempotencyKey(req SMSSendRequest) string {
	partNo := req.Part.PartNo
	if partNo <= 0 {
		partNo = 1
	}
	base := strings.TrimSpace(req.MessageID)
	if base == "" {
		base = strings.TrimSpace(req.Peer)
	}
	if base == "" {
		base = "message"
	}
	return "sms-submit:" + smsToken(base) + ":part-" + intString(partNo)
}

func IMSMessagingUSSDSessionKey(req USSDRequest) string {
	base := strings.TrimSpace(req.SessionID)
	if base == "" {
		base = firstNonEmpty(strings.TrimSpace(req.Command), strings.TrimSpace(req.Input), "session")
	}
	return "ussd-session:" + smsToken(base)
}

func normalizeIMSMessagingRetryPolicy(policy IMSMessagingRetryPolicy) IMSMessagingRetryPolicy {
	out := DefaultIMSMessagingRetryPolicy()
	if policy.MaxAttempts > 0 {
		out.MaxAttempts = policy.MaxAttempts
	}
	if policy.BaseDelay > 0 {
		out.BaseDelay = policy.BaseDelay
	}
	if policy.MaxDelay > 0 {
		out.MaxDelay = policy.MaxDelay
	}
	if out.MaxDelay < out.BaseDelay {
		out.MaxDelay = out.BaseDelay
	}
	return out
}

func normalizeIMSMessagingRetryOperation(operation IMSMessagingRetryOperation) IMSMessagingRetryOperation {
	switch operation {
	case IMSMessagingRetryOperationSMSSubmit, IMSMessagingRetryOperationUSSDSession:
		return operation
	default:
		return IMSMessagingRetryOperationSMSSubmit
	}
}

func normalizeIMSMessagingRetryMethod(method string, operation IMSMessagingRetryOperation) string {
	method = strings.ToUpper(strings.TrimSpace(method))
	if method != "" {
		return method
	}
	if operation == IMSMessagingRetryOperationUSSDSession {
		return "INVITE"
	}
	return "MESSAGE"
}

func defaultUSSDRetryMethod(req USSDRequest) string {
	if strings.TrimSpace(req.Input) != "" {
		return "INFO"
	}
	return "INVITE"
}

func classifyIMSMessagingRetryResponse(recovery IMSMessagingSIPRecoveryDecision) IMSMessagingRetryClass {
	code := recovery.StatusCode
	switch {
	case code == 202:
		return IMSMessagingRetryClassAccepted
	case code >= 200 && code < 300:
		return IMSMessagingRetryClassSuccess
	case code >= 300 && code < 400:
		return IMSMessagingRetryClassRedirect
	case code == 401 || code == 407:
		return IMSMessagingRetryClassAuthentication
	case code == 408:
		return IMSMessagingRetryClassSIPTimeout
	case code == 429:
		return IMSMessagingRetryClassThrottled
	case code >= 500 && code < 600:
		return IMSMessagingRetryClassServerFailure
	case code >= 400 && code < 500:
		return IMSMessagingRetryClassClientFailure
	default:
		return IMSMessagingRetryClassUnknown
	}
}

func imsMessagingRetryableResponse(class IMSMessagingRetryClass, recovery IMSMessagingSIPRecoveryDecision) bool {
	switch class {
	case IMSMessagingRetryClassAccepted, IMSMessagingRetryClassSuccess:
		return false
	case IMSMessagingRetryClassRedirect:
		return recovery.TargetFailover || recovery.RedirectURI != "" || firstIMSMessagingRecoveryTarget(recovery.Candidates) != ""
	case IMSMessagingRetryClassAuthentication, IMSMessagingRetryClassSIPTimeout, IMSMessagingRetryClassThrottled, IMSMessagingRetryClassServerFailure:
		return true
	case IMSMessagingRetryClassClientFailure:
		return recovery.Recoverable || recovery.RegistrationRecoveryNeeded
	default:
		return recovery.Recoverable || recovery.RegistrationRecoveryNeeded
	}
}

func completeIMSMessagingRetryPlan(plan *IMSMessagingRetryPlan, retryable bool, policy IMSMessagingRetryPolicy, now time.Time) {
	plan.DuplicateRisk = plan.Operation == IMSMessagingRetryOperationSMSSubmit &&
		(plan.TransportFailure || plan.FinalResponseTimeout || (plan.TimedOut && plan.StatusCode == 0))
	if !retryable {
		plan.Retry = false
		plan.Terminal = true
		plan.Action = IMSMessagingRetryActionNone
		return
	}
	if policy.MaxAttempts > 0 && plan.Attempt >= policy.MaxAttempts {
		plan.Retry = false
		plan.Terminal = true
		plan.Action = IMSMessagingRetryActionNone
		if plan.Reason == "" {
			plan.Reason = "max attempts reached"
		}
		return
	}
	plan.Retry = true
	plan.Terminal = false
	plan.NextAttempt = plan.Attempt + 1
	if plan.RetryAfterPresent {
		plan.Delay = plan.RetryAfter
	} else {
		plan.Delay = imsMessagingRetryBackoffDelay(plan.Attempt, policy)
	}
	if plan.Delay < 0 {
		plan.Delay = 0
	}
	if !now.IsZero() {
		plan.NextAttemptAt = now.Add(plan.Delay)
	}
	plan.Action = imsMessagingRetryAction(*plan)
	plan.Durable = plan.RetryKey != ""
}

func imsMessagingRetryAction(plan IMSMessagingRetryPlan) IMSMessagingRetryAction {
	if !plan.Retry {
		return IMSMessagingRetryActionNone
	}
	switch {
	case plan.TargetFailover && plan.TargetURI != "":
		return IMSMessagingRetryActionFailoverTarget
	case plan.AuthenticationRefresh:
		return IMSMessagingRetryActionRefreshAuthentication
	case plan.RegistrationRecoveryNeeded:
		return IMSMessagingRetryActionRecoverRegistration
	case plan.RetryAfterPresent:
		return IMSMessagingRetryActionRetryAfter
	default:
		return IMSMessagingRetryActionRetry
	}
}

func imsMessagingRetryBackoffDelay(attempt int, policy IMSMessagingRetryPolicy) time.Duration {
	if attempt <= 1 {
		return policy.BaseDelay
	}
	delay := policy.BaseDelay
	for i := 1; i < attempt; i++ {
		if delay >= policy.MaxDelay/2 {
			return policy.MaxDelay
		}
		delay *= 2
		if delay >= policy.MaxDelay {
			return policy.MaxDelay
		}
	}
	return delay
}

func imsMessagingRetryErrorText(err error) string {
	if err == nil {
		return ""
	}
	return err.Error()
}

func (e IMSMessagingRetryEnvelope) hasReplayPayload() bool {
	switch e.Operation {
	case IMSMessagingRetryOperationSMSSubmit:
		return e.Payload.SMSSubmit != nil
	case IMSMessagingRetryOperationUSSDSession:
		return e.Payload.USSD != nil
	default:
		return false
	}
}

func (e IMSMessagingRetryEnvelope) retryQueueKeyMatches(operation IMSMessagingRetryOperation, key string) bool {
	if strings.TrimSpace(e.Key) != key {
		return false
	}
	return operation == "" || e.Operation == operation
}

func imsMessagingRetryEnvelopeLess(a, b IMSMessagingRetryEnvelope) bool {
	if a.DueAt.IsZero() != b.DueAt.IsZero() {
		return a.DueAt.IsZero()
	}
	if !a.DueAt.Equal(b.DueAt) {
		return a.DueAt.Before(b.DueAt)
	}
	if !a.CreatedAt.Equal(b.CreatedAt) {
		return a.CreatedAt.Before(b.CreatedAt)
	}
	if a.Operation != b.Operation {
		return a.Operation < b.Operation
	}
	return a.Key < b.Key
}

func intString(v int) string {
	if v == 0 {
		return "0"
	}
	var buf [20]byte
	i := len(buf)
	n := v
	neg := n < 0
	if neg {
		n = -n
	}
	for n > 0 {
		i--
		buf[i] = byte('0' + n%10)
		n /= 10
	}
	if neg {
		i--
		buf[i] = '-'
	}
	return string(buf[i:])
}
