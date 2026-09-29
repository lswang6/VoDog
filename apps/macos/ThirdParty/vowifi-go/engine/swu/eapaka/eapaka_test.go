package eapaka

import (
	"encoding/hex"
	"errors"
	"testing"
)

func TestIdentityResponseMarshalParse(t *testing.T) {
	raw, err := (Packet{
		Code:       CodeResponse,
		Identifier: 7,
		Type:       TypeAKA,
		Subtype:    SubtypeIdentity,
		Attributes: []Attribute{IdentityAttribute("310280000000001")},
	}).MarshalBinary()
	if err != nil {
		t.Fatalf("MarshalBinary() error = %v", err)
	}
	want := "0207001c170500000e05000f33313032383030303030303030303100"
	if hex.EncodeToString(raw) != want {
		t.Fatalf("packet=%x, want %s", raw, want)
	}
	parsed, err := ParsePacket(raw)
	if err != nil {
		t.Fatalf("ParsePacket() error = %v", err)
	}
	if parsed.Code != CodeResponse || parsed.Type != TypeAKA || parsed.Subtype != SubtypeIdentity || len(parsed.Attributes) != 1 {
		t.Fatalf("parsed=%+v", parsed)
	}
	if parsed.Attributes[0].Type != AttributeIdentity {
		t.Fatalf("attr=%+v", parsed.Attributes[0])
	}
	identity, err := parsed.Attributes[0].IdentityValue()
	if err != nil {
		t.Fatalf("IdentityValue() error = %v", err)
	}
	if identity != "310280000000001" {
		t.Fatalf("identity=%q", identity)
	}
}

func TestChallengeResponseAttributes(t *testing.T) {
	raw, err := (Packet{
		Code:       CodeResponse,
		Identifier: 9,
		Type:       TypeAKA,
		Subtype:    SubtypeChallenge,
		Attributes: []Attribute{
			RESAttribute([]byte{0x11, 0x22, 0x33, 0x44}),
			FixedAttribute(AttributeMAC, make([]byte, 16)),
		},
	}).MarshalBinary()
	if err != nil {
		t.Fatalf("MarshalBinary() error = %v", err)
	}
	parsed, err := ParsePacket(raw)
	if err != nil {
		t.Fatalf("ParsePacket() error = %v", err)
	}
	if parsed.Subtype != SubtypeChallenge || len(parsed.Attributes) != 2 {
		t.Fatalf("parsed=%+v", parsed)
	}
	res, bits, err := parsed.Attributes[0].RESValue()
	if err != nil {
		t.Fatalf("RESValue() error = %v", err)
	}
	if bits != 32 || hex.EncodeToString(res) != "11223344" {
		t.Fatalf("RES bits=%d value=%x", bits, res)
	}
	mac, err := parsed.Attributes[1].FixedValue(16)
	if err != nil {
		t.Fatalf("FixedValue() error = %v", err)
	}
	if hex.EncodeToString(mac) != "00000000000000000000000000000000" {
		t.Fatalf("MAC=%x", mac)
	}
}

func TestAKAPrimeKDFAttributes(t *testing.T) {
	raw, err := (Packet{
		Code:       CodeResponse,
		Identifier: 10,
		Type:       TypeAKAPrime,
		Subtype:    SubtypeChallenge,
		Attributes: []Attribute{
			KDFInputAttribute("WLAN"),
			KDFAttribute(1),
		},
	}).MarshalBinary()
	if err != nil {
		t.Fatalf("MarshalBinary() error = %v", err)
	}
	parsed, err := ParsePacket(raw)
	if err != nil {
		t.Fatalf("ParsePacket() error = %v", err)
	}
	if parsed.Type != TypeAKAPrime || parsed.Attributes[0].Type != AttributeKDFInput || parsed.Attributes[1].Type != AttributeKDF {
		t.Fatalf("parsed=%+v", parsed)
	}
	if len(parsed.Attributes[1].Data) != 2 {
		t.Fatalf("AT_KDF data length=%d, want 2", len(parsed.Attributes[1].Data))
	}
	kdf, err := parsed.Attributes[1].KDFValue()
	if err != nil {
		t.Fatalf("KDFValue() error = %v", err)
	}
	if kdf != 1 {
		t.Fatalf("AT_KDF=%d", kdf)
	}
	networkName, err := parsed.Attributes[0].VariableValue()
	if err != nil {
		t.Fatalf("VariableValue() error = %v", err)
	}
	if string(networkName) != "WLAN" {
		t.Fatalf("networkName=%q", string(networkName))
	}
}

