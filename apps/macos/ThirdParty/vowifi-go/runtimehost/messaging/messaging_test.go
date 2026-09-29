package messaging

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/boa-z/vowifi-go/runtimehost/eventhost"
)

func TestSegmentSMSGSM7(t *testing.T) {
	parts := SegmentSMS(strings.Repeat("a", 161), "")
	if len(parts) != 2 {
		t.Fatalf("parts=%d, want 2", len(parts))
	}
	if parts[0].Encoding != "gsm7" || len([]rune(parts[0].Text)) != 153 || len(parts[0].UDH) == 0 {
		t.Fatalf("first part=%+v", parts[0])
	}
	if parts[1].PartNo != 2 || parts[1].TotalParts != 2 {
		t.Fatalf("second part=%+v", parts[1])
	}
}

func TestSegmentSMSUsesFreshConcatReferences(t *testing.T) {
	first := SegmentSMS(strings.Repeat("a", 161), "")
	second := SegmentSMS(strings.Repeat("b", 161), "")
	if len(first) != 2 || len(second) != 2 {
		t.Fatalf("parts first=%d second=%d", len(first), len(second))
	}
	if first[0].ConcatRefBits != 8 || second[0].ConcatRefBits != 8 {
		t.Fatalf("concat bits first=%+v second=%+v", first[0], second[0])
	}
	if first[0].ConcatRef == 0 || second[0].ConcatRef == 0 || first[0].ConcatRef == second[0].ConcatRef {
		t.Fatalf("concat refs first=%d second=%d", first[0].ConcatRef, second[0].ConcatRef)
	}
	if first[0].UDH[3] != byte(first[0].ConcatRef) || second[0].UDH[3] != byte(second[0].ConcatRef) {
		t.Fatalf("UDH refs first=%x second=%x", first[0].UDH, second[0].UDH)
	}
}

func TestSegmentSMSWithExplicit16BitConcatReference(t *testing.T) {
	parts := SegmentSMSWithOptions(strings.Repeat("a", 306), SendOptions{ConcatRef: 0x1234, ConcatRefBits: 16})
	if len(parts) != 3 {
		t.Fatalf("parts=%d, want 3", len(parts))
	}
	if parts[0].ConcatRef != 0x1234 || parts[0].ConcatRefBits != 16 {
		t.Fatalf("first part=%+v", parts[0])
	}
	wantUDH := []byte{0x06, 0x08, 0x04, 0x12, 0x34, 0x03, 0x01}
	if string(parts[0].UDH) != string(wantUDH) {
		t.Fatalf("UDH=%x want %x", parts[0].UDH, wantUDH)
	}
	if messageLen(parts[0].Text, "gsm7") != 152 {
		t.Fatalf("first part septets=%d want 152", messageLen(parts[0].Text, "gsm7"))
	}
}

func TestSegmentSMSWithApplicationPorts(t *testing.T) {
	parts := SegmentSMSWithOptions("hi", SendOptions{ApplicationDestPort: 2948, ApplicationSourcePort: 9200})
	if len(parts) != 1 {
		t.Fatalf("parts=%d, want 1", len(parts))
	}
	part := parts[0]
	wantUDH := []byte{0x06, 0x05, 0x04, 0x0b, 0x84, 0x23, 0xf0}
	if string(part.UDH) != string(wantUDH) || part.ApplicationPortBits != 16 {
		t.Fatalf("part=%+v UDH=%x want %x", part, part.UDH, wantUDH)
	}
	if part.ApplicationDestPort != 2948 || part.ApplicationSourcePort != 9200 {
		t.Fatalf("application ports=%d/%d", part.ApplicationDestPort, part.ApplicationSourcePort)
	}
}

func TestSegmentSMSWithApplicationPortsAndConcat(t *testing.T) {
	parts := SegmentSMSWithOptions(strings.Repeat("a", 155), SendOptions{
		ApplicationDestPort:   0x7f,
		ApplicationSourcePort: 0x00,
		ApplicationPortBits:   8,
		ConcatRef:             0x7a,
		ConcatRefBits:         8,
	})
	if len(parts) != 2 {
		t.Fatalf("parts=%d, want 2", len(parts))
	}
	wantFirstUDH := []byte{0x09, 0x04, 0x02, 0x7f, 0x00, 0x00, 0x03, 0x7a, 0x02, 0x01}
	wantSecondUDH := []byte{0x09, 0x04, 0x02, 0x7f, 0x00, 0x00, 0x03, 0x7a, 0x02, 0x02}
	if string(parts[0].UDH) != string(wantFirstUDH) || string(parts[1].UDH) != string(wantSecondUDH) {
		t.Fatalf("UDH first=%x second=%x", parts[0].UDH, parts[1].UDH)
	}
	if messageLen(parts[0].Text, "gsm7") != 148 {
		t.Fatalf("first part septets=%d want 148", messageLen(parts[0].Text, "gsm7"))
	}
}

func TestSegmentSMSGSM7ExtendedCharacters(t *testing.T) {
	single := SegmentSMS(strings.Repeat("^", 80), "")
	if len(single) != 1 || single[0].Encoding != "gsm7" || single[0].UDH != nil || messageLen(single[0].Text, single[0].Encoding) != 160 {
		t.Fatalf("single extended parts=%+v", single)
	}

	parts := SegmentSMS(strings.Repeat("^", 81), "")
	if len(parts) != 2 {
		t.Fatalf("parts=%d, want 2", len(parts))
	}
	if parts[0].Encoding != "gsm7" || messageLen(parts[0].Text, "gsm7") > 153 || len([]rune(parts[0].Text)) != 76 || len(parts[0].UDH) == 0 {
		t.Fatalf("first extended part=%+v septets=%d", parts[0], messageLen(parts[0].Text, "gsm7"))
	}
	if parts[1].PartNo != 2 || parts[1].TotalParts != 2 || messageLen(parts[1].Text, "gsm7") != 10 {
		t.Fatalf("second extended part=%+v septets=%d", parts[1], messageLen(parts[1].Text, "gsm7"))
	}
}

func TestSegmentSMSGSM7NationalLanguageSingleShift(t *testing.T) {
	single := SegmentSMSWithOptions(strings.Repeat("\u011e", 77), SendOptions{SingleShiftLang: SMSNationalLanguageTurkish})
	if len(single) != 1 {
		t.Fatalf("single parts=%d, want 1", len(single))
	}
	wantSingleUDH := []byte{0x03, 0x24, 0x01, 0x01}
	if single[0].Encoding != "gsm7" || string(single[0].UDH) != string(wantSingleUDH) || single[0].SingleShiftLang != SMSNationalLanguageTurkish {
		t.Fatalf("single part=%+v UDH=%x want %x", single[0], single[0].UDH, wantSingleUDH)
	}
	if messageLenWithLanguage(single[0].Text, "gsm7", 0, SMSNationalLanguageTurkish) != 154 {
		t.Fatalf("single septets=%d want 154", messageLenWithLanguage(single[0].Text, "gsm7", 0, SMSNationalLanguageTurkish))
	}

	parts := SegmentSMSWithOptions(strings.Repeat("\u011e", 78), SendOptions{
		SingleShiftLang: SMSNationalLanguageTurkish,
		ConcatRef:       0x44,
		ConcatRefBits:   8,
	})
	if len(parts) != 2 {
		t.Fatalf("parts=%d, want 2", len(parts))
	}
	wantFirstUDH := []byte{0x08, 0x24, 0x01, 0x01, 0x00, 0x03, 0x44, 0x02, 0x01}
	if string(parts[0].UDH) != string(wantFirstUDH) || parts[0].ConcatRef != 0x44 || parts[0].SingleShiftLang != SMSNationalLanguageTurkish {
		t.Fatalf("first part=%+v UDH=%x want %x", parts[0], parts[0].UDH, wantFirstUDH)
	}
	if len([]rune(parts[0].Text)) != 74 || messageLenWithLanguage(parts[0].Text, "gsm7", 0, SMSNationalLanguageTurkish) != 148 {
		t.Fatalf("first part text runes=%d septets=%d", len([]rune(parts[0].Text)), messageLenWithLanguage(parts[0].Text, "gsm7", 0, SMSNationalLanguageTurkish))
	}
}

func TestSegmentSMSUCS2(t *testing.T) {
	parts := SegmentSMS(strings.Repeat("你", 71), "")
	if len(parts) != 2 {
		t.Fatalf("parts=%d, want 2", len(parts))
	}
	if parts[0].Encoding != "ucs2" || len([]rune(parts[0].Text)) != 67 {
		t.Fatalf("first part=%+v", parts[0])
	}
}

