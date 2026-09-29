package ikev2

import (
	"bytes"
	"crypto"
	"errors"
	"testing"
)

func TestKeyMaterialProfileAndSplitDefaultIKEProposal(t *testing.T) {
	profile, err := KeyMaterialProfileFromSA(DefaultIKEProposal())
	if err != nil {
		t.Fatalf("KeyMaterialProfileFromSA() error = %v", err)
	}
	if profile.PRF != crypto.SHA256 || profile.EncryptionKeyLength != 16 || profile.IntegrityChecksumLength != 16 {
		t.Fatalf("profile=%+v", profile)
	}
	if profile.RequiredLength() != DefaultIKEKeyMaterialLength {
		t.Fatalf("RequiredLength()=%d, want %d", profile.RequiredLength(), DefaultIKEKeyMaterialLength)
	}
	keys, err := SplitIKEKeys(profile, incrementalBytes(profile.RequiredLength()))
	if err != nil {
		t.Fatalf("SplitIKEKeys() error = %v", err)
	}
	if !bytes.Equal(keys.SKD, incrementalBytes(32)) {
		t.Fatalf("SK_d=%x", keys.SKD)
	}
	if !bytes.Equal(keys.SKAi, incrementalBytesRange(32, 64)) ||
		!bytes.Equal(keys.SKAr, incrementalBytesRange(64, 96)) ||
		!bytes.Equal(keys.SKEi, incrementalBytesRange(96, 112)) ||
		!bytes.Equal(keys.SKEr, incrementalBytesRange(112, 128)) ||
		!bytes.Equal(keys.SKPi, incrementalBytesRange(128, 160)) ||
		!bytes.Equal(keys.SKPr, incrementalBytesRange(160, 192)) {
		t.Fatalf("split keys=%+v", keys)
	}
}

func TestKeyMaterialProfileAllowsAESGCMIKEWithoutINTEG(t *testing.T) {
	profile, err := KeyMaterialProfileFromSA(aesGCMIKEProposal(false))
	if err != nil {
		t.Fatalf("KeyMaterialProfileFromSA(AES-GCM) error = %v", err)
	}
	if profile.PRF != crypto.SHA256 ||
		profile.EncryptionID != ENCR_AES_GCM_16 ||
		profile.EncryptionKeyLength != 20 ||
		profile.EncryptionBlockSize != 8 ||
		profile.IntegrityID != 0 ||
		profile.IntegrityKeyLength != 0 ||
		profile.IntegrityChecksumLength != 16 {
		t.Fatalf("profile=%+v", profile)
	}
	if profile.RequiredLength() != 136 {
		t.Fatalf("RequiredLength()=%d, want 136", profile.RequiredLength())
	}
	keys, err := SplitIKEKeys(profile, incrementalBytes(profile.RequiredLength()))
	if err != nil {
		t.Fatalf("SplitIKEKeys() error = %v", err)
	}
	if len(keys.SKAi) != 0 || len(keys.SKAr) != 0 {
		t.Fatalf("combined-mode integrity keys should be empty: SK_ai=%x SK_ar=%x", keys.SKAi, keys.SKAr)
	}
	if !bytes.Equal(keys.SKD, incrementalBytesRange(0, 32)) ||
		!bytes.Equal(keys.SKEi, incrementalBytesRange(32, 52)) ||
		!bytes.Equal(keys.SKEr, incrementalBytesRange(52, 72)) ||
		!bytes.Equal(keys.SKPi, incrementalBytesRange(72, 104)) ||
		!bytes.Equal(keys.SKPr, incrementalBytesRange(104, 136)) {
		t.Fatalf("split AES-GCM keys=%+v", keys)
	}
}

func TestKeyMaterialProfileRejectsAESGCMIKEWithINTEG(t *testing.T) {
	_, err := KeyMaterialProfileFromSA(aesGCMIKEProposal(true))
	if !errors.Is(err, ErrUnsupportedTransform) {
		t.Fatalf("KeyMaterialProfileFromSA(AES-GCM+INTEG) err=%v, want ErrUnsupportedTransform", err)
	}
}