func TestNotificationAndClientErrorAttributes(t *testing.T) {
	raw, err := (Packet{
		Code:       CodeRequest,
		Identifier: 13,
		Type:       TypeAKA,
		Subtype:    SubtypeNotification,
		Attributes: []Attribute{NotificationAttribute(NotificationGeneralFailureBeforeAuthentication)},
	}).MarshalBinary()
	if err != nil {
		t.Fatalf("MarshalBinary(notification) error = %v", err)
	}
	want := "010d000c170c00000c014000"
	if hex.EncodeToString(raw) != want {
		t.Fatalf("notification packet=%x, want %s", raw, want)
	}
	parsed, err := ParsePacket(raw)
	if err != nil {
		t.Fatalf("ParsePacket(notification) error = %v", err)
	}
	attr, ok := FindAttribute(parsed.Attributes, AttributeNotification)
	if !ok {
		t.Fatal("missing AT_NOTIFICATION")
	}
	code, err := attr.NotificationValue()
	if err != nil {
		t.Fatalf("NotificationValue() error = %v", err)
	}
	if code != NotificationGeneralFailureBeforeAuthentication {
		t.Fatalf("notification code=%d", code)
	}

	raw, err = (Packet{
		Code:       CodeResponse,
		Identifier: 14,
		Type:       TypeAKA,
		Subtype:    SubtypeClientError,
		Attributes: []Attribute{ClientErrorCodeAttribute(ClientErrorUnableToProcessPacket)},
	}).MarshalBinary()
	if err != nil {
		t.Fatalf("MarshalBinary(client-error) error = %v", err)
	}
	want = "020e000c170e000016010000"
	if hex.EncodeToString(raw) != want {
		t.Fatalf("client-error packet=%x, want %s", raw, want)
	}
	parsed, err = ParsePacket(raw)
	if err != nil {
		t.Fatalf("ParsePacket(client-error) error = %v", err)
	}
	attr, ok = FindAttribute(parsed.Attributes, AttributeClientErrorCode)
	if !ok {
		t.Fatal("missing AT_CLIENT_ERROR_CODE")
	}
	clientError, err := attr.ClientErrorCodeValue()
	if err != nil {
		t.Fatalf("ClientErrorCodeValue() error = %v", err)
	}
	if clientError != ClientErrorUnableToProcessPacket {
		t.Fatalf("client error=%d", clientError)
	}
}

func TestTypedControlAttributeExtraction(t *testing.T) {
	packets := [][]byte{
		{CodeRequest, 1, 0, 8, TypeAKA, SubtypeIdentity, 0, 0},
		{CodeResponse, 1, 0, 8, TypeAKA, SubtypeIdentity, 0, 0},
	}
	attrs := []Attribute{
		NotificationAttribute(NotificationSuccess | 0x0025),
		ClientErrorCodeAttribute(ClientErrorRANDNotFresh),
		CounterTooSmallAttribute(),
		CheckcodeAttributeForPackets(packets),
		ResultIndAttribute(),
	}

	notification, ok, err := NotificationFromAttributes(attrs)
	if err != nil {
		t.Fatalf("NotificationFromAttributes() error = %v", err)
	}
	if !ok || notification.Value != NotificationSuccess|0x0025 || notification.Code != 0x0025 || !notification.Success || notification.BeforeAuthentication {
		t.Fatalf("notification ok=%t info=%+v", ok, notification)
	}
	clientError, ok, err := ClientErrorCodeFromAttributes(attrs)
	if err != nil {
		t.Fatalf("ClientErrorCodeFromAttributes() error = %v", err)
	}
	if !ok || clientError != ClientErrorRANDNotFresh {
		t.Fatalf("client error ok=%t code=%d", ok, clientError)
	}
	counterTooSmall, err := CounterTooSmallFromAttributes(attrs)
	if err != nil {
		t.Fatalf("CounterTooSmallFromAttributes() error = %v", err)
	}
	if !counterTooSmall {
		t.Fatal("CounterTooSmallFromAttributes() = false, want true")
	}
	checkcode, ok, err := CheckcodeFromAttributes(attrs)
	if err != nil {
		t.Fatalf("CheckcodeFromAttributes() error = %v", err)
	}
	if !ok || len(checkcode) != 20 {
		t.Fatalf("checkcode ok=%t value=%x", ok, checkcode)
	}
	checkcode[0] ^= 0xff
	again, ok, err := CheckcodeFromAttributes(attrs)
	if err != nil {
		t.Fatalf("CheckcodeFromAttributes(again) error = %v", err)
	}
	if !ok || again[0] == checkcode[0] {
		t.Fatalf("checkcode was not cloned: first=%x again=%x", checkcode, again)
	}
	resultInd, err := ResultIndFromAttributes(attrs)
	if err != nil {
		t.Fatalf("ResultIndFromAttributes() error = %v", err)
	}
	if !resultInd {
		t.Fatal("ResultIndFromAttributes() = false, want true")
	}
}

func TestTypedControlPacketParsing(t *testing.T) {
	notification, err := ParseNotificationRequest(Packet{
		Code:       CodeRequest,
		Identifier: 3,
		Type:       TypeAKAPrime,
		Subtype:    SubtypeNotification,
		Attributes: []Attribute{NotificationAttribute(NotificationGeneralFailureBeforeAuthentication)},
	})
	if err != nil {
		t.Fatalf("ParseNotificationRequest() error = %v", err)
	}
	if notification.Value != NotificationGeneralFailureBeforeAuthentication || !notification.BeforeAuthentication || notification.Success {
		t.Fatalf("notification=%+v", notification)
	}

	clientError, err := ParseClientErrorResponse(Packet{
		Code:       CodeResponse,
		Identifier: 4,
		Type:       TypeAKA,
		Subtype:    SubtypeClientError,
		Attributes: []Attribute{ClientErrorCodeAttribute(ClientErrorInsufficientChallenges)},
	})
	if err != nil {
		t.Fatalf("ParseClientErrorResponse() error = %v", err)
	}
	if clientError != ClientErrorInsufficientChallenges {
		t.Fatalf("client error=%d", clientError)
	}
}

