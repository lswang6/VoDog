package voiceclient

import (
	"strings"
	"time"
)

const (
	defaultSIPTimerT1 = 500 * time.Millisecond
	defaultSIPTimerT2 = 4 * time.Second
	defaultSIPTimerT4 = 5 * time.Second
)

// SIPTransactionTimerConfig overrides the RFC 3261 transaction timer base values.
type SIPTransactionTimerConfig struct {
	T1 time.Duration
	T2 time.Duration
	T4 time.Duration
}

// SIPTransactionTimerPolicy describes the client transaction timers for a request method.
type SIPTransactionTimerPolicy struct {
	Method string
	Invite bool
	T1     time.Duration
	T2     time.Duration
	T4     time.Duration
	TimerA time.Duration
	TimerB time.Duration
	TimerD time.Duration
	TimerE time.Duration
	TimerF time.Duration
	TimerG time.Duration
	TimerH time.Duration
	TimerI time.Duration
	TimerJ time.Duration
	TimerK time.Duration
}

// SIPTransactionRetrySchedule describes UDP retransmission timing before timeout.
type SIPTransactionRetrySchedule struct {
	Method      string
	Invite      bool
	Intervals   []time.Duration
	Timeout     time.Duration
	CleanupWait time.Duration
}

type SIPClientTransactionState string

const (
	SIPClientTransactionStateCalling    SIPClientTransactionState = "calling"
	SIPClientTransactionStateTrying     SIPClientTransactionState = "trying"
	SIPClientTransactionStateProceeding SIPClientTransactionState = "proceeding"
	SIPClientTransactionStateCompleted  SIPClientTransactionState = "completed"
	SIPClientTransactionStateTerminated SIPClientTransactionState = "terminated"
)

type SIPClientTransactionEvent string

const (
	SIPClientTransactionEventResponse        SIPClientTransactionEvent = "response"
	SIPClientTransactionEventRetransmitTimer SIPClientTransactionEvent = "retransmit-timer"
	SIPClientTransactionEventTimeoutTimer    SIPClientTransactionEvent = "timeout-timer"
	SIPClientTransactionEventCleanupTimer    SIPClientTransactionEvent = "cleanup-timer"
)

type SIPClientTransactionAction string

const (
	SIPClientTransactionActionNone               SIPClientTransactionAction = "none"
	SIPClientTransactionActionWait               SIPClientTransactionAction = "wait"
	SIPClientTransactionActionRetransmitRequest  SIPClientTransactionAction = "retransmit-request"
	SIPClientTransactionActionDeliverProvisional SIPClientTransactionAction = "deliver-provisional"
	SIPClientTransactionActionDeliverFinal       SIPClientTransactionAction = "deliver-final"
	SIPClientTransactionActionTimeout            SIPClientTransactionAction = "timeout"
	SIPClientTransactionActionTerminate          SIPClientTransactionAction = "terminate"
)

// SIPClientTransactionInput describes one response or timer event for the pure
// client transaction state machine. ReliableTransport should be true for TCP/TLS
// style transports where RFC 3261 cleanup timers D/K are zero.
type SIPClientTransactionInput struct {
	Method                   string
	State                    SIPClientTransactionState
	Event                    SIPClientTransactionEvent
	Response                 SIPResponse
	ReliableTransport        bool
	LastRetransmitInterval   time.Duration
	TimerConfig              SIPTransactionTimerConfig
	MaxRetransmits           int
	CompletedRetransmissions int
}

// SIPClientTransactionStep is a non-executing decision for one client
// transaction event.
type SIPClientTransactionStep struct {
	Method                 string
	Invite                 bool
	Event                  SIPClientTransactionEvent
	State                  SIPClientTransactionState
	NextState              SIPClientTransactionState
	Action                 SIPClientTransactionAction
	StatusCode             int
	Provisional            bool
	Final                  bool
	Success                bool
	Failure                bool
	DeliverResponse        bool
	RetransmitRequest      bool
	SendAck                bool
	TimedOut               bool
	Terminated             bool
	CleanupAfter           time.Duration
	NextRetransmitInterval time.Duration
	TimerName              string
}

