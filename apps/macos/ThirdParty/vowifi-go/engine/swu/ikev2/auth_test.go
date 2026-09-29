package ikev2

import (
	"bytes"
	"context"
	"errors"
	"net"
	"testing"

	"github.com/boa-z/vowifi-go/engine/sim"
	"github.com/boa-z/vowifi-go/engine/swu/eapaka"
)

type authFakeTransport struct {
	t          *testing.T
	init       InitResult
	keys       IKEKeys
	exchanges  int
	identity   string
	firstInner []Payload
}

func (f *authFakeTransport) ExchangeIKE(ctx context.Context, request []byte) ([]byte, error) {
	f.t.Helper()
	switch f.exchanges {
	case 0:
		msg, inner, err := UnprotectMessage(request, f.keys, true)
		if err != nil {
			return nil, err
		}
		if msg.Header.ExchangeType != ExchangeIKE_AUTH || msg.Header.MessageID != 1 || msg.Header.Flags&FlagInitiator == 0 {
			f.t.Fatalf("first auth header=%+v", msg.Header)
		}
		f.firstInner = clonePayloads(inner)
		if gotTypes(inner); !bytes.Equal(gotTypes(inner), []byte{PayloadIDi, PayloadSA, PayloadTSi, PayloadTSr, PayloadCP, PayloadNotify, PayloadNotify, PayloadNotify}) {
			f.t.Fatalf("first inner types=%v", gotTypes(inner))
		}
		req, err := (eapaka.Packet{
			Code:       eapaka.CodeRequest,
			Identifier: 9,
			Type:       eapaka.TypeAKA,
			Subtype:    eapaka.SubtypeIdentity,
			Attributes: []eapaka.Attribute{
				eapaka.FullAuthIDReqAttribute(),
				eapaka.VersionListAttribute(2, eapaka.SupportedVersion),
			},
		}).MarshalBinary()
		if err != nil {
			return nil, err
		}
		_, raw, err := ProtectMessage(authHeader(f.init, 1, false), f.keys, false, []Payload{EAPPayload(req)}, bytes.Repeat([]byte{0x31}, f.keys.Profile.EncryptionBlockSize))
		if err != nil {
			return nil, err
		}
		f.exchanges++
		return raw, nil
	case 1:
		msg, inner, err := UnprotectMessage(request, f.keys, true)
		if err != nil {
			return nil, err
		}
		if msg.Header.MessageID != 2 || len(inner) != 1 || inner[0].Type != PayloadEAP {
			f.t.Fatalf("second auth header=%+v inner=%+v", msg.Header, inner)
		}
		pkt, err := eapaka.ParsePacket(inner[0].Body)
		if err != nil {
			return nil, err
		}
		if pkt.Code != eapaka.CodeResponse || pkt.Subtype != eapaka.SubtypeIdentity {
			f.t.Fatalf("identity packet=%+v", pkt)
		}
		attr, ok := eapaka.FindAttribute(pkt.Attributes, eapaka.AttributeIdentity)
		if !ok {
			f.t.Fatal("missing AT_IDENTITY")
		}
		identity, err := attr.IdentityValue()
		if err != nil {
			return nil, err
		}
		f.identity = identity
		selectedAttr, ok := eapaka.FindAttribute(pkt.Attributes, eapaka.AttributeSelectedVersion)
		if !ok {
			f.t.Fatal("missing AT_SELECTED_VERSION")
		}
		selected, err := selectedAttr.SelectedVersionValue()
		if err != nil {
			return nil, err
		}
		if selected != eapaka.SupportedVersion {
			f.t.Fatalf("selected version=%d", selected)
		}
		challenge, err := (eapaka.Packet{
			Code:       eapaka.CodeRequest,
			Identifier: 10,
			Type:       eapaka.TypeAKA,
			Subtype:    eapaka.SubtypeChallenge,
			Attributes: []eapaka.Attribute{
				eapaka.RANDAttribute(bytes.Repeat([]byte{0xa1}, 16)),
				eapaka.AUTNAttribute(bytes.Repeat([]byte{0xb2}, 16)),
			},
		}).MarshalBinary()
		if err != nil {
			return nil, err
		}
		_, raw, err := ProtectMessage(authHeader(f.init, 2, false), f.keys, false, []Payload{EAPPayload(challenge)}, bytes.Repeat([]byte{0x32}, f.keys.Profile.EncryptionBlockSize))
		if err != nil {
			return nil, err
		}
		f.exchanges++
		return raw, nil
	default:
		return nil, errors.New("unexpected extra exchange")
	}
}

func TestRunIKEAuthEAPIdentity(t *testing.T) {
	init := fakeInitResult(t)
	transport := &authFakeTransport{t: t, init: init, keys: init.Keys}
	res, err := RunIKE_AUTH_EAPIdentity(context.Background(), AuthConfig{
		Transport:     transport,
		Init:          init,
		InitiatorID:   Identity{Type: IDRFC822Addr, Data: []byte("310280000000001@nai.epc.mnc280.mcc310.3gppnetwork.org")},
		EAPIdentity:   "310280000000001@nai.epc.mnc280.mcc310.3gppnetwork.org",
		ChildSPI:      []byte{0xca, 0xfe, 0xba, 0xbe},
		InitialIV:     bytes.Repeat([]byte{0x21}, init.Keys.Profile.EncryptionBlockSize),
		EAPIdentityIV: bytes.Repeat([]byte{0x22}, init.Keys.Profile.EncryptionBlockSize),
	})
	if err != nil {
		t.Fatalf("RunIKE_AUTH_EAPIdentity() error = %v", err)
	}
	if transport.exchanges != 2 || transport.identity != "310280000000001@nai.epc.mnc280.mcc310.3gppnetwork.org" {
		t.Fatalf("exchanges=%d identity=%q", transport.exchanges, transport.identity)
	}
	childSA, err := ParseSecurityAssociation(transport.firstInner[1].Body)
	if err != nil {
		t.Fatalf("ParseSecurityAssociation() error = %v", err)
	}
	if len(childSA.Proposals) != 1 || !bytes.Equal(childSA.Proposals[0].SPI, []byte{0xca, 0xfe, 0xba, 0xbe}) {
		t.Fatalf("child SA=%+v", childSA)
	}
	if res.EAPRequest == nil || res.EAPRequest.Subtype != eapaka.SubtypeIdentity {
		t.Fatalf("EAPRequest=%+v", res.EAPRequest)
	}
	if res.EAPAfterIdentity == nil || res.EAPAfterIdentity.Subtype != eapaka.SubtypeChallenge || res.NextMessageID != 3 {
		t.Fatalf("after=%+v next=%d", res.EAPAfterIdentity, res.NextMessageID)
	}
	attr, ok := eapaka.FindAttribute(res.EAPAfterIdentity.Attributes, eapaka.AttributeRAND)
	if !ok {
		t.Fatal("missing AT_RAND")
	}
	rands, err := attr.RANDValues()
	if err != nil {
		t.Fatalf("RANDValues() error = %v", err)
	}
	if len(rands) != 1 || !bytes.Equal(rands[0], bytes.Repeat([]byte{0xa1}, 16)) {
		t.Fatalf("RAND=%x", rands)
	}
}

func TestUnprotectIKEAuthResponseClassifiesNotifyError(t *testing.T) {
	init := fakeInitResult(t)
	notifyPayload, err := NotifyPayload(Notify{
		NotifyType:       NotifyUnsupportedCriticalPayload,
		NotificationData: []byte{PayloadVendorID},
	})
	if err != nil {
		t.Fatalf("NotifyPayload() error = %v", err)
	}
	_, raw, err := ProtectMessage(
		authHeader(init, 1, false),
		init.Keys,
		false,
		[]Payload{notifyPayload},
		bytes.Repeat([]byte{0x61}, init.Keys.Profile.EncryptionBlockSize),
	)
	if err != nil {
		t.Fatalf("ProtectMessage() error = %v", err)
	}
	_, _, err = unprotectAuthResponse(raw, init, init.Keys, 1)
	if !errors.Is(err, ErrInvalidAuthResponse) ||
		!errors.Is(err, ErrIKEv2NotifyError) ||
		!errors.Is(err, ErrNotifyUnsupportedCriticalPayload) {
		t.Fatalf("unprotectAuthResponse() err=%v, want auth notify error", err)
	}
	var notifyErr *NotifyError
	if !errors.As(err, &notifyErr) || notifyErr.Notify.NotifyType != NotifyUnsupportedCriticalPayload {
		t.Fatalf("unprotectAuthResponse() notifyErr=%+v err=%v", notifyErr, err)
	}
}

func TestRunIKEAuthEAPIdentityUsesPseudonymForFullAuthRequest(t *testing.T) {
	init := fakeInitResult(t)
	transport := &authFakeTransport{t: t, init: init, keys: init.Keys}
	res, err := RunIKE_AUTH_EAPIdentity(context.Background(), AuthConfig{
		Transport:     transport,
		Init:          init,
		InitiatorID:   Identity{Type: IDRFC822Addr, Data: []byte("310280000000001@nai.epc.mnc280.mcc310.3gppnetwork.org")},
		EAPIdentity:   "310280000000001@nai.epc.mnc280.mcc310.3gppnetwork.org",
		EAPPseudonym:  "pseudo-identity",
		ChildSPI:      []byte{0xca, 0xfe, 0xba, 0xbe},
		InitialIV:     bytes.Repeat([]byte{0x23}, init.Keys.Profile.EncryptionBlockSize),
		EAPIdentityIV: bytes.Repeat([]byte{0x24}, init.Keys.Profile.EncryptionBlockSize),
	})
	if err != nil {
		t.Fatalf("RunIKE_AUTH_EAPIdentity() error = %v", err)
	}
	if transport.identity != "pseudo-identity" || res.EAPIdentityUsed != "pseudo-identity" {
		t.Fatalf("identity transport=%q result=%q", transport.identity, res.EAPIdentityUsed)
	}
}

func TestIdentityForEAPRequestSelectsRequestedIdentity(t *testing.T) {
	opts := eapIdentityOptions{
		PermanentIdentity: " permanent ",
		Pseudonym:         " pseudonym ",
		ReauthIdentity:    " reauth ",
	}
	tests := []struct {
		name  string
		attrs []eapaka.Attribute
		opts  eapIdentityOptions
		want  string
	}{
		{
			name: "default permanent",
			opts: opts,
			want: "permanent",
		},
		{
			name:  "permanent requested",
			attrs: []eapaka.Attribute{eapaka.PermanentIDReqAttribute()},
			opts:  opts,
			want:  "permanent",
		},
		{
			name:  "full auth requested",
			attrs: []eapaka.Attribute{eapaka.FullAuthIDReqAttribute()},
			opts:  opts,
			want:  "pseudonym",
		},
		{
			name:  "full auth falls back to permanent",
			attrs: []eapaka.Attribute{eapaka.FullAuthIDReqAttribute()},
			opts: eapIdentityOptions{
				PermanentIdentity: "permanent",
				Pseudonym:         " ",
				ReauthIdentity:    "reauth",
			},
			want: "permanent",
		},
		{
			name:  "any requested",
			attrs: []eapaka.Attribute{eapaka.AnyIDReqAttribute()},
			opts:  opts,
			want:  "reauth",
		},
		{
			name:  "any falls back to pseudonym",
			attrs: []eapaka.Attribute{eapaka.AnyIDReqAttribute()},
			opts: eapIdentityOptions{
				PermanentIdentity: "permanent",
				Pseudonym:         "pseudonym",
			},
			want: "pseudonym",
		},
		{
			name:  "any falls back to permanent",
			attrs: []eapaka.Attribute{eapaka.AnyIDReqAttribute()},
			opts: eapIdentityOptions{
				PermanentIdentity: "permanent",
			},
			want: "permanent",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := identityForEAPRequest(eapaka.Packet{
				Code:       eapaka.CodeRequest,
				Type:       eapaka.TypeAKA,
				Subtype:    eapaka.SubtypeIdentity,
				Attributes: tt.attrs,
			}, tt.opts)
			if got != tt.want {
				t.Fatalf("identityForEAPRequest() = %q, want %q", got, tt.want)
			}
		})
	}
}