func TestSynchronizationFailureParsingAndRecoveryClassification(t *testing.T) {
	auts := mustHex(t, "010203040506a1a2a3a4a5a6a7a8")
	response := Packet{
		Code:       CodeResponse,
		Identifier: 8,
		Type:       TypeAKAPrime,
		Subtype:    SubtypeSynchronizationFailure,
		Attributes: []Attribute{AUTSAttribute(auts), KDFAttribute(AKAPrimeKDFDefault)},
	}

	info, err := ParseSynchronizationFailureResponse(response)
	if err != nil {
		t.Fatalf("ParseSynchronizationFailureResponse() error = %v", err)
	}
	if hex.EncodeToString(info.AUTS) != "010203040506a1a2a3a4a5a6a7a8" {
		t.Fatalf("AUTS=%x", info.AUTS)
	}
	if hex.EncodeToString(info.AUTSFields.SQNMSXorAK) != "010203040506" || hex.EncodeToString(info.AUTSFields.MACS) != "a1a2a3a4a5a6a7a8" {
		t.Fatalf("AUTS fields=%+v", info.AUTSFields)
	}
	if len(info.KDFValues) != 1 || info.KDFValues[0] != AKAPrimeKDFDefault {
		t.Fatalf("KDF values=%v", info.KDFValues)
	}

	info.AUTS[0] = 0xff
	decision, ok, err := ClassifyAKARecoveryPacket(response)
	if err != nil {
		t.Fatalf("ClassifyAKARecoveryPacket() error = %v", err)
	}
	if !ok || decision.Action != AKARecoveryResync || !decision.SyncFailure || decision.AuthFailure || decision.ClientError {
		t.Fatalf("decision ok=%t value=%+v", ok, decision)
	}
	if hex.EncodeToString(decision.SyncInfo.AUTS) != "010203040506a1a2a3a4a5a6a7a8" {
		t.Fatalf("classified AUTS was not cloned: %x", decision.SyncInfo.AUTS)
	}
}

func TestClassifyAKARecoveryPacketActions(t *testing.T) {
	tests := []struct {
		name       string
		packet     Packet
		ok         bool
		action     AKARecoveryAction
		auth       bool
		client     bool
		clientCode uint16
	}{
		{
			name:   "terminal failure",
			packet: Packet{Code: CodeFailure},
			ok:     true,
			action: AKARecoveryFail,
		},
		{
			name: "authentication reject",
			packet: Packet{
				Code:    CodeResponse,
				Type:    TypeAKA,
				Subtype: SubtypeAuthenticationReject,
			},
			ok:     true,
			action: AKARecoveryFail,
			auth:   true,
		},
		{
			name: "rand not fresh retries",
			packet: Packet{
				Code:       CodeResponse,
				Type:       TypeAKA,
				Subtype:    SubtypeClientError,
				Attributes: []Attribute{ClientErrorCodeAttribute(ClientErrorRANDNotFresh)},
			},
			ok:         true,
			action:     AKARecoveryRetry,
			client:     true,
			clientCode: ClientErrorRANDNotFresh,
		},
		{
			name: "insufficient challenges retries",
			packet: Packet{
				Code:       CodeResponse,
				Type:       TypeAKA,
				Subtype:    SubtypeClientError,
				Attributes: []Attribute{ClientErrorCodeAttribute(ClientErrorInsufficientChallenges)},
			},
			ok:         true,
			action:     AKARecoveryRetry,
			client:     true,
			clientCode: ClientErrorInsufficientChallenges,
		},
		{
			name: "unsupported version fails",
			packet: Packet{
				Code:       CodeResponse,
				Type:       TypeAKA,
				Subtype:    SubtypeClientError,
				Attributes: []Attribute{ClientErrorCodeAttribute(ClientErrorUnsupportedVersion)},
			},
			ok:         true,
			action:     AKARecoveryFail,
			client:     true,
			clientCode: ClientErrorUnsupportedVersion,
		},
		{
			name: "unrelated response",
			packet: Packet{
				Code:    CodeResponse,
				Type:    TypeAKA,
				Subtype: SubtypeChallenge,
			},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, ok, err := ClassifyAKARecoveryPacket(tt.packet)
			if err != nil {
				t.Fatalf("ClassifyAKARecoveryPacket() error = %v", err)
			}
			if ok != tt.ok {
				t.Fatalf("ok=%t, want %t", ok, tt.ok)
			}
			if !tt.ok {
				return
			}
			if got.Action != tt.action || got.AuthFailure != tt.auth || got.ClientError != tt.client || got.ClientErrorCode != tt.clientCode {
				t.Fatalf("decision=%+v", got)
			}
		})
	}
}