type SIPServerTransactionState string

const (
	SIPServerTransactionStateTrying     SIPServerTransactionState = "trying"
	SIPServerTransactionStateProceeding SIPServerTransactionState = "proceeding"
	SIPServerTransactionStateCompleted  SIPServerTransactionState = "completed"
	SIPServerTransactionStateConfirmed  SIPServerTransactionState = "confirmed"
	SIPServerTransactionStateTerminated SIPServerTransactionState = "terminated"
)

type SIPServerTransactionEvent string

const (
	SIPServerTransactionEventRequest         SIPServerTransactionEvent = "request"
	SIPServerTransactionEventResponse        SIPServerTransactionEvent = "response"
	SIPServerTransactionEventACK             SIPServerTransactionEvent = "ack"
	SIPServerTransactionEventRetransmitTimer SIPServerTransactionEvent = "retransmit-timer"
	SIPServerTransactionEventTimeoutTimer    SIPServerTransactionEvent = "timeout-timer"
	SIPServerTransactionEventCleanupTimer    SIPServerTransactionEvent = "cleanup-timer"
)

type SIPServerTransactionAction string

const (
	SIPServerTransactionActionNone               SIPServerTransactionAction = "none"
	SIPServerTransactionActionWait               SIPServerTransactionAction = "wait"
	SIPServerTransactionActionPassRequest        SIPServerTransactionAction = "pass-request"
	SIPServerTransactionActionSendResponse       SIPServerTransactionAction = "send-response"
	SIPServerTransactionActionRetransmitResponse SIPServerTransactionAction = "retransmit-response"
	SIPServerTransactionActionDeliverACK         SIPServerTransactionAction = "deliver-ack"
	SIPServerTransactionActionTimeout            SIPServerTransactionAction = "timeout"
	SIPServerTransactionActionTerminate          SIPServerTransactionAction = "terminate"
)

// SIPServerTransactionInput describes one request, TU response, ACK, or timer
// event for the pure server transaction state machine. Response is used as the
// outbound response for Response events and as the cached response for request
// retransmission or retransmit timer events.
type SIPServerTransactionInput struct {
	Method                 string
	State                  SIPServerTransactionState
	Event                  SIPServerTransactionEvent
	Response               SIPResponse
	ReliableTransport      bool
	RequestRetransmission  bool
	LastRetransmitInterval time.Duration
	TimerConfig            SIPTransactionTimerConfig
}

// SIPServerTransactionStep is a non-executing decision for one server
// transaction event.
type SIPServerTransactionStep struct {
	Method                 string
	Invite                 bool
	Event                  SIPServerTransactionEvent
	State                  SIPServerTransactionState
	NextState              SIPServerTransactionState
	Action                 SIPServerTransactionAction
	StatusCode             int
	Provisional            bool
	Final                  bool
	Success                bool
	Failure                bool
	PassRequest            bool
	SendResponse           bool
	RetransmitResponse     bool
	DeliverACK             bool
	TimedOut               bool
	Terminated             bool
	CleanupAfter           time.Duration
	TimeoutAfter           time.Duration
	NextRetransmitInterval time.Duration
	TimerName              string
}

// DefaultSIPTransactionTimerPolicy returns the default transaction timer policy.
func DefaultSIPTransactionTimerPolicy(method string) SIPTransactionTimerPolicy {
	return SIPTransactionTimerPolicyFor(method, SIPTransactionTimerConfig{})
}

