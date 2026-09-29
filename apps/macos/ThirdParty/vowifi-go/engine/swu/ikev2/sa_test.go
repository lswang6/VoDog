package ikev2

import (
	"encoding/hex"
	"errors"
	"testing"
)

func TestDefaultIKEProposalMarshalParse(t *testing.T) {
	sa := DefaultIKEProposal()
	body, err := sa.MarshalBinary()
	if err != nil {
		t.Fatalf("MarshalBinary() error = %v", err)
	}
	want := "0000002c010100040300000c0100000c800e00800300000802000005030000080300000c000000080400001f"
	if hex.EncodeToString(body) != want {
		t.Fatalf("SA body=%x, want %s", body, want)
	}
	parsed, err := ParseSecurityAssociation(body)
	if err != nil {
		t.Fatalf("ParseSecurityAssociation() error = %v", err)
	}
	if len(parsed.Proposals) != 1 || len(parsed.Proposals[0].Transforms) != 4 {
		t.Fatalf("parsed=%+v", parsed)
	}
	encr := parsed.Proposals[0].Transforms[0]
	if encr.Type != TransformENCR || encr.ID != ENCR_AES_CBC || len(encr.Attributes) != 1 {
		t.Fatalf("ENCR transform=%+v", encr)
	}
	if encr.Attributes[0].Type != AttributeKeyLength || hex.EncodeToString(encr.Attributes[0].Value) != "0080" {
		t.Fatalf("ENCR attrs=%+v", encr.Attributes)
	}
}

func TestDefaultESPProposalIncludesSPI(t *testing.T) {
	body, err := DefaultESPProposal([]byte{0xaa, 0xbb, 0xcc, 0xdd}).MarshalBinary()
	if err != nil {
		t.Fatalf("MarshalBinary() error = %v", err)
	}
	parsed, err := ParseSecurityAssociation(body)
	if err != nil {
		t.Fatalf("ParseSecurityAssociation() error = %v", err)
	}
	p := parsed.Proposals[0]
	if p.ProtocolID != ProtocolESP || hex.EncodeToString(p.SPI) != "aabbccdd" || len(p.Transforms) != 3 {
		t.Fatalf("proposal=%+v", p)
	}
}

func TestEPDGCompatibleProposalsUseMODP2048AndLegacyAlternatives(t *testing.T) {
	ike := EPDGCompatibleIKEProposal()
	p := ike.Proposals[0]
	if !proposalHasTransform(p, Transform{Type: TransformDHRGroup, ID: DHGroup2048BitMODP}) ||
		!proposalHasTransform(p, Transform{Type: TransformPRF, ID: PRF_HMAC_SHA1}) ||
		!proposalHasTransform(p, Transform{Type: TransformINTEG, ID: INTEG_HMAC_SHA1_96}) {
		t.Fatalf("IKE proposal=%+v", p)
	}
	esp := EPDGCompatibleESPProposal(nil)
	if len(esp.Proposals) != 1 || len(esp.Proposals[0].SPI) != 0 ||
		!proposalHasTransform(esp.Proposals[0], Transform{Type: TransformINTEG, ID: INTEG_HMAC_SHA1_96}) {
		t.Fatalf("ESP proposal=%+v", esp)
	}
}

func TestSecurityAssociationRejectsBadTransformCount(t *testing.T) {
	body := mustHex("0000002c010100050300000c0100000c800e00800300000802000005030000080300000c000000080400001f")
	_, err := ParseSecurityAssociation(body)
	if !errors.Is(err, ErrInvalidSA) {
		t.Fatalf("ParseSecurityAssociation() err=%v, want ErrInvalidSA", err)
	}
}

func TestValidateSelectedSAAllowsOfferedESPWithResponderSPI(t *testing.T) {
	offered := DefaultESPProposal([]byte{0xca, 0xfe, 0xba, 0xbe})
	selected := DefaultESPProposal([]byte{0xde, 0xad, 0xbe, 0xef})
	if err := ValidateSelectedSA(offered, selected); err != nil {
		t.Fatalf("ValidateSelectedSA() error = %v", err)
	}
}

func TestValidateSelectedSARejectsUnofferedIKETransform(t *testing.T) {
	offered := DefaultIKEProposal()
	selected := DefaultIKEProposal()
	selected.Proposals[0].Transforms[1].ID = PRF_HMAC_SHA2_512
	err := ValidateSelectedSA(offered, selected)
	if !errors.Is(err, ErrUnsupportedSASelection) {
		t.Fatalf("ValidateSelectedSA() err=%v, want ErrUnsupportedSASelection", err)
	}
}

