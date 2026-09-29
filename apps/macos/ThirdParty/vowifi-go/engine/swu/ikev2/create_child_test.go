package ikev2

import (
	"bytes"
	"context"
	"errors"
	"net"
	"testing"
)

func TestRunCREATECHILDSADerivesChildKeys(t *testing.T) {
	init := fakeInitResult(t)
	localSPI := []byte{0xca, 0xfe, 0xba, 0xbe}
	remoteSPI := []byte{0xde, 0xad, 0xbe, 0xef}
	requestNonce := bytes.Repeat([]byte{0x11}, 32)
	responseNonce := bytes.Repeat([]byte{0x22}, 32)
	transport := &createChildTransport{
		t:             t,
		init:          init,
		messageID:     5,
		localSPI:      localSPI,
		remoteSPI:     remoteSPI,
		responseNonce: responseNonce,
	}
	res, err := RunCREATE_CHILD_SA(context.Background(), CreateChildSAConfig{
		Transport: transport,
		Init:      init,
		ChildSPI:  localSPI,
		Nonce:     requestNonce,
		MessageID: 5,
		IV:        bytes.Repeat([]byte{0x91}, init.Keys.Profile.EncryptionBlockSize),
	})
	if err != nil {
		t.Fatalf("RunCREATE_CHILD_SA() error = %v", err)
	}
	if transport.requests != 1 || !transport.sawSA || !transport.sawNonce || !transport.sawTSi || !transport.sawTSr {
		t.Fatalf("transport=%+v", transport)
	}
	if !bytes.Equal(res.RequestNonce, requestNonce) || !bytes.Equal(res.ResponseNonce, responseNonce) ||
		res.NextMessageID != 6 || res.Rekeyed {
		t.Fatalf("res=%+v", res)
	}
	if !bytes.Equal(res.ChildSA.LocalSPI, localSPI) || !bytes.Equal(res.ChildSA.RemoteSPI, remoteSPI) {
		t.Fatalf("child SA=%+v", res.ChildSA)
	}
	expected, err := DeriveChildSAKeysWithNonces(init.Keys.Profile.PRF, init.Keys.SKD, requestNonce, responseNonce, DefaultESPProposal(remoteSPI))
	if err != nil {
		t.Fatalf("DeriveChildSAKeysWithNonces() error = %v", err)
	}
	if !bytes.Equal(res.ChildSA.Keys.Outbound.EncryptionKey, expected.Outbound.EncryptionKey) ||
		!bytes.Equal(res.ChildSA.Keys.Inbound.IntegrityKey, expected.Inbound.IntegrityKey) {
		t.Fatalf("child keys=%+v expected=%+v", res.ChildSA.Keys, expected)
	}
}

func TestBuildCreateChildSAPayloadsIncludesRekeyNotify(t *testing.T) {
	init := fakeInitResult(t)
	payloads, nonce, localSPI, err := BuildCreateChildSAPayloads(CreateChildSAConfig{
		Init:     init,
		ChildSPI: []byte{0x01, 0x02, 0x03, 0x04},
		RekeySPI: []byte{0xaa, 0xbb, 0xcc, 0xdd},
		Nonce:    bytes.Repeat([]byte{0x33}, 32),
	})
	if err != nil {
		t.Fatalf("BuildCreateChildSAPayloads() error = %v", err)
	}
	if !bytes.Equal(nonce, bytes.Repeat([]byte{0x33}, 32)) || !bytes.Equal(localSPI, []byte{1, 2, 3, 4}) {
		t.Fatalf("nonce=%x localSPI=%x", nonce, localSPI)
	}
	if len(payloads) != 5 || payloads[0].Type != PayloadNotify || payloads[1].Type != PayloadSA {
		t.Fatalf("payloads=%+v", payloads)
	}
	notify, err := ParseNotify(payloads[0].Body)
	if err != nil {
		t.Fatalf("ParseNotify() error = %v", err)
	}
	if notify.ProtocolID != ProtocolESP || notify.NotifyType != NotifyRekeySA ||
		!bytes.Equal(notify.SPI, []byte{0xaa, 0xbb, 0xcc, 0xdd}) {
		t.Fatalf("notify=%+v", notify)
	}
}

