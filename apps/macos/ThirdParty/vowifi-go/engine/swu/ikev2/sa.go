package ikev2

import (
	"encoding/binary"
	"errors"
	"fmt"
)

const (
	TransformENCR     uint8 = 1
	TransformPRF      uint8 = 2
	TransformINTEG    uint8 = 3
	TransformDHRGroup uint8 = 4
	TransformESN      uint8 = 5
)

const (
	ENCR_AES_CBC    uint16 = 12
	ENCR_AES_GCM_16 uint16 = 20

	PRF_HMAC_SHA1     uint16 = 2
	PRF_HMAC_SHA2_256 uint16 = 5
	PRF_HMAC_SHA2_384 uint16 = 6
	PRF_HMAC_SHA2_512 uint16 = 7

	INTEG_HMAC_SHA1_96      uint16 = 2
	INTEG_AES_XCBC_96       uint16 = 5
	INTEG_HMAC_SHA2_256_128 uint16 = 12
	INTEG_HMAC_SHA2_384_192 uint16 = 13
	INTEG_HMAC_SHA2_512_256 uint16 = 14

	ESNNo  uint16 = 0
	ESNYes uint16 = 1
)

const (
	AttributeKeyLength uint16 = 14
)

var (
	ErrInvalidSA              = errors.New("invalid ikev2 sa payload")
	ErrUnsupportedSASelection = errors.New("unsupported ikev2 selected sa")
)

type TransformAttribute struct {
	Type  uint16
	Value []byte
}

func KeyLengthAttribute(bits uint16) TransformAttribute {
	var b [2]byte
	binary.BigEndian.PutUint16(b[:], bits)
	return TransformAttribute{Type: AttributeKeyLength, Value: b[:]}
}

type Transform struct {
	Type       uint8
	ID         uint16
	Attributes []TransformAttribute
}

type Proposal struct {
	Number     uint8
	ProtocolID uint8
	SPI        []byte
	Transforms []Transform
}

type SecurityAssociation struct {
	Proposals []Proposal
}

func DefaultIKEProposal() SecurityAssociation {
	return SecurityAssociation{Proposals: []Proposal{{
		Number:     1,
		ProtocolID: ProtocolIKE,
		Transforms: []Transform{
			{Type: TransformENCR, ID: ENCR_AES_CBC, Attributes: []TransformAttribute{KeyLengthAttribute(128)}},
			{Type: TransformPRF, ID: PRF_HMAC_SHA2_256},
			{Type: TransformINTEG, ID: INTEG_HMAC_SHA2_256_128},
			{Type: TransformDHRGroup, ID: DHGroupCurve25519},
		},
	}}}
}

func DefaultESPProposal(spi []byte) SecurityAssociation {
	return SecurityAssociation{Proposals: []Proposal{{
		Number:     1,
		ProtocolID: ProtocolESP,
		SPI:        append([]byte(nil), spi...),
		Transforms: []Transform{
			{Type: TransformENCR, ID: ENCR_AES_CBC, Attributes: []TransformAttribute{KeyLengthAttribute(128)}},
			{Type: TransformINTEG, ID: INTEG_HMAC_SHA2_256_128},
			{Type: TransformESN, ID: ESNNo},
		},
	}}}
}

// EPDGCompatibleIKEProposal offers the conservative IKE algorithms used by
// deployed 3GPP ePDGs.  Keep a single DH transform because IKE_SA_INIT carries
// only one key exchange payload; the peer may select any of the encryption,
// PRF, and integrity alternatives.
func EPDGCompatibleIKEProposal() SecurityAssociation {
	return SecurityAssociation{Proposals: []Proposal{{
		Number:     1,
		ProtocolID: ProtocolIKE,
		Transforms: []Transform{
			{Type: TransformENCR, ID: ENCR_AES_CBC, Attributes: []TransformAttribute{KeyLengthAttribute(128)}},
			{Type: TransformENCR, ID: ENCR_AES_CBC, Attributes: []TransformAttribute{KeyLengthAttribute(256)}},
			{Type: TransformPRF, ID: PRF_HMAC_SHA1},
			{Type: TransformPRF, ID: PRF_HMAC_SHA2_256},
			{Type: TransformINTEG, ID: INTEG_HMAC_SHA1_96},
			{Type: TransformINTEG, ID: INTEG_HMAC_SHA2_256_128},
			{Type: TransformDHRGroup, ID: DHGroup2048BitMODP},
		},
	}}}
}