func TestRunIKEAuthFullCompletesAKAWithNotification(t *testing.T) {
	init := fakeInitResult(t)
	identity := "310280000000001@nai.epc.mnc280.mcc310.3gppnetwork.org"
	aka := simAKAResult()
	eapKeys, err := eapaka.DeriveKeys(identity, aka)
	if err != nil {
		t.Fatalf("DeriveKeys() error = %v", err)
	}
	localSPI := []byte{0x01, 0x02, 0x03, 0x04}
	random := bytes.NewReader(append(localSPI, bytes.Repeat([]byte{0x44}, 256)...))
	exchanges := 0
	var identityRequestRaw []byte
	var identityTranscript [][]byte
	transport := InitTransportFunc(func(ctx context.Context, request []byte) ([]byte, error) {
		msg, inner, err := UnprotectMessage(request, init.Keys, true)
		if err != nil {
			return nil, err
		}
		switch exchanges {
		case 0:
			if msg.Header.MessageID != 1 || !bytes.Equal(gotTypes(inner), []byte{PayloadIDi, PayloadSA, PayloadTSi, PayloadTSr, PayloadCP, PayloadNotify, PayloadNotify, PayloadNotify}) {
				t.Fatalf("initial auth header=%+v inner types=%v", msg.Header, gotTypes(inner))
			}
			req := eapaka.Packet{
				Code:       eapaka.CodeRequest,
				Identifier: 9,
				Type:       eapaka.TypeAKA,
				Subtype:    eapaka.SubtypeIdentity,
				Attributes: []eapaka.Attribute{eapaka.FullAuthIDReqAttribute()},
			}
			rawReq, err := req.MarshalBinary()
			if err != nil {
				return nil, err
			}
			identityRequestRaw = append([]byte(nil), rawReq...)
			exchanges++
			_, rawResp, err := ProtectMessage(authHeader(init, 1, false), init.Keys, false, []Payload{EAPPayload(rawReq)}, bytes.Repeat([]byte{0x91}, init.Keys.Profile.EncryptionBlockSize))
			return rawResp, err
		case 1:
			if msg.Header.MessageID != 2 || len(inner) != 1 || inner[0].Type != PayloadEAP {
				t.Fatalf("identity auth header=%+v inner=%+v", msg.Header, inner)
			}
			pkt := parseTestEAP(t, inner[0].Body)
			if pkt.Code != eapaka.CodeResponse || pkt.Subtype != eapaka.SubtypeIdentity {
				t.Fatalf("identity response=%+v", pkt)
			}
			identityTranscript = [][]byte{append([]byte(nil), identityRequestRaw...), append([]byte(nil), inner[0].Body...)}
			challenge := signedAKAChallengeWithCheckcode(t, identity, aka, identityTranscript)
			rawChallenge, err := challenge.MarshalBinary()
			if err != nil {
				return nil, err
			}
			exchanges++
			_, rawResp, err := ProtectMessage(authHeader(init, 2, false), init.Keys, false, []Payload{EAPPayload(rawChallenge)}, bytes.Repeat([]byte{0x92}, init.Keys.Profile.EncryptionBlockSize))
			return rawResp, err
		case 2:
			if msg.Header.MessageID != 3 || len(inner) != 1 || inner[0].Type != PayloadEAP {
				t.Fatalf("challenge auth header=%+v inner=%+v", msg.Header, inner)
			}
			pkt := parseTestEAP(t, inner[0].Body)
			if pkt.Code != eapaka.CodeResponse || pkt.Subtype != eapaka.SubtypeChallenge {
				t.Fatalf("challenge response=%+v", pkt)
			}
			raw, err := pkt.MarshalBinary()
			if err != nil {
				return nil, err
			}
			if err := eapaka.VerifyMAC(eapKeys.KAut, raw, nil); err != nil {
				return nil, err
			}
			checkcodeAttr, ok := eapaka.FindAttribute(pkt.Attributes, eapaka.AttributeCheckcode)
			if !ok {
				t.Fatal("missing AT_CHECKCODE")
			}
			if err := eapaka.VerifyCheckcodeAttribute(checkcodeAttr, identityTranscript); err != nil {
				return nil, err
			}
			if _, ok := eapaka.FindAttribute(pkt.Attributes, eapaka.AttributeResultInd); !ok {
				t.Fatal("missing AT_RESULT_IND")
			}
			notification := signedAKANotification(t, 14, eapKeys, eapaka.NotificationSuccess)
			rawNotification, err := notification.MarshalBinary()
			if err != nil {
				return nil, err
			}
			exchanges++
			_, rawResp, err := ProtectMessage(authHeader(init, 3, false), init.Keys, false, []Payload{EAPPayload(rawNotification)}, bytes.Repeat([]byte{0x93}, init.Keys.Profile.EncryptionBlockSize))
			return rawResp, err
		case 3:
			if msg.Header.MessageID != 4 || len(inner) != 1 || inner[0].Type != PayloadEAP {
				t.Fatalf("notification auth header=%+v inner=%+v", msg.Header, inner)
			}
			pkt := parseTestEAP(t, inner[0].Body)
			if pkt.Code != eapaka.CodeResponse || pkt.Subtype != eapaka.SubtypeNotification {
				t.Fatalf("notification response=%+v", pkt)
			}
			raw, err := pkt.MarshalBinary()
			if err != nil {
				return nil, err
			}
			if err := eapaka.VerifyMAC(eapKeys.KAut, raw, nil); err != nil {
				return nil, err
			}
			payloads, err := authSuccessChildPayloads(t, pkt.Identifier, []byte{0xde, 0xad, 0xbe, 0xef})
			if err != nil {
				return nil, err
			}
			exchanges++
			_, rawResp, err := ProtectMessage(authHeader(init, 4, false), init.Keys, false, payloads, bytes.Repeat([]byte{0x94}, init.Keys.Profile.EncryptionBlockSize))
			return rawResp, err
		default:
			return nil, errors.New("unexpected extra exchange")
		}
	})

	res, err := RunIKE_AUTH_Full(context.Background(), FullAuthConfig{
		Transport:   transport,
		Init:        init,
		SIM:         akaProviderStub{result: aka},
		InitiatorID: Identity{Type: IDRFC822Addr, Data: []byte(identity)},
		EAPIdentity: identity,
		Random:      random,
	})
	if err != nil {
		t.Fatalf("RunIKE_AUTH_Full() error = %v", err)
	}
	if exchanges != 4 {
		t.Fatalf("exchanges=%d, want 4", exchanges)
	}
	if len(res.IdentityExchanges) != 0 || len(res.AKAChallenges) != 1 || len(res.EAPNotifications) != 1 {
		t.Fatalf("identity exchanges=%d aka=%d notifications=%d", len(res.IdentityExchanges), len(res.AKAChallenges), len(res.EAPNotifications))
	}
	if res.ChildSA == nil || !bytes.Equal(res.ChildSA.LocalSPI, localSPI) || !bytes.Equal(res.ChildSA.RemoteSPI, []byte{0xde, 0xad, 0xbe, 0xef}) {
		t.Fatalf("child SA=%+v", res.ChildSA)
	}
	if len(res.EAPKeys.KAut) != eapaka.KeyLengthKAut || res.EAPLast == nil || res.EAPLast.Code != eapaka.CodeSuccess || res.NextMessageID != 5 {
		t.Fatalf("result=%+v", res)
	}
}

func TestRunIKEAuthFullUsesPseudonymForFullAuthChallengeKeys(t *testing.T) {
	init := fakeInitResult(t)
	permanent := "310280000000001@nai.epc.mnc280.mcc310.3gppnetwork.org"
	pseudonym := "pseudo-identity"
	aka := simAKAResult()
	expectedKeys, err := eapaka.DeriveKeys(pseudonym, aka)
	if err != nil {
		t.Fatalf("DeriveKeys() error = %v", err)
	}
	localSPI := []byte{0xca, 0xfe, 0xba, 0xbe}
	random := bytes.NewReader(bytes.Repeat([]byte{0x45}, 256))
	exchanges := 0
	var identityRequestRaw []byte
	var identityTranscript [][]byte
	transport := InitTransportFunc(func(ctx context.Context, request []byte) ([]byte, error) {
		msg, inner, err := UnprotectMessage(request, init.Keys, true)
		if err != nil {
			return nil, err
		}
		switch exchanges {
		case 0:
			if msg.Header.MessageID != 1 || !bytes.Equal(gotTypes(inner), []byte{PayloadIDi, PayloadSA, PayloadTSi, PayloadTSr, PayloadCP, PayloadNotify, PayloadNotify, PayloadNotify}) {
				t.Fatalf("initial auth header=%+v inner types=%v", msg.Header, gotTypes(inner))
			}
			req := eapaka.Packet{
				Code:       eapaka.CodeRequest,
				Identifier: 9,
				Type:       eapaka.TypeAKA,
				Subtype:    eapaka.SubtypeIdentity,
				Attributes: []eapaka.Attribute{
					eapaka.FullAuthIDReqAttribute(),
					eapaka.VersionListAttribute(eapaka.SupportedVersion),
				},
			}
			rawReq, err := req.MarshalBinary()
			if err != nil {
				return nil, err
			}
			identityRequestRaw = append([]byte(nil), rawReq...)
			exchanges++
			_, rawResp, err := ProtectMessage(authHeader(init, 1, false), init.Keys, false, []Payload{EAPPayload(rawReq)}, bytes.Repeat([]byte{0xa3}, init.Keys.Profile.EncryptionBlockSize))
			return rawResp, err
		case 1:
			if msg.Header.MessageID != 2 || len(inner) != 1 || inner[0].Type != PayloadEAP {
				t.Fatalf("identity auth header=%+v inner=%+v", msg.Header, inner)
			}
			pkt := parseTestEAP(t, inner[0].Body)
			if pkt.Code != eapaka.CodeResponse || pkt.Subtype != eapaka.SubtypeIdentity {
				t.Fatalf("identity response=%+v", pkt)
			}
			attr, ok := eapaka.FindAttribute(pkt.Attributes, eapaka.AttributeIdentity)
			if !ok {
				t.Fatal("missing AT_IDENTITY")
			}
			identity, err := attr.IdentityValue()
			if err != nil {
				return nil, err
			}
			if identity != pseudonym {
				t.Fatalf("identity response identity=%q, want %q", identity, pseudonym)
			}
			selectedAttr, ok := eapaka.FindAttribute(pkt.Attributes, eapaka.AttributeSelectedVersion)
			if !ok {
				t.Fatal("missing AT_SELECTED_VERSION")
			}
			selected, err := selectedAttr.SelectedVersionValue()
			if err != nil {
				return nil, err
			}
			if selected != eapaka.SupportedVersion {
				t.Fatalf("selected version=%d", selected)
			}
			identityTranscript = [][]byte{append([]byte(nil), identityRequestRaw...), append([]byte(nil), inner[0].Body...)}
			challenge := signedAKAChallengeWithCheckcode(t, pseudonym, aka, identityTranscript)
			rawChallenge, err := challenge.MarshalBinary()
			if err != nil {
				return nil, err
			}
			exchanges++
			_, rawResp, err := ProtectMessage(authHeader(init, 2, false), init.Keys, false, []Payload{EAPPayload(rawChallenge)}, bytes.Repeat([]byte{0xa4}, init.Keys.Profile.EncryptionBlockSize))
			return rawResp, err
		case 2:
			if msg.Header.MessageID != 3 || len(inner) != 1 || inner[0].Type != PayloadEAP {
				t.Fatalf("challenge auth header=%+v inner=%+v", msg.Header, inner)
			}
			pkt := parseTestEAP(t, inner[0].Body)
			if pkt.Code != eapaka.CodeResponse || pkt.Subtype != eapaka.SubtypeChallenge {
				t.Fatalf("challenge response=%+v", pkt)
			}
			raw, err := pkt.MarshalBinary()
			if err != nil {
				return nil, err
			}
			if err := eapaka.VerifyMAC(expectedKeys.KAut, raw, nil); err != nil {
				return nil, err
			}
			checkcodeAttr, ok := eapaka.FindAttribute(pkt.Attributes, eapaka.AttributeCheckcode)
			if !ok {
				t.Fatal("missing AT_CHECKCODE")
			}
			if err := eapaka.VerifyCheckcodeAttribute(checkcodeAttr, identityTranscript); err != nil {
				return nil, err
			}
			payloads, err := authSuccessChildPayloads(t, pkt.Identifier, []byte{0xde, 0xad, 0xbe, 0xef})
			if err != nil {
				return nil, err
			}
			exchanges++
			_, rawResp, err := ProtectMessage(authHeader(init, 3, false), init.Keys, false, payloads, bytes.Repeat([]byte{0xa5}, init.Keys.Profile.EncryptionBlockSize))
			return rawResp, err
		default:
			return nil, errors.New("unexpected extra exchange")
		}
	})

	res, err := RunIKE_AUTH_Full(context.Background(), FullAuthConfig{
		Transport:    transport,
		Init:         init,
		SIM:          akaProviderStub{result: aka},
		InitiatorID:  Identity{Type: IDRFC822Addr, Data: []byte(permanent)},
		EAPIdentity:  permanent,
		EAPPseudonym: pseudonym,
		ChildSPI:     localSPI,
		Random:       random,
	})
	if err != nil {
		t.Fatalf("RunIKE_AUTH_Full() error = %v", err)
	}
	if exchanges != 3 {
		t.Fatalf("exchanges=%d, want 3", exchanges)
	}
	if res.Auth.EAPIdentityUsed != pseudonym || len(res.IdentityExchanges) != 0 || len(res.AKAChallenges) != 1 {
		t.Fatalf("identity used=%q identity exchanges=%d aka=%d", res.Auth.EAPIdentityUsed, len(res.IdentityExchanges), len(res.AKAChallenges))
	}
	if !bytes.Equal(res.EAPKeys.KAut, expectedKeys.KAut) || !bytes.Equal(res.EAPKeys.MSK, expectedKeys.MSK) {
		t.Fatalf("EAP keys were not derived from pseudonym")
	}
	if res.ChildSA == nil || !bytes.Equal(res.ChildSA.LocalSPI, localSPI) || !bytes.Equal(res.ChildSA.RemoteSPI, []byte{0xde, 0xad, 0xbe, 0xef}) {
		t.Fatalf("child SA=%+v", res.ChildSA)
	}
}