func TestProtectAndUnprotectMessageAESGCM(t *testing.T) {
	keys := testAESGCMIKEKeys(t)
	idi, err := IdentityPayload(PayloadIDi, Identity{Type: IDRFC822Addr, Data: []byte("001010123456789@wlan.mnc010.mcc001.3gppnetwork.org")})
	if err != nil {
		t.Fatalf("IdentityPayload() error = %v", err)
	}
	cp, err := ConfigurationPayload(SWuConfigurationRequest())
	if err != nil {
		t.Fatalf("ConfigurationPayload() error = %v", err)
	}
	header := Header{
		InitiatorSPI: 0x0102030405060708,
		ResponderSPI: 0x1112131415161718,
		ExchangeType: ExchangeIKE_AUTH,
		Flags:        FlagInitiator,
		MessageID:    2,
	}
	iv := []byte{0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08}
	msg, raw, err := ProtectMessage(header, keys, true, []Payload{idi, cp}, iv)
	if err != nil {
		t.Fatalf("ProtectMessage(AES-GCM) error = %v", err)
	}
	if msg.Header.NextPayload != 0 {
		t.Fatalf("message header should be set during marshal only: %+v", msg.Header)
	}
	if raw[16] != PayloadSK || raw[28] != PayloadIDi {
		t.Fatalf("raw header next=%d SK next=%d", raw[16], raw[28])
	}
	if got := raw[HeaderLength+4 : HeaderLength+4+len(iv)]; !bytes.Equal(got, iv) {
		t.Fatalf("SK explicit IV=%x, want %x", got, iv)
	}
	parsed, inner, err := UnprotectMessage(raw, keys, true)
	if err != nil {
		t.Fatalf("UnprotectMessage(AES-GCM) error = %v", err)
	}
	if len(parsed.Payloads) != 1 || parsed.Payloads[0].Type != PayloadSK || parsed.Payloads[0].NextPayload != PayloadIDi {
		t.Fatalf("parsed=%+v", parsed)
	}
	if len(inner) != 2 || inner[0].Type != PayloadIDi || inner[1].Type != PayloadCP {
		t.Fatalf("inner=%+v", inner)
	}
	id, err := ParseIdentity(inner[0].Body)
	if err != nil {
		t.Fatalf("ParseIdentity() error = %v", err)
	}
	if string(id.Data) != "001010123456789@wlan.mnc010.mcc001.3gppnetwork.org" {
		t.Fatalf("id=%+v", id)
	}
}

func TestUnprotectAESGCMRejectsTamperedTag(t *testing.T) {
	keys := testAESGCMIKEKeys(t)
	idi, err := IdentityPayload(PayloadIDi, Identity{Type: IDRFC822Addr, Data: []byte("001010123456789@wlan.mnc010.mcc001.3gppnetwork.org")})
	if err != nil {
		t.Fatalf("IdentityPayload() error = %v", err)
	}
	_, raw, err := ProtectMessage(
		Header{InitiatorSPI: 1, ResponderSPI: 2, ExchangeType: ExchangeIKE_AUTH, MessageID: 3},
		keys,
		true,
		[]Payload{idi},
		bytes.Repeat([]byte{0x33}, keys.Profile.EncryptionBlockSize),
	)
	if err != nil {
		t.Fatalf("ProtectMessage(AES-GCM) error = %v", err)
	}
	raw[len(raw)-1] ^= 0xff
	_, _, err = UnprotectMessage(raw, keys, true)
	if !errors.Is(err, ErrInvalidSKPayload) {
		t.Fatalf("UnprotectMessage(tampered tag) err=%v, want ErrInvalidSKPayload", err)
	}
}

func TestUnprotectAESGCMRejectsTamperedAAD(t *testing.T) {
	keys := testAESGCMIKEKeys(t)
	idi, err := IdentityPayload(PayloadIDi, Identity{Type: IDRFC822Addr, Data: []byte("001010123456789@wlan.mnc010.mcc001.3gppnetwork.org")})
	if err != nil {
		t.Fatalf("IdentityPayload() error = %v", err)
	}
	_, raw, err := ProtectMessage(
		Header{InitiatorSPI: 1, ResponderSPI: 2, ExchangeType: ExchangeIKE_AUTH, MessageID: 4},
		keys,
		true,
		[]Payload{idi},
		bytes.Repeat([]byte{0x44}, keys.Profile.EncryptionBlockSize),
	)
	if err != nil {
		t.Fatalf("ProtectMessage(AES-GCM) error = %v", err)
	}
	raw[20] ^= 0x01
	_, _, err = UnprotectMessage(raw, keys, true)
	if !errors.Is(err, ErrInvalidSKPayload) {
		t.Fatalf("UnprotectMessage(tampered AAD) err=%v, want ErrInvalidSKPayload", err)
	}
}