// SIPTransactionTimerPolicyFor returns transaction timers using cfg base values.
func SIPTransactionTimerPolicyFor(method string, cfg SIPTransactionTimerConfig) SIPTransactionTimerPolicy {
	method = strings.ToUpper(strings.TrimSpace(method))
	t1 := cfg.T1
	if t1 <= 0 {
		t1 = defaultSIPTimerT1
	}
	t2 := cfg.T2
	if t2 <= 0 {
		t2 = defaultSIPTimerT2
	}
	if t2 < t1 {
		t2 = t1
	}
	t4 := cfg.T4
	if t4 <= 0 {
		t4 = defaultSIPTimerT4
	}
	policy := SIPTransactionTimerPolicy{
		Method: method,
		Invite: sipTransactionKindForMethod(method) == sipTransactionInvite,
		T1:     t1,
		T2:     t2,
		T4:     t4,
	}
	if policy.Invite {
		policy.TimerA = t1
		policy.TimerB = 64 * t1
		policy.TimerD = 64 * t1
		policy.TimerG = t1
		policy.TimerH = 64 * t1
		policy.TimerI = t4
		return policy
	}
	policy.TimerE = t1
	policy.TimerF = 64 * t1
	policy.TimerJ = 64 * t1
	policy.TimerK = t4
	return policy
}

// SIPTransactionRetryScheduleFor returns the retry schedule for a UDP client transaction.
func SIPTransactionRetryScheduleFor(method string, cfg SIPTransactionTimerConfig) SIPTransactionRetrySchedule {
	policy := SIPTransactionTimerPolicyFor(method, cfg)
	interval := policy.TimerE
	timeout := policy.TimerF
	cleanupWait := policy.TimerK
	if policy.Invite {
		interval = policy.TimerA
		timeout = policy.TimerB
		cleanupWait = 0
	}
	schedule := SIPTransactionRetrySchedule{
		Method:      policy.Method,
		Invite:      policy.Invite,
		Timeout:     timeout,
		CleanupWait: cleanupWait,
	}
	for elapsed := time.Duration(0); interval > 0 && elapsed+interval < timeout; {
		schedule.Intervals = append(schedule.Intervals, interval)
		elapsed += interval
		interval = nextSIPRetransmitInterval(interval, policy.T2)
	}
	return schedule
}

// InitialSIPClientTransactionState returns the RFC 3261 client transaction
// start state for method.
func InitialSIPClientTransactionState(method string) SIPClientTransactionState {
	if sipTransactionKindForMethod(method) == sipTransactionInvite {
		return SIPClientTransactionStateCalling
	}
	return SIPClientTransactionStateTrying
}

// InitialSIPServerTransactionState returns the RFC 3261 server transaction
// start state for method after the matching request is received.
func InitialSIPServerTransactionState(method string) SIPServerTransactionState {
	if sipTransactionKindForMethod(method) == sipTransactionInvite {
		return SIPServerTransactionStateProceeding
	}
	return SIPServerTransactionStateTrying
}

// AdvanceSIPClientTransaction advances a pure RFC 3261 client transaction state
// machine by one response or timer event. It does not write to the network.
func AdvanceSIPClientTransaction(input SIPClientTransactionInput) SIPClientTransactionStep {
	policy := SIPTransactionTimerPolicyFor(input.Method, input.TimerConfig)
	state := normalizeSIPClientTransactionState(input.State, policy.Method)
	event := input.Event
	if event == "" {
		event = SIPClientTransactionEventResponse
	}
	step := SIPClientTransactionStep{
		Method:    policy.Method,
		Invite:    policy.Invite,
		Event:     event,
		State:     state,
		NextState: state,
		Action:    SIPClientTransactionActionNone,
	}
	if state == SIPClientTransactionStateTerminated {
		step.Terminated = true
		return step
	}
	switch event {
	case SIPClientTransactionEventResponse:
		return advanceSIPClientTransactionResponse(step, input.Response, input.ReliableTransport, policy)
	case SIPClientTransactionEventRetransmitTimer:
		return advanceSIPClientTransactionRetransmitTimer(step, input.ReliableTransport, input.LastRetransmitInterval, input.MaxRetransmits, input.CompletedRetransmissions, policy)
	case SIPClientTransactionEventTimeoutTimer:
		return advanceSIPClientTransactionTimeoutTimer(step)
	case SIPClientTransactionEventCleanupTimer:
		return advanceSIPClientTransactionCleanupTimer(step)
	default:
		step.Action = SIPClientTransactionActionWait
		return step
	}
}