func TestSegmentSMSUCS2SurrogatePairBoundaries(t *testing.T) {
	single := SegmentSMS(strings.Repeat("\U0001F642", 35), "")
	if len(single) != 1 {
		t.Fatalf("single parts=%d, want 1", len(single))
	}
	if single[0].Encoding != "ucs2" || messageLen(single[0].Text, single[0].Encoding) != 70 || len(single[0].UDH) != 0 {
		t.Fatalf("single part=%+v units=%d", single[0], messageLen(single[0].Text, single[0].Encoding))
	}
	tpdu, err := BuildSMSSubmitTPDU("+18005551212", single[0], 1)
	if err != nil {
		t.Fatalf("BuildSMSSubmitTPDU(single) error = %v", err)
	}
	if tpdu[11] != 0x08 || tpdu[12] != 140 || len(tpdu[13:]) != 140 {
		t.Fatalf("single UCS2 DCS=0x%02x UDL=%d userData=%d TPDU=%x", tpdu[11], tpdu[12], len(tpdu[13:]), tpdu)
	}

	parts := SegmentSMSWithOptions(strings.Repeat("\U0001F642", 36), SendOptions{ConcatRef: 0x7a, ConcatRefBits: 8})
	if len(parts) != 2 {
		t.Fatalf("parts=%d, want 2", len(parts))
	}
	if parts[0].Encoding != "ucs2" || len([]rune(parts[0].Text)) != 33 || messageLen(parts[0].Text, parts[0].Encoding) != 66 {
		t.Fatalf("first part=%+v units=%d", parts[0], messageLen(parts[0].Text, parts[0].Encoding))
	}
	if len([]rune(parts[1].Text)) != 3 || messageLen(parts[1].Text, parts[1].Encoding) != 6 {
		t.Fatalf("second part=%+v units=%d", parts[1], messageLen(parts[1].Text, parts[1].Encoding))
	}
	for _, part := range parts {
		tpdu, err := BuildSMSSubmitTPDU("+18005551212", part, byte(part.PartNo))
		if err != nil {
			t.Fatalf("BuildSMSSubmitTPDU(part %d) error = %v", part.PartNo, err)
		}
		if tpdu[11] != 0x08 || int(tpdu[12]) > 140 || len(tpdu[13:]) != int(tpdu[12]) {
			t.Fatalf("part %d DCS=0x%02x UDL=%d userData=%d TPDU=%x", part.PartNo, tpdu[11], tpdu[12], len(tpdu[13:]), tpdu)
		}
	}
}

func TestSendSMSWithTransportStoresEveryPart(t *testing.T) {
	store := &fakeDeliveryStore{}
	dispatch := &fakeDispatcher{}
	transport := &fakeSMSTransport{}
	svc := NewService("dev-1", "310280000000001", store, dispatch)
	svc.SetSMSTransport(transport)

	out, err := svc.SendSMSWithOptions(context.Background(), "+18005551212", strings.Repeat("a", 161), SendOptions{})
	if err != nil {
		t.Fatalf("SendSMSWithOptions() error = %v", err)
	}
	if out.Parts != 2 || out.PartsTotal != 2 || out.State != "sent" {
		t.Fatalf("outcome=%+v", out)
	}
	if len(transport.requests) != 2 || transport.requests[0].Part.PartNo != 1 || transport.requests[1].Part.PartNo != 2 {
		t.Fatalf("transport requests=%+v", transport.requests)
	}
	if store.createdPartsTotal != 2 || len(store.parts) != 2 || store.state != "sent" || store.acks != 2 {
		t.Fatalf("store=%+v parts=%+v", store, store.parts)
	}
	if len(dispatch.events) != 1 {
		t.Fatalf("events=%d", len(dispatch.events))
	}
	sent, ok := dispatch.events[0].(eventhost.SMSSent)
	if !ok || sent.TotalParts != 2 {
		t.Fatalf("event=%+v", dispatch.events[0])
	}
}

func TestSendSMSWithOptionsPropagatesValidityPeriod(t *testing.T) {
	transport := &fakeSMSTransport{}
	svc := NewService("dev-1", "310280000000001", nil, nil)
	svc.SetSMSTransport(transport)

	out, err := svc.SendSMSWithOptions(context.Background(), "+18005551212", strings.Repeat("a", 161), SendOptions{
		ValidityPeriod: 6 * time.Hour,
	})
	if err != nil {
		t.Fatalf("SendSMSWithOptions() error = %v", err)
	}
	if out.PartsTotal != 2 || len(transport.requests) != 2 {
		t.Fatalf("out=%+v requests=%+v", out, transport.requests)
	}
	for _, req := range transport.requests {
		if req.Part.ValidityPeriod != 6*time.Hour {
			t.Fatalf("part validity=%s want 6h part=%+v", req.Part.ValidityPeriod, req.Part)
		}
	}
}

func TestSendSMSWithOptionsPropagatesValidityDeadline(t *testing.T) {
	transport := &fakeSMSTransport{}
	svc := NewService("dev-1", "310280000000001", nil, nil)
	svc.SetSMSTransport(transport)
	deadline := time.Date(2026, 7, 5, 12, 34, 56, 0, time.FixedZone("CST", 8*3600))

	out, err := svc.SendSMSWithOptions(context.Background(), "+18005551212", "hello", SendOptions{
		ValidityDeadline: deadline,
	})
	if err != nil {
		t.Fatalf("SendSMSWithOptions() error = %v", err)
	}
	if out.PartsTotal != 1 || len(transport.requests) != 1 {
		t.Fatalf("out=%+v requests=%+v", out, transport.requests)
	}
	if !transport.requests[0].Part.ValidityDeadline.Equal(deadline) {
		t.Fatalf("deadline=%s want %s part=%+v", transport.requests[0].Part.ValidityDeadline, deadline, transport.requests[0].Part)
	}
}

func TestSendSMSWithOptionsPropagatesSubmitProtocolFields(t *testing.T) {
	transport := &fakeSMSTransport{}
	svc := NewService("dev-1", "310280000000001", nil, nil)
	svc.SetSMSTransport(transport)

	_, err := svc.SendSMSWithOptions(context.Background(), "+18005551212", "flash", SendOptions{
		ProtocolID:       0x7f,
		DataCodingScheme: 0x10,
	})
	if err != nil {
		t.Fatalf("SendSMSWithOptions() error = %v", err)
	}
	if len(transport.requests) != 1 {
		t.Fatalf("requests=%+v", transport.requests)
	}
	part := transport.requests[0].Part
	if part.ProtocolID != 0x7f || part.DataCodingScheme != 0x10 {
		t.Fatalf("part=%+v", part)
	}
}

func TestSendSMSWithOptionsPropagatesSubmitFirstOctetFlags(t *testing.T) {
	transport := &fakeSMSTransport{}
	svc := NewService("dev-1", "310280000000001", nil, nil)
	svc.SetSMSTransport(transport)

	_, err := svc.SendSMSWithOptions(context.Background(), "+18005551212", "hello", SendOptions{
		ReplyPath:        true,
		RejectDuplicates: true,
	})
	if err != nil {
		t.Fatalf("SendSMSWithOptions() error = %v", err)
	}
	if len(transport.requests) != 1 {
		t.Fatalf("requests=%+v", transport.requests)
	}
	part := transport.requests[0].Part
	if !part.ReplyPath || !part.RejectDuplicates {
		t.Fatalf("part=%+v", part)
	}
}

func TestSendSMSWithTransportFailureMarksDeliveryFailed(t *testing.T) {
	store := &fakeDeliveryStore{}
	transport := &fakeSMSTransport{failPart: 2}
	svc := NewService("dev-1", "310280000000001", store, nil)
	svc.SetSMSTransport(transport)

	out, err := svc.SendSMSWithOptions(context.Background(), "+18005551212", strings.Repeat("a", 161), SendOptions{})
	if err == nil {
		t.Fatal("SendSMSWithOptions() err=nil, want failure")
	}
	if out.State != "failed" || out.Parts != 1 || store.state != "failed" || store.acks != 1 {
		t.Fatalf("outcome=%+v store=%+v", out, store)
	}
	if !strings.Contains(store.lastError, "part failed") {
		t.Fatalf("lastError=%q", store.lastError)
	}
}

func TestSendSMSWithTransportFailureQueuesIMSRetry(t *testing.T) {
	store := &fakeRetryDeliveryStore{}
	transport := &retrySMSTransport{
		result: SMSSendResult{State: "failed", SIPCode: 503, ErrorText: "Service Unavailable", RetryAfter: 2 * time.Second},
		err:    errors.New("Service Unavailable"),
	}
	svc := NewService("dev-1", "310280000000001", store, nil)
	svc.SetSMSTransport(transport)

	out, err := svc.SendSMSWithOptions(context.Background(), "+18005551212", "hello", SendOptions{})
	if err == nil {
		t.Fatal("SendSMSWithOptions() err=nil, want failure")
	}
	if out.State != "failed" || len(transport.requests) != 1 {
		t.Fatalf("outcome=%+v requests=%+v", out, transport.requests)
	}
	if len(store.retryUpserts) != 1 || len(store.retryDeletes) != 0 {
		t.Fatalf("retry upserts=%+v deletes=%+v", store.retryUpserts, store.retryDeletes)
	}
	envelope := store.retryUpserts[0]
	if !envelope.Pending() ||
		envelope.Operation != IMSMessagingRetryOperationSMSSubmit ||
		envelope.Key != IMSMessagingSMSSubmitIdempotencyKey(transport.requests[0]) ||
		envelope.IdempotencyKey != envelope.Key ||
		envelope.Plan.Action != IMSMessagingRetryActionRecoverRegistration ||
		envelope.DueAt.IsZero() ||
		!envelope.ReplayReady(envelope.DueAt) {
		t.Fatalf("retry envelope=%+v", envelope)
	}
	req, ok := envelope.SMSSubmitRequest()
	if !ok || req.MessageID != out.MessageID || req.Peer != "+18005551212" || req.Part.Text != "hello" {
		t.Fatalf("SMSSubmitRequest()=%+v ok=%v", req, ok)
	}
}