func TestRunIKEAuthFullNegotiatesAKAPrimeKDF(t *testing.T) {
	init := fakeInitResult(t)
	identity := "310280000000001@nai.epc.mnc280.mcc310.3gppnetwork.org"
	networkName := "WLAN"
	aka := simAKAResult()
	localSPI := []byte{0xca, 0xfe, 0xba, 0xbe}
	exchanges := 0
	transport := InitTransportFunc(func(ctx context.Context, request []byte) ([]byte, error) {
		msg, inner, err := UnprotectMessage(request, init.Keys, true)
		if err != nil {
			return nil, err
		}
		switch exchanges {
		case 0:
			if msg.Header.MessageID != 1 {
				t.Fatalf("initial auth header=%+v", msg.Header)
			}
			req := eapaka.Packet{
				Code:       eapaka.CodeRequest,
				Identifier: 20,
				Type:       eapaka.TypeAKA,
				Subtype:    eapaka.SubtypeIdentity,
				Attributes: []eapaka.Attribute{eapaka.FullAuthIDReqAttribute()},
			}
			rawReq, err := req.MarshalBinary()
			if err != nil {
				return nil, err
			}
			exchanges++
			_, rawResp, err := ProtectMessage(authHeader(init, 1, false), init.Keys, false, []Payload{EAPPayload(rawReq)}, bytes.Repeat([]byte{0x95}, init.Keys.Profile.EncryptionBlockSize))
			return rawResp, err
		case 1:
			if msg.Header.MessageID != 2 || parseTestEAP(t, inner[0].Body).Subtype != eapaka.SubtypeIdentity {
				t.Fatalf("identity exchange header=%+v inner=%+v", msg.Header, inner)
			}
			kdfOffer := eapaka.Packet{
				Code:       eapaka.CodeRequest,
				Identifier: 21,
				Type:       eapaka.TypeAKAPrime,
				Subtype:    eapaka.SubtypeChallenge,
				Attributes: []eapaka.Attribute{
					eapaka.RANDAttribute(bytes.Repeat([]byte{0xa1}, 16)),
					eapaka.AUTNAttribute(bytes.Repeat([]byte{0xb2}, 16)),
					eapaka.KDFInputAttribute(networkName),
					eapaka.KDFAttribute(99),
					eapaka.KDFAttribute(eapaka.AKAPrimeKDFDefault),
				},
			}
			rawOffer, err := kdfOffer.MarshalBinary()
			if err != nil {
				return nil, err
			}
			exchanges++
			_, rawResp, err := ProtectMessage(authHeader(init, 2, false), init.Keys, false, []Payload{EAPPayload(rawOffer)}, bytes.Repeat([]byte{0x96}, init.Keys.Profile.EncryptionBlockSize))
			return rawResp, err
		case 2:
			if msg.Header.MessageID != 3 || len(inner) != 1 || inner[0].Type != PayloadEAP {
				t.Fatalf("kdf exchange header=%+v inner=%+v", msg.Header, inner)
			}
			pkt := parseTestEAP(t, inner[0].Body)
			if pkt.Type != eapaka.TypeAKAPrime || pkt.Subtype != eapaka.SubtypeChallenge || len(pkt.Attributes) != 1 || pkt.Attributes[0].Type != eapaka.AttributeKDF {
				t.Fatalf("kdf response=%+v", pkt)
			}
			challenge := signedAKAPrimeChallenge(t, identity, networkName, aka)
			rawChallenge, err := challenge.MarshalBinary()
			if err != nil {
				return nil, err
			}
			exchanges++
			_, rawResp, err := ProtectMessage(authHeader(init, 3, false), init.Keys, false, []Payload{EAPPayload(rawChallenge)}, bytes.Repeat([]byte{0x97}, init.Keys.Profile.EncryptionBlockSize))
			return rawResp, err
		case 3:
			if msg.Header.MessageID != 4 || len(inner) != 1 || inner[0].Type != PayloadEAP {
				t.Fatalf("aka prime exchange header=%+v inner=%+v", msg.Header, inner)
			}
			pkt := parseTestEAP(t, inner[0].Body)
			if pkt.Type != eapaka.TypeAKAPrime || pkt.Subtype != eapaka.SubtypeChallenge {
				t.Fatalf("AKA' response=%+v", pkt)
			}
			keys, err := eapaka.DeriveAKAPrimeKeys(identity, networkName, bytes.Repeat([]byte{0xb2}, 16), aka)
			if err != nil {
				return nil, err
			}
			raw, err := pkt.MarshalBinary()
			if err != nil {
				return nil, err
			}
			if err := eapaka.VerifyAKAPrimeMAC(keys.KAut, raw, nil); err != nil {
				return nil, err
			}
			payloads, err := authSuccessChildPayloads(t, pkt.Identifier, []byte{0xde, 0xad, 0xca, 0xfe})
			if err != nil {
				return nil, err
			}
			exchanges++
			_, rawResp, err := ProtectMessage(authHeader(init, 4, false), init.Keys, false, payloads, bytes.Repeat([]byte{0x98}, init.Keys.Profile.EncryptionBlockSize))
			return rawResp, err
		default:
			return nil, errors.New("unexpected extra exchange")
		}
	})

	res, err := RunIKE_AUTH_Full(context.Background(), FullAuthConfig{
		Transport:   transport,
		Init:        init,
		SIM:         akaProviderStub{result: aka},
		InitiatorID: Identity{Type: IDRFC822Addr, Data: []byte(identity)},
		EAPIdentity: identity,
		ChildSPI:    localSPI,
	})
	if err != nil {
		t.Fatalf("RunIKE_AUTH_Full(AKA') error = %v", err)
	}
	if exchanges != 4 || res.KDFNegotiations != 1 || len(res.AKAChallenges) != 2 {
		t.Fatalf("exchanges=%d kdf=%d aka=%d", exchanges, res.KDFNegotiations, len(res.AKAChallenges))
	}
	if len(res.EAPKeys.KAut) != eapaka.KeyLengthAKAPrimeKAut || len(res.EAPKeys.KRe) != eapaka.KeyLengthKRe {
		t.Fatalf("EAP keys=%+v", res.EAPKeys)
	}
	if res.ChildSA == nil || !bytes.Equal(res.ChildSA.RemoteSPI, []byte{0xde, 0xad, 0xca, 0xfe}) || res.NextMessageID != 5 {
		t.Fatalf("result=%+v", res)
	}
}

func TestRunIKEAuthFullHandlesInitialReauthentication(t *testing.T) {
	init := fakeInitResult(t)
	fullIdentity := "310280000000001@nai.epc.mnc280.mcc310.3gppnetwork.org"
	reauthIdentity := "reauth-2"
	aka := simAKAResult()
	eapKeys, err := eapaka.DeriveKeys(fullIdentity, aka)
	if err != nil {
		t.Fatalf("DeriveKeys() error = %v", err)
	}
	nonceS := []byte("0123456789abcdef")
	reauthRequest := signedAKAReauthenticationRequest(t, eapaka.TypeAKA, eapKeys, 3, nonceS, []eapaka.Attribute{
		eapaka.NextReauthIDAttribute("reauth-3"),
	}, nil)
	exchanges := 0
	transport := InitTransportFunc(func(ctx context.Context, request []byte) ([]byte, error) {
		msg, inner, err := UnprotectMessage(request, init.Keys, true)
		if err != nil {
			return nil, err
		}
		switch exchanges {
		case 0:
			if msg.Header.MessageID != 1 || len(inner) == 0 {
				t.Fatalf("initial auth header=%+v inner=%+v", msg.Header, inner)
			}
			raw, err := reauthRequest.MarshalBinary()
			if err != nil {
				return nil, err
			}
			exchanges++
			_, rawResp, err := ProtectMessage(authHeader(init, 1, false), init.Keys, false, []Payload{EAPPayload(raw)}, bytes.Repeat([]byte{0xa1}, init.Keys.Profile.EncryptionBlockSize))
			return rawResp, err
		case 1:
			if msg.Header.MessageID != 2 || len(inner) != 1 || inner[0].Type != PayloadEAP {
				t.Fatalf("reauth response header=%+v inner=%+v", msg.Header, inner)
			}
			pkt, err := eapaka.ParsePacket(inner[0].Body)
			if err != nil {
				return nil, err
			}
			if pkt.Code != eapaka.CodeResponse || pkt.Subtype != eapaka.SubtypeReauthentication {
				t.Fatalf("reauth response=%+v", pkt)
			}
			raw, err := pkt.MarshalBinary()
			if err != nil {
				return nil, err
			}
			if err := eapaka.VerifyMAC(eapKeys.KAut, raw, nonceS); err != nil {
				return nil, err
			}
			attrs := decryptedAKAReauthenticationResponseAttrs(t, eapKeys, pkt)
			counterAttr, ok := eapaka.FindAttribute(attrs, eapaka.AttributeCounter)
			if !ok {
				t.Fatalf("missing AT_COUNTER in %+v", attrs)
			}
			counter, err := counterAttr.CounterValue()
			if err != nil {
				return nil, err
			}
			if counter != 3 {
				t.Fatalf("counter=%d", counter)
			}
			payloads, err := authSuccessChildPayloads(t, pkt.Identifier, []byte{0xde, 0xad, 0xda, 0x7a})
			if err != nil {
				return nil, err
			}
			exchanges++
			_, rawResp, err := ProtectMessage(authHeader(init, 2, false), init.Keys, false, payloads, bytes.Repeat([]byte{0xa2}, init.Keys.Profile.EncryptionBlockSize))
			return rawResp, err
		default:
			return nil, errors.New("unexpected extra exchange")
		}
	})
	res, err := RunIKE_AUTH_Full(context.Background(), FullAuthConfig{
		Transport:          transport,
		Init:               init,
		EAPKeys:            eapKeys,
		InitiatorID:        Identity{Type: IDRFC822Addr, Data: []byte(fullIdentity)},
		EAPIdentity:        fullIdentity,
		EAPReauthIdentity:  reauthIdentity,
		EAPReauthCounter:   2,
		EAPReauthCounterOK: true,
		ChildSPI:           []byte{0xca, 0xfe, 0xba, 0xbe},
	})
	if err != nil {
		t.Fatalf("RunIKE_AUTH_Full(reauth) error = %v", err)
	}
	if exchanges != 2 || len(res.IdentityExchanges) != 0 || len(res.AKAChallenges) != 1 {
		t.Fatalf("exchanges=%d identity=%d aka=%d", exchanges, len(res.IdentityExchanges), len(res.AKAChallenges))
	}
	if !res.EAPReauthenticated || res.EAPReauthCounterTooSmall || res.EAPReauthCounter != 3 || res.EAPNextReauthID != "reauth-3" {
		t.Fatalf("reauth result=%+v", res)
	}
	expectedKeys, err := eapaka.DeriveReauthenticationKeys(reauthIdentity, eapKeys, 3, nonceS)
	if err != nil {
		t.Fatalf("DeriveReauthenticationKeys() error = %v", err)
	}
	if !bytes.Equal(res.EAPKeys.MSK, expectedKeys.MSK) || !bytes.Equal(res.EAPKeys.EMSK, expectedKeys.EMSK) {
		t.Fatalf("EAP keys=%+v expected=%+v", res.EAPKeys, expectedKeys)
	}
	if res.ChildSA == nil || !bytes.Equal(res.ChildSA.RemoteSPI, []byte{0xde, 0xad, 0xda, 0x7a}) || res.NextMessageID != 3 {
		t.Fatalf("result=%+v", res)
	}
}