func TestParseSynchronizationFailureResponseRejectsInvalidAttributes(t *testing.T) {
	response := Packet{
		Code:    CodeResponse,
		Type:    TypeAKA,
		Subtype: SubtypeSynchronizationFailure,
	}
	if _, err := ParseSynchronizationFailureResponse(response); !errors.Is(err, ErrInvalidAttribute) {
		t.Fatalf("ParseSynchronizationFailureResponse(missing AUTS) err=%v, want ErrInvalidAttribute", err)
	}

	auts := mustHex(t, "010203040506a1a2a3a4a5a6a7a8")
	response.Attributes = []Attribute{AUTSAttribute(auts), AUTSAttribute(auts)}
	if _, err := ParseSynchronizationFailureResponse(response); !errors.Is(err, ErrInvalidAttribute) {
		t.Fatalf("ParseSynchronizationFailureResponse(duplicate AUTS) err=%v, want ErrInvalidAttribute", err)
	}

	response.Attributes = []Attribute{AUTSAttribute(auts[:13])}
	if _, err := ParseSynchronizationFailureResponse(response); !errors.Is(err, ErrInvalidAttribute) {
		t.Fatalf("ParseSynchronizationFailureResponse(short AUTS) err=%v, want ErrInvalidAttribute", err)
	}

	response.Type = TypeAKAPrime
	response.Attributes = []Attribute{AUTSAttribute(auts)}
	if _, err := ParseSynchronizationFailureResponse(response); !errors.Is(err, ErrInvalidAttribute) {
		t.Fatalf("ParseSynchronizationFailureResponse(missing AKA' KDF) err=%v, want ErrInvalidAttribute", err)
	}

	response.Type = 99
	if _, _, err := ClassifyAKARecoveryPacket(response); !errors.Is(err, ErrInvalidPacket) {
		t.Fatalf("ClassifyAKARecoveryPacket(bad type) err=%v, want ErrInvalidPacket", err)
	}
}

func TestTypedControlExtractionRejectsInvalidAttributes(t *testing.T) {
	if _, _, err := NotificationFromAttributes([]Attribute{
		NotificationAttribute(NotificationSuccess),
		NotificationAttribute(NotificationGeneralFailureBeforeAuthentication),
	}); !errors.Is(err, ErrInvalidAttribute) {
		t.Fatalf("NotificationFromAttributes(duplicate) err=%v, want ErrInvalidAttribute", err)
	}
	if _, err := ResultIndFromAttributes([]Attribute{{Type: AttributeResultInd, Data: []byte{0, 1}}}); !errors.Is(err, ErrInvalidAttribute) {
		t.Fatalf("ResultIndFromAttributes(invalid) err=%v, want ErrInvalidAttribute", err)
	}
	if _, err := CounterTooSmallFromAttributes([]Attribute{{Type: AttributeCounterTooSmall, Data: []byte{1, 0}}}); !errors.Is(err, ErrInvalidAttribute) {
		t.Fatalf("CounterTooSmallFromAttributes(invalid) err=%v, want ErrInvalidAttribute", err)
	}
	if _, err := ParseClientErrorResponse(Packet{
		Code:       CodeResponse,
		Type:       99,
		Subtype:    SubtypeClientError,
		Attributes: []Attribute{ClientErrorCodeAttribute(ClientErrorUnableToProcessPacket)},
	}); !errors.Is(err, ErrInvalidPacket) {
		t.Fatalf("ParseClientErrorResponse(bad type) err=%v, want ErrInvalidPacket", err)
	}
}

func TestVersionAttributes(t *testing.T) {
	raw, err := MarshalAttributes([]Attribute{
		VersionListAttribute(2, SupportedVersion),
		SelectedVersionAttribute(SupportedVersion),
	})
	if err != nil {
		t.Fatalf("MarshalAttributes() error = %v", err)
	}
	attrs, err := ParseAttributes(raw)
	if err != nil {
		t.Fatalf("ParseAttributes() error = %v", err)
	}
	versions, err := attrs[0].VersionListValue()
	if err != nil {
		t.Fatalf("VersionListValue() error = %v", err)
	}
	if len(versions) != 2 || versions[0] != 2 || versions[1] != SupportedVersion {
		t.Fatalf("versions=%v", versions)
	}
	selected, err := attrs[1].SelectedVersionValue()
	if err != nil {
		t.Fatalf("SelectedVersionValue() error = %v", err)
	}
	if selected != SupportedVersion {
		t.Fatalf("selected=%d", selected)
	}
}