func advanceSIPClientTransactionResponse(step SIPClientTransactionStep, resp SIPResponse, reliable bool, policy SIPTransactionTimerPolicy) SIPClientTransactionStep {
	code := resp.StatusCode
	step.StatusCode = code
	step.Provisional = isSIPProvisionalResponse(code)
	step.Success = isSIPSuccess(code)
	step.Final = code >= 200
	step.Failure = code >= 300
	if code == 0 {
		step.Action = SIPClientTransactionActionWait
		return step
	}
	if step.Invite {
		return advanceSIPInviteClientTransactionResponse(step, reliable, policy)
	}
	return advanceSIPNonInviteClientTransactionResponse(step, reliable, policy)
}

func advanceSIPInviteClientTransactionResponse(step SIPClientTransactionStep, reliable bool, policy SIPTransactionTimerPolicy) SIPClientTransactionStep {
	switch {
	case step.Provisional:
		if step.State == SIPClientTransactionStateCalling || step.State == SIPClientTransactionStateProceeding {
			step.NextState = SIPClientTransactionStateProceeding
			step.Action = SIPClientTransactionActionDeliverProvisional
			step.DeliverResponse = true
			return step
		}
	case step.Success:
		if step.State == SIPClientTransactionStateCalling || step.State == SIPClientTransactionStateProceeding {
			step.NextState = SIPClientTransactionStateTerminated
			step.Action = SIPClientTransactionActionDeliverFinal
			step.DeliverResponse = true
			step.Terminated = true
			return step
		}
	case step.Failure:
		if step.State == SIPClientTransactionStateCompleted {
			step.Action = SIPClientTransactionActionDeliverFinal
			step.SendAck = true
			return step
		}
		if step.State == SIPClientTransactionStateCalling || step.State == SIPClientTransactionStateProceeding {
			step.Action = SIPClientTransactionActionDeliverFinal
			step.DeliverResponse = true
			step.SendAck = true
			return completeSIPClientTransaction(step, reliable, policy.TimerD)
		}
	}
	step.Action = SIPClientTransactionActionWait
	return step
}

func advanceSIPNonInviteClientTransactionResponse(step SIPClientTransactionStep, reliable bool, policy SIPTransactionTimerPolicy) SIPClientTransactionStep {
	switch {
	case step.Provisional:
		if step.State == SIPClientTransactionStateTrying || step.State == SIPClientTransactionStateProceeding {
			step.NextState = SIPClientTransactionStateProceeding
			step.Action = SIPClientTransactionActionDeliverProvisional
			step.DeliverResponse = true
			return step
		}
	case step.Final:
		if step.State == SIPClientTransactionStateTrying || step.State == SIPClientTransactionStateProceeding {
			step.Action = SIPClientTransactionActionDeliverFinal
			step.DeliverResponse = true
			return completeSIPClientTransaction(step, reliable, policy.TimerK)
		}
	}
	step.Action = SIPClientTransactionActionWait
	return step
}

func advanceSIPClientTransactionRetransmitTimer(step SIPClientTransactionStep, reliable bool, last time.Duration, max, done int, policy SIPTransactionTimerPolicy) SIPClientTransactionStep {
	if reliable {
		step.Action = SIPClientTransactionActionWait
		return step
	}
	if step.Invite {
		if step.State != SIPClientTransactionStateCalling || !shouldSIPRetransmit(done, max) {
			step.Action = SIPClientTransactionActionWait
			return step
		}
		step.TimerName = "A"
	} else {
		if (step.State != SIPClientTransactionStateTrying && step.State != SIPClientTransactionStateProceeding) || !shouldSIPRetransmit(done, max) {
			step.Action = SIPClientTransactionActionWait
			return step
		}
		step.TimerName = "E"
	}
	interval := last
	if interval <= 0 {
		if step.Invite {
			interval = policy.TimerA
		} else {
			interval = policy.TimerE
		}
	}
	if !step.Invite && step.State == SIPClientTransactionStateProceeding && interval < policy.T2 {
		interval = policy.T2
	}
	step.Action = SIPClientTransactionActionRetransmitRequest
	step.RetransmitRequest = true
	step.NextRetransmitInterval = nextSIPRetransmitInterval(interval, policy.T2)
	return step
}

