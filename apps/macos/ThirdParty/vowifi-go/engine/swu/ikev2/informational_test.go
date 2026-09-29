package ikev2

import (
	"bytes"
	"context"
	"encoding/hex"
	"errors"
	"testing"
)

func TestInformationalEmptyDPDRoundTrip(t *testing.T) {
	init, keys := informationalFixture(t)
	iv := bytes.Repeat([]byte{0x71}, keys.Profile.EncryptionBlockSize)
	msg, raw, err := BuildInformationalRequest(init, keys, 9, nil, iv)
	if err != nil {
		t.Fatalf("BuildInformationalRequest() error = %v", err)
	}
	if msg.Header.ExchangeType != ExchangeINFORMATIONAL || msg.Header.Flags != FlagInitiator {
		t.Fatalf("msg.Header=%+v", msg.Header)
	}
	if raw[16] != PayloadSK || raw[18] != ExchangeINFORMATIONAL || raw[28] != PayloadNoNext {
		t.Fatalf("raw header next=%d exchange=%d SK next=%d", raw[16], raw[18], raw[28])
	}
	parsed, inner, err := ParseInformationalRequest(raw, init, keys, 9)
	if err != nil {
		t.Fatalf("ParseInformationalRequest() error = %v", err)
	}
	if parsed.Header.MessageID != 9 || len(inner) != 0 {
		t.Fatalf("parsed=%+v inner=%+v", parsed, inner)
	}

	_, responseRaw, err := BuildInformationalResponse(init, keys, 9, nil, bytes.Repeat([]byte{0x72}, keys.Profile.EncryptionBlockSize))
	if err != nil {
		t.Fatalf("BuildInformationalResponse() error = %v", err)
	}
	response, inner, err := ParseInformationalResponse(responseRaw, init, keys, 9)
	if err != nil {
		t.Fatalf("ParseInformationalResponse() error = %v", err)
	}
	if response.Header.Flags != FlagResponse || len(inner) != 0 {
		t.Fatalf("response=%+v inner=%+v", response, inner)
	}
}

func TestInformationalESPDeleteRoundTrip(t *testing.T) {
	init, keys := informationalFixture(t)
	deletePayload, err := ESPDeletePayload(mustHex("01020304"))
	if err != nil {
		t.Fatalf("ESPDeletePayload() error = %v", err)
	}
	_, raw, err := BuildInformationalRequest(init, keys, 10, []Payload{deletePayload}, bytes.Repeat([]byte{0x73}, keys.Profile.EncryptionBlockSize))
	if err != nil {
		t.Fatalf("BuildInformationalRequest() error = %v", err)
	}
	_, inner, err := ParseInformationalRequest(raw, init, keys, 10)
	if err != nil {
		t.Fatalf("ParseInformationalRequest() error = %v", err)
	}
	if len(inner) != 1 || inner[0].Type != PayloadDelete {
		t.Fatalf("inner=%+v", inner)
	}
	deletePayloadBody, err := ParseDelete(inner[0].Body)
	if err != nil {
		t.Fatalf("ParseDelete() error = %v", err)
	}
	if deletePayloadBody.ProtocolID != ProtocolESP || len(deletePayloadBody.SPIs) != 1 ||
		hex.EncodeToString(deletePayloadBody.SPIs[0]) != "01020304" {
		t.Fatalf("delete=%+v", deletePayloadBody)
	}
}

