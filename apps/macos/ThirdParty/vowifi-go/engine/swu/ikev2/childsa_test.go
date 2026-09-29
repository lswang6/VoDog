package ikev2

import (
	"bytes"
	"errors"
	"testing"
)

func TestDeriveChildSAKeysWithNonces(t *testing.T) {
	init := fakeInitResult(t)
	selected := DefaultESPProposal([]byte{0xde, 0xad, 0xbe, 0xef})
	keys, err := DeriveChildSAKeys(init, selected)
	if err != nil {
		t.Fatalf("DeriveChildSAKeys() error = %v", err)
	}
	if keys.Profile.DirectionKeyLength() != 48 {
		t.Fatalf("direction key length=%d", keys.Profile.DirectionKeyLength())
	}
	seed := append(append([]byte(nil), init.NonceI...), init.NonceR...)
	keymat, err := PRFPlus(init.Keys.Profile.PRF, init.Keys.SKD, seed, 96)
	if err != nil {
		t.Fatalf("PRFPlus() error = %v", err)
	}
	if !bytes.Equal(keys.Outbound.EncryptionKey, keymat[:16]) ||
		!bytes.Equal(keys.Outbound.IntegrityKey, keymat[16:48]) ||
		!bytes.Equal(keys.Inbound.EncryptionKey, keymat[48:64]) ||
		!bytes.Equal(keys.Inbound.IntegrityKey, keymat[64:96]) {
		t.Fatalf("keys=%+v keymat=%x", keys, keymat)
	}
}

func TestDeriveChildSAKeysAllowsAESGCMESPWithoutINTEG(t *testing.T) {
	init := fakeInitResult(t)
	selected := aesGCMESPProposal([]byte{0xde, 0xad, 0xbe, 0xef}, false)
	keys, err := DeriveChildSAKeys(init, selected)
	if err != nil {
		t.Fatalf("DeriveChildSAKeys(AES-GCM) error = %v", err)
	}
	if keys.Profile.EncryptionID != ENCR_AES_GCM_16 ||
		keys.Profile.EncryptionKeyLength != 20 ||
		keys.Profile.IntegrityID != 0 ||
		keys.Profile.IntegrityKeyLength != 0 ||
		keys.Profile.DirectionKeyLength() != 20 {
		t.Fatalf("profile=%+v", keys.Profile)
	}
	if len(keys.Outbound.IntegrityKey) != 0 || len(keys.Inbound.IntegrityKey) != 0 {
		t.Fatalf("combined-mode integrity keys should be empty: outbound=%x inbound=%x", keys.Outbound.IntegrityKey, keys.Inbound.IntegrityKey)
	}
	seed := append(append([]byte(nil), init.NonceI...), init.NonceR...)
	keymat, err := PRFPlus(init.Keys.Profile.PRF, init.Keys.SKD, seed, 40)
	if err != nil {
		t.Fatalf("PRFPlus() error = %v", err)
	}
	if !bytes.Equal(keys.Outbound.EncryptionKey, keymat[:20]) ||
		!bytes.Equal(keys.Inbound.EncryptionKey, keymat[20:40]) {
		t.Fatalf("keys=%+v keymat=%x", keys, keymat)
	}
}

func TestESPKeyProfileRejectsAESGCMESPWithINTEG(t *testing.T) {
	_, err := ESPKeyProfileFromSA(aesGCMESPProposal([]byte{0xde, 0xad, 0xbe, 0xef}, true))
	if !errors.Is(err, ErrInvalidChildSA) {
		t.Fatalf("ESPKeyProfileFromSA(AES-GCM+INTEG) err=%v, want ErrInvalidChildSA", err)
	}
}

func TestParseChildSAResult(t *testing.T) {
	init := fakeInitResult(t)
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
	cfgPayload, err := ConfigurationPayload(Configuration{Type: CFGReply, Attributes: []ConfigurationAttribute{
		{Type: ConfigInternalIPv4Address, Value: []byte{10, 0, 0, 2}},
		{Type: ConfigInternalIPv4DNS, Value: []byte{10, 0, 0, 1}},
	}})
	if err != nil {
		t.Fatalf("ConfigurationPayload() error = %v", err)
	}
	result, err := ParseChildSAResult(init, []Payload{saPayload, tsiPayload, tsrPayload, cfgPayload}, []byte{0xca, 0xfe, 0xba, 0xbe})
	if err != nil {
		t.Fatalf("ParseChildSAResult() error = %v", err)
	}
	if !bytes.Equal(result.LocalSPI, []byte{0xca, 0xfe, 0xba, 0xbe}) || !bytes.Equal(result.RemoteSPI, []byte{0xde, 0xad, 0xbe, 0xef}) {
		t.Fatalf("SPIs local=%x remote=%x", result.LocalSPI, result.RemoteSPI)
	}
	if result.Configuration == nil || len(result.Configuration.Attributes) != 2 {
		t.Fatalf("configuration=%+v", result.Configuration)
	}
	if len(result.TSi.Selectors) != 1 || len(result.TSr.Selectors) != 1 {
		t.Fatalf("TSi/TSr=%+v/%+v", result.TSi, result.TSr)
	}
	if len(result.Keys.Outbound.EncryptionKey) != 16 || len(result.Keys.Inbound.IntegrityKey) != 32 {
		t.Fatalf("keys=%+v", result.Keys)
	}
}

func TestParseChildSAResultRejectsMissingSA(t *testing.T) {
	init := fakeInitResult(t)
	_, err := ParseChildSAResult(init, nil, nil)
	if err == nil {
		t.Fatal("ParseChildSAResult() err=nil, want error")
	}
}