// EPDGCompatibleESPProposal offers the matching CHILD_SA algorithms.  A nil
// SPI is filled from ChildSPI when IKE_AUTH is built.
func EPDGCompatibleESPProposal(spi []byte) SecurityAssociation {
	return SecurityAssociation{Proposals: []Proposal{{
		Number:     1,
		ProtocolID: ProtocolESP,
		SPI:        append([]byte(nil), spi...),
		Transforms: []Transform{
			{Type: TransformENCR, ID: ENCR_AES_CBC, Attributes: []TransformAttribute{KeyLengthAttribute(128)}},
			{Type: TransformENCR, ID: ENCR_AES_CBC, Attributes: []TransformAttribute{KeyLengthAttribute(256)}},
			{Type: TransformINTEG, ID: INTEG_HMAC_SHA1_96},
			{Type: TransformINTEG, ID: INTEG_HMAC_SHA2_256_128},
			{Type: TransformESN, ID: ESNNo},
		},
	}}}
}

func (sa SecurityAssociation) MarshalBinary() ([]byte, error) {
	if len(sa.Proposals) == 0 {
		return nil, fmt.Errorf("%w: no proposals", ErrInvalidSA)
	}
	var out []byte
	for i, p := range sa.Proposals {
		body, err := p.marshalBody()
		if err != nil {
			return nil, err
		}
		if len(body)+4 > 0xffff {
			return nil, fmt.Errorf("%w: proposal too long", ErrInvalidSA)
		}
		last := byte(0)
		if i+1 < len(sa.Proposals) {
			last = 2
		}
		hdr := make([]byte, 4)
		hdr[0] = last
		binary.BigEndian.PutUint16(hdr[2:4], uint16(len(body)+4))
		out = append(out, hdr...)
		out = append(out, body...)
	}
	return out, nil
}

func ParseSecurityAssociation(data []byte) (SecurityAssociation, error) {
	var out SecurityAssociation
	rest := data
	for len(rest) > 0 {
		if len(rest) < 4 {
			return SecurityAssociation{}, ErrInvalidSA
		}
		more := rest[0]
		length := int(binary.BigEndian.Uint16(rest[2:4]))
		if length < 8 || length > len(rest) {
			return SecurityAssociation{}, fmt.Errorf("%w: proposal length %d", ErrInvalidSA, length)
		}
		p, err := parseProposalBody(rest[4:length])
		if err != nil {
			return SecurityAssociation{}, err
		}
		out.Proposals = append(out.Proposals, p)
		rest = rest[length:]
		if more == 0 {
			if len(rest) != 0 {
				return SecurityAssociation{}, fmt.Errorf("%w: trailing proposal bytes", ErrInvalidSA)
			}
			break
		}
		if more != 2 {
			return SecurityAssociation{}, fmt.Errorf("%w: proposal last flag %d", ErrInvalidSA, more)
		}
	}
	if len(out.Proposals) == 0 {
		return SecurityAssociation{}, fmt.Errorf("%w: no proposals", ErrInvalidSA)
	}
	return out, nil
}

func SecurityAssociationPayload(sa SecurityAssociation) (Payload, error) {
	body, err := sa.MarshalBinary()
	if err != nil {
		return Payload{}, err
	}
	return Payload{Type: PayloadSA, Body: body}, nil
}