func TestInformationalContentClassifiesNotifyAndDelete(t *testing.T) {
	init, keys := informationalFixture(t)
	notifyPayload, err := NotifyPayload(Notify{
		NotifyType:       NotifyUnacceptableAddresses,
		NotificationData: []byte{0xaa},
	})
	if err != nil {
		t.Fatalf("NotifyPayload() error = %v", err)
	}
	deletePayload, err := ESPDeletePayload(mustHex("01020304"))
	if err != nil {
		t.Fatalf("ESPDeletePayload() error = %v", err)
	}
	_, raw, err := BuildInformationalResponse(init, keys, 15, []Payload{
		MOBIKESupportedNotify(),
		notifyPayload,
		deletePayload,
	}, bytes.Repeat([]byte{0x7a}, keys.Profile.EncryptionBlockSize))
	if err != nil {
		t.Fatalf("BuildInformationalResponse() error = %v", err)
	}

	_, content, err := ParseInformationalResponseContent(raw, init, keys, 15)
	if err != nil {
		t.Fatalf("ParseInformationalResponseContent() error = %v", err)
	}
	if len(content.Payloads) != 3 || len(content.Notifies) != 2 ||
		len(content.NotifyActions) != 2 || len(content.Deletes) != 1 {
		t.Fatalf("content=%+v", content)
	}
	if !errors.Is(content.NotifyError, ErrIKEv2NotifyError) ||
		!errors.Is(content.NotifyError, ErrNotifyUnacceptableAddresses) {
		t.Fatalf("NotifyError=%v, want ErrIKEv2NotifyError and ErrNotifyUnacceptableAddresses", content.NotifyError)
	}
	var notifyErr *NotifyError
	if !errors.As(content.NotifyError, &notifyErr) {
		t.Fatalf("NotifyError=%T, want *NotifyError", content.NotifyError)
	}
	if notifyErr.Notify.NotifyType != NotifyUnacceptableAddresses ||
		hex.EncodeToString(notifyErr.Notify.NotificationData) != "aa" {
		t.Fatalf("notifyErr=%+v", notifyErr)
	}
	if content.Notifies[0].NotifyType != NotifyMOBIKESupported ||
		content.Notifies[1].NotifyType != NotifyUnacceptableAddresses {
		t.Fatalf("notifies=%+v", content.Notifies)
	}
	if content.NotifyActions[0].Kind != NotifyActionMOBIKESupported ||
		content.NotifyActions[1].Kind != NotifyActionMOBIKEAddressRecovery ||
		!content.NotifyActions[1].Retry {
		t.Fatalf("notify actions=%+v", content.NotifyActions)
	}
	if content.Deletes[0].ProtocolID != ProtocolESP || len(content.Deletes[0].SPIs) != 1 ||
		hex.EncodeToString(content.Deletes[0].SPIs[0]) != "01020304" {
		t.Fatalf("deletes=%+v", content.Deletes)
	}

	_, inner, err := ParseInformationalResponse(raw, init, keys, 15)
	if err != nil {
		t.Fatalf("ParseInformationalResponse() error = %v", err)
	}
	if len(inner) != len(content.Payloads) {
		t.Fatalf("inner=%+v content.Payloads=%+v", inner, content.Payloads)
	}
}

func TestInformationalRejectsMalformedNotifyDelete(t *testing.T) {
	init, keys := informationalFixture(t)
	cases := []struct {
		name    string
		payload Payload
		want    error
	}{
		{
			name:    "notify",
			payload: Payload{Type: PayloadNotify, Body: []byte{ProtocolIKE, 0, 0}},
			want:    ErrInvalidNotify,
		},
		{
			name:    "delete",
			payload: Payload{Type: PayloadDelete, Body: []byte{ProtocolESP, 4, 0, 1, 1, 2, 3}},
			want:    ErrInvalidDelete,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, raw, err := BuildInformationalRequest(init, keys, 16, []Payload{tc.payload}, bytes.Repeat([]byte{0x7b}, keys.Profile.EncryptionBlockSize))
			if err != nil {
				t.Fatalf("BuildInformationalRequest() error = %v", err)
			}
			_, _, err = ParseInformationalRequest(raw, init, keys, 16)
			if !errors.Is(err, ErrInvalidInformational) || !errors.Is(err, tc.want) {
				t.Fatalf("ParseInformationalRequest() err=%v, want ErrInvalidInformational and %v", err, tc.want)
			}
		})
	}
}