func advanceSIPClientTransactionTimeoutTimer(step SIPClientTransactionStep) SIPClientTransactionStep {
	if step.Invite {
		if step.State != SIPClientTransactionStateCalling {
			step.Action = SIPClientTransactionActionWait
			return step
		}
		step.TimerName = "B"
	} else {
		if step.State != SIPClientTransactionStateTrying && step.State != SIPClientTransactionStateProceeding {
			step.Action = SIPClientTransactionActionWait
			return step
		}
		step.TimerName = "F"
	}
	step.NextState = SIPClientTransactionStateTerminated
	step.Action = SIPClientTransactionActionTimeout
	step.TimedOut = true
	step.Terminated = true
	return step
}

func advanceSIPClientTransactionCleanupTimer(step SIPClientTransactionStep) SIPClientTransactionStep {
	if step.State != SIPClientTransactionStateCompleted {
		step.Action = SIPClientTransactionActionWait
		return step
	}
	if step.Invite {
		step.TimerName = "D"
	} else {
		step.TimerName = "K"
	}
	step.NextState = SIPClientTransactionStateTerminated
	step.Action = SIPClientTransactionActionTerminate
	step.Terminated = true
	return step
}

func completeSIPClientTransaction(step SIPClientTransactionStep, reliable bool, cleanupAfter time.Duration) SIPClientTransactionStep {
	if reliable || cleanupAfter <= 0 {
		step.NextState = SIPClientTransactionStateTerminated
		step.Terminated = true
		return step
	}
	step.NextState = SIPClientTransactionStateCompleted
	step.CleanupAfter = cleanupAfter
	return step
}

func sipClientTransactionRetransmitTimerActive(method string, state SIPClientTransactionState) bool {
	if sipTransactionKindForMethod(method) == sipTransactionInvite {
		return normalizeSIPClientTransactionState(state, method) == SIPClientTransactionStateCalling
	}
	state = normalizeSIPClientTransactionState(state, method)
	return state == SIPClientTransactionStateTrying || state == SIPClientTransactionStateProceeding
}

func normalizeSIPClientTransactionState(state SIPClientTransactionState, method string) SIPClientTransactionState {
	switch state {
	case SIPClientTransactionStateCalling:
		if sipTransactionKindForMethod(method) == sipTransactionInvite {
			return state
		}
	case SIPClientTransactionStateTrying:
		if sipTransactionKindForMethod(method) != sipTransactionInvite {
			return state
		}
	case SIPClientTransactionStateProceeding,
		SIPClientTransactionStateCompleted,
		SIPClientTransactionStateTerminated:
		return state
	}
	return InitialSIPClientTransactionState(method)
}

// AdvanceSIPServerTransaction advances a pure RFC 3261 server transaction state
// machine by one request, response, ACK, or timer event. It does not write to
// the network.
func AdvanceSIPServerTransaction(input SIPServerTransactionInput) SIPServerTransactionStep {
	policy := SIPTransactionTimerPolicyFor(input.Method, input.TimerConfig)
	state := normalizeSIPServerTransactionState(input.State, policy.Method)
	event := input.Event
	if event == "" {
		event = SIPServerTransactionEventRequest
	}
	step := SIPServerTransactionStep{
		Method:    policy.Method,
		Invite:    policy.Invite,
		Event:     event,
		State:     state,
		NextState: state,
		Action:    SIPServerTransactionActionNone,
	}
	if state == SIPServerTransactionStateTerminated {
		step.Terminated = true
		return step
	}
	switch event {
	case SIPServerTransactionEventRequest:
		return advanceSIPServerTransactionRequest(step, input.Response, input.RequestRetransmission)
	case SIPServerTransactionEventResponse:
		return advanceSIPServerTransactionResponse(step, input.Response, input.ReliableTransport, policy)
	case SIPServerTransactionEventACK:
		return advanceSIPServerTransactionACK(step, input.ReliableTransport, policy)
	case SIPServerTransactionEventRetransmitTimer:
		return advanceSIPServerTransactionRetransmitTimer(step, input.ReliableTransport, input.Response, input.LastRetransmitInterval, policy)
	case SIPServerTransactionEventTimeoutTimer:
		return advanceSIPServerTransactionTimeoutTimer(step)
	case SIPServerTransactionEventCleanupTimer:
		return advanceSIPServerTransactionCleanupTimer(step)
	default:
		step.Action = SIPServerTransactionActionWait
		return step
	}
}