func TestRunIKEAuthAKAChallenge(t *testing.T) {
	init := fakeInitResult(t)
	identity := "310280000000001@nai.epc.mnc280.mcc310.3gppnetwork.org"
	aka := simAKAResult()
	eapKeys, err := eapaka.DeriveKeys(identity, aka)
	if err != nil {
		t.Fatalf("DeriveKeys() error = %v", err)
	}
	encryptedIV := bytes.Repeat([]byte{0x33}, 16)
	encrypted, err := eapaka.EncryptAttributes(eapKeys.KEncr, encryptedIV, []eapaka.Attribute{
		eapaka.NextPseudonymAttribute("pseudo-2"),
		eapaka.NextReauthIDAttribute("reauth-2"),
	})
	if err != nil {
		t.Fatalf("EncryptAttributes() error = %v", err)
	}
	challenge := signedAKAChallengeWithEncryptedAttrs(t, identity, aka, eapaka.IVAttribute(encryptedIV), encrypted)
	transport := InitTransportFunc(func(ctx context.Context, request []byte) ([]byte, error) {
		msg, inner, err := UnprotectMessage(request, init.Keys, true)
		if err != nil {
			return nil, err
		}
		if msg.Header.MessageID != 3 || len(inner) != 1 || inner[0].Type != PayloadEAP {
			t.Fatalf("request header=%+v inner=%+v", msg.Header, inner)
		}
		pkt, err := eapaka.ParsePacket(inner[0].Body)
		if err != nil {
			return nil, err
		}
		if pkt.Code != eapaka.CodeResponse || pkt.Subtype != eapaka.SubtypeChallenge {
			t.Fatalf("packet=%+v", pkt)
		}
		raw, err := pkt.MarshalBinary()
		if err != nil {
			return nil, err
		}
		if err := eapaka.VerifyMAC(eapKeys.KAut, raw, nil); err != nil {
			return nil, err
		}
		resAttr, ok := eapaka.FindAttribute(pkt.Attributes, eapaka.AttributeRES)
		if !ok {
			t.Fatal("missing AT_RES")
		}
		res, _, err := resAttr.RESValue()
		if err != nil {
			return nil, err
		}
		if !bytes.Equal(res, aka.RES) {
			t.Fatalf("RES=%x", res)
		}
		success, err := (eapaka.Packet{Code: eapaka.CodeSuccess, Identifier: pkt.Identifier}).MarshalBinary()
		if err != nil {
			return nil, err
		}
		saPayload, err := SecurityAssociationPayload(DefaultESPProposal([]byte{0xde, 0xad, 0xbe, 0xef}))
		if err != nil {
			return nil, err
		}
		tsiPayload, err := TrafficSelectorsPayload(PayloadTSi, IPv4AnyTrafficSelectors())
		if err != nil {
			return nil, err
		}
		tsrPayload, err := TrafficSelectorsPayload(PayloadTSr, IPv4AnyTrafficSelectors())
		if err != nil {
			return nil, err
		}
		cpPayload, err := ConfigurationPayload(Configuration{Type: CFGReply, Attributes: []ConfigurationAttribute{{Type: ConfigInternalIPv4Address, Value: []byte{10, 0, 0, 2}}}})
		if err != nil {
			return nil, err
		}
		_, rawResp, err := ProtectMessage(authHeader(init, 3, false), init.Keys, false, []Payload{EAPPayload(success), saPayload, tsiPayload, tsrPayload, cpPayload}, bytes.Repeat([]byte{0x42}, init.Keys.Profile.EncryptionBlockSize))
		return rawResp, err
	})
	localSPI := []byte{0xca, 0xfe, 0xba, 0xbe}
	res, err := RunIKE_AUTH_AKAChallenge(context.Background(), AKAChallengeConfig{
		Transport: transport,
		Init:      init,
		SIM:       akaProviderStub{result: aka},
		Identity:  identity,
		Request:   challenge,
		ChildSPI:  localSPI,
		MessageID: 3,
		IV:        bytes.Repeat([]byte{0x41}, init.Keys.Profile.EncryptionBlockSize),
	})
	if err != nil {
		t.Fatalf("RunIKE_AUTH_AKAChallenge() error = %v", err)
	}
	if res.SyncFailure || res.EAPNext == nil || res.EAPNext.Code != eapaka.CodeSuccess || res.NextMessageID != 4 {
		t.Fatalf("result=%+v", res)
	}
	if len(res.EAPKeys.KAut) != eapaka.KeyLengthKAut || len(res.EAPKeys.MSK) != eapaka.KeyLengthMSK {
		t.Fatalf("EAP keys=%+v", res.EAPKeys)
	}
	if len(res.EAPEncryptedAttributes) != 2 || res.EAPEncryptedAttributes[0].Type != eapaka.AttributeNextPseudonym || res.EAPEncryptedAttributes[1].Type != eapaka.AttributeNextReauthID {
		t.Fatalf("encrypted attributes=%+v", res.EAPEncryptedAttributes)
	}
	if res.EAPNextPseudonym != "pseudo-2" || res.EAPNextReauthID != "reauth-2" {
		t.Fatalf("EAP identity state pseudonym=%q reauth=%q", res.EAPNextPseudonym, res.EAPNextReauthID)
	}
	if res.ChildSA == nil || !bytes.Equal(res.ChildSA.LocalSPI, localSPI) || !bytes.Equal(res.ChildSA.RemoteSPI, []byte{0xde, 0xad, 0xbe, 0xef}) {
		t.Fatalf("child SA=%+v", res.ChildSA)
	}
	if len(res.ChildSA.Keys.Outbound.EncryptionKey) != 16 || len(res.ChildSA.Keys.Inbound.IntegrityKey) != 32 {
		t.Fatalf("child keys=%+v", res.ChildSA.Keys)
	}
}

func TestRunIKEAuthAKAChallengeHandlesNotificationBeforeSuccess(t *testing.T) {
	init := fakeInitResult(t)
	identity := "310280000000001@nai.epc.mnc280.mcc310.3gppnetwork.org"
	aka := simAKAResult()
	challenge := signedAKAChallenge(t, identity, aka)
	eapKeys, err := eapaka.DeriveKeys(identity, aka)
	if err != nil {
		t.Fatalf("DeriveKeys() error = %v", err)
	}
	exchanges := 0
	transport := InitTransportFunc(func(ctx context.Context, request []byte) ([]byte, error) {
		msg, inner, err := UnprotectMessage(request, init.Keys, true)
		if err != nil {
			return nil, err
		}
		if len(inner) != 1 || inner[0].Type != PayloadEAP {
			t.Fatalf("request header=%+v inner=%+v", msg.Header, inner)
		}
		pkt, err := eapaka.ParsePacket(inner[0].Body)
		if err != nil {
			return nil, err
		}
		switch exchanges {
		case 0:
			if msg.Header.MessageID != 3 || pkt.Code != eapaka.CodeResponse || pkt.Subtype != eapaka.SubtypeChallenge {
				t.Fatalf("challenge response header=%+v packet=%+v", msg.Header, pkt)
			}
			raw, err := pkt.MarshalBinary()
			if err != nil {
				return nil, err
			}
			if err := eapaka.VerifyMAC(eapKeys.KAut, raw, nil); err != nil {
				return nil, err
			}
			notification := signedAKANotification(t, 14, eapKeys, eapaka.NotificationSuccess)
			notificationRaw, err := notification.MarshalBinary()
			if err != nil {
				return nil, err
			}
			exchanges++
			_, rawResp, err := ProtectMessage(authHeader(init, 3, false), init.Keys, false, []Payload{EAPPayload(notificationRaw)}, bytes.Repeat([]byte{0x82}, init.Keys.Profile.EncryptionBlockSize))
			return rawResp, err
		case 1:
			if msg.Header.MessageID != 4 || pkt.Code != eapaka.CodeResponse || pkt.Subtype != eapaka.SubtypeNotification {
				t.Fatalf("notification response header=%+v packet=%+v", msg.Header, pkt)
			}
			raw, err := pkt.MarshalBinary()
			if err != nil {
				return nil, err
			}
			if err := eapaka.VerifyMAC(eapKeys.KAut, raw, nil); err != nil {
				return nil, err
			}
			success, err := (eapaka.Packet{Code: eapaka.CodeSuccess, Identifier: pkt.Identifier}).MarshalBinary()
			if err != nil {
				return nil, err
			}
			saPayload, err := SecurityAssociationPayload(DefaultESPProposal([]byte{0xde, 0xad, 0xfa, 0xce}))
			if err != nil {
				return nil, err
			}
			tsiPayload, err := TrafficSelectorsPayload(PayloadTSi, IPv4AnyTrafficSelectors())
			if err != nil {
				return nil, err
			}
			tsrPayload, err := TrafficSelectorsPayload(PayloadTSr, IPv4AnyTrafficSelectors())
			if err != nil {
				return nil, err
			}
			exchanges++
			_, rawResp, err := ProtectMessage(authHeader(init, 4, false), init.Keys, false, []Payload{EAPPayload(success), saPayload, tsiPayload, tsrPayload}, bytes.Repeat([]byte{0x83}, init.Keys.Profile.EncryptionBlockSize))
			return rawResp, err
		default:
			return nil, errors.New("unexpected extra exchange")
		}
	})
	localSPI := []byte{0xca, 0xfe, 0xba, 0xbe}
	res, err := RunIKE_AUTH_AKAChallenge(context.Background(), AKAChallengeConfig{
		Transport: transport,
		Init:      init,
		SIM:       akaProviderStub{result: aka},
		Identity:  identity,
		Request:   challenge,
		ChildSPI:  localSPI,
		MessageID: 3,
		IV:        bytes.Repeat([]byte{0x81}, init.Keys.Profile.EncryptionBlockSize),
	})
	if err != nil {
		t.Fatalf("RunIKE_AUTH_AKAChallenge() error = %v", err)
	}
	if exchanges != 2 {
		t.Fatalf("exchanges=%d, want challenge response plus notification ack", exchanges)
	}
	if len(res.EAPNotifications) != 1 || res.EAPNotifications[0].Subtype != eapaka.SubtypeNotification {
		t.Fatalf("notifications=%+v", res.EAPNotifications)
	}
	if len(res.FollowupRequestBytes) != 1 || len(res.FollowupResponseBytes) != 1 || len(res.FinalResponseBytes) == 0 || len(res.FinalResponseInner) == 0 {
		t.Fatalf("followup request=%d response=%d final=%d/%d", len(res.FollowupRequestBytes), len(res.FollowupResponseBytes), len(res.FinalResponseBytes), len(res.FinalResponseInner))
	}
	if res.EAPNext == nil || res.EAPNext.Code != eapaka.CodeSuccess || res.NextMessageID != 5 {
		t.Fatalf("result=%+v", res)
	}
	if res.ChildSA == nil || !bytes.Equal(res.ChildSA.LocalSPI, localSPI) || !bytes.Equal(res.ChildSA.RemoteSPI, []byte{0xde, 0xad, 0xfa, 0xce}) {
		t.Fatalf("child SA=%+v", res.ChildSA)
	}
}