func TestRunInformationalExchangeReturnsResponseContent(t *testing.T) {
	init, keys := informationalFixture(t)
	notifyPayload, err := NotifyPayload(Notify{NotifyType: NotifyInvalidSyntax})
	if err != nil {
		t.Fatalf("NotifyPayload() error = %v", err)
	}
	deletePayload, err := ESPDeletePayload(mustHex("aabbccdd"))
	if err != nil {
		t.Fatalf("ESPDeletePayload() error = %v", err)
	}
	transport := &informationalExchangeTransport{
		t:                    t,
		init:                 init,
		keys:                 keys,
		messageID:            17,
		requestFromInitiator: true,
		responseInner:        []Payload{notifyPayload, deletePayload},
	}
	res, err := RunInformationalExchange(context.Background(), InformationalConfig{
		Transport: transport,
		Init:      init,
		Keys:      keys,
		MessageID: 17,
		IV:        bytes.Repeat([]byte{0x7c}, keys.Profile.EncryptionBlockSize),
	})
	if err != nil {
		t.Fatalf("RunInformationalExchange() error = %v", err)
	}
	if len(res.ResponseInner) != 2 || len(res.Response.Payloads) != 2 ||
		len(res.Response.Notifies) != 1 || len(res.Response.Deletes) != 1 {
		t.Fatalf("res=%+v", res)
	}
	if !errors.Is(res.Response.NotifyError, ErrIKEv2NotifyError) ||
		!errors.Is(res.Response.NotifyError, ErrNotifyInvalidSyntax) {
		t.Fatalf("Response.NotifyError=%v, want ErrIKEv2NotifyError and ErrNotifyInvalidSyntax", res.Response.NotifyError)
	}
	if res.Response.Deletes[0].ProtocolID != ProtocolESP ||
		hex.EncodeToString(res.Response.Deletes[0].SPIs[0]) != "aabbccdd" {
		t.Fatalf("Response.Deletes=%+v", res.Response.Deletes)
	}
}

func TestInformationalResponderOriginatedDPDRoundTrip(t *testing.T) {
	init, keys := informationalFixture(t)
	_, requestRaw, err := BuildInformationalRequestFrom(init, keys, 12, false, nil, bytes.Repeat([]byte{0x75}, keys.Profile.EncryptionBlockSize))
	if err != nil {
		t.Fatalf("BuildInformationalRequestFrom() error = %v", err)
	}
	request, inner, err := ParseInformationalRequestFrom(requestRaw, init, keys, 12, false)
	if err != nil {
		t.Fatalf("ParseInformationalRequestFrom() error = %v", err)
	}
	if request.Header.Flags&(FlagInitiator|FlagResponse) != 0 || len(inner) != 0 {
		t.Fatalf("request=%+v inner=%+v", request, inner)
	}

	_, responseRaw, err := BuildInformationalResponseFrom(init, keys, 12, true, nil, bytes.Repeat([]byte{0x76}, keys.Profile.EncryptionBlockSize))
	if err != nil {
		t.Fatalf("BuildInformationalResponseFrom() error = %v", err)
	}
	response, inner, err := ParseInformationalResponseFrom(responseRaw, init, keys, 12, true)
	if err != nil {
		t.Fatalf("ParseInformationalResponseFrom() error = %v", err)
	}
	if response.Header.Flags&(FlagInitiator|FlagResponse) != FlagInitiator|FlagResponse || len(inner) != 0 {
		t.Fatalf("response=%+v inner=%+v", response, inner)
	}
}

func TestInformationalRejectsUnexpectedHeader(t *testing.T) {
	init, keys := informationalFixture(t)
	_, raw, err := BuildInformationalResponse(init, keys, 11, nil, bytes.Repeat([]byte{0x74}, keys.Profile.EncryptionBlockSize))
	if err != nil {
		t.Fatalf("BuildInformationalResponse() error = %v", err)
	}
	if _, _, err := ParseInformationalResponse(raw, init, keys, 12); !errors.Is(err, ErrInvalidInformational) {
		t.Fatalf("ParseInformationalResponse() err=%v, want ErrInvalidInformational", err)
	}
	if _, _, err := ParseInformationalRequest(raw, init, keys, 11); !errors.Is(err, ErrInvalidSKPayload) {
		t.Fatalf("ParseInformationalRequest() err=%v, want ErrInvalidSKPayload", err)
	}
}