func TestRunCREATECHILDSARejectsMissingResponseNonce(t *testing.T) {
	init := fakeInitResult(t)
	transport := &createChildTransport{
		t:                 t,
		init:              init,
		messageID:         7,
		localSPI:          []byte{0xca, 0xfe, 0xba, 0xbe},
		remoteSPI:         []byte{0xde, 0xad, 0xbe, 0xef},
		omitResponseNonce: true,
	}
	_, err := RunCREATE_CHILD_SA(context.Background(), CreateChildSAConfig{
		Transport: transport,
		Init:      init,
		ChildSPI:  transport.localSPI,
		Nonce:     bytes.Repeat([]byte{0x44}, 32),
		MessageID: 7,
		IV:        bytes.Repeat([]byte{0x92}, init.Keys.Profile.EncryptionBlockSize),
	})
	if !errors.Is(err, ErrInvalidCreateChild) {
		t.Fatalf("RunCREATE_CHILD_SA() err=%v, want ErrInvalidCreateChild", err)
	}
}

func TestRunCREATECHILDSAClassifiesResponseNotifyErrors(t *testing.T) {
	cases := []struct {
		name       string
		notifyType uint16
		want       error
	}{
		{"invalid syntax", NotifyInvalidSyntax, ErrNotifyInvalidSyntax},
		{"no proposal chosen", NotifyNoProposalChosen, ErrNotifyNoProposalChosen},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			init := fakeInitResult(t)
			transport := &createChildTransport{
				t:         t,
				init:      init,
				messageID: 9,
				localSPI:  []byte{0xca, 0xfe, 0xba, 0xbe},
				responseNotify: &Notify{
					NotifyType: tc.notifyType,
				},
			}
			_, err := RunCREATE_CHILD_SA(context.Background(), CreateChildSAConfig{
				Transport: transport,
				Init:      init,
				ChildSPI:  transport.localSPI,
				Nonce:     bytes.Repeat([]byte{0x47}, 32),
				MessageID: 9,
				IV:        bytes.Repeat([]byte{0x95}, init.Keys.Profile.EncryptionBlockSize),
			})
			if !errors.Is(err, ErrInvalidCreateChild) ||
				!errors.Is(err, ErrIKEv2NotifyError) ||
				!errors.Is(err, tc.want) {
				t.Fatalf("RunCREATE_CHILD_SA() err=%v, want ErrInvalidCreateChild, ErrIKEv2NotifyError, and %v", err, tc.want)
			}
			var notifyErr *NotifyError
			if !errors.As(err, &notifyErr) {
				t.Fatalf("RunCREATE_CHILD_SA() err=%T, want *NotifyError", err)
			}
			if notifyErr.Notify.NotifyType != tc.notifyType {
				t.Fatalf("notifyErr=%+v", notifyErr)
			}
		})
	}
}

func TestRunCREATECHILDSAExposesInvalidKEAlternativeGroup(t *testing.T) {
	init := fakeInitResult(t)
	transport := &createChildTransport{
		t:         t,
		init:      init,
		messageID: 10,
		localSPI:  []byte{0xca, 0xfe, 0xba, 0xbe},
		responseNotify: &Notify{
			NotifyType:       NotifyInvalidKEPayload,
			NotificationData: []byte{0, byte(DHGroup2048BitMODP)},
		},
	}
	_, err := RunCREATE_CHILD_SA(context.Background(), CreateChildSAConfig{
		Transport: transport,
		Init:      init,
		ChildSPI:  transport.localSPI,
		Nonce:     bytes.Repeat([]byte{0x48}, 32),
		MessageID: 10,
		IV:        bytes.Repeat([]byte{0x96}, init.Keys.Profile.EncryptionBlockSize),
	})
	if !errors.Is(err, ErrInvalidCreateChild) ||
		!errors.Is(err, ErrIKEv2NotifyError) ||
		!errors.Is(err, ErrNotifyInvalidKEPayload) {
		t.Fatalf("RunCREATE_CHILD_SA() err=%v, want ErrInvalidCreateChild, ErrIKEv2NotifyError, and ErrNotifyInvalidKEPayload", err)
	}

	group, ok, parseErr := InvalidKEPayloadAlternativeGroupFromError(err)
	if parseErr != nil || !ok || group != DHGroup2048BitMODP {
		t.Fatalf("InvalidKEPayloadAlternativeGroupFromError() group=%d ok=%t err=%v", group, ok, parseErr)
	}
	var notifyErr *NotifyError
	if !errors.As(err, &notifyErr) {
		t.Fatalf("RunCREATE_CHILD_SA() err=%T, want *NotifyError", err)
	}
	group, ok, parseErr = notifyErr.InvalidKEPayloadAlternativeGroup()
	if parseErr != nil || !ok || group != DHGroup2048BitMODP {
		t.Fatalf("NotifyError.InvalidKEPayloadAlternativeGroup() group=%d ok=%t err=%v", group, ok, parseErr)
	}
}