func TestProtectAESGCMRejectsBadIVLength(t *testing.T) {
	keys := testAESGCMIKEKeys(t)
	idi, err := IdentityPayload(PayloadIDi, Identity{Type: IDRFC822Addr, Data: []byte("001010123456789@wlan.mnc010.mcc001.3gppnetwork.org")})
	if err != nil {
		t.Fatalf("IdentityPayload() error = %v", err)
	}
	_, _, err = ProtectMessage(
		Header{InitiatorSPI: 1, ResponderSPI: 2, ExchangeType: ExchangeIKE_AUTH, MessageID: 5},
		keys,
		true,
		[]Payload{idi},
		bytes.Repeat([]byte{0x55}, keys.Profile.EncryptionBlockSize-1),
	)
	if !errors.Is(err, ErrInvalidSKPayload) {
		t.Fatalf("ProtectMessage(bad AES-GCM IV) err=%v, want ErrInvalidSKPayload", err)
	}
}

func TestProtectAndUnprotectMessage(t *testing.T) {
	profile, err := KeyMaterialProfileFromSA(DefaultIKEProposal())
	if err != nil {
		t.Fatalf("KeyMaterialProfileFromSA() error = %v", err)
	}
	keys, err := SplitIKEKeys(profile, incrementalBytes(profile.RequiredLength()))
	if err != nil {
		t.Fatalf("SplitIKEKeys() error = %v", err)
	}
	idi, err := IdentityPayload(PayloadIDi, Identity{Type: IDRFC822Addr, Data: []byte("310280000000001@nai.epc.mnc280.mcc310.3gppnetwork.org")})
	if err != nil {
		t.Fatalf("IdentityPayload() error = %v", err)
	}
	cp, err := ConfigurationPayload(SWuConfigurationRequest())
	if err != nil {
		t.Fatalf("ConfigurationPayload() error = %v", err)
	}
	header := Header{
		InitiatorSPI: 0x0102030405060708,
		ResponderSPI: 0x1112131415161718,
		ExchangeType: ExchangeIKE_AUTH,
		Flags:        FlagInitiator,
		MessageID:    1,
	}
	iv := bytes.Repeat([]byte{0xa5}, profile.EncryptionBlockSize)
	msg, raw, err := ProtectMessage(header, keys, true, []Payload{idi, cp}, iv)
	if err != nil {
		t.Fatalf("ProtectMessage() error = %v", err)
	}
	if msg.Header.NextPayload != 0 {
		t.Fatalf("message header should be set during marshal only: %+v", msg.Header)
	}
	if raw[16] != PayloadSK || raw[28] != PayloadIDi {
		t.Fatalf("raw header next=%d SK next=%d", raw[16], raw[28])
	}
	parsed, inner, err := UnprotectMessage(raw, keys, true)
	if err != nil {
		t.Fatalf("UnprotectMessage() error = %v", err)
	}
	if len(parsed.Payloads) != 1 || parsed.Payloads[0].Type != PayloadSK || parsed.Payloads[0].NextPayload != PayloadIDi {
		t.Fatalf("parsed=%+v", parsed)
	}
	if len(inner) != 2 || inner[0].Type != PayloadIDi || inner[1].Type != PayloadCP {
		t.Fatalf("inner=%+v", inner)
	}
	id, err := ParseIdentity(inner[0].Body)
	if err != nil {
		t.Fatalf("ParseIdentity() error = %v", err)
	}
	if string(id.Data) != "310280000000001@nai.epc.mnc280.mcc310.3gppnetwork.org" {
		t.Fatalf("id=%+v", id)
	}
}

func aesGCMIKEProposal(includeINTEG bool) SecurityAssociation {
	transforms := []Transform{
		{Type: TransformENCR, ID: ENCR_AES_GCM_16, Attributes: []TransformAttribute{KeyLengthAttribute(128)}},
		{Type: TransformPRF, ID: PRF_HMAC_SHA2_256},
		{Type: TransformDHRGroup, ID: DHGroupCurve25519},
	}
	if includeINTEG {
		transforms = []Transform{
			{Type: TransformENCR, ID: ENCR_AES_GCM_16, Attributes: []TransformAttribute{KeyLengthAttribute(128)}},
			{Type: TransformPRF, ID: PRF_HMAC_SHA2_256},
			{Type: TransformINTEG, ID: INTEG_HMAC_SHA2_256_128},
			{Type: TransformDHRGroup, ID: DHGroupCurve25519},
		}
	}
	return SecurityAssociation{Proposals: []Proposal{{
		Number:     1,
		ProtocolID: ProtocolIKE,
		Transforms: transforms,
	}}}
}