func TestBiddingAttribute(t *testing.T) {
	for _, tc := range []struct {
		name               string
		preferAKAPrime     bool
		want               string
		wantPreferAKAPrime bool
	}{
		{
			name:               "prefer AKA prime",
			preferAKAPrime:     true,
			want:               "88018000",
			wantPreferAKAPrime: true,
		},
		{
			name:               "no preference",
			preferAKAPrime:     false,
			want:               "88010000",
			wantPreferAKAPrime: false,
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			raw, err := BiddingAttribute(tc.preferAKAPrime).MarshalBinary()
			if err != nil {
				t.Fatalf("MarshalBinary() error = %v", err)
			}
			if hex.EncodeToString(raw) != tc.want {
				t.Fatalf("AT_BIDDING=%x, want %s", raw, tc.want)
			}
			attrs, err := ParseAttributes(raw)
			if err != nil {
				t.Fatalf("ParseAttributes() error = %v", err)
			}
			got, err := attrs[0].BiddingValue()
			if err != nil {
				t.Fatalf("BiddingValue() error = %v", err)
			}
			if got != tc.wantPreferAKAPrime {
				t.Fatalf("prefer AKA'=%t, want %t", got, tc.wantPreferAKAPrime)
			}
		})
	}
}

func TestCheckcodeAttribute(t *testing.T) {
	packets := [][]byte{
		{CodeRequest, 1, 0, 8, TypeAKA, SubtypeIdentity, 0, 0},
		{CodeResponse, 1, 0, 8, TypeAKA, SubtypeIdentity, 0, 0},
	}
	attr := CheckcodeAttributeForPackets(packets)
	value, err := attr.CheckcodeValue()
	if err != nil {
		t.Fatalf("CheckcodeValue() error = %v", err)
	}
	if len(value) != 20 {
		t.Fatalf("checkcode length=%d, want 20", len(value))
	}
	if err := VerifyCheckcodeAttribute(attr, packets); err != nil {
		t.Fatalf("VerifyCheckcodeAttribute() error = %v", err)
	}
	if err := VerifyCheckcodeAttribute(attr, [][]byte{packets[1], packets[0]}); !errors.Is(err, ErrInvalidCheckcode) {
		t.Fatalf("VerifyCheckcodeAttribute(reordered) err=%v, want ErrInvalidCheckcode", err)
	}

	empty := CheckcodeAttributeForPackets(nil)
	if value, err := empty.CheckcodeValue(); err != nil || len(value) != 0 {
		t.Fatalf("empty CheckcodeValue() value=%x err=%v", value, err)
	}
	if err := VerifyCheckcodeAttribute(empty, nil); err != nil {
		t.Fatalf("VerifyCheckcodeAttribute(empty) error = %v", err)
	}
}

func TestResultIndAttribute(t *testing.T) {
	attr := ResultIndAttribute()
	if attr.Type != AttributeResultInd {
		t.Fatalf("type=%d, want AT_RESULT_IND", attr.Type)
	}
	if len(attr.Data) != 2 || attr.Data[0] != 0 || attr.Data[1] != 0 {
		t.Fatalf("data=%x, want reserved zero bytes", attr.Data)
	}
	raw, err := attr.MarshalBinary()
	if err != nil {
		t.Fatalf("MarshalBinary() error = %v", err)
	}
	want := "87010000"
	if hex.EncodeToString(raw) != want {
		t.Fatalf("AT_RESULT_IND=%x, want %s", raw, want)
	}
}

func TestIdentityStateFromAttributes(t *testing.T) {
	state, err := IdentityStateFromAttributes([]Attribute{
		NextPseudonymAttribute("pseudo-1"),
		NextReauthIDAttribute("reauth-1"),
		ResultIndAttribute(),
	})
	if err != nil {
		t.Fatalf("IdentityStateFromAttributes() error = %v", err)
	}
	if state.NextPseudonym != "pseudo-1" || state.NextReauthID != "reauth-1" {
		t.Fatalf("state=%+v", state)
	}
}

func TestReauthenticationAttributes(t *testing.T) {
	raw, err := MarshalAttributes([]Attribute{
		CounterAttribute(7),
		CounterTooSmallAttribute(),
		NonceSAttribute([]byte("1234567890abcdef")),
	})
	if err != nil {
		t.Fatalf("MarshalAttributes() error = %v", err)
	}
	want := "13010007140100001505000031323334353637383930616263646566"
	if hex.EncodeToString(raw) != want {
		t.Fatalf("reauth attrs=%x, want %s", raw, want)
	}
	attrs, err := ParseAttributes(raw)
	if err != nil {
		t.Fatalf("ParseAttributes() error = %v", err)
	}
	counter, err := attrs[0].CounterValue()
	if err != nil {
		t.Fatalf("CounterValue() error = %v", err)
	}
	if counter != 7 {
		t.Fatalf("counter=%d", counter)
	}
	if err := attrs[1].CounterTooSmallValue(); err != nil {
		t.Fatalf("CounterTooSmallValue() error = %v", err)
	}
	nonce, err := attrs[2].NonceSValue()
	if err != nil {
		t.Fatalf("NonceSValue() error = %v", err)
	}
	if string(nonce) != "1234567890abcdef" {
		t.Fatalf("nonce_s=%q", string(nonce))
	}
}