func TestCreateChildSANotifyActionFromError(t *testing.T) {
	init := fakeInitResult(t)
	transport := &createChildTransport{
		t:         t,
		init:      init,
		messageID: 12,
		localSPI:  []byte{0xca, 0xfe, 0xba, 0xbe},
		responseNotify: &Notify{
			NotifyType:       NotifyInvalidKEPayload,
			NotificationData: []byte{0, byte(DHGroup384BitECP)},
		},
	}
	_, err := RunCREATE_CHILD_SA(context.Background(), CreateChildSAConfig{
		Transport: transport,
		Init:      init,
		ChildSPI:  transport.localSPI,
		Nonce:     bytes.Repeat([]byte{0x49}, 32),
		MessageID: 12,
		IV:        bytes.Repeat([]byte{0x98}, init.Keys.Profile.EncryptionBlockSize),
	})
	if !errors.Is(err, ErrInvalidCreateChild) {
		t.Fatalf("RunCREATE_CHILD_SA() err=%v, want ErrInvalidCreateChild", err)
	}
	action, ok := CreateChildSANotifyActionFromError(err)
	if !ok || action.Kind != NotifyActionRetryWithSuggestedDH ||
		!action.Retry || action.SuggestedDHGroup != DHGroup384BitECP ||
		action.Notify.NotifyType != NotifyInvalidKEPayload {
		t.Fatalf("CreateChildSANotifyActionFromError() action=%+v ok=%t", action, ok)
	}
	action.Notify.NotificationData[1] = 0
	if transport.responseNotify.NotificationData[1] != byte(DHGroup384BitECP) {
		t.Fatalf("action notify data aliases response notify")
	}
}

func TestRunCREATECHILDSARejectsUnsupportedSelectedSA(t *testing.T) {
	init := fakeInitResult(t)
	localSPI := []byte{0xca, 0xfe, 0xba, 0xbe}
	remoteSPI := []byte{0xde, 0xad, 0xbe, 0xef}
	selected := DefaultESPProposal(remoteSPI)
	selected.Proposals[0].Transforms[1].ID = INTEG_HMAC_SHA2_512_256
	transport := &createChildTransport{
		t:             t,
		init:          init,
		messageID:     8,
		localSPI:      localSPI,
		remoteSPI:     remoteSPI,
		responseNonce: bytes.Repeat([]byte{0x66}, 32),
		responseSA:    selected,
	}
	_, err := RunCREATE_CHILD_SA(context.Background(), CreateChildSAConfig{
		Transport: transport,
		Init:      init,
		ChildSPI:  localSPI,
		Nonce:     bytes.Repeat([]byte{0x45}, 32),
		MessageID: 8,
		IV:        bytes.Repeat([]byte{0x94}, init.Keys.Profile.EncryptionBlockSize),
	})
	if !errors.Is(err, ErrUnsupportedSASelection) {
		t.Fatalf("RunCREATE_CHILD_SA() err=%v, want ErrUnsupportedSASelection", err)
	}
}

func TestRunCREATECHILDSARejectsWidenedTrafficSelector(t *testing.T) {
	init := fakeInitResult(t)
	localSPI := []byte{0xca, 0xfe, 0xba, 0xbe}
	narrowTSi := TrafficSelectors{Selectors: []TrafficSelector{{
		Type:      TSIPv4AddressRange,
		StartPort: 0,
		EndPort:   65535,
		StartAddr: net.IPv4(10, 0, 0, 10),
		EndAddr:   net.IPv4(10, 0, 0, 10),
	}}}
	transport := &createChildTransport{
		t:             t,
		init:          init,
		messageID:     11,
		localSPI:      localSPI,
		remoteSPI:     []byte{0xde, 0xad, 0xbe, 0xef},
		responseNonce: bytes.Repeat([]byte{0x67}, 32),
		responseTSi:   IPv4AnyTrafficSelectors(),
	}
	_, err := RunCREATE_CHILD_SA(context.Background(), CreateChildSAConfig{
		Transport: transport,
		Init:      init,
		ChildSPI:  localSPI,
		Nonce:     bytes.Repeat([]byte{0x46}, 32),
		MessageID: 11,
		TSi:       narrowTSi,
		IV:        bytes.Repeat([]byte{0x97}, init.Keys.Profile.EncryptionBlockSize),
	})
	if !errors.Is(err, ErrInvalidChildSA) || !errors.Is(err, ErrInvalidTrafficSelector) {
		t.Fatalf("RunCREATE_CHILD_SA() err=%v, want ErrInvalidChildSA and ErrInvalidTrafficSelector", err)
	}
}

