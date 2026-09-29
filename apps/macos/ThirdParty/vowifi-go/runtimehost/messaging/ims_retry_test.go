package messaging

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
	"time"

	"github.com/boa-z/vowifi-go/runtimehost/voiceclient"
)

type imsRetryTimeoutError struct{}

func (imsRetryTimeoutError) Error() string   { return "timeout" }
func (imsRetryTimeoutError) Timeout() bool   { return true }
func (imsRetryTimeoutError) Temporary() bool { return true }

func TestPlanIMSSMSSubmitRetryAcceptedIsTerminalAndDurable(t *testing.T) {
	now := time.Date(2026, 7, 7, 10, 0, 0, 0, time.UTC)
	plan := PlanIMSSMSSubmitRetry(
		SMSSendRequest{
			MessageID: "billing July",
			Peer:      "+18005551212",
			Part:      SMSPart{PartNo: 2},
		},
		SMSSendResult{SIPCode: 202, State: "accepted"},
		nil,
		IMSMessagingRetryOptions{Attempt: 1, Now: now},
	)

	if plan.Operation != IMSMessagingRetryOperationSMSSubmit ||
		plan.Method != "MESSAGE" ||
		plan.Class != IMSMessagingRetryClassAccepted ||
		plan.Action != IMSMessagingRetryActionNone ||
		plan.Retry ||
		!plan.Terminal ||
		plan.RetryKey != "sms-submit:billing-July:part-2" ||
		plan.IdempotencyKey != plan.RetryKey ||
		plan.Durable {
		t.Fatalf("accepted SMS retry plan=%+v", plan)
	}
	if !plan.NextAttemptAt.IsZero() || plan.Delay != 0 {
		t.Fatalf("accepted plan scheduled retry: %+v", plan)
	}
	if _, err := json.Marshal(plan); err != nil {
		t.Fatalf("Marshal retry plan error = %v", err)
	}
}

func TestPlanIMSMessagingRetryClassifies4xxAndRetryAfter(t *testing.T) {
	now := time.Date(2026, 7, 7, 10, 0, 0, 0, time.UTC)
	plan := PlanIMSMessagingRetry(IMSMessagingRetryInput{
		Operation: IMSMessagingRetryOperationSMSSubmit,
		Method:    "MESSAGE",
		Response: voiceclient.SIPResponse{
			StatusCode: 429,
			Reason:     "Too Many Requests",
			Headers:    map[string][]string{"Retry-After": {"0"}},
		},
		Attempt:        2,
		Now:            now,
		IdempotencyKey: "sms-submit:rate-limited:part-1",
	})

	if plan.Class != IMSMessagingRetryClassThrottled ||
		!plan.Retry ||
		plan.Terminal ||
		plan.Action != IMSMessagingRetryActionRetryAfter ||
		!plan.RetryAfterPresent ||
		plan.RetryAfter != 0 ||
		plan.Delay != 0 ||
		!plan.NextAttemptAt.Equal(now) ||
		!plan.Durable {
		t.Fatalf("429 retry plan=%+v", plan)
	}

	forbidden := PlanIMSMessagingRetry(IMSMessagingRetryInput{
		Operation:      IMSMessagingRetryOperationSMSSubmit,
		Method:         "MESSAGE",
		Response:       voiceclient.SIPResponse{StatusCode: 403, Reason: "Forbidden"},
		Attempt:        1,
		IdempotencyKey: "sms-submit:forbidden:part-1",
	})
	if forbidden.Class != IMSMessagingRetryClassClientFailure ||
		forbidden.Retry ||
		!forbidden.Terminal ||
		forbidden.Action != IMSMessagingRetryActionNone ||
		forbidden.Reason != "Forbidden" {
		t.Fatalf("403 retry plan=%+v", forbidden)
	}
}

func TestPlanIMSMessagingRetryCarriesAuthChallenge(t *testing.T) {
	now := time.Date(2026, 7, 7, 10, 0, 0, 0, time.UTC)
	plan := PlanIMSMessagingRetry(IMSMessagingRetryInput{
		Operation: IMSMessagingRetryOperationSMSSubmit,
		Method:    "MESSAGE",
		Response: voiceclient.SIPResponse{
			StatusCode: 407,
			Reason:     "Proxy Authentication Required",
			Headers: map[string][]string{
				"Proxy-Authenticate": {`Digest realm="ims.example", nonce="p1", algorithm=AKAv2-MD5`},
				"Retry-After":        {"2"},
			},
		},
		Attempt:        1,
		Now:            now,
		IdempotencyKey: "sms-submit:auth:part-1",
	})

	if plan.Class != IMSMessagingRetryClassAuthentication ||
		!plan.Retry ||
		plan.Terminal ||
		plan.Action != IMSMessagingRetryActionRefreshAuthentication ||
		!plan.AuthenticationRefresh ||
		plan.AuthenticationChallengeHeader != "Proxy-Authenticate" ||
		plan.AuthenticationAuthorizationHeader != "Proxy-Authorization" ||
		plan.AuthenticationChallenge != `Digest realm="ims.example", nonce="p1", algorithm=AKAv2-MD5` ||
		!plan.RetryAfterPresent ||
		plan.Delay != 2*time.Second ||
		!plan.NextAttemptAt.Equal(now.Add(2*time.Second)) ||
		!plan.Durable {
		t.Fatalf("auth retry plan=%+v", plan)
	}
}