func TestReauthenticationAttributeExtraction(t *testing.T) {
	attrs := []Attribute{
		CounterAttribute(9),
		NonceSAttribute([]byte("fedcba9876543210")),
	}
	counter, ok, err := CounterFromAttributes(attrs)
	if err != nil {
		t.Fatalf("CounterFromAttributes() error = %v", err)
	}
	if !ok || counter != 9 {
		t.Fatalf("counter ok=%t value=%d", ok, counter)
	}
	nonceS, ok, err := NonceSFromAttributes(attrs)
	if err != nil {
		t.Fatalf("NonceSFromAttributes() error = %v", err)
	}
	if !ok || string(nonceS) != "fedcba9876543210" {
		t.Fatalf("nonce_s ok=%t value=%q", ok, string(nonceS))
	}
	nonceS[0] = 'x'
	again, ok, err := NonceSFromAttributes(attrs)
	if err != nil {
		t.Fatalf("NonceSFromAttributes(again) error = %v", err)
	}
	if !ok || string(again) != "fedcba9876543210" {
		t.Fatalf("nonce_s was not cloned: ok=%t value=%q", ok, string(again))
	}
	if _, ok, err := CounterFromAttributes(nil); err != nil || ok {
		t.Fatalf("CounterFromAttributes(nil) ok=%t err=%v, want missing nil error", ok, err)
	}
	if _, _, err := CounterFromAttributes([]Attribute{CounterAttribute(1), CounterAttribute(2)}); !errors.Is(err, ErrInvalidAttribute) {
		t.Fatalf("CounterFromAttributes(duplicate) err=%v, want ErrInvalidAttribute", err)
	}
	if _, _, err := NonceSFromAttributes([]Attribute{NonceSAttribute([]byte("short"))}); !errors.Is(err, ErrInvalidAttribute) {
		t.Fatalf("NonceSFromAttributes(short) err=%v, want ErrInvalidAttribute", err)
	}
	if _, _, err := NonceSFromAttributes([]Attribute{
		NonceSAttribute([]byte("fedcba9876543210")),
		NonceSAttribute([]byte("0123456789abcdef")),
	}); !errors.Is(err, ErrInvalidAttribute) {
		t.Fatalf("NonceSFromAttributes(duplicate) err=%v, want ErrInvalidAttribute", err)
	}
}

func TestAKAChallengeAttributes(t *testing.T) {
	raw, err := (Packet{
		Code:       CodeRequest,
		Identifier: 11,
		Type:       TypeAKA,
		Subtype:    SubtypeChallenge,
		Attributes: []Attribute{
			RANDAttribute([]byte("1234567890abcdef")),
			AUTNAttribute([]byte("fedcba0987654321")),
			FullAuthIDReqAttribute(),
		},
	}).MarshalBinary()
	if err != nil {
		t.Fatalf("MarshalBinary() error = %v", err)
	}
	parsed, err := ParsePacket(raw)
	if err != nil {
		t.Fatalf("ParsePacket() error = %v", err)
	}
	randAttr, ok := FindAttribute(parsed.Attributes, AttributeRAND)
	if !ok {
		t.Fatal("missing AT_RAND")
	}
	rands, err := randAttr.RANDValues()
	if err != nil {
		t.Fatalf("RANDValues() error = %v", err)
	}
	if len(rands) != 1 || string(rands[0]) != "1234567890abcdef" {
		t.Fatalf("RAND=%q", rands)
	}
	autnAttr, ok := FindAttribute(parsed.Attributes, AttributeAUTN)
	if !ok {
		t.Fatal("missing AT_AUTN")
	}
	autn, err := autnAttr.AUTNValue()
	if err != nil {
		t.Fatalf("AUTNValue() error = %v", err)
	}
	if string(autn) != "fedcba0987654321" {
		t.Fatalf("AUTN=%q", string(autn))
	}
	if _, ok := FindAttribute(parsed.Attributes, AttributeFullAuthIDReq); !ok {
		t.Fatal("missing AT_FULLAUTH_ID_REQ")
	}
}

func TestAUTNFields(t *testing.T) {
	autn := mustHex(t, "0102030405068000a1a2a3a4a5a6a7a8")
	fields, err := ParseAUTN(autn)
	if err != nil {
		t.Fatalf("ParseAUTN() error = %v", err)
	}
	if hex.EncodeToString(fields.SQNXorAK) != "010203040506" {
		t.Fatalf("SQN xor AK=%x", fields.SQNXorAK)
	}
	if hex.EncodeToString(fields.AMF) != "8000" {
		t.Fatalf("AMF=%x", fields.AMF)
	}
	if hex.EncodeToString(fields.MAC) != "a1a2a3a4a5a6a7a8" {
		t.Fatalf("MAC-A=%x", fields.MAC)
	}
	sqn, err := fields.SQN(mustHex(t, "010101010101"))
	if err != nil {
		t.Fatalf("SQN() error = %v", err)
	}
	if hex.EncodeToString(sqn) != "000302050407" {
		t.Fatalf("SQN=%x", sqn)
	}
	attrFields, err := AUTNAttribute(autn).AUTNFields()
	if err != nil {
		t.Fatalf("AUTNFields() error = %v", err)
	}
	if hex.EncodeToString(attrFields.MAC) != "a1a2a3a4a5a6a7a8" {
		t.Fatalf("attribute AUTN MAC-A=%x", attrFields.MAC)
	}
	if _, err := ParseAUTN(autn[:15]); !errors.Is(err, ErrInvalidAttribute) {
		t.Fatalf("ParseAUTN(short) err=%v, want ErrInvalidAttribute", err)
	}
	if _, err := fields.SQN([]byte{0x01}); !errors.Is(err, ErrInvalidAttribute) {
		t.Fatalf("SQN(short AK) err=%v, want ErrInvalidAttribute", err)
	}
}