func ValidateSelectedSA(offered, selected SecurityAssociation) error {
	if len(offered.Proposals) == 0 {
		return fmt.Errorf("%w: no offered proposals", ErrUnsupportedSASelection)
	}
	if len(selected.Proposals) == 0 {
		return fmt.Errorf("%w: no selected proposals", ErrUnsupportedSASelection)
	}
	if len(selected.Proposals) != 1 {
		return fmt.Errorf("%w: selected proposal count %d", ErrUnsupportedSASelection, len(selected.Proposals))
	}
	selectedProposal := selected.Proposals[0]
	if len(selectedProposal.Transforms) == 0 {
		return fmt.Errorf("%w: selected proposal has no transforms", ErrUnsupportedSASelection)
	}
	if err := validateSelectedProposalRequiredTransforms(selectedProposal); err != nil {
		return err
	}
	for _, offeredProposal := range offered.Proposals {
		if proposalSupportsSelection(offeredProposal, selectedProposal) {
			return nil
		}
	}
	return fmt.Errorf("%w: proposal %d protocol %d", ErrUnsupportedSASelection, selectedProposal.Number, selectedProposal.ProtocolID)
}

func validateSelectedProposalRequiredTransforms(proposal Proposal) error {
	var required []uint8
	encr, hasENCR := findTransform(proposal, TransformENCR)
	switch proposal.ProtocolID {
	case ProtocolIKE:
		required = []uint8{TransformENCR, TransformPRF, TransformDHRGroup}
	case ProtocolESP:
		required = []uint8{TransformENCR, TransformESN}
	default:
		return fmt.Errorf("%w: protocol %d", ErrUnsupportedSASelection, proposal.ProtocolID)
	}
	if !hasENCR || !isCombinedModeEncryption(encr.ID) {
		required = append(required, TransformINTEG)
	} else if proposalHasTransformType(proposal, TransformINTEG) {
		return fmt.Errorf("%w: combined-mode ENCR must not include INTEG", ErrUnsupportedSASelection)
	}
	for _, transformType := range required {
		if !proposalHasTransformType(proposal, transformType) {
			return fmt.Errorf("%w: missing transform type %d", ErrUnsupportedSASelection, transformType)
		}
	}
	return nil
}

func isCombinedModeEncryption(id uint16) bool {
	return id == ENCR_AES_GCM_16
}

func proposalSupportsSelection(offered, selected Proposal) bool {
	if offered.ProtocolID != selected.ProtocolID {
		return false
	}
	for _, selectedTransform := range selected.Transforms {
		if !proposalHasTransform(offered, selectedTransform) {
			return false
		}
	}
	return true
}

func proposalHasTransform(proposal Proposal, target Transform) bool {
	for _, transform := range proposal.Transforms {
		if transformsEqual(transform, target) {
			return true
		}
	}
	return false
}

func proposalHasTransformType(proposal Proposal, transformType uint8) bool {
	for _, transform := range proposal.Transforms {
		if transform.Type == transformType {
			return true
		}
	}
	return false
}

func transformsEqual(a, b Transform) bool {
	return a.Type == b.Type && a.ID == b.ID && transformAttributesEqual(a.Attributes, b.Attributes)
}

func transformAttributesEqual(a, b []TransformAttribute) bool {
	if len(a) != len(b) {
		return false
	}
	used := make([]bool, len(b))
	for _, attrA := range a {
		found := false
		for i, attrB := range b {
			if used[i] || attrA.Type != attrB.Type || !bytesEqual(attrA.Value, attrB.Value) {
				continue
			}
			used[i] = true
			found = true
			break
		}
		if !found {
			return false
		}
	}
	return true
}

func (p Proposal) marshalBody() ([]byte, error) {
	if len(p.Transforms) == 0 {
		return nil, fmt.Errorf("%w: proposal has no transforms", ErrInvalidSA)
	}
	if len(p.SPI) > 0xff || len(p.Transforms) > 0xff {
		return nil, fmt.Errorf("%w: proposal field too large", ErrInvalidSA)
	}
	body := []byte{p.Number, p.ProtocolID, byte(len(p.SPI)), byte(len(p.Transforms))}
	body = append(body, p.SPI...)
	for i, tr := range p.Transforms {
		encoded, err := tr.marshal(i+1 < len(p.Transforms))
		if err != nil {
			return nil, err
		}
		body = append(body, encoded...)
	}
	return body, nil
}