func TestSendSMSWithTransportSuccessClearsIMSRetry(t *testing.T) {
	store := &fakeRetryDeliveryStore{}
	transport := &fakeSMSTransport{}
	svc := NewService("dev-1", "310280000000001", store, nil)
	svc.SetSMSTransport(transport)

	out, err := svc.SendSMSWithOptions(context.Background(), "+18005551212", "hello", SendOptions{})
	if err != nil {
		t.Fatalf("SendSMSWithOptions() error = %v", err)
	}
	if out.State != "sent" || len(transport.requests) != 1 {
		t.Fatalf("outcome=%+v requests=%+v", out, transport.requests)
	}
	if len(store.retryUpserts) != 0 || len(store.retryDeletes) != 1 {
		t.Fatalf("retry upserts=%+v deletes=%+v", store.retryUpserts, store.retryDeletes)
	}
	if store.retryDeletes[0].operation != IMSMessagingRetryOperationSMSSubmit ||
		store.retryDeletes[0].key != IMSMessagingSMSSubmitIdempotencyKey(transport.requests[0]) {
		t.Fatalf("retry delete=%+v", store.retryDeletes[0])
	}
}

func TestSendSMSWithOptionsRejectsInvalidConcatReference(t *testing.T) {
	svc := NewService("dev-1", "310280000000001", nil, nil)
	_, err := svc.SendSMSWithOptions(context.Background(), "+18005551212", strings.Repeat("a", 161), SendOptions{
		ConcatRef:     0x1ff,
		ConcatRefBits: 8,
	})
	if err == nil || !strings.Contains(err.Error(), "8-bit concat reference") {
		t.Fatalf("SendSMSWithOptions() err=%v, want 8-bit concat reference error", err)
	}
}

func TestSendSMSWithOptionsRejectsInvalidValidityPeriod(t *testing.T) {
	svc := NewService("dev-1", "310280000000001", nil, nil)
	_, err := svc.SendSMSWithOptions(context.Background(), "+18005551212", "hello", SendOptions{
		ValidityPeriod: 64 * 7 * 24 * time.Hour,
	})
	if err == nil || !strings.Contains(err.Error(), "validity period") {
		t.Fatalf("SendSMSWithOptions() err=%v, want validity period error", err)
	}

	_, err = svc.SendSMSWithOptions(context.Background(), "+18005551212", "hello", SendOptions{
		ValidityPeriod:   time.Hour,
		ValidityDeadline: time.Date(2026, 7, 5, 12, 34, 56, 0, time.UTC),
	})
	if err == nil || !strings.Contains(err.Error(), "mutually exclusive") {
		t.Fatalf("SendSMSWithOptions() err=%v, want mutual exclusion", err)
	}
}

func TestSendSMSWithOptionsRejectsInvalidApplicationPort(t *testing.T) {
	svc := NewService("dev-1", "310280000000001", nil, nil)
	_, err := svc.SendSMSWithOptions(context.Background(), "+18005551212", "hello", SendOptions{
		ApplicationDestPort: 0x100,
		ApplicationPortBits: 8,
	})
	if err == nil || !strings.Contains(err.Error(), "8-bit application port") {
		t.Fatalf("SendSMSWithOptions() err=%v, want 8-bit application port error", err)
	}
}

func TestSendSMSWithOptionsRejectsInvalidNationalLanguage(t *testing.T) {
	svc := NewService("dev-1", "310280000000001", nil, nil)
	_, err := svc.SendSMSWithOptions(context.Background(), "+18005551212", "hello", SendOptions{
		SingleShiftLang: 14,
	})
	if err == nil || !strings.Contains(err.Error(), "national single shift") {
		t.Fatalf("SendSMSWithOptions() err=%v, want national single shift error", err)
	}
}

func TestUSSDTransportSessionLifecycle(t *testing.T) {
	transport := &fakeUSSDTransport{
		executeResult:  USSDResult{Text: "1. Balance\n2. Data", RawText: "menu", Status: 1, DCS: 15, Done: false},
		continueResult: USSDResult{Text: "Balance: 10", Status: 0, DCS: 15, Done: true},
	}
	dispatch := &fakeDispatcher{}
	svc := NewService("dev-1", "310280000000001", nil, dispatch)
	svc.SetUSSDTransport(transport)

	first, err := svc.SendUSSD(context.Background(), "*100#")
	if err != nil {
		t.Fatalf("SendUSSD() error = %v", err)
	}
	if first.Done || first.SessionID == "" || first.Text != "1. Balance\n2. Data" {
		t.Fatalf("first=%+v", first)
	}
	if len(transport.executeRequests) != 1 || transport.executeRequests[0].Command != "*100#" {
		t.Fatalf("execute requests=%+v", transport.executeRequests)
	}
	if len(dispatch.events) != 1 {
		t.Fatalf("events=%d", len(dispatch.events))
	}
	firstEvent, ok := dispatch.events[0].(eventhost.USSDUpdated)
	if !ok || firstEvent.DevID != "dev-1" || firstEvent.SessionID != first.SessionID || firstEvent.Text != "1. Balance\n2. Data" || firstEvent.RawText != "menu" || firstEvent.Status != 1 || firstEvent.DCS != 15 || firstEvent.Done || firstEvent.Time.IsZero() {
		t.Fatalf("event=%+v", dispatch.events[0])
	}

	next, err := svc.ContinueUSSD(context.Background(), first.SessionID, "1")
	if err != nil {
		t.Fatalf("ContinueUSSD() error = %v", err)
	}
	if !next.Done || next.Text != "Balance: 10" {
		t.Fatalf("next=%+v", next)
	}
	if len(transport.continueRequests) != 1 || transport.continueRequests[0].Input != "1" {
		t.Fatalf("continue requests=%+v", transport.continueRequests)
	}
	if len(dispatch.events) != 2 {
		t.Fatalf("events=%d", len(dispatch.events))
	}
	nextEvent, ok := dispatch.events[1].(eventhost.USSDUpdated)
	if !ok || nextEvent.SessionID != first.SessionID || nextEvent.Text != "Balance: 10" || nextEvent.Status != 0 || nextEvent.DCS != 15 || !nextEvent.Done || nextEvent.Time.IsZero() {
		t.Fatalf("event=%+v", dispatch.events[1])
	}
	if _, err := svc.ContinueUSSD(context.Background(), first.SessionID, "1"); err == nil {
		t.Fatal("ContinueUSSD() err=nil after session completion, want inactive session error")
	}
}

func TestSendUSSDTransportFailureQueuesIMSRetry(t *testing.T) {
	store := &fakeRetryDeliveryStore{}
	transport := &fakeUSSDTransport{
		executeResult: USSDResult{Status: 503, Done: true, RetryAfter: 4 * time.Second},
		executeErr:    errors.New("Service Unavailable"),
	}
	svc := NewService("dev-1", "310280000000001", store, nil)
	svc.SetUSSDTransport(transport)

	_, err := svc.SendUSSD(context.Background(), "*100#")
	if err == nil {
		t.Fatal("SendUSSD() err=nil, want failure")
	}
	if len(transport.executeRequests) != 1 {
		t.Fatalf("execute requests=%+v", transport.executeRequests)
	}
	if len(store.retryUpserts) != 1 || len(store.retryDeletes) != 0 {
		t.Fatalf("retry upserts=%+v deletes=%+v", store.retryUpserts, store.retryDeletes)
	}
	envelope := store.retryUpserts[0]
	if !envelope.Pending() ||
		envelope.Operation != IMSMessagingRetryOperationUSSDSession ||
		envelope.Method != "INVITE" ||
		envelope.Key != IMSMessagingUSSDSessionKey(transport.executeRequests[0]) ||
		envelope.SessionKey != envelope.Key ||
		envelope.DueAt.IsZero() ||
		!envelope.ReplayReady(envelope.DueAt) {
		t.Fatalf("retry envelope=%+v", envelope)
	}
	req, ok := envelope.USSDRequest()
	if !ok || req.Command != "*100#" || req.SessionID != transport.executeRequests[0].SessionID {
		t.Fatalf("USSDRequest()=%+v ok=%v", req, ok)
	}
}