func TestRunIKEAuthAKAChallengeHandlesInitialNotificationWithoutSIM(t *testing.T) {
	init := fakeInitResult(t)
	request := eapaka.Packet{
		Code:       eapaka.CodeRequest,
		Identifier: 15,
		Type:       eapaka.TypeAKA,
		Subtype:    eapaka.SubtypeNotification,
		Attributes: []eapaka.Attribute{eapaka.NotificationAttribute(eapaka.NotificationGeneralFailureBeforeAuthentication)},
	}
	transport := InitTransportFunc(func(ctx context.Context, requestBytes []byte) ([]byte, error) {
		msg, inner, err := UnprotectMessage(requestBytes, init.Keys, true)
		if err != nil {
			return nil, err
		}
		if msg.Header.MessageID != 3 || len(inner) != 1 || inner[0].Type != PayloadEAP {
			t.Fatalf("request header=%+v inner=%+v", msg.Header, inner)
		}
		pkt, err := eapaka.ParsePacket(inner[0].Body)
		if err != nil {
			return nil, err
		}
		if pkt.Code != eapaka.CodeResponse || pkt.Subtype != eapaka.SubtypeNotification || len(pkt.Attributes) != 0 {
			t.Fatalf("notification response=%+v", pkt)
		}
		challenge, err := (eapaka.Packet{
			Code:       eapaka.CodeRequest,
			Identifier: 16,
			Type:       eapaka.TypeAKA,
			Subtype:    eapaka.SubtypeChallenge,
			Attributes: []eapaka.Attribute{
				eapaka.RANDAttribute(bytes.Repeat([]byte{0xa1}, 16)),
				eapaka.AUTNAttribute(bytes.Repeat([]byte{0xb2}, 16)),
			},
		}).MarshalBinary()
		if err != nil {
			return nil, err
		}
		_, rawResp, err := ProtectMessage(authHeader(init, 3, false), init.Keys, false, []Payload{EAPPayload(challenge)}, bytes.Repeat([]byte{0x84}, init.Keys.Profile.EncryptionBlockSize))
		return rawResp, err
	})
	res, err := RunIKE_AUTH_AKAChallenge(context.Background(), AKAChallengeConfig{
		Transport: transport,
		Init:      init,
		Request:   request,
		MessageID: 3,
		IV:        bytes.Repeat([]byte{0x85}, init.Keys.Profile.EncryptionBlockSize),
	})
	if err != nil {
		t.Fatalf("RunIKE_AUTH_AKAChallenge() error = %v", err)
	}
	if res.EAPResponse.Subtype != eapaka.SubtypeNotification || len(res.EAPNotifications) != 1 || res.EAPNext == nil || res.EAPNext.Subtype != eapaka.SubtypeChallenge || res.EAPClientError {
		t.Fatalf("result=%+v", res)
	}
}

func TestRunIKEAuthAKAChallengeHandlesAuthenticatedInitialNotification(t *testing.T) {
	init := fakeInitResult(t)
	identity := "310280000000001@nai.epc.mnc280.mcc310.3gppnetwork.org"
	aka := simAKAResult()
	eapKeys, err := eapaka.DeriveKeys(identity, aka)
	if err != nil {
		t.Fatalf("DeriveKeys() error = %v", err)
	}
	request := signedAKANotification(t, 18, eapKeys, eapaka.NotificationSuccess)
	transport := InitTransportFunc(func(ctx context.Context, requestBytes []byte) ([]byte, error) {
		msg, inner, err := UnprotectMessage(requestBytes, init.Keys, true)
		if err != nil {
			return nil, err
		}
		if msg.Header.MessageID != 3 || len(inner) != 1 || inner[0].Type != PayloadEAP {
			t.Fatalf("request header=%+v inner=%+v", msg.Header, inner)
		}
		pkt, err := eapaka.ParsePacket(inner[0].Body)
		if err != nil {
			return nil, err
		}
		if pkt.Code != eapaka.CodeResponse || pkt.Subtype != eapaka.SubtypeNotification {
			t.Fatalf("notification response=%+v", pkt)
		}
		raw, err := pkt.MarshalBinary()
		if err != nil {
			return nil, err
		}
		if err := eapaka.VerifyMAC(eapKeys.KAut, raw, nil); err != nil {
			return nil, err
		}
		success, err := (eapaka.Packet{Code: eapaka.CodeSuccess, Identifier: pkt.Identifier}).MarshalBinary()
		if err != nil {
			return nil, err
		}
		_, rawResp, err := ProtectMessage(authHeader(init, 3, false), init.Keys, false, []Payload{EAPPayload(success)}, bytes.Repeat([]byte{0x88}, init.Keys.Profile.EncryptionBlockSize))
		return rawResp, err
	})
	res, err := RunIKE_AUTH_AKAChallenge(context.Background(), AKAChallengeConfig{
		Transport: transport,
		Init:      init,
		EAPKeys:   eapKeys,
		Request:   request,
		MessageID: 3,
		IV:        bytes.Repeat([]byte{0x89}, init.Keys.Profile.EncryptionBlockSize),
	})
	if err != nil {
		t.Fatalf("RunIKE_AUTH_AKAChallenge() error = %v", err)
	}
	if res.EAPResponse.Subtype != eapaka.SubtypeNotification || len(res.EAPKeys.KAut) != eapaka.KeyLengthKAut || len(res.EAPNotifications) != 1 || res.EAPNext == nil || res.EAPNext.Code != eapaka.CodeSuccess || res.EAPClientError {
		t.Fatalf("result=%+v", res)
	}
}

func TestRunIKEAuthAKAChallengeHandlesReauthentication(t *testing.T) {
	init := fakeInitResult(t)
	fullIdentity := "310280000000001@nai.epc.mnc280.mcc310.3gppnetwork.org"
	reauthIdentity := "reauth-2"
	aka := simAKAResult()
	eapKeys, err := eapaka.DeriveKeys(fullIdentity, aka)
	if err != nil {
		t.Fatalf("DeriveKeys() error = %v", err)
	}
	nonceS := []byte("0123456789abcdef")
	request := signedAKAReauthenticationRequest(t, eapaka.TypeAKA, eapKeys, 3, nonceS, []eapaka.Attribute{
		eapaka.NextReauthIDAttribute("reauth-3"),
	}, []eapaka.Attribute{eapaka.ResultIndAttribute()})
	transport := InitTransportFunc(func(ctx context.Context, requestBytes []byte) ([]byte, error) {
		msg, inner, err := UnprotectMessage(requestBytes, init.Keys, true)
		if err != nil {
			return nil, err
		}
		if msg.Header.MessageID != 3 || len(inner) != 1 || inner[0].Type != PayloadEAP {
			t.Fatalf("request header=%+v inner=%+v", msg.Header, inner)
		}
		pkt, err := eapaka.ParsePacket(inner[0].Body)
		if err != nil {
			return nil, err
		}
		if pkt.Code != eapaka.CodeResponse || pkt.Subtype != eapaka.SubtypeReauthentication {
			t.Fatalf("reauth response=%+v", pkt)
		}
		if _, ok := eapaka.FindAttribute(pkt.Attributes, eapaka.AttributeResultInd); !ok {
			t.Fatal("missing echoed AT_RESULT_IND")
		}
		raw, err := pkt.MarshalBinary()
		if err != nil {
			return nil, err
		}
		if err := eapaka.VerifyMAC(eapKeys.KAut, raw, nonceS); err != nil {
			return nil, err
		}
		attrs := decryptedAKAReauthenticationResponseAttrs(t, eapKeys, pkt)
		counterAttr, ok := eapaka.FindAttribute(attrs, eapaka.AttributeCounter)
		if !ok {
			t.Fatalf("missing encrypted AT_COUNTER in %+v", attrs)
		}
		counter, err := counterAttr.CounterValue()
		if err != nil {
			return nil, err
		}
		if counter != 3 {
			t.Fatalf("counter=%d", counter)
		}
		payloads, err := authSuccessChildPayloads(t, pkt.Identifier, []byte{0xfa, 0xce, 0xfe, 0xed})
		if err != nil {
			return nil, err
		}
		_, rawResp, err := ProtectMessage(authHeader(init, 3, false), init.Keys, false, payloads, bytes.Repeat([]byte{0x8a}, init.Keys.Profile.EncryptionBlockSize))
		return rawResp, err
	})
	localSPI := []byte{0xca, 0xfe, 0xba, 0xbe}
	res, err := RunIKE_AUTH_AKAChallenge(context.Background(), AKAChallengeConfig{
		Transport:          transport,
		Init:               init,
		EAPKeys:            eapKeys,
		Identity:           reauthIdentity,
		Request:            request,
		ChildSPI:           localSPI,
		MessageID:          3,
		IV:                 bytes.Repeat([]byte{0x89}, init.Keys.Profile.EncryptionBlockSize),
		EAPReauthIV:        bytes.Repeat([]byte{0x67}, 16),
		EAPReauthCounter:   2,
		EAPReauthCounterOK: true,
	})
	if err != nil {
		t.Fatalf("RunIKE_AUTH_AKAChallenge(reauth) error = %v", err)
	}
	if !res.EAPReauthenticated || res.EAPReauthCounterTooSmall || res.EAPReauthCounter != 3 {
		t.Fatalf("reauth flags result=%+v", res)
	}
	if res.EAPNext == nil || res.EAPNext.Code != eapaka.CodeSuccess || res.NextMessageID != 4 {
		t.Fatalf("result=%+v", res)
	}
	if res.EAPNextReauthID != "reauth-3" || len(res.EAPEncryptedAttributes) != 3 {
		t.Fatalf("reauth identity state=%q encrypted=%+v", res.EAPNextReauthID, res.EAPEncryptedAttributes)
	}
	expectedKeys, err := eapaka.DeriveReauthenticationKeys(reauthIdentity, eapKeys, 3, nonceS)
	if err != nil {
		t.Fatalf("DeriveReauthenticationKeys() error = %v", err)
	}
	if !bytes.Equal(res.EAPKeys.MSK, expectedKeys.MSK) || !bytes.Equal(res.EAPKeys.EMSK, expectedKeys.EMSK) || !bytes.Equal(res.EAPKeys.KAut, eapKeys.KAut) {
		t.Fatalf("reauth keys=%+v expected=%+v", res.EAPKeys, expectedKeys)
	}
	if res.ChildSA == nil || !bytes.Equal(res.ChildSA.LocalSPI, localSPI) || !bytes.Equal(res.ChildSA.RemoteSPI, []byte{0xfa, 0xce, 0xfe, 0xed}) {
		t.Fatalf("child SA=%+v", res.ChildSA)
	}
}

func TestRunIKEAuthAKAChallengeHandlesReauthenticationCounterTooSmall(t *testing.T) {
	init := fakeInitResult(t)
	fullIdentity := "310280000000001@nai.epc.mnc280.mcc310.3gppnetwork.org"
	aka := simAKAResult()
	eapKeys, err := eapaka.DeriveKeys(fullIdentity, aka)
	if err != nil {
		t.Fatalf("DeriveKeys() error = %v", err)
	}
	nonceS := []byte("0123456789abcdef")
	request := signedAKAReauthenticationRequest(t, eapaka.TypeAKA, eapKeys, 2, nonceS, nil, nil)
	transport := InitTransportFunc(func(ctx context.Context, requestBytes []byte) ([]byte, error) {
		msg, inner, err := UnprotectMessage(requestBytes, init.Keys, true)
		if err != nil {
			return nil, err
		}
		if msg.Header.MessageID != 3 || len(inner) != 1 || inner[0].Type != PayloadEAP {
			t.Fatalf("request header=%+v inner=%+v", msg.Header, inner)
		}
		pkt, err := eapaka.ParsePacket(inner[0].Body)
		if err != nil {
			return nil, err
		}
		if pkt.Code != eapaka.CodeResponse || pkt.Subtype != eapaka.SubtypeReauthentication {
			t.Fatalf("reauth response=%+v", pkt)
		}
		raw, err := pkt.MarshalBinary()
		if err != nil {
			return nil, err
		}
		if err := eapaka.VerifyMAC(eapKeys.KAut, raw, nonceS); err != nil {
			return nil, err
		}
		attrs := decryptedAKAReauthenticationResponseAttrs(t, eapKeys, pkt)
		if tooSmall, ok := eapaka.FindAttribute(attrs, eapaka.AttributeCounterTooSmall); !ok {
			t.Fatalf("missing encrypted AT_COUNTER_TOO_SMALL in %+v", attrs)
		} else if err := tooSmall.CounterTooSmallValue(); err != nil {
			return nil, err
		}
		identityReq, err := (eapaka.Packet{
			Code:       eapaka.CodeRequest,
			Identifier: pkt.Identifier + 1,
			Type:       eapaka.TypeAKA,
			Subtype:    eapaka.SubtypeIdentity,
			Attributes: []eapaka.Attribute{eapaka.FullAuthIDReqAttribute()},
		}).MarshalBinary()
		if err != nil {
			return nil, err
		}
		_, rawResp, err := ProtectMessage(authHeader(init, 3, false), init.Keys, false, []Payload{EAPPayload(identityReq)}, bytes.Repeat([]byte{0x8c}, init.Keys.Profile.EncryptionBlockSize))
		return rawResp, err
	})
	res, err := RunIKE_AUTH_AKAChallenge(context.Background(), AKAChallengeConfig{
		Transport:          transport,
		Init:               init,
		EAPKeys:            eapKeys,
		Request:            request,
		MessageID:          3,
		IV:                 bytes.Repeat([]byte{0x8b}, init.Keys.Profile.EncryptionBlockSize),
		EAPReauthIV:        bytes.Repeat([]byte{0x68}, 16),
		EAPReauthCounter:   5,
		EAPReauthCounterOK: true,
	})
	if err != nil {
		t.Fatalf("RunIKE_AUTH_AKAChallenge(reauth counter-too-small) error = %v", err)
	}
	if res.EAPReauthenticated || !res.EAPReauthCounterTooSmall || res.EAPReauthCounter != 2 {
		t.Fatalf("reauth flags result=%+v", res)
	}
	if !bytes.Equal(res.EAPKeys.MSK, eapKeys.MSK) || !bytes.Equal(res.EAPKeys.EMSK, eapKeys.EMSK) {
		t.Fatalf("counter-too-small should preserve old keys: %+v", res.EAPKeys)
	}
	if res.EAPNext == nil || res.EAPNext.Subtype != eapaka.SubtypeIdentity || res.EAPNext.Identifier != request.Identifier+1 {
		t.Fatalf("next EAP=%+v", res.EAPNext)
	}
}