func advanceSIPServerTransactionRequest(step SIPServerTransactionStep, cached SIPResponse, retransmission bool) SIPServerTransactionStep {
	if !retransmission {
		if step.State == SIPServerTransactionStateTrying || step.State == SIPServerTransactionStateProceeding {
			step.Action = SIPServerTransactionActionPassRequest
			step.PassRequest = true
			return step
		}
		step.Action = SIPServerTransactionActionWait
		return step
	}
	step = applySIPServerTransactionResponseInfo(step, cached)
	switch {
	case step.Invite && step.State == SIPServerTransactionStateProceeding && step.StatusCode > 0:
		step.Action = SIPServerTransactionActionRetransmitResponse
		step.RetransmitResponse = true
	case step.Invite && step.State == SIPServerTransactionStateCompleted:
		step.Action = SIPServerTransactionActionRetransmitResponse
		step.RetransmitResponse = true
	case !step.Invite && (step.State == SIPServerTransactionStateProceeding || step.State == SIPServerTransactionStateCompleted) && step.StatusCode > 0:
		step.Action = SIPServerTransactionActionRetransmitResponse
		step.RetransmitResponse = true
	default:
		step.Action = SIPServerTransactionActionWait
	}
	return step
}

func advanceSIPServerTransactionResponse(step SIPServerTransactionStep, resp SIPResponse, reliable bool, policy SIPTransactionTimerPolicy) SIPServerTransactionStep {
	step = applySIPServerTransactionResponseInfo(step, resp)
	if step.StatusCode == 0 {
		step.Action = SIPServerTransactionActionWait
		return step
	}
	if step.Invite {
		return advanceSIPInviteServerTransactionResponse(step, reliable, policy)
	}
	return advanceSIPNonInviteServerTransactionResponse(step, reliable, policy)
}

func advanceSIPInviteServerTransactionResponse(step SIPServerTransactionStep, reliable bool, policy SIPTransactionTimerPolicy) SIPServerTransactionStep {
	if step.State != SIPServerTransactionStateProceeding {
		step.Action = SIPServerTransactionActionWait
		return step
	}
	step.Action = SIPServerTransactionActionSendResponse
	step.SendResponse = true
	switch {
	case step.Provisional:
		step.NextState = SIPServerTransactionStateProceeding
	case step.Success:
		step.NextState = SIPServerTransactionStateTerminated
		step.Terminated = true
	case step.Failure:
		return completeSIPInviteServerTransaction(step, reliable, policy)
	default:
		step.Action = SIPServerTransactionActionWait
		step.SendResponse = false
	}
	return step
}

func advanceSIPNonInviteServerTransactionResponse(step SIPServerTransactionStep, reliable bool, policy SIPTransactionTimerPolicy) SIPServerTransactionStep {
	if step.State != SIPServerTransactionStateTrying && step.State != SIPServerTransactionStateProceeding {
		step.Action = SIPServerTransactionActionWait
		return step
	}
	step.Action = SIPServerTransactionActionSendResponse
	step.SendResponse = true
	if step.Provisional {
		step.NextState = SIPServerTransactionStateProceeding
		return step
	}
	if !step.Final {
		step.Action = SIPServerTransactionActionWait
		step.SendResponse = false
		return step
	}
	if reliable || policy.TimerJ <= 0 {
		step.NextState = SIPServerTransactionStateTerminated
		step.Terminated = true
		return step
	}
	step.NextState = SIPServerTransactionStateCompleted
	step.CleanupAfter = policy.TimerJ
	step.TimerName = "J"
	return step
}