func TestPlanIMSMessagingRetryClassifies5xxWithRetryAfter(t *testing.T) {
	now := time.Date(2026, 7, 7, 10, 0, 0, 0, time.UTC)
	plan := PlanIMSMessagingRetry(IMSMessagingRetryInput{
		Operation: IMSMessagingRetryOperationSMSSubmit,
		Method:    "MESSAGE",
		Response: voiceclient.SIPResponse{
			StatusCode: 503,
			Reason:     "Service Unavailable",
			Headers:    map[string][]string{"Retry-After": {"7"}},
		},
		Attempt:        1,
		Now:            now,
		IdempotencyKey: "sms-submit:server-failure:part-1",
	})

	if plan.Class != IMSMessagingRetryClassServerFailure ||
		!plan.Retry ||
		plan.Action != IMSMessagingRetryActionRecoverRegistration ||
		!plan.RegistrationRecoveryNeeded ||
		!plan.TargetFailover ||
		!plan.RetryAfterPresent ||
		plan.RetryAfter != 7*time.Second ||
		plan.Delay != 7*time.Second ||
		!plan.NextAttemptAt.Equal(now.Add(7*time.Second)) ||
		!plan.Durable {
		t.Fatalf("503 retry plan=%+v", plan)
	}
}

func TestPlanIMSSMSSubmitRetryClassifiesSIPTimeoutWithBackoff(t *testing.T) {
	now := time.Date(2026, 7, 7, 10, 0, 0, 0, time.UTC)
	plan := PlanIMSSMSSubmitRetry(
		SMSSendRequest{
			MessageID: "timeout sms",
			Peer:      "+18005551212",
			Part:      SMSPart{PartNo: 1},
		},
		SMSSendResult{},
		imsRetryTimeoutError{},
		IMSMessagingRetryOptions{
			Attempt: 3,
			Now:     now,
			Policy: IMSMessagingRetryPolicy{
				MaxAttempts: 5,
				BaseDelay:   2 * time.Second,
				MaxDelay:    9 * time.Second,
			},
		},
	)

	if plan.Class != IMSMessagingRetryClassSIPTimeout ||
		!plan.TransportFailure ||
		!plan.TimedOut ||
		!plan.Retry ||
		plan.Action != IMSMessagingRetryActionRecoverRegistration ||
		!plan.RegistrationRecoveryNeeded ||
		!plan.DuplicateRisk ||
		plan.Delay != 8*time.Second ||
		plan.NextAttempt != 4 ||
		!plan.NextAttemptAt.Equal(now.Add(8*time.Second)) ||
		plan.RetryKey != "sms-submit:timeout-sms:part-1" ||
		!plan.Durable {
		t.Fatalf("timeout SMS retry plan=%+v", plan)
	}
}

func TestPlanIMSUSSDSessionRetryUsesSessionKeyAndStopsAtAttemptLimit(t *testing.T) {
	req := USSDRequest{SessionID: "ussd menu", Input: "1"}
	plan := PlanIMSUSSDSessionRetry(
		req,
		USSDResult{SessionID: req.SessionID, Status: 408, Done: true},
		errors.New("SIP timeout"),
		IMSMessagingRetryOptions{
			Attempt: 4,
			Policy:  IMSMessagingRetryPolicy{MaxAttempts: 4, BaseDelay: time.Second, MaxDelay: 8 * time.Second},
		},
	)

	if plan.Operation != IMSMessagingRetryOperationUSSDSession ||
		plan.Method != "INFO" ||
		plan.Class != IMSMessagingRetryClassSIPTimeout ||
		!plan.TimedOut ||
		plan.Retry ||
		!plan.Terminal ||
		plan.Action != IMSMessagingRetryActionNone ||
		plan.SessionKey != "ussd-session:ussd-menu" ||
		plan.RetryKey != plan.SessionKey ||
		plan.Durable ||
		plan.Delay != 0 {
		t.Fatalf("USSD attempt-limit plan=%+v", plan)
	}
}