func TestRunIKEAuthAKAChallengeSendsClientErrorForUnsupportedSubtype(t *testing.T) {
	init := fakeInitResult(t)
	request := eapaka.Packet{
		Code:       eapaka.CodeRequest,
		Identifier: 17,
		Type:       eapaka.TypeAKA,
		Subtype:    eapaka.SubtypeReauthentication,
	}
	transport := InitTransportFunc(func(ctx context.Context, requestBytes []byte) ([]byte, error) {
		msg, inner, err := UnprotectMessage(requestBytes, init.Keys, true)
		if err != nil {
			return nil, err
		}
		if msg.Header.MessageID != 3 || len(inner) != 1 || inner[0].Type != PayloadEAP {
			t.Fatalf("request header=%+v inner=%+v", msg.Header, inner)
		}
		pkt, err := eapaka.ParsePacket(inner[0].Body)
		if err != nil {
			return nil, err
		}
		if pkt.Code != eapaka.CodeResponse || pkt.Subtype != eapaka.SubtypeClientError {
			t.Fatalf("client error response=%+v", pkt)
		}
		attr, ok := eapaka.FindAttribute(pkt.Attributes, eapaka.AttributeClientErrorCode)
		if !ok {
			t.Fatalf("missing AT_CLIENT_ERROR_CODE: %+v", pkt)
		}
		code, err := attr.ClientErrorCodeValue()
		if err != nil {
			return nil, err
		}
		if code != eapaka.ClientErrorUnableToProcessPacket {
			t.Fatalf("client error code=%d", code)
		}
		failure, err := (eapaka.Packet{Code: eapaka.CodeFailure, Identifier: pkt.Identifier}).MarshalBinary()
		if err != nil {
			return nil, err
		}
		_, rawResp, err := ProtectMessage(authHeader(init, 3, false), init.Keys, false, []Payload{EAPPayload(failure)}, bytes.Repeat([]byte{0x86}, init.Keys.Profile.EncryptionBlockSize))
		return rawResp, err
	})
	res, err := RunIKE_AUTH_AKAChallenge(context.Background(), AKAChallengeConfig{
		Transport: transport,
		Init:      init,
		Request:   request,
		MessageID: 3,
		IV:        bytes.Repeat([]byte{0x87}, init.Keys.Profile.EncryptionBlockSize),
	})
	if err != nil {
		t.Fatalf("RunIKE_AUTH_AKAChallenge() error = %v", err)
	}
	if !res.EAPClientError || res.EAPResponse.Subtype != eapaka.SubtypeClientError || res.EAPNext == nil || res.EAPNext.Code != eapaka.CodeFailure {
		t.Fatalf("result=%+v", res)
	}
}

func TestRunIKEAuthAKAPrimeChallenge(t *testing.T) {
	init := fakeInitResult(t)
	identity := "310280000000001@nai.epc.mnc280.mcc310.3gppnetwork.org"
	networkName := "WLAN"
	aka := simAKAResult()
	challenge := signedAKAPrimeChallenge(t, identity, networkName, aka)
	transport := InitTransportFunc(func(ctx context.Context, request []byte) ([]byte, error) {
		msg, inner, err := UnprotectMessage(request, init.Keys, true)
		if err != nil {
			return nil, err
		}
		if msg.Header.MessageID != 3 || len(inner) != 1 || inner[0].Type != PayloadEAP {
			t.Fatalf("request header=%+v inner=%+v", msg.Header, inner)
		}
		pkt, err := eapaka.ParsePacket(inner[0].Body)
		if err != nil {
			return nil, err
		}
		if pkt.Code != eapaka.CodeResponse || pkt.Type != eapaka.TypeAKAPrime || pkt.Subtype != eapaka.SubtypeChallenge {
			t.Fatalf("packet=%+v", pkt)
		}
		keys, err := eapaka.DeriveAKAPrimeKeys(identity, networkName, bytes.Repeat([]byte{0xb2}, 16), aka)
		if err != nil {
			return nil, err
		}
		raw, err := pkt.MarshalBinary()
		if err != nil {
			return nil, err
		}
		if err := eapaka.VerifyAKAPrimeMAC(keys.KAut, raw, nil); err != nil {
			return nil, err
		}
		if _, ok := eapaka.FindAttribute(pkt.Attributes, eapaka.AttributeRES); !ok {
			t.Fatal("missing AT_RES")
		}
		kdfAttr, ok := eapaka.FindAttribute(pkt.Attributes, eapaka.AttributeKDF)
		if !ok {
			t.Fatal("missing AT_KDF")
		}
		kdf, err := kdfAttr.KDFValue()
		if err != nil {
			return nil, err
		}
		if kdf != eapaka.AKAPrimeKDFDefault {
			t.Fatalf("AT_KDF=%d", kdf)
		}
		success, err := (eapaka.Packet{Code: eapaka.CodeSuccess, Identifier: pkt.Identifier}).MarshalBinary()
		if err != nil {
			return nil, err
		}
		_, rawResp, err := ProtectMessage(authHeader(init, 3, false), init.Keys, false, []Payload{EAPPayload(success)}, bytes.Repeat([]byte{0x62}, init.Keys.Profile.EncryptionBlockSize))
		return rawResp, err
	})
	res, err := RunIKE_AUTH_AKAChallenge(context.Background(), AKAChallengeConfig{
		Transport: transport,
		Init:      init,
		SIM:       akaProviderStub{result: aka},
		Identity:  identity,
		Request:   challenge,
		MessageID: 3,
		IV:        bytes.Repeat([]byte{0x61}, init.Keys.Profile.EncryptionBlockSize),
	})
	if err != nil {
		t.Fatalf("RunIKE_AUTH_AKAChallenge(AKA') error = %v", err)
	}
	if res.SyncFailure || res.EAPNext == nil || res.EAPNext.Code != eapaka.CodeSuccess {
		t.Fatalf("result=%+v", res)
	}
	if res.EAPResponse.Type != eapaka.TypeAKAPrime || len(res.EAPKeys.KAut) != eapaka.KeyLengthAKAPrimeKAut || len(res.EAPKeys.KRe) != eapaka.KeyLengthKRe {
		t.Fatalf("AKA' response=%+v keys=%+v", res.EAPResponse, res.EAPKeys)
	}
}

func TestRunIKEAuthAKAPrimeKDFNegotiation(t *testing.T) {
	init := fakeInitResult(t)
	challenge := eapaka.Packet{
		Code:       eapaka.CodeRequest,
		Identifier: 12,
		Type:       eapaka.TypeAKAPrime,
		Subtype:    eapaka.SubtypeChallenge,
		Attributes: []eapaka.Attribute{
			eapaka.KDFAttribute(99),
			eapaka.KDFAttribute(eapaka.AKAPrimeKDFDefault),
			eapaka.KDFInputAttribute("WLAN"),
		},
	}
	transport := InitTransportFunc(func(ctx context.Context, request []byte) ([]byte, error) {
		msg, inner, err := UnprotectMessage(request, init.Keys, true)
		if err != nil {
			return nil, err
		}
		if msg.Header.MessageID != 3 || len(inner) != 1 || inner[0].Type != PayloadEAP {
			t.Fatalf("request header=%+v inner=%+v", msg.Header, inner)
		}
		pkt, err := eapaka.ParsePacket(inner[0].Body)
		if err != nil {
			return nil, err
		}
		if pkt.Code != eapaka.CodeResponse || pkt.Type != eapaka.TypeAKAPrime || pkt.Subtype != eapaka.SubtypeChallenge {
			t.Fatalf("packet=%+v", pkt)
		}
		if len(pkt.Attributes) != 1 || pkt.Attributes[0].Type != eapaka.AttributeKDF {
			t.Fatalf("attributes=%+v, want only AT_KDF", pkt.Attributes)
		}
		kdf, err := pkt.Attributes[0].KDFValue()
		if err != nil {
			return nil, err
		}
		if kdf != eapaka.AKAPrimeKDFDefault {
			t.Fatalf("AT_KDF=%d", kdf)
		}
		next, err := (eapaka.Packet{
			Code:       eapaka.CodeRequest,
			Identifier: 13,
			Type:       eapaka.TypeAKAPrime,
			Subtype:    eapaka.SubtypeChallenge,
			Attributes: []eapaka.Attribute{
				eapaka.KDFAttribute(eapaka.AKAPrimeKDFDefault),
				eapaka.KDFAttribute(99),
				eapaka.KDFInputAttribute("WLAN"),
			},
		}).MarshalBinary()
		if err != nil {
			return nil, err
		}
		_, rawResp, err := ProtectMessage(authHeader(init, 3, false), init.Keys, false, []Payload{EAPPayload(next)}, bytes.Repeat([]byte{0x72}, init.Keys.Profile.EncryptionBlockSize))
		return rawResp, err
	})
	res, err := RunIKE_AUTH_AKAChallenge(context.Background(), AKAChallengeConfig{
		Transport: transport,
		Init:      init,
		Request:   challenge,
		MessageID: 3,
		IV:        bytes.Repeat([]byte{0x71}, init.Keys.Profile.EncryptionBlockSize),
	})
	if err != nil {
		t.Fatalf("RunIKE_AUTH_AKAChallenge(KDF negotiation) error = %v", err)
	}
	if !res.KDFNegotiated || res.SyncFailure || res.EAPResponse.Type != eapaka.TypeAKAPrime {
		t.Fatalf("result=%+v", res)
	}
	if len(res.EAPResponse.Attributes) != 1 || res.EAPNext == nil || res.EAPNext.Identifier != 13 || res.NextMessageID != 4 {
		t.Fatalf("response=%+v next=%+v nextMessageID=%d", res.EAPResponse, res.EAPNext, res.NextMessageID)
	}
}

func TestRunIKEAuthAKAChallengeSyncFailure(t *testing.T) {
	init := fakeInitResult(t)
	identity := "310280000000001@nai.epc.mnc280.mcc310.3gppnetwork.org"
	aka := simAKAResult()
	challenge := signedAKAChallenge(t, identity, aka)
	wantAUTS := bytes.Repeat([]byte{0xee}, 14)
	transport := InitTransportFunc(func(ctx context.Context, request []byte) ([]byte, error) {
		msg, inner, err := UnprotectMessage(request, init.Keys, true)
		if err != nil {
			return nil, err
		}
		if msg.Header.MessageID != 3 || len(inner) != 1 || inner[0].Type != PayloadEAP {
			t.Fatalf("request header=%+v inner=%+v", msg.Header, inner)
		}
		pkt, err := eapaka.ParsePacket(inner[0].Body)
		if err != nil {
			return nil, err
		}
		if pkt.Subtype != eapaka.SubtypeSynchronizationFailure {
			t.Fatalf("packet=%+v", pkt)
		}
		attr, ok := eapaka.FindAttribute(pkt.Attributes, eapaka.AttributeAUTS)
		if !ok {
			t.Fatal("missing AT_AUTS")
		}
		auts, err := attr.AUTSValue()
		if err != nil {
			return nil, err
		}
		if !bytes.Equal(auts, wantAUTS) {
			t.Fatalf("AUTS=%x", auts)
		}
		failure, err := (eapaka.Packet{Code: eapaka.CodeFailure, Identifier: pkt.Identifier}).MarshalBinary()
		if err != nil {
			return nil, err
		}
		_, rawResp, err := ProtectMessage(authHeader(init, 3, false), init.Keys, false, []Payload{EAPPayload(failure)}, bytes.Repeat([]byte{0x52}, init.Keys.Profile.EncryptionBlockSize))
		return rawResp, err
	})
	res, err := RunIKE_AUTH_AKAChallenge(context.Background(), AKAChallengeConfig{
		Transport: transport,
		Init:      init,
		SIM:       akaProviderStub{result: sim.AKAResult{AUTS: wantAUTS}, err: sim.ErrSyncFailure},
		Identity:  identity,
		Request:   challenge,
		MessageID: 3,
		IV:        bytes.Repeat([]byte{0x51}, init.Keys.Profile.EncryptionBlockSize),
	})
	if err != nil {
		t.Fatalf("RunIKE_AUTH_AKAChallenge() error = %v", err)
	}
	if !res.SyncFailure || res.EAPNext == nil || res.EAPNext.Code != eapaka.CodeFailure {
		t.Fatalf("result=%+v", res)
	}
}