func TestUnprotectRejectsTamperedICV(t *testing.T) {
	profile, err := KeyMaterialProfileFromSA(DefaultIKEProposal())
	if err != nil {
		t.Fatalf("KeyMaterialProfileFromSA() error = %v", err)
	}
	keys, err := SplitIKEKeys(profile, incrementalBytes(profile.RequiredLength()))
	if err != nil {
		t.Fatalf("SplitIKEKeys() error = %v", err)
	}
	idi, err := IdentityPayload(PayloadIDi, Identity{Type: IDRFC822Addr, Data: []byte("user@example.com")})
	if err != nil {
		t.Fatalf("IdentityPayload() error = %v", err)
	}
	_, raw, err := ProtectMessage(Header{InitiatorSPI: 1, ResponderSPI: 2, ExchangeType: ExchangeIKE_AUTH, MessageID: 1}, keys, true, []Payload{idi}, bytes.Repeat([]byte{0x5a}, 16))
	if err != nil {
		t.Fatalf("ProtectMessage() error = %v", err)
	}
	raw[len(raw)-1] ^= 0xff
	_, _, err = UnprotectMessage(raw, keys, true)
	if !errors.Is(err, ErrInvalidSKPayload) {
		t.Fatalf("UnprotectMessage() err=%v, want ErrInvalidSKPayload", err)
	}
}

func TestProtectAllowsEmptyInformational(t *testing.T) {
	profile, err := KeyMaterialProfileFromSA(DefaultIKEProposal())
	if err != nil {
		t.Fatalf("KeyMaterialProfileFromSA() error = %v", err)
	}
	keys, err := SplitIKEKeys(profile, incrementalBytes(profile.RequiredLength()))
	if err != nil {
		t.Fatalf("SplitIKEKeys() error = %v", err)
	}
	header := Header{
		InitiatorSPI: 0x0102030405060708,
		ResponderSPI: 0x1112131415161718,
		ExchangeType: ExchangeINFORMATIONAL,
		Flags:        FlagInitiator,
		MessageID:    8,
	}
	msg, raw, err := ProtectMessage(header, keys, true, nil, bytes.Repeat([]byte{0x6a}, profile.EncryptionBlockSize))
	if err != nil {
		t.Fatalf("ProtectMessage() error = %v", err)
	}
	if len(msg.Payloads) != 1 || msg.Payloads[0].NextPayload != PayloadNoNext {
		t.Fatalf("msg=%+v", msg)
	}
	if raw[16] != PayloadSK || raw[28] != PayloadNoNext {
		t.Fatalf("raw header next=%d SK next=%d", raw[16], raw[28])
	}
	_, inner, err := UnprotectMessage(raw, keys, true)
	if err != nil {
		t.Fatalf("UnprotectMessage() error = %v", err)
	}
	if len(inner) != 0 {
		t.Fatalf("inner=%+v, want empty", inner)
	}
}

func TestProtectRejectsEmptyNonInformational(t *testing.T) {
	profile, err := KeyMaterialProfileFromSA(DefaultIKEProposal())
	if err != nil {
		t.Fatalf("KeyMaterialProfileFromSA() error = %v", err)
	}
	keys, err := SplitIKEKeys(profile, incrementalBytes(profile.RequiredLength()))
	if err != nil {
		t.Fatalf("SplitIKEKeys() error = %v", err)
	}
	_, _, err = ProtectMessage(Header{InitiatorSPI: 1, ResponderSPI: 2, ExchangeType: ExchangeIKE_AUTH, MessageID: 1}, keys, true, nil, bytes.Repeat([]byte{0x5b}, 16))
	if !errors.Is(err, ErrInvalidSKPayload) {
		t.Fatalf("ProtectMessage() err=%v, want ErrInvalidSKPayload", err)
	}
}

func TestMarshalRejectsOuterPayloadAfterSK(t *testing.T) {
	_, _, err := MarshalPayloads([]Payload{
		{Type: PayloadSK, NextPayload: PayloadIDi, Body: []byte{1, 2, 3, 4}},
		{Type: PayloadNotify, Body: []byte{1, 2, 3, 4}},
	})
	if !errors.Is(err, ErrInvalidLength) {
		t.Fatalf("MarshalPayloads() err=%v, want ErrInvalidLength", err)
	}
}

func incrementalBytes(n int) []byte {
	return incrementalBytesRange(0, n)
}

func testAESGCMIKEKeys(t *testing.T) IKEKeys {
	t.Helper()
	profile, err := KeyMaterialProfileFromSA(aesGCMIKEProposal(false))
	if err != nil {
		t.Fatalf("KeyMaterialProfileFromSA(AES-GCM) error = %v", err)
	}
	keys, err := SplitIKEKeys(profile, incrementalBytes(profile.RequiredLength()))
	if err != nil {
		t.Fatalf("SplitIKEKeys(AES-GCM) error = %v", err)
	}
	return keys
}

func incrementalBytesRange(start, end int) []byte {
	out := make([]byte, end-start)
	for i := range out {
		out[i] = byte(start + i)
	}
	return out
}