func TestAKAAttributeBoundaryValidation(t *testing.T) {
	resAttr := RESAttribute([]byte{0x11, 0x22, 0x33, 0x44, 0x55})
	raw, err := resAttr.MarshalBinary()
	if err != nil {
		t.Fatalf("MarshalBinary(AT_RES) error = %v", err)
	}
	attrs, err := ParseAttributes(raw)
	if err != nil {
		t.Fatalf("ParseAttributes(AT_RES) error = %v", err)
	}
	res, bits, err := attrs[0].RESValue()
	if err != nil {
		t.Fatalf("RESValue() error = %v", err)
	}
	if bits != 40 || hex.EncodeToString(res) != "1122334455" {
		t.Fatalf("RES bits=%d value=%x", bits, res)
	}

	attrs[0].Data[len(attrs[0].Data)-1] = 0x01
	if _, _, err := attrs[0].RESValue(); !errors.Is(err, ErrInvalidAttribute) {
		t.Fatalf("RESValue(non-zero padding) err=%v, want ErrInvalidAttribute", err)
	}
	if _, _, err := (Attribute{Type: AttributeRES, Data: []byte{0, 24, 0x11, 0x22, 0x33}}).RESValue(); !errors.Is(err, ErrInvalidAttribute) {
		t.Fatalf("RESValue(short bits) err=%v, want ErrInvalidAttribute", err)
	}

	if _, err := AUTNAttribute([]byte("short")).AUTNValue(); !errors.Is(err, ErrInvalidAttribute) {
		t.Fatalf("AUTNValue(short) err=%v, want ErrInvalidAttribute", err)
	}

	auts := []byte("abcdefghijklmn")
	raw, err = AUTSAttribute(auts).MarshalBinary()
	if err != nil {
		t.Fatalf("MarshalBinary(AT_AUTS) error = %v", err)
	}
	attrs, err = ParseAttributes(raw)
	if err != nil {
		t.Fatalf("ParseAttributes(AT_AUTS) error = %v", err)
	}
	gotAUTS, err := attrs[0].AUTSValue()
	if err != nil {
		t.Fatalf("AUTSValue() error = %v", err)
	}
	if string(gotAUTS) != string(auts) {
		t.Fatalf("AUTS=%q, want %q", string(gotAUTS), string(auts))
	}
	attrs[0].Data[len(attrs[0].Data)-1] = 0x01
	if _, err := attrs[0].AUTSValue(); !errors.Is(err, ErrInvalidAttribute) {
		t.Fatalf("AUTSValue(non-zero padding) err=%v, want ErrInvalidAttribute", err)
	}
}

func TestAUTSFieldsAndAttributeValidation(t *testing.T) {
	auts := mustHex(t, "010203040506a1a2a3a4a5a6a7a8")
	fields, err := ParseAUTS(auts)
	if err != nil {
		t.Fatalf("ParseAUTS() error = %v", err)
	}
	if hex.EncodeToString(fields.SQNMSXorAK) != "010203040506" || hex.EncodeToString(fields.MACS) != "a1a2a3a4a5a6a7a8" {
		t.Fatalf("AUTS fields=%+v", fields)
	}
	auts[0] = 0xff
	rebuilt, err := fields.Bytes()
	if err != nil {
		t.Fatalf("AUTSFields.Bytes() error = %v", err)
	}
	if hex.EncodeToString(rebuilt) != "010203040506a1a2a3a4a5a6a7a8" {
		t.Fatalf("rebuilt AUTS=%x", rebuilt)
	}
	sqnMS, err := fields.SQNMS(mustHex(t, "010101010101"))
	if err != nil {
		t.Fatalf("AUTSFields.SQNMS() error = %v", err)
	}
	if hex.EncodeToString(sqnMS) != "000302050407" {
		t.Fatalf("SQN_MS=%x", sqnMS)
	}

	attrFields, err := AUTSAttribute(rebuilt).AUTSFields()
	if err != nil {
		t.Fatalf("AUTSAttribute().AUTSFields() error = %v", err)
	}
	if hex.EncodeToString(attrFields.MACS) != "a1a2a3a4a5a6a7a8" {
		t.Fatalf("attribute AUTS MAC-S=%x", attrFields.MACS)
	}

	valid := []Attribute{
		RANDAttribute(mustHex(t, "101112131415161718191a1b1c1d1e1f")),
		AUTNAttribute(mustHex(t, "20212223242580003031323334353637")),
		MACAttribute(nil),
		ResultIndAttribute(),
	}
	if err := ValidateAttributes(valid); err != nil {
		t.Fatalf("ValidateAttributes(valid) error = %v", err)
	}
	if err := ValidateAttribute(Attribute{Type: AttributeResultInd, Data: []byte{0x00, 0x01}}); !errors.Is(err, ErrInvalidAttribute) {
		t.Fatalf("ValidateAttribute(bad result-ind) err=%v, want ErrInvalidAttribute", err)
	}
	if err := ValidateAttribute(Attribute{Type: AttributePadding, Data: []byte{0, 0, 0, 0}}); !errors.Is(err, ErrInvalidAttribute) {
		t.Fatalf("ValidateAttribute(bad padding length) err=%v, want ErrInvalidAttribute", err)
	}
}