func TestReplayIMSMessagingRetrySMSSuccessDeletesRetry(t *testing.T) {
	now := time.Date(2026, 7, 9, 12, 0, 0, 0, time.UTC)
	req := SMSSendRequest{
		DeviceID:  "dev-1",
		IMSI:      "310280000000001",
		Peer:      "+18005551212",
		MessageID: "msg-1",
		Part:      SMSPart{PartNo: 1, TotalParts: 1, Text: "hello"},
	}
	envelope := NewIMSSMSSubmitRetryEnvelope(
		req,
		SMSSendResult{State: "failed", SIPCode: 503, ErrorText: "Service Unavailable", RetryAfter: time.Second},
		errors.New("Service Unavailable"),
		IMSMessagingRetryOptions{Attempt: 1, Now: now.Add(-2 * time.Second)},
	)
	store := &fakeRetryDeliveryStore{}
	transport := &fakeSMSTransport{}
	svc := NewService("dev-1", "310280000000001", store, nil)
	svc.SetSMSTransport(transport)

	result, err := svc.ReplayIMSMessagingRetry(context.Background(), envelope, now)
	if err != nil {
		t.Fatalf("ReplayIMSMessagingRetry() error = %v", err)
	}
	if !result.Replayed || !result.Deleted || result.Upserted || result.SMSResult.State != "sent" {
		t.Fatalf("replay result=%+v", result)
	}
	if len(transport.requests) != 1 || transport.requests[0].MessageID != "msg-1" {
		t.Fatalf("transport requests=%+v", transport.requests)
	}
	if len(store.retryDeletes) != 1 || store.retryDeletes[0].operation != IMSMessagingRetryOperationSMSSubmit || store.retryDeletes[0].key != envelope.Key {
		t.Fatalf("retry deletes=%+v", store.retryDeletes)
	}
	if len(store.retryUpserts) != 0 {
		t.Fatalf("retry upserts=%+v", store.retryUpserts)
	}
	if len(store.parts) != 1 || store.parts[0].State != "sent" || store.recomputedMessageID != "msg-1" {
		t.Fatalf("delivery store parts=%+v recomputed=%q", store.parts, store.recomputedMessageID)
	}
	if !result.NextEnvelope.Terminal() {
		t.Fatalf("next envelope should be terminal after success: %+v", result.NextEnvelope)
	}
}

func TestReplayIMSMessagingRetrySMSFailureUpsertsNextAttempt(t *testing.T) {
	now := time.Date(2026, 7, 9, 12, 0, 0, 0, time.UTC)
	req := SMSSendRequest{
		DeviceID:  "dev-1",
		IMSI:      "310280000000001",
		Peer:      "+18005551212",
		MessageID: "msg-1",
		Part:      SMSPart{PartNo: 1, TotalParts: 1, Text: "hello"},
	}
	envelope := NewIMSSMSSubmitRetryEnvelope(
		req,
		SMSSendResult{State: "failed", SIPCode: 503, ErrorText: "Service Unavailable", RetryAfter: time.Second},
		errors.New("Service Unavailable"),
		IMSMessagingRetryOptions{Attempt: 1, Now: now.Add(-2 * time.Second)},
	)
	store := &fakeRetryDeliveryStore{}
	transport := &retrySMSTransport{
		result: SMSSendResult{State: "failed", SIPCode: 503, ErrorText: "Service Unavailable", RetryAfter: 3 * time.Second},
		err:    errors.New("Service Unavailable"),
	}
	svc := NewService("dev-1", "310280000000001", store, nil)
	svc.SetSMSTransport(transport)

	result, err := svc.ReplayIMSMessagingRetry(context.Background(), envelope, now)
	if err == nil {
		t.Fatal("ReplayIMSMessagingRetry() err=nil, want retry failure")
	}
	if !result.Replayed || !result.Upserted || result.Deleted || len(store.retryUpserts) != 1 || len(store.retryDeletes) != 0 {
		t.Fatalf("replay result=%+v upserts=%+v deletes=%+v", result, store.retryUpserts, store.retryDeletes)
	}
	next := store.retryUpserts[0]
	if !next.Pending() || next.Key != envelope.Key || next.Attempt != 2 || next.NextAttempt != 3 || !next.DueAt.Equal(now.Add(3*time.Second)) {
		t.Fatalf("next retry envelope=%+v", next)
	}
	if len(transport.requests) != 1 || transport.requests[0].MessageID != "msg-1" {
		t.Fatalf("transport requests=%+v", transport.requests)
	}
}

func TestReplayIMSMessagingRetrySkipsNotDueEnvelope(t *testing.T) {
	now := time.Date(2026, 7, 9, 12, 0, 0, 0, time.UTC)
	req := SMSSendRequest{
		DeviceID:  "dev-1",
		IMSI:      "310280000000001",
		Peer:      "+18005551212",
		MessageID: "msg-1",
		Part:      SMSPart{PartNo: 1, TotalParts: 1, Text: "hello"},
	}
	envelope := NewIMSSMSSubmitRetryEnvelope(
		req,
		SMSSendResult{State: "failed", SIPCode: 503, ErrorText: "Service Unavailable", RetryAfter: time.Minute},
		errors.New("Service Unavailable"),
		IMSMessagingRetryOptions{Attempt: 1, Now: now},
	)
	store := &fakeRetryDeliveryStore{}
	transport := &fakeSMSTransport{}
	svc := NewService("dev-1", "310280000000001", store, nil)
	svc.SetSMSTransport(transport)

	result, err := svc.ReplayIMSMessagingRetry(context.Background(), envelope, now.Add(10*time.Second))
	if err != nil {
		t.Fatalf("ReplayIMSMessagingRetry() error = %v", err)
	}
	if result.Replayed || len(transport.requests) != 0 || len(store.retryUpserts) != 0 || len(store.retryDeletes) != 0 {
		t.Fatalf("result=%+v requests=%+v upserts=%+v deletes=%+v", result, transport.requests, store.retryUpserts, store.retryDeletes)
	}
}

func TestReplayIMSMessagingRetryUSSDExecuteSuccessDeletesRetry(t *testing.T) {
	now := time.Date(2026, 7, 9, 12, 0, 0, 0, time.UTC)
	req := USSDRequest{DeviceID: "dev-1", IMSI: "310280000000001", SessionID: "ussd-1", Command: "*100#"}
	envelope := NewIMSUSSDSessionRetryEnvelope(
		req,
		USSDResult{Status: 503, Done: true, RetryAfter: time.Second},
		errors.New("Service Unavailable"),
		IMSMessagingRetryOptions{Attempt: 1, Now: now.Add(-2 * time.Second)},
	)
	store := &fakeRetryDeliveryStore{}
	dispatch := &fakeDispatcher{}
	transport := &fakeUSSDTransport{executeResult: USSDResult{Text: "1. Balance", Status: 200, Done: false}}
	svc := NewService("dev-1", "310280000000001", store, dispatch)
	svc.SetUSSDTransport(transport)

	result, err := svc.ReplayIMSMessagingRetry(context.Background(), envelope, now)
	if err != nil {
		t.Fatalf("ReplayIMSMessagingRetry() error = %v", err)
	}
	if !result.Replayed || !result.Deleted || result.Upserted || result.USSDResult.SessionID != "ussd-1" || !svc.hasUSSDSession("ussd-1") {
		t.Fatalf("replay result=%+v active=%v", result, svc.hasUSSDSession("ussd-1"))
	}
	if len(transport.executeRequests) != 1 || transport.executeRequests[0].Command != "*100#" {
		t.Fatalf("execute requests=%+v", transport.executeRequests)
	}
	if len(store.retryDeletes) != 1 || store.retryDeletes[0].operation != IMSMessagingRetryOperationUSSDSession || store.retryDeletes[0].key != envelope.Key {
		t.Fatalf("retry deletes=%+v", store.retryDeletes)
	}
	if len(dispatch.events) != 1 {
		t.Fatalf("events=%+v", dispatch.events)
	}
}

func TestReplayIMSMessagingRetryUSSDContinueSuccessDoesNotRequireLocalSession(t *testing.T) {
	now := time.Date(2026, 7, 9, 12, 0, 0, 0, time.UTC)
	req := USSDRequest{DeviceID: "dev-1", IMSI: "310280000000001", SessionID: "ussd-1", Input: "1"}
	envelope := NewIMSUSSDSessionRetryEnvelope(
		req,
		USSDResult{Status: 503, Done: true, RetryAfter: time.Second},
		errors.New("Service Unavailable"),
		IMSMessagingRetryOptions{Method: "INFO", Attempt: 1, Now: now.Add(-2 * time.Second)},
	)
	store := &fakeRetryDeliveryStore{}
	transport := &fakeUSSDTransport{continueResult: USSDResult{Text: "Balance: 10", Status: 200, Done: true}}
	svc := NewService("dev-1", "310280000000001", store, nil)
	svc.SetUSSDTransport(transport)

	result, err := svc.ReplayIMSMessagingRetry(context.Background(), envelope, now)
	if err != nil {
		t.Fatalf("ReplayIMSMessagingRetry() error = %v", err)
	}
	if !result.Replayed || !result.Deleted || len(transport.continueRequests) != 1 || transport.continueRequests[0].Input != "1" {
		t.Fatalf("result=%+v continue requests=%+v", result, transport.continueRequests)
	}
	if svc.hasUSSDSession("ussd-1") {
		t.Fatal("terminal replayed USSD continue left an active session")
	}
}