type createChildTransport struct {
	t                 *testing.T
	init              InitResult
	messageID         uint32
	localSPI          []byte
	remoteSPI         []byte
	responseSA        SecurityAssociation
	responseNotify    *Notify
	responseNonce     []byte
	responseTSi       TrafficSelectors
	responseTSr       TrafficSelectors
	rekeySPI          []byte
	omitResponseNonce bool
	requests          int
	sawRekey          bool
	sawSA             bool
	sawNonce          bool
	sawTSi            bool
	sawTSr            bool
}

func (tr *createChildTransport) ExchangeIKE(ctx context.Context, request []byte) ([]byte, error) {
	tr.t.Helper()
	msg, inner, err := UnprotectMessage(request, tr.init.Keys, true)
	if err != nil {
		tr.t.Fatalf("UnprotectMessage(request) error = %v", err)
	}
	if msg.Header.ExchangeType != ExchangeCREATE_CHILD_SA || msg.Header.MessageID != tr.messageID ||
		msg.Header.Flags&FlagInitiator == 0 {
		tr.t.Fatalf("request header=%+v", msg.Header)
	}
	tr.requests++
	for _, payload := range inner {
		switch payload.Type {
		case PayloadNotify:
			notify, err := ParseNotify(payload.Body)
			if err != nil {
				tr.t.Fatalf("ParseNotify() error = %v", err)
			}
			if notify.NotifyType == NotifyRekeySA {
				if notify.ProtocolID != ProtocolESP || !bytes.Equal(notify.SPI, tr.rekeySPI) {
					tr.t.Fatalf("rekey notify=%+v want SPI %x", notify, tr.rekeySPI)
				}
				tr.sawRekey = true
			}
		case PayloadSA:
			sa, err := ParseSecurityAssociation(payload.Body)
			if err != nil {
				tr.t.Fatalf("ParseSecurityAssociation() error = %v", err)
			}
			if len(sa.Proposals) != 1 || !bytes.Equal(sa.Proposals[0].SPI, tr.localSPI) {
				tr.t.Fatalf("request SA=%+v", sa)
			}
			tr.sawSA = true
		case PayloadNonce:
			if len(payload.Body) == 0 {
				tr.t.Fatalf("request nonce is empty")
			}
			tr.sawNonce = true
		case PayloadTSi:
			tr.sawTSi = true
		case PayloadTSr:
			tr.sawTSr = true
		}
	}
	if tr.responseNotify != nil {
		notifyPayload, err := NotifyPayload(*tr.responseNotify)
		if err != nil {
			tr.t.Fatalf("NotifyPayload(response) error = %v", err)
		}
		_, raw, err := ProtectMessage(
			createChildHeader(tr.init, tr.messageID, false),
			tr.init.Keys,
			false,
			[]Payload{notifyPayload},
			bytes.Repeat([]byte{0x93}, tr.init.Keys.Profile.EncryptionBlockSize),
		)
		if err != nil {
			tr.t.Fatalf("ProtectMessage(response notify) error = %v", err)
		}
		return raw, nil
	}
	responseSA := tr.responseSA
	if len(responseSA.Proposals) == 0 {
		responseSA = DefaultESPProposal(tr.remoteSPI)
	}
	saPayload, err := SecurityAssociationPayload(responseSA)
	if err != nil {
		tr.t.Fatalf("SecurityAssociationPayload() error = %v", err)
	}
	responseTSi := tr.responseTSi
	if len(responseTSi.Selectors) == 0 {
		responseTSi = IPv4AnyTrafficSelectors()
	}
	tsiPayload, err := TrafficSelectorsPayload(PayloadTSi, responseTSi)
	if err != nil {
		tr.t.Fatalf("TrafficSelectorsPayload(TSi) error = %v", err)
	}
	responseTSr := tr.responseTSr
	if len(responseTSr.Selectors) == 0 {
		responseTSr = IPv4AnyTrafficSelectors()
	}
	tsrPayload, err := TrafficSelectorsPayload(PayloadTSr, responseTSr)
	if err != nil {
		tr.t.Fatalf("TrafficSelectorsPayload(TSr) error = %v", err)
	}
	responseInner := []Payload{saPayload}
	if !tr.omitResponseNonce {
		nonce := tr.responseNonce
		if len(nonce) == 0 {
			nonce = bytes.Repeat([]byte{0x55}, 32)
		}
		responseInner = append(responseInner, NoncePayload(nonce))
	}
	responseInner = append(responseInner, tsiPayload, tsrPayload)
	_, raw, err := ProtectMessage(
		createChildHeader(tr.init, tr.messageID, false),
		tr.init.Keys,
		false,
		responseInner,
		bytes.Repeat([]byte{0x93}, tr.init.Keys.Profile.EncryptionBlockSize),
	)
	if err != nil {
		tr.t.Fatalf("ProtectMessage(response) error = %v", err)
	}
	return raw, nil
}