func TestPlanIMSUSSDSessionRetryRedirectsToTarget(t *testing.T) {
	now := time.Date(2026, 7, 7, 10, 0, 0, 0, time.UTC)
	plan := PlanIMSMessagingRetry(IMSMessagingRetryInput{
		Operation: IMSMessagingRetryOperationUSSDSession,
		Method:    "INVITE",
		Response: voiceclient.SIPResponse{
			StatusCode: 302,
			Reason:     "Moved Temporarily",
			Headers:    map[string][]string{"Contact": {"<sip:ussd-backup@ims.example>;q=0.8"}},
		},
		Attempt:    1,
		Now:        now,
		SessionKey: "ussd-session:menu",
	})

	if plan.Class != IMSMessagingRetryClassRedirect ||
		!plan.Retry ||
		plan.Action != IMSMessagingRetryActionFailoverTarget ||
		plan.TargetURI != "sip:ussd-backup@ims.example" ||
		!plan.TargetFailover ||
		plan.Delay != time.Second ||
		!plan.NextAttemptAt.Equal(now.Add(time.Second)) ||
		!plan.Durable {
		t.Fatalf("USSD redirect retry plan=%+v", plan)
	}
}

func TestPlanIMSMessagingRetryDoesNotRetryCallerCancellation(t *testing.T) {
	plan := PlanIMSMessagingRetry(IMSMessagingRetryInput{
		Operation:      IMSMessagingRetryOperationSMSSubmit,
		Method:         "MESSAGE",
		Err:            context.Canceled,
		Attempt:        1,
		IdempotencyKey: "sms-submit:canceled:part-1",
	})

	if plan.Class != IMSMessagingRetryClassTransportFailure ||
		!plan.TransportFailure ||
		plan.Retry ||
		!plan.Terminal ||
		plan.Action != IMSMessagingRetryActionNone ||
		plan.Durable {
		t.Fatalf("canceled retry plan=%+v", plan)
	}
}

func TestIMSMessagingRetryEnvelopeJSONAndReplayReadiness(t *testing.T) {
	now := time.Date(2026, 7, 7, 10, 0, 0, 0, time.UTC)
	req := SMSSendRequest{
		DeviceID:  "dev-1",
		IMSI:      "310280000000001",
		Peer:      "+18005551212",
		MessageID: "retry sms",
		Part:      SMSPart{PartNo: 1, TotalParts: 1, Text: "hello", Encoding: "gsm7"},
	}
	envelope := NewIMSSMSSubmitRetryEnvelope(
		req,
		SMSSendResult{SIPCode: 503, State: "failed", ErrorText: "Service Unavailable", RetryAfter: 2 * time.Second},
		errors.New("Service Unavailable"),
		IMSMessagingRetryOptions{Attempt: 2, Now: now},
	)

	if envelope.Version != 1 ||
		envelope.Operation != IMSMessagingRetryOperationSMSSubmit ||
		envelope.Method != "MESSAGE" ||
		envelope.State != IMSMessagingRetryQueueStatePending ||
		envelope.Key != "sms-submit:retry-sms:part-1" ||
		envelope.IdempotencyKey != envelope.Key ||
		envelope.Attempt != 2 ||
		envelope.NextAttempt != 3 ||
		!envelope.DueAt.Equal(now.Add(2*time.Second)) ||
		envelope.Terminal() ||
		!envelope.Pending() {
		t.Fatalf("SMS retry envelope=%+v", envelope)
	}
	if envelope.ReplayReady(now.Add(2*time.Second - time.Nanosecond)) {
		t.Fatalf("ReplayReady()=true before due time for %+v", envelope)
	}
	if !envelope.ReplayReady(now.Add(2 * time.Second)) {
		t.Fatalf("ReplayReady()=false at due time for %+v", envelope)
	}
	replayReq, ok := envelope.SMSSubmitRequest()
	if !ok || replayReq.MessageID != req.MessageID || replayReq.Part.Text != req.Part.Text {
		t.Fatalf("SMSSubmitRequest()=%+v ok=%v", replayReq, ok)
	}

	raw, err := json.Marshal(envelope)
	if err != nil {
		t.Fatalf("Marshal envelope error = %v", err)
	}
	var decoded IMSMessagingRetryEnvelope
	if err := json.Unmarshal(raw, &decoded); err != nil {
		t.Fatalf("Unmarshal envelope error = %v", err)
	}
	decodedReq, ok := decoded.SMSSubmitRequest()
	if !ok || decoded.Key != envelope.Key || decodedReq.MessageID != req.MessageID || !decoded.ReplayReady(now.Add(2*time.Second)) {
		t.Fatalf("decoded envelope=%+v req=%+v ok=%v", decoded, decodedReq, ok)
	}
}