func TestValidateSelectedSARejectsUnofferedESPAttribute(t *testing.T) {
	offered := DefaultESPProposal([]byte{0xca, 0xfe, 0xba, 0xbe})
	selected := DefaultESPProposal([]byte{0xde, 0xad, 0xbe, 0xef})
	selected.Proposals[0].Transforms[0].Attributes = []TransformAttribute{KeyLengthAttribute(256)}
	err := ValidateSelectedSA(offered, selected)
	if !errors.Is(err, ErrUnsupportedSASelection) {
		t.Fatalf("ValidateSelectedSA() err=%v, want ErrUnsupportedSASelection", err)
	}
}

func TestValidateSelectedSAAllowsAESGCMESPWithoutINTEG(t *testing.T) {
	offered := aesGCMESPProposal([]byte{0xca, 0xfe, 0xba, 0xbe}, false)
	selected := aesGCMESPProposal([]byte{0xde, 0xad, 0xbe, 0xef}, false)
	if err := ValidateSelectedSA(offered, selected); err != nil {
		t.Fatalf("ValidateSelectedSA() error = %v", err)
	}
}

func TestValidateSelectedSARejectsAESGCMESPWithINTEG(t *testing.T) {
	offered := aesGCMESPProposal([]byte{0xca, 0xfe, 0xba, 0xbe}, true)
	selected := aesGCMESPProposal([]byte{0xde, 0xad, 0xbe, 0xef}, true)
	err := ValidateSelectedSA(offered, selected)
	if !errors.Is(err, ErrUnsupportedSASelection) {
		t.Fatalf("ValidateSelectedSA() err=%v, want ErrUnsupportedSASelection", err)
	}
}

func TestValidateSelectedSAAllowsAESGCMIKEWithoutINTEG(t *testing.T) {
	offered := aesGCMIKEProposal(false)
	selected := aesGCMIKEProposal(false)
	if err := ValidateSelectedSA(offered, selected); err != nil {
		t.Fatalf("ValidateSelectedSA() error = %v", err)
	}
}

func TestValidateSelectedSARejectsAESGCMIKEWithINTEG(t *testing.T) {
	offered := aesGCMIKEProposal(true)
	selected := aesGCMIKEProposal(true)
	err := ValidateSelectedSA(offered, selected)
	if !errors.Is(err, ErrUnsupportedSASelection) {
		t.Fatalf("ValidateSelectedSA() err=%v, want ErrUnsupportedSASelection", err)
	}
}

func TestValidateSelectedSARejectsMissingRequiredTransforms(t *testing.T) {
	offeredIKE := DefaultIKEProposal()
	selectedIKE := DefaultIKEProposal()
	selectedIKE.Proposals[0].Transforms = selectedIKE.Proposals[0].Transforms[:3]
	if err := ValidateSelectedSA(offeredIKE, selectedIKE); !errors.Is(err, ErrUnsupportedSASelection) {
		t.Fatalf("ValidateSelectedSA(IKE missing DH) err=%v, want ErrUnsupportedSASelection", err)
	}

	offeredESP := DefaultESPProposal([]byte{0xca, 0xfe, 0xba, 0xbe})
	selectedESP := DefaultESPProposal([]byte{0xde, 0xad, 0xbe, 0xef})
	selectedESP.Proposals[0].Transforms = selectedESP.Proposals[0].Transforms[:2]
	if err := ValidateSelectedSA(offeredESP, selectedESP); !errors.Is(err, ErrUnsupportedSASelection) {
		t.Fatalf("ValidateSelectedSA(ESP missing ESN) err=%v, want ErrUnsupportedSASelection", err)
	}

	selectedUnknown := DefaultESPProposal([]byte{0xde, 0xad, 0xbe, 0xef})
	selectedUnknown.Proposals[0].ProtocolID = ProtocolAH
	if err := ValidateSelectedSA(offeredESP, selectedUnknown); !errors.Is(err, ErrUnsupportedSASelection) {
		t.Fatalf("ValidateSelectedSA(unknown protocol) err=%v, want ErrUnsupportedSASelection", err)
	}
}

func aesGCMESPProposal(spi []byte, includeINTEG bool) SecurityAssociation {
	transforms := []Transform{
		{Type: TransformENCR, ID: ENCR_AES_GCM_16, Attributes: []TransformAttribute{KeyLengthAttribute(128)}},
		{Type: TransformESN, ID: ESNNo},
	}
	if includeINTEG {
		transforms = []Transform{
			{Type: TransformENCR, ID: ENCR_AES_GCM_16, Attributes: []TransformAttribute{KeyLengthAttribute(128)}},
			{Type: TransformINTEG, ID: INTEG_HMAC_SHA2_256_128},
			{Type: TransformESN, ID: ESNNo},
		}
	}
	return SecurityAssociation{Proposals: []Proposal{{
		Number:     1,
		ProtocolID: ProtocolESP,
		SPI:        append([]byte(nil), spi...),
		Transforms: transforms,
	}}}
}