func advanceSIPServerTransactionACK(step SIPServerTransactionStep, reliable bool, policy SIPTransactionTimerPolicy) SIPServerTransactionStep {
	if !step.Invite || step.State != SIPServerTransactionStateCompleted {
		step.Action = SIPServerTransactionActionWait
		return step
	}
	step.Action = SIPServerTransactionActionDeliverACK
	step.DeliverACK = true
	if reliable || policy.TimerI <= 0 {
		step.NextState = SIPServerTransactionStateTerminated
		step.Terminated = true
		return step
	}
	step.NextState = SIPServerTransactionStateConfirmed
	step.CleanupAfter = policy.TimerI
	step.TimerName = "I"
	return step
}

func advanceSIPServerTransactionRetransmitTimer(step SIPServerTransactionStep, reliable bool, cached SIPResponse, last time.Duration, policy SIPTransactionTimerPolicy) SIPServerTransactionStep {
	if reliable || !step.Invite || step.State != SIPServerTransactionStateCompleted {
		step.Action = SIPServerTransactionActionWait
		return step
	}
	step = applySIPServerTransactionResponseInfo(step, cached)
	if !step.Failure {
		step.Action = SIPServerTransactionActionWait
		return step
	}
	interval := last
	if interval <= 0 {
		interval = policy.TimerG
	}
	step.Action = SIPServerTransactionActionRetransmitResponse
	step.RetransmitResponse = true
	step.TimerName = "G"
	step.NextRetransmitInterval = nextSIPRetransmitInterval(interval, policy.T2)
	return step
}

func advanceSIPServerTransactionTimeoutTimer(step SIPServerTransactionStep) SIPServerTransactionStep {
	if !step.Invite || step.State != SIPServerTransactionStateCompleted {
		step.Action = SIPServerTransactionActionWait
		return step
	}
	step.NextState = SIPServerTransactionStateTerminated
	step.Action = SIPServerTransactionActionTimeout
	step.TimerName = "H"
	step.TimedOut = true
	step.Terminated = true
	return step
}

func advanceSIPServerTransactionCleanupTimer(step SIPServerTransactionStep) SIPServerTransactionStep {
	switch {
	case step.Invite && step.State == SIPServerTransactionStateConfirmed:
		step.TimerName = "I"
	case !step.Invite && step.State == SIPServerTransactionStateCompleted:
		step.TimerName = "J"
	default:
		step.Action = SIPServerTransactionActionWait
		return step
	}
	step.NextState = SIPServerTransactionStateTerminated
	step.Action = SIPServerTransactionActionTerminate
	step.Terminated = true
	return step
}

func completeSIPInviteServerTransaction(step SIPServerTransactionStep, reliable bool, policy SIPTransactionTimerPolicy) SIPServerTransactionStep {
	step.NextState = SIPServerTransactionStateCompleted
	if !reliable && policy.TimerG > 0 {
		step.NextRetransmitInterval = policy.TimerG
		step.TimerName = "G"
	}
	step.TimeoutAfter = policy.TimerH
	return step
}

func applySIPServerTransactionResponseInfo(step SIPServerTransactionStep, resp SIPResponse) SIPServerTransactionStep {
	code := resp.StatusCode
	step.StatusCode = code
	step.Provisional = isSIPProvisionalResponse(code)
	step.Success = isSIPSuccess(code)
	step.Final = code >= 200
	step.Failure = code >= 300
	return step
}

func normalizeSIPServerTransactionState(state SIPServerTransactionState, method string) SIPServerTransactionState {
	switch state {
	case SIPServerTransactionStateTrying:
		if sipTransactionKindForMethod(method) != sipTransactionInvite {
			return state
		}
	case SIPServerTransactionStateProceeding,
		SIPServerTransactionStateCompleted,
		SIPServerTransactionStateTerminated:
		return state
	case SIPServerTransactionStateConfirmed:
		if sipTransactionKindForMethod(method) == sipTransactionInvite {
			return state
		}
	}
	return InitialSIPServerTransactionState(method)
}