func TestAKAAttributeRejectsNonZeroReservedAndPadding(t *testing.T) {
	raw, err := IdentityAttribute("abcde").MarshalBinary()
	if err != nil {
		t.Fatalf("MarshalBinary(AT_IDENTITY) error = %v", err)
	}
	raw[len(raw)-1] = 0x7f
	attrs, err := ParseAttributes(raw)
	if err != nil {
		t.Fatalf("ParseAttributes(AT_IDENTITY) error = %v", err)
	}
	if _, err := attrs[0].IdentityValue(); !errors.Is(err, ErrInvalidAttribute) {
		t.Fatalf("IdentityValue(non-zero padding) err=%v, want ErrInvalidAttribute", err)
	}

	if _, err := (Attribute{Type: AttributeRAND, Data: append([]byte{0x01, 0x00}, make([]byte, RANDLength)...)}).RANDValues(); !errors.Is(err, ErrInvalidAttribute) {
		t.Fatalf("RANDValues(non-zero reserved) err=%v, want ErrInvalidAttribute", err)
	}
	if _, err := (Attribute{Type: AttributeAUTN, Data: append([]byte{0x00, 0x01}, make([]byte, AUTNLength)...)}).AUTNValue(); !errors.Is(err, ErrInvalidAttribute) {
		t.Fatalf("AUTNValue(non-zero reserved) err=%v, want ErrInvalidAttribute", err)
	}
	if _, err := (Attribute{Type: AttributeEncrData, Data: []byte{0x00, 0x01, 0xaa}}).EncrDataValue(); !errors.Is(err, ErrInvalidAttribute) {
		t.Fatalf("EncrDataValue(non-zero reserved) err=%v, want ErrInvalidAttribute", err)
	}
	if _, err := (Attribute{Type: AttributeCheckcode, Data: append([]byte{0x00, 0x01}, make([]byte, 20)...)}).CheckcodeValue(); !errors.Is(err, ErrInvalidAttribute) {
		t.Fatalf("CheckcodeValue(non-zero reserved) err=%v, want ErrInvalidAttribute", err)
	}
	if err := (Attribute{Type: AttributeResultInd, Data: []byte{0x00, 0x01}}).ResultIndValue(); !errors.Is(err, ErrInvalidAttribute) {
		t.Fatalf("ResultIndValue(non-zero reserved) err=%v, want ErrInvalidAttribute", err)
	}
	if err := (Attribute{Type: AttributeCounterTooSmall, Data: []byte{0x01, 0x00}}).CounterTooSmallValue(); !errors.Is(err, ErrInvalidAttribute) {
		t.Fatalf("CounterTooSmallValue(non-zero reserved) err=%v, want ErrInvalidAttribute", err)
	}
	if _, err := (Attribute{Type: AttributeBidding, Data: []byte{0x40, 0x00}}).BiddingValue(); !errors.Is(err, ErrInvalidAttribute) {
		t.Fatalf("BiddingValue(non-zero first reserved bit) err=%v, want ErrInvalidAttribute", err)
	}
	if _, err := (Attribute{Type: AttributeBidding, Data: []byte{0x80, 0x01}}).BiddingValue(); !errors.Is(err, ErrInvalidAttribute) {
		t.Fatalf("BiddingValue(non-zero second reserved byte) err=%v, want ErrInvalidAttribute", err)
	}
}

func TestParseRejectsInvalidLengths(t *testing.T) {
	if _, err := ParsePacket([]byte{1, 2, 0, 3}); !errors.Is(err, ErrInvalidPacket) {
		t.Fatalf("ParsePacket() err=%v, want ErrInvalidPacket", err)
	}
	if _, err := ParseAttributes([]byte{AttributeIdentity, 0, 0, 0}); !errors.Is(err, ErrInvalidAttribute) {
		t.Fatalf("ParseAttributes() err=%v, want ErrInvalidAttribute", err)
	}
}

func TestPacketRejectsInvalidEAPCode(t *testing.T) {
	raw := []byte{9, 1, 0, 8, TypeAKA, SubtypeIdentity, 0, 0}
	if _, err := ParsePacket(raw); !errors.Is(err, ErrInvalidPacket) {
		t.Fatalf("ParsePacket(invalid code) err=%v, want ErrInvalidPacket", err)
	}

	_, err := Packet{
		Code:       9,
		Identifier: 1,
		Type:       TypeAKA,
		Subtype:    SubtypeIdentity,
	}.MarshalBinary()
	if !errors.Is(err, ErrInvalidPacket) {
		t.Fatalf("MarshalBinary(invalid code) err=%v, want ErrInvalidPacket", err)
	}
}