func TestReplayDueIMSMessagingRetriesSelectsDueWithLimit(t *testing.T) {
	now := time.Date(2026, 7, 9, 12, 0, 0, 0, time.UTC)
	dueReq := SMSSendRequest{DeviceID: "dev-1", IMSI: "310280000000001", Peer: "+18005551212", MessageID: "due", Part: SMSPart{PartNo: 1, TotalParts: 1, Text: "due"}}
	laterReq := SMSSendRequest{DeviceID: "dev-1", IMSI: "310280000000001", Peer: "+18005550000", MessageID: "later", Part: SMSPart{PartNo: 1, TotalParts: 1, Text: "later"}}
	due := NewIMSSMSSubmitRetryEnvelope(dueReq, SMSSendResult{State: "failed", SIPCode: 503, RetryAfter: time.Second}, errors.New("Service Unavailable"), IMSMessagingRetryOptions{Attempt: 1, Now: now.Add(-2 * time.Second)})
	later := NewIMSSMSSubmitRetryEnvelope(laterReq, SMSSendResult{State: "failed", SIPCode: 503, RetryAfter: time.Minute}, errors.New("Service Unavailable"), IMSMessagingRetryOptions{Attempt: 1, Now: now})
	transport := &fakeSMSTransport{}
	svc := NewService("dev-1", "310280000000001", &fakeRetryDeliveryStore{}, nil)
	svc.SetSMSTransport(transport)

	results, err := svc.ReplayDueIMSMessagingRetries(context.Background(), []IMSMessagingRetryEnvelope{later, due}, now, 1)
	if err != nil {
		t.Fatalf("ReplayDueIMSMessagingRetries() error = %v", err)
	}
	if len(results) != 1 || !results[0].Replayed || results[0].Envelope.Key != due.Key || len(transport.requests) != 1 || transport.requests[0].MessageID != "due" {
		t.Fatalf("results=%+v requests=%+v", results, transport.requests)
	}
}

func TestReplayDueIMSMessagingRetriesFromStoreLoadsDueEnvelopes(t *testing.T) {
	now := time.Date(2026, 7, 9, 12, 0, 0, 0, time.UTC)
	req := SMSSendRequest{DeviceID: "dev-1", IMSI: "310280000000001", Peer: "+18005551212", MessageID: "due", Part: SMSPart{PartNo: 1, TotalParts: 1, Text: "due"}}
	envelope := NewIMSSMSSubmitRetryEnvelope(req, SMSSendResult{State: "failed", SIPCode: 503, RetryAfter: time.Second}, errors.New("Service Unavailable"), IMSMessagingRetryOptions{Attempt: 1, Now: now.Add(-2 * time.Second)})
	store := &fakeRetryDeliveryStore{dueRetries: []IMSMessagingRetryEnvelope{envelope}}
	transport := &fakeSMSTransport{}
	svc := NewService("dev-1", "310280000000001", store, nil)
	svc.SetSMSTransport(transport)

	results, err := svc.ReplayDueIMSMessagingRetriesFromStore(context.Background(), now, 4)
	if err != nil {
		t.Fatalf("ReplayDueIMSMessagingRetriesFromStore() error = %v", err)
	}
	if len(results) != 1 || !results[0].Replayed || len(transport.requests) != 1 {
		t.Fatalf("results=%+v requests=%+v", results, transport.requests)
	}
	if store.dueLimit != 4 || !store.dueNow.Equal(now) {
		t.Fatalf("due query now=%s limit=%d", store.dueNow, store.dueLimit)
	}
	if len(store.retryDeletes) != 1 || store.retryDeletes[0].key != envelope.Key {
		t.Fatalf("retry deletes=%+v", store.retryDeletes)
	}
}

func TestReplayDueIMSMessagingRetriesFromStoreSkipsStoresWithoutDueQuery(t *testing.T) {
	svc := NewService("dev-1", "310280000000001", &fakeDeliveryStore{}, nil)
	results, err := svc.ReplayDueIMSMessagingRetriesFromStore(context.Background(), time.Now(), 4)
	if err != nil {
		t.Fatalf("ReplayDueIMSMessagingRetriesFromStore() error = %v", err)
	}
	if len(results) != 0 {
		t.Fatalf("results=%+v, want none", results)
	}
}

func TestUSSDCancelDelegatesAndClearsSession(t *testing.T) {
	transport := &fakeUSSDTransport{executeResult: USSDResult{Text: "menu", Done: false}}
	svc := NewService("dev-1", "310280000000001", nil, nil)
	svc.SetUSSDTransport(transport)

	first, err := svc.SendUSSD(context.Background(), "*100#")
	if err != nil {
		t.Fatalf("SendUSSD() error = %v", err)
	}
	if err := svc.CancelUSSD(context.Background(), first.SessionID); err != nil {
		t.Fatalf("CancelUSSD() error = %v", err)
	}
	if len(transport.cancelRequests) != 1 || transport.cancelRequests[0].SessionID != first.SessionID {
		t.Fatalf("cancel requests=%+v", transport.cancelRequests)
	}
	if _, err := svc.ContinueUSSD(context.Background(), first.SessionID, "1"); err == nil {
		t.Fatal("ContinueUSSD() err=nil after cancel, want inactive session error")
	}
}

func TestHandleSMSDeliveryReportMarksAndRecomputes(t *testing.T) {
	store := &fakeDeliveryStore{match: DeliveryPartMatch{MessageID: "msg-1", PartNo: 1, State: "delivered"}}
	svc := NewService("dev-1", "310280000000001", store, nil)

	match, err := svc.HandleSMSDeliveryReport(context.Background(), SMSDeliveryReport{
		InReplyTo: "sip-message-1",
		CallID:    "call-1",
		RPMR:      7,
		SIPCode:   202,
	})
	if err != nil {
		t.Fatalf("HandleSMSDeliveryReport() error = %v", err)
	}
	if match.MessageID != "msg-1" || store.reportState != "delivered" || store.reportSIPCode != 202 || store.reportRPMR != 7 {
		t.Fatalf("match=%+v store=%+v", match, store)
	}
	if store.recomputedMessageID != "msg-1" {
		t.Fatalf("recomputedMessageID=%q", store.recomputedMessageID)
	}
}

func TestHandleSMSDeliveryReportFailureCause(t *testing.T) {
	store := &fakeDeliveryStore{match: DeliveryPartMatch{MessageID: "msg-1", PartNo: 1, State: "failed"}}
	svc := NewService("dev-1", "310280000000001", store, nil)

	_, err := svc.HandleSMSDeliveryReport(context.Background(), SMSDeliveryReport{
		InReplyTo: "sip-message-1",
		RPCause:   42,
	})
	if err != nil {
		t.Fatalf("HandleSMSDeliveryReport() error = %v", err)
	}
	if store.reportState != "failed" || !strings.Contains(store.reportErrText, "42") {
		t.Fatalf("store=%+v", store)
	}
}

func TestHandleSMSDeliveryReportUsesMappedRPCauseText(t *testing.T) {
	store := &fakeDeliveryStore{match: DeliveryPartMatch{MessageID: "msg-1", PartNo: 1, State: "failed"}}
	svc := NewService("dev-1", "310280000000001", store, nil)

	_, err := svc.HandleSMSDeliveryReport(context.Background(), SMSDeliveryReport{
		CallID:  "call-1",
		RPCause: int(SMSRPCauseTemporaryFailure),
	})
	if err != nil {
		t.Fatalf("HandleSMSDeliveryReport() error = %v", err)
	}
	if store.reportErrText != "RP cause 41: temporary failure" {
		t.Fatalf("reportErrText=%q", store.reportErrText)
	}
}

func TestHandleIncomingSMSDispatchesEvent(t *testing.T) {
	dispatch := &fakeDispatcher{}
	svc := NewService("dev-1", "310280000000001", nil, dispatch)

	err := svc.HandleIncomingSMS(context.Background(), IncomingSMS{Sender: "+10086", Content: "hello"})
	if err != nil {
		t.Fatalf("HandleIncomingSMS() error = %v", err)
	}
	if len(dispatch.events) != 1 {
		t.Fatalf("events=%d", len(dispatch.events))
	}
	got, ok := dispatch.events[0].(eventhost.SMSReceived)
	if !ok || got.DevID != "dev-1" || got.Sender != "+10086" || got.Content != "hello" || got.Time.IsZero() {
		t.Fatalf("event=%+v", dispatch.events[0])
	}
}

func TestHandleIncomingSMSAcceptsEmptyControlUDH(t *testing.T) {
	dispatch := &fakeDispatcher{}
	svc := NewService("dev-1", "310280000000001", nil, dispatch)

	err := svc.HandleIncomingSMS(context.Background(), IncomingSMS{
		Sender:         "+10086",
		UserDataHeader: true,
		UserDataHeaderInfo: SMSUserDataHeaderInfo{
			Raw: []byte{0x04, 0x01, 0x02, 0x80, 0x02},
			SpecialMessageIndications: []SMSSpecialMessageIndication{{
				MessageType: "voicemail",
				Count:       2,
				Active:      true,
			}},
		},
	})
	if err != nil {
		t.Fatalf("HandleIncomingSMS() error = %v", err)
	}
	if len(dispatch.events) != 0 {
		t.Fatalf("events=%+v, want none for empty control-only SMS", dispatch.events)
	}

	err = svc.HandleIncomingSMS(context.Background(), IncomingSMS{Sender: "+10086"})
	if err == nil || !strings.Contains(err.Error(), "content is empty") {
		t.Fatalf("HandleIncomingSMS(empty without UDH) err=%v, want empty content error", err)
	}
}