func parseProposalBody(data []byte) (Proposal, error) {
	if len(data) < 4 {
		return Proposal{}, ErrInvalidSA
	}
	spiSize := int(data[2])
	transformCount := int(data[3])
	if len(data) < 4+spiSize {
		return Proposal{}, ErrInvalidSA
	}
	p := Proposal{
		Number:     data[0],
		ProtocolID: data[1],
		SPI:        append([]byte(nil), data[4:4+spiSize]...),
	}
	rest := data[4+spiSize:]
	for len(rest) > 0 {
		tr, more, length, err := parseTransform(rest)
		if err != nil {
			return Proposal{}, err
		}
		p.Transforms = append(p.Transforms, tr)
		rest = rest[length:]
		if !more {
			if len(rest) != 0 {
				return Proposal{}, fmt.Errorf("%w: trailing transform bytes", ErrInvalidSA)
			}
			break
		}
	}
	if len(p.Transforms) != transformCount {
		return Proposal{}, fmt.Errorf("%w: transform count %d != %d", ErrInvalidSA, len(p.Transforms), transformCount)
	}
	return p, nil
}

func (t Transform) marshal(more bool) ([]byte, error) {
	attrs, err := marshalTransformAttributes(t.Attributes)
	if err != nil {
		return nil, err
	}
	if 8+len(attrs) > 0xffff {
		return nil, fmt.Errorf("%w: transform too long", ErrInvalidSA)
	}
	out := make([]byte, 8, 8+len(attrs))
	if more {
		out[0] = 3
	}
	binary.BigEndian.PutUint16(out[2:4], uint16(8+len(attrs)))
	out[4] = t.Type
	binary.BigEndian.PutUint16(out[6:8], t.ID)
	out = append(out, attrs...)
	return out, nil
}

func parseTransform(data []byte) (Transform, bool, int, error) {
	if len(data) < 8 {
		return Transform{}, false, 0, ErrInvalidSA
	}
	moreFlag := data[0]
	length := int(binary.BigEndian.Uint16(data[2:4]))
	if length < 8 || length > len(data) {
		return Transform{}, false, 0, fmt.Errorf("%w: transform length %d", ErrInvalidSA, length)
	}
	t := Transform{
		Type: data[4],
		ID:   binary.BigEndian.Uint16(data[6:8]),
	}
	attrs, err := parseTransformAttributes(data[8:length])
	if err != nil {
		return Transform{}, false, 0, err
	}
	t.Attributes = attrs
	switch moreFlag {
	case 0:
		return t, false, length, nil
	case 3:
		return t, true, length, nil
	default:
		return Transform{}, false, 0, fmt.Errorf("%w: transform last flag %d", ErrInvalidSA, moreFlag)
	}
}

func marshalTransformAttributes(attrs []TransformAttribute) ([]byte, error) {
	var out []byte
	for _, attr := range attrs {
		if len(attr.Value) == 2 {
			var hdr [4]byte
			binary.BigEndian.PutUint16(hdr[0:2], attr.Type|0x8000)
			copy(hdr[2:4], attr.Value)
			out = append(out, hdr[:]...)
			continue
		}
		if len(attr.Value) > 0xffff {
			return nil, fmt.Errorf("%w: attribute too long", ErrInvalidSA)
		}
		var hdr [4]byte
		binary.BigEndian.PutUint16(hdr[0:2], attr.Type)
		binary.BigEndian.PutUint16(hdr[2:4], uint16(len(attr.Value)))
		out = append(out, hdr[:]...)
		out = append(out, attr.Value...)
	}
	return out, nil
}

func parseTransformAttributes(data []byte) ([]TransformAttribute, error) {
	var out []TransformAttribute
	for len(data) > 0 {
		if len(data) < 4 {
			return nil, ErrInvalidSA
		}
		attrType := binary.BigEndian.Uint16(data[0:2])
		if attrType&0x8000 != 0 {
			out = append(out, TransformAttribute{
				Type:  attrType & 0x7fff,
				Value: append([]byte(nil), data[2:4]...),
			})
			data = data[4:]
			continue
		}
		length := int(binary.BigEndian.Uint16(data[2:4]))
		if len(data) < 4+length {
			return nil, ErrInvalidSA
		}
		out = append(out, TransformAttribute{
			Type:  attrType,
			Value: append([]byte(nil), data[4:4+length]...),
		})
		data = data[4+length:]
	}
	return out, nil
}