func TestRunIKEAuthAKAChallengeAuthenticationReject(t *testing.T) {
	init := fakeInitResult(t)
	identity := "310280000000001@nai.epc.mnc280.mcc310.3gppnetwork.org"
	challenge := signedAKAChallenge(t, identity, simAKAResult())
	transport := InitTransportFunc(func(ctx context.Context, request []byte) ([]byte, error) {
		msg, inner, err := UnprotectMessage(request, init.Keys, true)
		if err != nil {
			return nil, err
		}
		if msg.Header.MessageID != 3 || len(inner) != 1 || inner[0].Type != PayloadEAP {
			t.Fatalf("request header=%+v inner=%+v", msg.Header, inner)
		}
		pkt, err := eapaka.ParsePacket(inner[0].Body)
		if err != nil {
			return nil, err
		}
		if pkt.Code != eapaka.CodeResponse || pkt.Subtype != eapaka.SubtypeAuthenticationReject || len(pkt.Attributes) != 0 {
			t.Fatalf("authentication reject packet=%+v", pkt)
		}
		failure, err := (eapaka.Packet{Code: eapaka.CodeFailure, Identifier: pkt.Identifier}).MarshalBinary()
		if err != nil {
			return nil, err
		}
		_, rawResp, err := ProtectMessage(authHeader(init, 3, false), init.Keys, false, []Payload{EAPPayload(failure)}, bytes.Repeat([]byte{0x54}, init.Keys.Profile.EncryptionBlockSize))
		return rawResp, err
	})
	res, err := RunIKE_AUTH_AKAChallenge(context.Background(), AKAChallengeConfig{
		Transport: transport,
		Init:      init,
		SIM:       akaProviderStub{err: sim.ErrAuthFailure},
		Identity:  identity,
		Request:   challenge,
		MessageID: 3,
		IV:        bytes.Repeat([]byte{0x53}, init.Keys.Profile.EncryptionBlockSize),
	})
	if err != nil {
		t.Fatalf("RunIKE_AUTH_AKAChallenge() error = %v", err)
	}
	if !res.AuthFailure || res.SyncFailure || res.EAPResponse.Subtype != eapaka.SubtypeAuthenticationReject || res.EAPNext == nil || res.EAPNext.Code != eapaka.CodeFailure {
		t.Fatalf("result=%+v", res)
	}
}

func TestRunIKEAuthAKAChallengeBiddingDownAuthenticationReject(t *testing.T) {
	init := fakeInitResult(t)
	identity := "310280000000001@nai.epc.mnc280.mcc310.3gppnetwork.org"
	challenge := signedAKAChallengeWithEncryptedAttrs(t, identity, simAKAResult(), eapaka.BiddingAttribute(true))
	transport := InitTransportFunc(func(ctx context.Context, request []byte) ([]byte, error) {
		msg, inner, err := UnprotectMessage(request, init.Keys, true)
		if err != nil {
			return nil, err
		}
		if msg.Header.MessageID != 3 || len(inner) != 1 || inner[0].Type != PayloadEAP {
			t.Fatalf("request header=%+v inner=%+v", msg.Header, inner)
		}
		pkt := parseTestEAP(t, inner[0].Body)
		if pkt.Code != eapaka.CodeResponse || pkt.Subtype != eapaka.SubtypeAuthenticationReject || len(pkt.Attributes) != 0 {
			t.Fatalf("bidding-down response=%+v", pkt)
		}
		failure, err := (eapaka.Packet{Code: eapaka.CodeFailure, Identifier: pkt.Identifier}).MarshalBinary()
		if err != nil {
			return nil, err
		}
		_, rawResp, err := ProtectMessage(authHeader(init, 3, false), init.Keys, false, []Payload{EAPPayload(failure)}, bytes.Repeat([]byte{0x55}, init.Keys.Profile.EncryptionBlockSize))
		return rawResp, err
	})
	res, err := RunIKE_AUTH_AKAChallenge(context.Background(), AKAChallengeConfig{
		Transport: transport,
		Init:      init,
		SIM:       akaProviderStub{result: simAKAResult()},
		Identity:  identity,
		Request:   challenge,
		MessageID: 3,
		IV:        bytes.Repeat([]byte{0x56}, init.Keys.Profile.EncryptionBlockSize),
	})
	if err != nil {
		t.Fatalf("RunIKE_AUTH_AKAChallenge() error = %v", err)
	}
	if !res.AuthFailure || res.SyncFailure || res.EAPResponse.Subtype != eapaka.SubtypeAuthenticationReject || res.EAPNext == nil || res.EAPNext.Code != eapaka.CodeFailure {
		t.Fatalf("bidding-down result=%+v", res)
	}
	if len(res.EAPKeys.KAut) != 0 {
		t.Fatalf("bidding-down must not expose full-auth keys: %+v", res.EAPKeys)
	}
}

func TestBuildIKEAuthInitialPayloadsRejectsMissingID(t *testing.T) {
	_, err := BuildIKEAuthInitialPayloads(AuthConfig{})
	if !errors.Is(err, ErrInvalidIdentity) {
		t.Fatalf("BuildIKEAuthInitialPayloads() err=%v, want ErrInvalidIdentity", err)
	}
}

func TestCalculateAndVerifyPostEAPAuth(t *testing.T) {
	init := fakeInitResult(t)
	init.RequestBytes = []byte("ike-sa-init-request")
	init.ResponseBytes = []byte("ike-sa-init-response")
	msk := bytes.Repeat([]byte{0x5a}, eapaka.KeyLengthMSK)
	idi := Identity{Type: IDRFC822Addr, Data: []byte("0310240123456789@nai.epc.mnc240.mcc310.3gppnetwork.org")}
	idr := Identity{Type: IDFQDN, Data: []byte("ims")}

	idiBody, err := idi.MarshalBinary()
	if err != nil {
		t.Fatal(err)
	}
	initiatorAuth, err := calculateEAPAuth(init.Keys.Profile.PRF, msk, init.RequestBytes, init.NonceR, init.Keys.SKPi, idiBody)
	if err != nil || len(initiatorAuth) != init.Keys.Profile.PRF.Size() {
		t.Fatalf("initiator AUTH length=%d err=%v", len(initiatorAuth), err)
	}

	idrBody, err := idr.MarshalBinary()
	if err != nil {
		t.Fatal(err)
	}
	responderAuth, err := calculateEAPAuth(init.Keys.Profile.PRF, msk, init.ResponseBytes, init.NonceI, init.Keys.SKPr, idrBody)
	if err != nil {
		t.Fatal(err)
	}
	body := append([]byte{authMethodSharedKeyMIC, 0, 0, 0}, responderAuth...)
	if err := verifyEAPAuthPayload([]Payload{{Type: PayloadAUTH, Body: body}}, init, init.Keys, msk, idr); err != nil {
		t.Fatalf("verifyEAPAuthPayload() error = %v", err)
	}
	body[len(body)-1] ^= 0xff
	if err := verifyEAPAuthPayload([]Payload{{Type: PayloadAUTH, Body: body}}, init, init.Keys, msk, idr); !errors.Is(err, ErrInvalidAuthResponse) {
		t.Fatalf("verify tampered AUTH error=%v, want ErrInvalidAuthResponse", err)
	}
}

func TestBuildIKEAuthInitialPayloadsIncludesAPNResponderID(t *testing.T) {
	payloads, err := BuildIKEAuthInitialPayloads(AuthConfig{
		InitiatorID: Identity{Type: IDRFC822Addr, Data: []byte("user@nai.example")},
		ResponderID: Identity{Type: IDFQDN, Data: []byte("ims")},
		ChildSPI:    []byte{0xca, 0xfe, 0xba, 0xbe},
	})
	if err != nil {
		t.Fatalf("BuildIKEAuthInitialPayloads() error = %v", err)
	}
	wantTypes := []uint8{
		PayloadIDi, PayloadIDr, PayloadSA, PayloadTSi, PayloadTSr, PayloadCP,
		PayloadNotify, PayloadNotify, PayloadNotify,
	}
	if len(payloads) != len(wantTypes) {
		t.Fatalf("payload count=%d, want %d", len(payloads), len(wantTypes))
	}
	for index, want := range wantTypes {
		if payloads[index].Type != want {
			t.Fatalf("payload[%d].type=%d, want %d", index, payloads[index].Type, want)
		}
	}
	responderID, err := ParseIdentity(payloads[1].Body)
	if err != nil {
		t.Fatalf("ParseIdentity(IDr) error = %v", err)
	}
	if responderID.Type != IDFQDN || string(responderID.Data) != "ims" {
		t.Fatalf("IDr=%+v", responderID)
	}
	wantNotifies := []uint16{NotifyInitialContact, NotifyMOBIKESupported, NotifyEAPOnlyAuthentication}
	for index, want := range wantNotifies {
		notify, err := ParseNotify(payloads[6+index].Body)
		if err != nil || notify.NotifyType != want {
			t.Fatalf("notify[%d]=%+v err=%v, want %d", index, notify, err, want)
		}
	}
}

func TestParseIKEAuthChildSARejectsUnsupportedSelectedSA(t *testing.T) {
	init := fakeInitResult(t)
	localSPI := []byte{0xca, 0xfe, 0xba, 0xbe}
	selected := DefaultESPProposal([]byte{0xde, 0xad, 0xbe, 0xef})
	selected.Proposals[0].Transforms[1].ID = INTEG_HMAC_SHA2_512_256
	saPayload, err := SecurityAssociationPayload(selected)
	if err != nil {
		t.Fatalf("SecurityAssociationPayload() error = %v", err)
	}
	tsiPayload, err := TrafficSelectorsPayload(PayloadTSi, IPv4AnyTrafficSelectors())
	if err != nil {
		t.Fatalf("TrafficSelectorsPayload(TSi) error = %v", err)
	}
	tsrPayload, err := TrafficSelectorsPayload(PayloadTSr, IPv4AnyTrafficSelectors())
	if err != nil {
		t.Fatalf("TrafficSelectorsPayload(TSr) error = %v", err)
	}
	_, ok, err := parseChildSAIfPresent(init, []Payload{saPayload, tsiPayload, tsrPayload}, localSPI, 2, DefaultESPProposal(localSPI), TrafficSelectors{}, TrafficSelectors{})
	if ok || !errors.Is(err, ErrUnsupportedSASelection) {
		t.Fatalf("parseChildSAIfPresent() ok=%t err=%v, want ErrUnsupportedSASelection", ok, err)
	}
}