func TestHandleIMSMessageDispatchesRPDataAndReturnsAck(t *testing.T) {
	dispatch := &fakeDispatcher{}
	svc := NewService("dev-1", "310280000000001", nil, dispatch)
	tpdu := mustHex(t, "0005810180F600006270502143650005E8329BFD06")

	result, err := svc.HandleIMSMessage(context.Background(), IMSMessageRequest{
		FromURI:     "sip:smsc@ims.example",
		ToURI:       "sip:user@ims.example",
		CallID:      "sms-downlink-1",
		ContentType: IMS3GPPSMSContentType,
		Body:        imsRPDataBody(0x33, tpdu),
	})
	if err != nil {
		t.Fatalf("HandleIMSMessage() error = %v", err)
	}
	if result.StatusCode != 200 || result.ReplyContentType != IMS3GPPSMSContentType || string(result.ReplyBody) != string(BuildSMSRPAck(0x33)) {
		t.Fatalf("result=%+v", result)
	}
	if len(dispatch.events) != 1 {
		t.Fatalf("events=%d", len(dispatch.events))
	}
	got, ok := dispatch.events[0].(eventhost.SMSReceived)
	if !ok || got.Sender != "10086" || got.Content != "hello" {
		t.Fatalf("event=%+v", dispatch.events[0])
	}
}

func TestHandleIMSMessageUnwrapsCPIM3GPPSMSAndWrapsAck(t *testing.T) {
	dispatch := &fakeDispatcher{}
	svc := NewService("dev-1", "310280000000001", nil, dispatch)
	tpdu := mustHex(t, "0005810180F600006270502143650005E8329BFD06")
	rpdu := imsRPDataBody(0x33, tpdu)
	cpimBody, err := BuildIMSCPIMMessage("<sip:smsc@ims.example>", "<sip:user@ims.example>", IMS3GPPSMSContentType, rpdu)
	if err != nil {
		t.Fatalf("BuildIMSCPIMMessage() error = %v", err)
	}
	cpimBody = append(cpimBody, '\r', '\n')

	result, err := svc.HandleIMSMessage(context.Background(), IMSMessageRequest{
		CallID:      "sms-downlink-cpim",
		ContentType: "message/cpim; charset=utf-8",
		Body:        cpimBody,
	})
	if err != nil {
		t.Fatalf("HandleIMSMessage() error = %v", err)
	}
	if result.StatusCode != 200 || result.ReplyContentType != IMSCPIMContentType || result.Incoming == nil || result.Incoming.Content != "hello" {
		t.Fatalf("result=%+v", result)
	}
	reply, err := ParseIMSCPIMMessage(result.ReplyBody)
	if err != nil {
		t.Fatalf("ParseIMSCPIMMessage(reply) error = %v body=%x", err, result.ReplyBody)
	}
	if reply.ContentType != IMS3GPPSMSContentType || string(reply.Body) != string(BuildSMSRPAck(0x33)) {
		t.Fatalf("reply=%+v body=%x", reply, reply.Body)
	}
	if got := imsHeaderValue(reply.Headers, "From"); got != "<sip:user@ims.example>" {
		t.Fatalf("reply From=%q", got)
	}
	if got := imsHeaderValue(reply.Headers, "To"); got != "<sip:smsc@ims.example>" {
		t.Fatalf("reply To=%q", got)
	}
	if len(dispatch.events) != 1 {
		t.Fatalf("events=%d", len(dispatch.events))
	}
	got, ok := dispatch.events[0].(eventhost.SMSReceived)
	if !ok || got.Sender != "10086" || got.Content != "hello" {
		t.Fatalf("event=%+v", dispatch.events[0])
	}
}

func TestHandleIMSMessageRejectsMalformedCPIM(t *testing.T) {
	svc := NewService("dev-1", "310280000000001", nil, nil)

	result, err := svc.HandleIMSMessage(context.Background(), IMSMessageRequest{
		ContentType: IMSCPIMContentType,
		Body:        []byte("From: <sip:smsc@ims.example>\r\nContent-Type: application/vnd.3gpp.sms\r\n"),
	})
	if err == nil || result.StatusCode != 400 {
		t.Fatalf("result=%+v err=%v, want malformed CPIM rejection", result, err)
	}
}

func TestHandleIMSMessageAcceptsAlphanumericSender(t *testing.T) {
	dispatch := &fakeDispatcher{}
	svc := NewService("dev-1", "310280000000001", nil, dispatch)
	tpdu := mustHex(t, "0006D0C7F7FBCC2E0300006270502143650005E8329BFD06")

	result, err := svc.HandleIMSMessage(context.Background(), IMSMessageRequest{
		FromURI:     "sip:smsc@ims.example",
		ToURI:       "sip:user@ims.example",
		ContentType: IMS3GPPSMSContentType,
		Body:        imsRPDataBody(0x37, tpdu),
	})
	if err != nil {
		t.Fatalf("HandleIMSMessage() error = %v", err)
	}
	if result.Incoming == nil || result.Incoming.Sender != "Google" || result.Incoming.Content != "hello" || string(result.ReplyBody) != string(BuildSMSRPAck(0x37)) {
		t.Fatalf("result=%+v", result)
	}
	if len(dispatch.events) != 1 {
		t.Fatalf("events=%d", len(dispatch.events))
	}
	got, ok := dispatch.events[0].(eventhost.SMSReceived)
	if !ok || got.Sender != "Google" || got.Content != "hello" {
		t.Fatalf("event=%+v", dispatch.events[0])
	}
}

func TestHandleIMSMessagePreservesDeliverProtocolMetadata(t *testing.T) {
	svc := NewService("dev-1", "310280000000001", nil, nil)
	tpdu := mustHex(t, "A405810180F67F006270502143650005E8329BFD06")

	result, err := svc.HandleIMSMessage(context.Background(), IMSMessageRequest{
		FromURI:     "sip:smsc@ims.example",
		ToURI:       "sip:user@ims.example",
		ContentType: IMS3GPPSMSContentType,
		Body:        imsRPDataBody(0x36, tpdu),
	})
	if err != nil {
		t.Fatalf("HandleIMSMessage() error = %v", err)
	}
	if result.Incoming == nil || result.Incoming.Content != "hello" {
		t.Fatalf("result=%+v", result)
	}
	incoming := result.Incoming
	if incoming.ProtocolID != 0x7f || incoming.DataCodingScheme != 0x00 {
		t.Fatalf("incoming metadata=%+v", incoming)
	}
	if incoming.DataCoding.Raw != 0x00 || incoming.DataCoding.Alphabet != "gsm7" {
		t.Fatalf("incoming data coding=%+v", incoming.DataCoding)
	}
	if incoming.UserDataHeader || !incoming.StatusReportIndication || !incoming.ReplyPath || incoming.MoreMessagesToSend {
		t.Fatalf("incoming flags=%+v", incoming)
	}
	if string(result.ReplyBody) != string(BuildSMSRPAck(0x36)) {
		t.Fatalf("reply=%x", result.ReplyBody)
	}
}

func TestHandleIMSMessagePreservesUDHPortMetadata(t *testing.T) {
	svc := NewService("dev-1", "310280000000001", nil, nil)
	tpdu := mustHex(t, "4005810180F6000462705021436500090605040B8423F06869")

	result, err := svc.HandleIMSMessage(context.Background(), IMSMessageRequest{
		FromURI:     "sip:smsc@ims.example",
		ToURI:       "sip:user@ims.example",
		ContentType: IMS3GPPSMSContentType,
		Body:        imsRPDataBody(0x38, tpdu),
	})
	if err != nil {
		t.Fatalf("HandleIMSMessage() error = %v", err)
	}
	if result.Incoming == nil || result.Incoming.Content != "hi" || string(result.ReplyBody) != string(BuildSMSRPAck(0x38)) {
		t.Fatalf("result=%+v", result)
	}
	header := result.Incoming.UserDataHeaderInfo
	if !result.Incoming.UserDataHeader || !header.HasPorts || header.PortBits != 16 || header.DestinationPort != 2948 || header.SourcePort != 9200 {
		t.Fatalf("incoming UDH=%+v incoming=%+v", header, result.Incoming)
	}
}