func TestRunInformationalExchangeSendsLivenessCheck(t *testing.T) {
	init, keys := informationalFixture(t)
	transport := &informationalExchangeTransport{
		t:                    t,
		init:                 init,
		keys:                 keys,
		messageID:            13,
		requestFromInitiator: true,
	}
	res, err := RunLivenessCheck(context.Background(), InformationalConfig{
		Transport: transport,
		Init:      init,
		Keys:      keys,
		MessageID: 13,
		IV:        bytes.Repeat([]byte{0x77}, keys.Profile.EncryptionBlockSize),
	})
	if err != nil {
		t.Fatalf("RunLivenessCheck() error = %v", err)
	}
	if transport.requests != 1 || len(transport.requestInner) != 0 {
		t.Fatalf("transport requests=%d inner=%+v", transport.requests, transport.requestInner)
	}
	if len(res.RequestBytes) == 0 || len(res.ResponseBytes) == 0 || len(res.ResponseInner) != 0 || res.NextMessageID != 14 {
		t.Fatalf("res=%+v", res)
	}
}

func TestRunInformationalExchangeRejectsBadResponse(t *testing.T) {
	init, keys := informationalFixture(t)
	transport := &informationalExchangeTransport{
		t:                    t,
		init:                 init,
		keys:                 keys,
		messageID:            14,
		requestFromInitiator: true,
		badResponseMessageID: true,
	}
	_, err := RunInformationalExchange(context.Background(), InformationalConfig{
		Transport: transport,
		Init:      init,
		Keys:      keys,
		MessageID: 14,
		IV:        bytes.Repeat([]byte{0x78}, keys.Profile.EncryptionBlockSize),
	})
	if !errors.Is(err, ErrInvalidInformational) {
		t.Fatalf("RunInformationalExchange() err=%v, want ErrInvalidInformational", err)
	}
}

func informationalFixture(t *testing.T) (InitResult, IKEKeys) {
	t.Helper()
	profile, err := KeyMaterialProfileFromSA(DefaultIKEProposal())
	if err != nil {
		t.Fatalf("KeyMaterialProfileFromSA() error = %v", err)
	}
	keys, err := SplitIKEKeys(profile, incrementalBytes(profile.RequiredLength()))
	if err != nil {
		t.Fatalf("SplitIKEKeys() error = %v", err)
	}
	return InitResult{
		InitiatorSPI: 0x0102030405060708,
		ResponderSPI: 0x1112131415161718,
		Keys:         keys,
	}, keys
}

type informationalExchangeTransport struct {
	t                    *testing.T
	init                 InitResult
	keys                 IKEKeys
	messageID            uint32
	requestFromInitiator bool
	responseInner        []Payload
	badResponseMessageID bool
	requests             int
	requestInner         []Payload
}

func (tr *informationalExchangeTransport) ExchangeIKE(ctx context.Context, request []byte) ([]byte, error) {
	tr.t.Helper()
	_, inner, err := ParseInformationalRequestFrom(request, tr.init, tr.keys, tr.messageID, tr.requestFromInitiator)
	if err != nil {
		tr.t.Fatalf("ParseInformationalRequestFrom() error = %v", err)
	}
	tr.requests++
	tr.requestInner = clonePayloads(inner)
	messageID := tr.messageID
	if tr.badResponseMessageID {
		messageID++
	}
	_, raw, err := BuildInformationalResponseFrom(
		tr.init,
		tr.keys,
		messageID,
		!tr.requestFromInitiator,
		tr.responseInner,
		bytes.Repeat([]byte{0x79}, tr.keys.Profile.EncryptionBlockSize),
	)
	if err != nil {
		tr.t.Fatalf("BuildInformationalResponseFrom() error = %v", err)
	}
	return raw, nil
}