func TestIMSMessagingRetryQueueSelectsDueAndDropsTerminal(t *testing.T) {
	now := time.Date(2026, 7, 7, 10, 0, 0, 0, time.UTC)
	smsReq := SMSSendRequest{
		Peer:      "+18005551212",
		MessageID: "queue sms",
		Part:      SMSPart{PartNo: 1, Text: "hello"},
	}
	smsEnvelope := NewIMSSMSSubmitRetryEnvelope(
		smsReq,
		SMSSendResult{SIPCode: 503, State: "failed", ErrorText: "Service Unavailable", RetryAfter: 3 * time.Second},
		errors.New("Service Unavailable"),
		IMSMessagingRetryOptions{Attempt: 1, Now: now},
	)
	ussdReq := USSDRequest{SessionID: "menu 1", Input: "1"}
	ussdEnvelope := NewIMSUSSDSessionRetryEnvelope(
		ussdReq,
		USSDResult{SessionID: "menu 1", Status: 408, Done: true},
		errors.New("SIP timeout"),
		IMSMessagingRetryOptions{
			Attempt: 1,
			Now:     now,
			Policy:  IMSMessagingRetryPolicy{MaxAttempts: 4, BaseDelay: time.Second, MaxDelay: 8 * time.Second},
		},
	)

	var queue IMSMessagingRetryQueue
	queue.Upsert(smsEnvelope)
	queue.Upsert(ussdEnvelope)

	if due := queue.Due(now.Add(500*time.Millisecond), 0); len(due) != 0 {
		t.Fatalf("early due=%+v", due)
	}
	due := queue.Due(now.Add(3*time.Second), 1)
	if len(due) != 1 || due[0].Key != ussdEnvelope.Key || due[0].Operation != IMSMessagingRetryOperationUSSDSession {
		t.Fatalf("limited due=%+v", due)
	}
	due = queue.Due(now.Add(3*time.Second), 0)
	if len(due) != 2 || due[0].Key != ussdEnvelope.Key || due[1].Key != smsEnvelope.Key {
		t.Fatalf("due order=%+v", due)
	}

	terminal := NewIMSSMSSubmitRetryEnvelope(
		smsReq,
		SMSSendResult{SIPCode: 202, State: "accepted"},
		nil,
		IMSMessagingRetryOptions{Attempt: 2, Now: now.Add(4 * time.Second)},
	)
	queue.Upsert(terminal)
	if len(queue.Envelopes) != 1 || queue.Envelopes[0].Key != ussdEnvelope.Key {
		t.Fatalf("queue after terminal SMS=%+v", queue.Envelopes)
	}
}

func TestIMSUSSDRetryEnvelopeUsesSessionKeyAndPayload(t *testing.T) {
	now := time.Date(2026, 7, 7, 10, 0, 0, 0, time.UTC)
	req := USSDRequest{DeviceID: "dev-1", IMSI: "310280000000001", SessionID: "ussd menu", Input: "2"}
	envelope := NewIMSUSSDSessionRetryEnvelope(
		req,
		USSDResult{SessionID: "ussd menu", Status: 408, Done: true},
		errors.New("SIP timeout"),
		IMSMessagingRetryOptions{Attempt: 1, Now: now},
	)

	if envelope.Operation != IMSMessagingRetryOperationUSSDSession ||
		envelope.Method != "INFO" ||
		envelope.State != IMSMessagingRetryQueueStatePending ||
		envelope.Key != "ussd-session:ussd-menu" ||
		envelope.SessionKey != envelope.Key ||
		envelope.IdempotencyKey != "" ||
		!envelope.DueAt.Equal(now.Add(time.Second)) ||
		!envelope.ReplayReady(now.Add(time.Second)) {
		t.Fatalf("USSD retry envelope=%+v", envelope)
	}
	replayReq, ok := envelope.USSDRequest()
	if !ok || replayReq.SessionID != req.SessionID || replayReq.Input != req.Input {
		t.Fatalf("USSDRequest()=%+v ok=%v", replayReq, ok)
	}
	if _, ok := envelope.SMSSubmitRequest(); ok {
		t.Fatalf("SMSSubmitRequest() ok=true for USSD envelope")
	}
}

func TestIMSMessagingRetryKeysAreStable(t *testing.T) {
	smsKey := IMSMessagingSMSSubmitIdempotencyKey(SMSSendRequest{
		Peer: "+18005551212",
		Part: SMSPart{},
	})
	if smsKey != "sms-submit:18005551212:part-1" {
		t.Fatalf("SMS idempotency key=%q", smsKey)
	}
	ussdKey := IMSMessagingUSSDSessionKey(USSDRequest{Command: "*100#"})
	if ussdKey != "ussd-session:100" {
		t.Fatalf("USSD session key=%q", ussdKey)
	}
}