func TestHandleIMSMessagePreservesUDHMessageIndicationMetadata(t *testing.T) {
	svc := NewService("dev-1", "310280000000001", nil, nil)
	tpdu := deliverTPDUWithUserData(t, []byte{0x07, 0x01, 0x02, 0x80, 0x02, 0x06, 0x01, 0x83}, "vm", 0, 0)

	result, err := svc.HandleIMSMessage(context.Background(), IMSMessageRequest{
		FromURI:     "sip:smsc@ims.example",
		ToURI:       "sip:user@ims.example",
		ContentType: IMS3GPPSMSContentType,
		Body:        imsRPDataBody(0x39, tpdu),
	})
	if err != nil {
		t.Fatalf("HandleIMSMessage() error = %v", err)
	}
	if result.Incoming == nil || result.Incoming.Content != "vm" || string(result.ReplyBody) != string(BuildSMSRPAck(0x39)) {
		t.Fatalf("result=%+v", result)
	}
	header := result.Incoming.UserDataHeaderInfo
	if len(header.SpecialMessageIndications) != 1 || header.SpecialMessageIndications[0].MessageType != "voicemail" || header.SpecialMessageIndications[0].Count != 2 {
		t.Fatalf("special indications=%+v", header.SpecialMessageIndications)
	}
	if !header.HasSMSCControl || !header.SMSCControl.StatusReportTransactionCompleted || !header.SMSCControl.IncludeOriginalUDHInStatusReport {
		t.Fatalf("SMSC control=%+v", header.SMSCControl)
	}
}

func TestHandleIMSMessageAcksEmptyMessageIndicationSMS(t *testing.T) {
	dispatch := &fakeDispatcher{}
	svc := NewService("dev-1", "310280000000001", nil, dispatch)
	tpdu := deliverTPDUWithUserData(t, []byte{0x04, 0x01, 0x02, 0x80, 0x02}, "", 0, 0)

	result, err := svc.HandleIMSMessage(context.Background(), IMSMessageRequest{
		FromURI:     "sip:smsc@ims.example",
		ToURI:       "sip:user@ims.example",
		ContentType: IMS3GPPSMSContentType,
		Body:        imsRPDataBody(0x3a, tpdu),
	})
	if err != nil {
		t.Fatalf("HandleIMSMessage() error = %v", err)
	}
	if result.StatusCode != 200 || result.Incoming == nil || result.Incoming.Content != "" || string(result.ReplyBody) != string(BuildSMSRPAck(0x3a)) {
		t.Fatalf("result=%+v", result)
	}
	header := result.Incoming.UserDataHeaderInfo
	if len(header.SpecialMessageIndications) != 1 || header.SpecialMessageIndications[0].MessageType != "voicemail" || header.SpecialMessageIndications[0].Count != 2 {
		t.Fatalf("special indications=%+v", header.SpecialMessageIndications)
	}
	if len(dispatch.events) != 0 {
		t.Fatalf("events=%+v, want none for empty control-only SMS", dispatch.events)
	}
}

func TestHandleIMSMessageReassemblesConcatSMSBeforeDispatch(t *testing.T) {
	dispatch := &fakeDispatcher{}
	svc := NewService("dev-1", "310280000000001", nil, dispatch)
	part1 := mustHex(t, "4005810180F6000862705021436500080500037A02014F60")
	part2 := mustHex(t, "4005810180F6000862705021436500080500037A0202597D")

	result, err := svc.HandleIMSMessage(context.Background(), IMSMessageRequest{
		FromURI:     "sip:smsc@ims.example",
		ToURI:       "sip:user@ims.example",
		CallID:      "sms-downlink-2",
		ContentType: IMS3GPPSMSContentType,
		Body:        imsRPDataBody(0x34, part2),
	})
	if err != nil {
		t.Fatalf("HandleIMSMessage(part2) error = %v", err)
	}
	if result.StatusCode != 200 || result.Incoming != nil || string(result.ReplyBody) != string(BuildSMSRPAck(0x34)) {
		t.Fatalf("part2 result=%+v", result)
	}
	if len(dispatch.events) != 0 {
		t.Fatalf("events after partial=%d", len(dispatch.events))
	}

	result, err = svc.HandleIMSMessage(context.Background(), IMSMessageRequest{
		FromURI:     "sip:smsc@ims.example",
		ToURI:       "sip:user@ims.example",
		CallID:      "sms-downlink-1",
		ContentType: IMS3GPPSMSContentType,
		Body:        imsRPDataBody(0x33, part1),
	})
	if err != nil {
		t.Fatalf("HandleIMSMessage(part1) error = %v", err)
	}
	if result.StatusCode != 200 || result.Incoming == nil || result.Incoming.Content != "你好" || string(result.ReplyBody) != string(BuildSMSRPAck(0x33)) {
		t.Fatalf("part1 result=%+v", result)
	}
	if len(dispatch.events) != 1 {
		t.Fatalf("events after complete=%d", len(dispatch.events))
	}
	got, ok := dispatch.events[0].(eventhost.SMSReceived)
	if !ok || got.Sender != "10086" || got.Content != "你好" {
		t.Fatalf("event=%+v", dispatch.events[0])
	}
}

func TestHandleIMSMessageIgnoresDuplicateConcatPartUntilComplete(t *testing.T) {
	dispatch := &fakeDispatcher{}
	svc := NewService("dev-1", "310280000000001", nil, dispatch)
	part1 := mustHex(t, "4005810180F6000862705021436500080500037A02014F60")
	part2 := mustHex(t, "4005810180F6000862705021436500080500037A0202597D")

	for i := 0; i < 2; i++ {
		result, err := svc.HandleIMSMessage(context.Background(), IMSMessageRequest{
			FromURI:     "sip:smsc@ims.example",
			ToURI:       "sip:user@ims.example",
			ContentType: IMS3GPPSMSContentType,
			Body:        imsRPDataBody(byte(0x40+i), part2),
		})
		if err != nil {
			t.Fatalf("HandleIMSMessage(part2 duplicate %d) error = %v", i, err)
		}
		if result.Incoming != nil || len(dispatch.events) != 0 {
			t.Fatalf("duplicate result=%+v events=%d", result, len(dispatch.events))
		}
	}

	result, err := svc.HandleIMSMessage(context.Background(), IMSMessageRequest{
		FromURI:     "sip:smsc@ims.example",
		ToURI:       "sip:user@ims.example",
		ContentType: IMS3GPPSMSContentType,
		Body:        imsRPDataBody(0x42, part1),
	})
	if err != nil {
		t.Fatalf("HandleIMSMessage(part1) error = %v", err)
	}
	if result.Incoming == nil || result.Incoming.Content != "你好" || len(dispatch.events) != 1 {
		t.Fatalf("complete result=%+v events=%d", result, len(dispatch.events))
	}
}

func TestHandleIMSMessageMalformedConcatFallsBackToSingleSMS(t *testing.T) {
	dispatch := &fakeDispatcher{}
	svc := NewService("dev-1", "310280000000001", nil, dispatch)
	tpdu := mustHex(t, "4005810180F6000862705021436500080500037A02004F60")

	result, err := svc.HandleIMSMessage(context.Background(), IMSMessageRequest{
		FromURI:     "sip:smsc@ims.example",
		ToURI:       "sip:user@ims.example",
		ContentType: IMS3GPPSMSContentType,
		Body:        imsRPDataBody(0x35, tpdu),
	})
	if err != nil {
		t.Fatalf("HandleIMSMessage() error = %v", err)
	}
	if result.Incoming == nil || result.Incoming.Content != "你" || string(result.ReplyBody) != string(BuildSMSRPAck(0x35)) {
		t.Fatalf("result=%+v", result)
	}
	if len(dispatch.events) != 1 {
		t.Fatalf("events=%d", len(dispatch.events))
	}
}

func TestHandleIMSMessageMarksRPErrorDeliveryReport(t *testing.T) {
	store := &fakeDeliveryStore{match: DeliveryPartMatch{MessageID: "msg-1", PartNo: 1, State: "failed"}}
	svc := NewService("dev-1", "310280000000001", store, nil)

	result, err := svc.HandleIMSMessage(context.Background(), IMSMessageRequest{
		CallID:      "call-1",
		ContentType: IMS3GPPSMSContentType,
		Body:        BuildSMSRPError(7, SMSRPCauseTemporaryFailure),
	})
	if err != nil {
		t.Fatalf("HandleIMSMessage() error = %v", err)
	}
	if result.StatusCode != 200 || result.DeliveryReport == nil {
		t.Fatalf("result=%+v", result)
	}
	if store.reportCallID != "call-1" || store.reportRPMR != 7 || store.reportState != "failed" || store.reportRPCause != int(SMSRPCauseTemporaryFailure) {
		t.Fatalf("store=%+v", store)
	}
	if store.reportErrText != "RP cause 41: temporary failure" {
		t.Fatalf("reportErrText=%q", store.reportErrText)
	}
}

func TestHandleIMSMessageMarksStatusReportFailureText(t *testing.T) {
	store := &fakeDeliveryStore{match: DeliveryPartMatch{MessageID: "msg-1", PartNo: 1, State: "failed"}}
	svc := NewService("dev-1", "310280000000001", store, nil)
	tpdu := mustHex(t, "02070B918100551512F2627050214365006270502144000046")

	result, err := svc.HandleIMSMessage(context.Background(), IMSMessageRequest{
		CallID:      "status-report-failed",
		ContentType: IMS3GPPSMSContentType,
		Body:        imsRPDataBody(0x44, tpdu),
	})
	if err != nil {
		t.Fatalf("HandleIMSMessage() error = %v", err)
	}
	if result.StatusCode != 200 || result.DeliveryReport == nil {
		t.Fatalf("result=%+v", result)
	}
	if store.reportCallID != "status-report-failed" || store.reportRPMR != 7 || store.reportState != "failed" || store.reportRPCause != 0x46 {
		t.Fatalf("store=%+v", store)
	}
	if !strings.Contains(store.reportErrText, "validity period expired") {
		t.Fatalf("reportErrText=%q", store.reportErrText)
	}
}