func TestParseIKEAuthChildSARejectsWidenedTrafficSelector(t *testing.T) {
	init := fakeInitResult(t)
	localSPI := []byte{0xca, 0xfe, 0xba, 0xbe}
	saPayload, err := SecurityAssociationPayload(DefaultESPProposal([]byte{0xde, 0xad, 0xbe, 0xef}))
	if err != nil {
		t.Fatalf("SecurityAssociationPayload() error = %v", err)
	}
	tsiPayload, err := TrafficSelectorsPayload(PayloadTSi, IPv4AnyTrafficSelectors())
	if err != nil {
		t.Fatalf("TrafficSelectorsPayload(TSi) error = %v", err)
	}
	tsrPayload, err := TrafficSelectorsPayload(PayloadTSr, IPv4AnyTrafficSelectors())
	if err != nil {
		t.Fatalf("TrafficSelectorsPayload(TSr) error = %v", err)
	}
	offeredTSi := TrafficSelectors{Selectors: []TrafficSelector{{
		Type:      TSIPv4AddressRange,
		StartPort: 0,
		EndPort:   65535,
		StartAddr: net.IPv4(10, 0, 0, 10),
		EndAddr:   net.IPv4(10, 0, 0, 10),
	}}}
	_, ok, err := parseChildSAIfPresent(init, []Payload{saPayload, tsiPayload, tsrPayload}, localSPI, 2, DefaultESPProposal(localSPI), offeredTSi, IPv4AnyTrafficSelectors())
	if ok || !errors.Is(err, ErrInvalidChildSA) || !errors.Is(err, ErrInvalidTrafficSelector) {
		t.Fatalf("parseChildSAIfPresent() ok=%t err=%v, want ErrInvalidChildSA and ErrInvalidTrafficSelector", ok, err)
	}
}

func fakeInitResult(t *testing.T) InitResult {
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
		NonceI:       bytes.Repeat([]byte{0xa1}, 32),
		NonceR:       bytes.Repeat([]byte{0xb2}, 32),
		SelectedSA:   DefaultIKEProposal(),
		Keys:         keys,
	}
}

type akaProviderStub struct {
	result sim.AKAResult
	err    error
}

func (p akaProviderStub) CalculateAKA(rand16, autn16 []byte) (sim.AKAResult, error) {
	if !bytes.Equal(rand16, bytes.Repeat([]byte{0xa1}, 16)) || !bytes.Equal(autn16, bytes.Repeat([]byte{0xb2}, 16)) {
		return sim.AKAResult{}, errors.New("unexpected RAND/AUTN")
	}
	return p.result, p.err
}

func simAKAResult() sim.AKAResult {
	return sim.AKAResult{
		RES: []byte{0x11, 0x22, 0x33, 0x44},
		CK:  bytes.Repeat([]byte{0xc1}, 16),
		IK:  bytes.Repeat([]byte{0xd2}, 16),
	}
}

func signedAKAChallenge(t *testing.T, identity string, aka sim.AKAResult) eapaka.Packet {
	t.Helper()
	keys, err := eapaka.DeriveKeys(identity, aka)
	if err != nil {
		t.Fatalf("DeriveKeys() error = %v", err)
	}
	challenge := eapaka.Packet{
		Code:       eapaka.CodeRequest,
		Identifier: 10,
		Type:       eapaka.TypeAKA,
		Subtype:    eapaka.SubtypeChallenge,
		Attributes: []eapaka.Attribute{
			eapaka.RANDAttribute(bytes.Repeat([]byte{0xa1}, 16)),
			eapaka.AUTNAttribute(bytes.Repeat([]byte{0xb2}, 16)),
			eapaka.MACAttribute(nil),
		},
	}
	raw, err := challenge.MarshalBinary()
	if err != nil {
		t.Fatalf("MarshalBinary() error = %v", err)
	}
	mac, err := eapaka.CalculateMAC(keys.KAut, raw, nil)
	if err != nil {
		t.Fatalf("CalculateMAC() error = %v", err)
	}
	challenge.Attributes[len(challenge.Attributes)-1] = eapaka.MACAttribute(mac)
	return challenge
}

func signedAKAChallengeWithEncryptedAttrs(t *testing.T, identity string, aka sim.AKAResult, attrs ...eapaka.Attribute) eapaka.Packet {
	t.Helper()
	keys, err := eapaka.DeriveKeys(identity, aka)
	if err != nil {
		t.Fatalf("DeriveKeys() error = %v", err)
	}
	challengeAttrs := []eapaka.Attribute{
		eapaka.RANDAttribute(bytes.Repeat([]byte{0xa1}, 16)),
		eapaka.AUTNAttribute(bytes.Repeat([]byte{0xb2}, 16)),
	}
	challengeAttrs = append(challengeAttrs, attrs...)
	challengeAttrs = append(challengeAttrs, eapaka.MACAttribute(nil))
	challenge := eapaka.Packet{
		Code:       eapaka.CodeRequest,
		Identifier: 10,
		Type:       eapaka.TypeAKA,
		Subtype:    eapaka.SubtypeChallenge,
		Attributes: challengeAttrs,
	}
	raw, err := challenge.MarshalBinary()
	if err != nil {
		t.Fatalf("MarshalBinary() error = %v", err)
	}
	mac, err := eapaka.CalculateMAC(keys.KAut, raw, nil)
	if err != nil {
		t.Fatalf("CalculateMAC() error = %v", err)
	}
	challenge.Attributes[len(challenge.Attributes)-1] = eapaka.MACAttribute(mac)
	return challenge
}

func signedAKAChallengeWithCheckcode(t *testing.T, identity string, aka sim.AKAResult, transcript [][]byte) eapaka.Packet {
	t.Helper()
	keys, err := eapaka.DeriveKeys(identity, aka)
	if err != nil {
		t.Fatalf("DeriveKeys() error = %v", err)
	}
	challenge := eapaka.Packet{
		Code:       eapaka.CodeRequest,
		Identifier: 10,
		Type:       eapaka.TypeAKA,
		Subtype:    eapaka.SubtypeChallenge,
		Attributes: []eapaka.Attribute{
			eapaka.RANDAttribute(bytes.Repeat([]byte{0xa1}, 16)),
			eapaka.AUTNAttribute(bytes.Repeat([]byte{0xb2}, 16)),
			eapaka.CheckcodeAttributeForPackets(transcript),
			eapaka.ResultIndAttribute(),
			eapaka.MACAttribute(nil),
		},
	}
	raw, err := challenge.MarshalBinary()
	if err != nil {
		t.Fatalf("MarshalBinary() error = %v", err)
	}
	mac, err := eapaka.CalculateMAC(keys.KAut, raw, nil)
	if err != nil {
		t.Fatalf("CalculateMAC() error = %v", err)
	}
	challenge.Attributes[len(challenge.Attributes)-1] = eapaka.MACAttribute(mac)
	return challenge
}

func signedAKANotification(t *testing.T, identifier uint8, keys eapaka.Keys, code uint16) eapaka.Packet {
	t.Helper()
	notification := eapaka.Packet{
		Code:       eapaka.CodeRequest,
		Identifier: identifier,
		Type:       eapaka.TypeAKA,
		Subtype:    eapaka.SubtypeNotification,
		Attributes: []eapaka.Attribute{
			eapaka.NotificationAttribute(code),
			eapaka.MACAttribute(nil),
		},
	}
	raw, err := notification.MarshalBinary()
	if err != nil {
		t.Fatalf("MarshalBinary() error = %v", err)
	}
	mac, err := eapaka.CalculateMAC(keys.KAut, raw, nil)
	if err != nil {
		t.Fatalf("CalculateMAC() error = %v", err)
	}
	notification.Attributes[len(notification.Attributes)-1] = eapaka.MACAttribute(mac)
	return notification
}

func signedAKAReauthenticationRequest(t *testing.T, eapType uint8, keys eapaka.Keys, counter uint16, nonceS []byte, encryptedExtra, topLevelExtra []eapaka.Attribute) eapaka.Packet {
	t.Helper()
	iv := bytes.Repeat([]byte{0x56}, 16)
	encryptedAttrs := []eapaka.Attribute{
		eapaka.CounterAttribute(counter),
		eapaka.NonceSAttribute(nonceS),
	}
	encryptedAttrs = append(encryptedAttrs, encryptedExtra...)
	encrypted, err := eapaka.EncryptAttributes(keys.KEncr, iv, encryptedAttrs)
	if err != nil {
		t.Fatalf("EncryptAttributes() error = %v", err)
	}
	attrs := []eapaka.Attribute{
		eapaka.IVAttribute(iv),
		encrypted,
	}
	attrs = append(attrs, topLevelExtra...)
	attrs = append(attrs, eapaka.MACAttribute(nil))
	request := eapaka.Packet{
		Code:       eapaka.CodeRequest,
		Identifier: 19,
		Type:       eapType,
		Subtype:    eapaka.SubtypeReauthentication,
		Attributes: attrs,
	}
	raw, err := request.MarshalBinary()
	if err != nil {
		t.Fatalf("MarshalBinary() error = %v", err)
	}
	var mac []byte
	if eapType == eapaka.TypeAKAPrime {
		mac, err = eapaka.CalculateAKAPrimeMAC(keys.KAut, raw, nil)
	} else {
		mac, err = eapaka.CalculateMAC(keys.KAut, raw, nil)
	}
	if err != nil {
		t.Fatalf("CalculateMAC() error = %v", err)
	}
	request.Attributes[len(request.Attributes)-1] = eapaka.MACAttribute(mac)
	return request
}

func decryptedAKAReauthenticationResponseAttrs(t *testing.T, keys eapaka.Keys, packet eapaka.Packet) []eapaka.Attribute {
	t.Helper()
	ivAttr, ok := eapaka.FindAttribute(packet.Attributes, eapaka.AttributeIV)
	if !ok {
		t.Fatal("missing AT_IV")
	}
	encryptedAttr, ok := eapaka.FindAttribute(packet.Attributes, eapaka.AttributeEncrData)
	if !ok {
		t.Fatal("missing AT_ENCR_DATA")
	}
	attrs, err := eapaka.DecryptEncryptedAttributes(keys.KEncr, ivAttr, encryptedAttr)
	if err != nil {
		t.Fatalf("DecryptEncryptedAttributes() error = %v", err)
	}
	return attrs
}

func signedAKAPrimeChallenge(t *testing.T, identity, networkName string, aka sim.AKAResult) eapaka.Packet {
	t.Helper()
	autn := bytes.Repeat([]byte{0xb2}, 16)
	keys, err := eapaka.DeriveAKAPrimeKeys(identity, networkName, autn, aka)
	if err != nil {
		t.Fatalf("DeriveAKAPrimeKeys() error = %v", err)
	}
	challenge := eapaka.Packet{
		Code:       eapaka.CodeRequest,
		Identifier: 11,
		Type:       eapaka.TypeAKAPrime,
		Subtype:    eapaka.SubtypeChallenge,
		Attributes: []eapaka.Attribute{
			eapaka.RANDAttribute(bytes.Repeat([]byte{0xa1}, 16)),
			eapaka.AUTNAttribute(autn),
			eapaka.KDFInputAttribute(networkName),
			eapaka.KDFAttribute(eapaka.AKAPrimeKDFDefault),
			eapaka.MACAttribute(nil),
		},
	}
	raw, err := challenge.MarshalBinary()
	if err != nil {
		t.Fatalf("MarshalBinary() error = %v", err)
	}
	mac, err := eapaka.CalculateAKAPrimeMAC(keys.KAut, raw, nil)
	if err != nil {
		t.Fatalf("CalculateAKAPrimeMAC() error = %v", err)
	}
	challenge.Attributes[len(challenge.Attributes)-1] = eapaka.MACAttribute(mac)
	return challenge
}

func authSuccessChildPayloads(t *testing.T, identifier uint8, remoteSPI []byte) ([]Payload, error) {
	t.Helper()
	success, err := (eapaka.Packet{Code: eapaka.CodeSuccess, Identifier: identifier}).MarshalBinary()
	if err != nil {
		return nil, err
	}
	saPayload, err := SecurityAssociationPayload(DefaultESPProposal(remoteSPI))
	if err != nil {
		return nil, err
	}
	tsiPayload, err := TrafficSelectorsPayload(PayloadTSi, IPv4AnyTrafficSelectors())
	if err != nil {
		return nil, err
	}
	tsrPayload, err := TrafficSelectorsPayload(PayloadTSr, IPv4AnyTrafficSelectors())
	if err != nil {
		return nil, err
	}
	cpPayload, err := ConfigurationPayload(Configuration{Type: CFGReply, Attributes: []ConfigurationAttribute{{Type: ConfigInternalIPv4Address, Value: []byte{10, 0, 0, 2}}}})
	if err != nil {
		return nil, err
	}
	return []Payload{EAPPayload(success), saPayload, tsiPayload, tsrPayload, cpPayload}, nil
}

func parseTestEAP(t *testing.T, raw []byte) eapaka.Packet {
	t.Helper()
	packet, err := eapaka.ParsePacket(raw)
	if err != nil {
		t.Fatalf("ParsePacket() error = %v", err)
	}
	return packet
}

func gotTypes(payloads []Payload) []byte {
	out := make([]byte, len(payloads))
	for i, p := range payloads {
		out[i] = p.Type
	}
	return out
}