func TestHandleIMSMessagePreservesStatusReportOptionalParameters(t *testing.T) {
	svc := NewService("dev-1", "310280000000001", nil, nil)
	tpdu := mustHex(t, "26070B918100551512F2627050214365006270502144000000077F0005E8329BFD06")

	result, err := svc.HandleIMSMessage(context.Background(), IMSMessageRequest{
		CallID:      "status-report-optional",
		ContentType: IMS3GPPSMSContentType,
		Body:        imsRPDataBody(0x45, tpdu),
	})
	if err != nil {
		t.Fatalf("HandleIMSMessage() error = %v", err)
	}
	if result.StatusCode != 200 || result.DeliveryReport == nil || string(result.ReplyBody) != string(BuildSMSRPAck(0x45)) {
		t.Fatalf("result=%+v", result)
	}
	report := result.DeliveryReport
	if report.RPMR != 7 || report.State != "delivered" || report.Recipient != "+18005551212" || report.FirstOctet != 0x26 {
		t.Fatalf("report=%+v", report)
	}
	if report.MoreMessagesToSend || !report.StatusReportQualifier || report.UserDataHeader {
		t.Fatalf("report flags=%+v", report)
	}
	if report.ParameterIndicator != 0x07 || report.ProtocolID != 0x7f || report.DataCodingScheme != 0x00 || report.UserData != "hello" {
		t.Fatalf("report optional fields=%+v", report)
	}
	if report.DataCoding.Raw != 0x00 || report.DataCoding.Alphabet != "gsm7" {
		t.Fatalf("report data coding=%+v", report.DataCoding)
	}
}

func TestHandleIMSMessageMarksStatusReportFromRPAck(t *testing.T) {
	store := &fakeDeliveryStore{match: DeliveryPartMatch{MessageID: "msg-1", PartNo: 1, State: "delivered"}}
	svc := NewService("dev-1", "310280000000001", store, nil)
	tpdu := mustHex(t, "02070B918100551512F2627050214365006270502144000000")
	body, err := BuildSMSRPAckWithTPDU(0x66, tpdu)
	if err != nil {
		t.Fatalf("BuildSMSRPAckWithTPDU() error = %v", err)
	}

	result, err := svc.HandleIMSMessage(context.Background(), IMSMessageRequest{
		CallID:      "status-report-in-ack",
		ContentType: IMS3GPPSMSContentType,
		Body:        body,
	})
	if err != nil {
		t.Fatalf("HandleIMSMessage() error = %v", err)
	}
	if result.StatusCode != 200 || result.DeliveryReport == nil || len(result.ReplyBody) != 0 {
		t.Fatalf("result=%+v", result)
	}
	report := result.DeliveryReport
	if report.RPMR != 7 || report.State != "delivered" || report.Recipient != "+18005551212" {
		t.Fatalf("report=%+v", report)
	}
	if store.reportCallID != "status-report-in-ack" || store.reportRPMR != 7 || store.reportState != "delivered" || store.reportRPCause != 0 {
		t.Fatalf("store=%+v", store)
	}
	if store.recomputedMessageID != "msg-1" {
		t.Fatalf("recomputedMessageID=%q", store.recomputedMessageID)
	}
}

type fakeSMSTransport struct {
	requests []SMSSendRequest
	failPart int
}

type retrySMSTransport struct {
	requests []SMSSendRequest
	result   SMSSendResult
	err      error
}

type fakeUSSDTransport struct {
	executeRequests  []USSDRequest
	continueRequests []USSDRequest
	cancelRequests   []USSDRequest
	executeResult    USSDResult
	continueResult   USSDResult
	executeErr       error
	continueErr      error
}

func (t *fakeUSSDTransport) ExecuteUSSD(ctx context.Context, req USSDRequest) (USSDResult, error) {
	t.executeRequests = append(t.executeRequests, req)
	return t.executeResult, t.executeErr
}

func (t *fakeUSSDTransport) ContinueUSSD(ctx context.Context, req USSDRequest) (USSDResult, error) {
	t.continueRequests = append(t.continueRequests, req)
	return t.continueResult, t.continueErr
}

func (t *fakeUSSDTransport) CancelUSSD(ctx context.Context, req USSDRequest) error {
	t.cancelRequests = append(t.cancelRequests, req)
	return nil
}

func (t *fakeSMSTransport) SendSMSPart(ctx context.Context, req SMSSendRequest) (SMSSendResult, error) {
	t.requests = append(t.requests, req)
	if req.Part.PartNo == t.failPart {
		return SMSSendResult{State: "failed", ErrorText: "part failed"}, errors.New("part failed")
	}
	return SMSSendResult{CallID: "call", RPMR: req.Part.PartNo, State: "sent"}, nil
}

func (t *retrySMSTransport) SendSMSPart(ctx context.Context, req SMSSendRequest) (SMSSendResult, error) {
	t.requests = append(t.requests, req)
	return t.result, t.err
}

type fakeDispatcher struct {
	events []eventhost.Event
}

func (d *fakeDispatcher) Dispatch(ctx context.Context, ev eventhost.Event) {
	d.events = append(d.events, ev)
}

type fakeDeliveryStore struct {
	createdPartsTotal   int
	parts               []DeliveryPartStatus
	state               string
	lastError           string
	acks                int
	match               DeliveryPartMatch
	reportInReplyTo     string
	reportCallID        string
	reportDeviceID      string
	reportRPMR          int
	reportState         string
	reportSIPCode       int
	reportRPCause       int
	reportErrText       string
	recomputedMessageID string
}

type fakeRetryDelete struct {
	operation IMSMessagingRetryOperation
	key       string
}

type fakeRetryDeliveryStore struct {
	fakeDeliveryStore
	retryUpserts []IMSMessagingRetryEnvelope
	retryDeletes []fakeRetryDelete
	dueRetries   []IMSMessagingRetryEnvelope
	dueNow       time.Time
	dueLimit     int
}

func (s *fakeDeliveryStore) CreateSMSDelivery(messageID, imsi, deviceID, peer, content string, partsTotal int, at time.Time) error {
	s.createdPartsTotal = partsTotal
	return nil
}

func (s *fakeDeliveryStore) UpsertSMSDeliveryPart(messageID string, partNo int, callID string, rpMR int, state string, sentAt time.Time) error {
	s.parts = append(s.parts, DeliveryPartStatus{PartNo: partNo, CallID: callID, RPMR: rpMR, State: state, SentAt: sentAt})
	return nil
}

func (s *fakeDeliveryStore) MarkSMSDeliveryPartReport(inReplyTo, callID, deviceID string, rpMR int, state string, sipCode int, rpCause int, errText string, at time.Time) (DeliveryPartMatch, error) {
	s.reportInReplyTo = inReplyTo
	s.reportCallID = callID
	s.reportDeviceID = deviceID
	s.reportRPMR = rpMR
	s.reportState = state
	s.reportSIPCode = sipCode
	s.reportRPCause = rpCause
	s.reportErrText = errText
	return s.match, nil
}

func (s *fakeDeliveryStore) RecomputeSMSDelivery(messageID string, at time.Time) error {
	s.recomputedMessageID = messageID
	return nil
}

func (s *fakeDeliveryStore) UpdateSMSDeliveryState(messageID, state, lastError string, acks int, at time.Time) error {
	s.state = state
	s.lastError = lastError
	s.acks = acks
	return nil
}

func (s *fakeDeliveryStore) GetSMSDeliveryStatus(messageID string) (*DeliveryStatus, error) {
	return nil, ErrDeliveryNotFound
}

func (s *fakeRetryDeliveryStore) UpsertIMSMessagingRetry(envelope IMSMessagingRetryEnvelope) error {
	s.retryUpserts = append(s.retryUpserts, envelope)
	return nil
}

func (s *fakeRetryDeliveryStore) DeleteIMSMessagingRetry(operation IMSMessagingRetryOperation, key string) error {
	s.retryDeletes = append(s.retryDeletes, fakeRetryDelete{operation: operation, key: key})
	return nil
}

func (s *fakeRetryDeliveryStore) ListDueIMSMessagingRetries(now time.Time, limit int) ([]IMSMessagingRetryEnvelope, error) {
	s.dueNow = now
	s.dueLimit = limit
	return SelectDueIMSMessagingRetryEnvelopes(s.dueRetries, now, limit), nil
}

func imsRPDataBody(rpMR byte, tpdu []byte) []byte {
	body := make([]byte, 0, 5+len(tpdu))
	body = append(body, 0x01, rpMR, 0x00, 0x00, byte(len(tpdu)))
	body = append(body, tpdu...)
	return body
}
