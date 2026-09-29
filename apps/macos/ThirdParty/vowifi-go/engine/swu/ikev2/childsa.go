package ikev2

import (
	"crypto"
	"errors"
	"fmt"

	"github.com/boa-z/vowifi-go/engine/swu/eapaka"
)

var ErrInvalidChildSA = errors.New("invalid ikev2 child sa")

type ESPKeyProfile struct {
	EncryptionID        uint16
	EncryptionKeyLength int
	IntegrityID         uint16
	IntegrityKeyLength  int
	ESN                 bool
}

func (p ESPKeyProfile) DirectionKeyLength() int {
	return p.EncryptionKeyLength + p.IntegrityKeyLength
}

type ESPKeys struct {
	EncryptionKey []byte
	IntegrityKey  []byte
}

type ChildSAKeys struct {
	Profile  ESPKeyProfile
	Outbound ESPKeys
	Inbound  ESPKeys
}

type ChildSAResult struct {
	SelectedSA    SecurityAssociation
	TSi           TrafficSelectors
	TSr           TrafficSelectors
	Configuration *Configuration
	LocalSPI      []byte
	RemoteSPI     []byte
	Keys          ChildSAKeys
	EAPSuccess    bool
	NextMessageID uint32
}

func ESPKeyProfileFromSA(sa SecurityAssociation) (ESPKeyProfile, error) {
	if len(sa.Proposals) == 0 {
		return ESPKeyProfile{}, fmt.Errorf("%w: no proposals", ErrInvalidChildSA)
	}
	p := sa.Proposals[0]
	if p.ProtocolID != ProtocolESP {
		return ESPKeyProfile{}, fmt.Errorf("%w: protocol %d is not ESP", ErrInvalidChildSA, p.ProtocolID)
	}
	encr, ok := findTransform(p, TransformENCR)
	if !ok {
		return ESPKeyProfile{}, fmt.Errorf("%w: missing ESP ENCR", ErrInvalidChildSA)
	}
	encrLen, _, err := encryptionProfile(encr)
	if err != nil {
		return ESPKeyProfile{}, err
	}
	var integID uint16
	var integLen int
	if isCombinedModeEncryption(encr.ID) {
		if _, ok := findTransform(p, TransformINTEG); ok {
			return ESPKeyProfile{}, fmt.Errorf("%w: combined-mode ESP ENCR must not include INTEG", ErrInvalidChildSA)
		}
	} else {
		integ, ok := findTransform(p, TransformINTEG)
		if !ok {
			return ESPKeyProfile{}, fmt.Errorf("%w: missing ESP INTEG", ErrInvalidChildSA)
		}
		integID = integ.ID
		integLen, _, err = integrityProfile(integ.ID)
		if err != nil {
			return ESPKeyProfile{}, err
		}
	}
	esn := false
	if tr, ok := findTransform(p, TransformESN); ok {
		esn = tr.ID == ESNYes
	}
	return ESPKeyProfile{
		EncryptionID:        encr.ID,
		EncryptionKeyLength: encrLen,
		IntegrityID:         integID,
		IntegrityKeyLength:  integLen,
		ESN:                 esn,
	}, nil
}

func DeriveChildSAKeys(init InitResult, selectedSA SecurityAssociation) (ChildSAKeys, error) {
	if init.Keys.Profile.PRF == 0 || len(init.Keys.SKD) == 0 {
		return ChildSAKeys{}, fmt.Errorf("%w: missing SK_d", ErrInvalidChildSA)
	}
	return DeriveChildSAKeysWithNonces(init.Keys.Profile.PRF, init.Keys.SKD, init.NonceI, init.NonceR, selectedSA)
}

func DeriveChildSAKeysWithNonces(prf crypto.Hash, skD, nonceI, nonceR []byte, selectedSA SecurityAssociation) (ChildSAKeys, error) {
	if len(skD) == 0 || len(nonceI) == 0 || len(nonceR) == 0 {
		return ChildSAKeys{}, fmt.Errorf("%w: missing child SA key seed", ErrInvalidChildSA)
	}
	profile, err := ESPKeyProfileFromSA(selectedSA)
	if err != nil {
		return ChildSAKeys{}, err
	}
	dirLen := profile.DirectionKeyLength()
	if dirLen <= 0 {
		return ChildSAKeys{}, fmt.Errorf("%w: invalid ESP profile", ErrInvalidChildSA)
	}
	seed := make([]byte, 0, len(nonceI)+len(nonceR))
	seed = append(seed, nonceI...)
	seed = append(seed, nonceR...)
	keymat, err := PRFPlus(prf, skD, seed, dirLen*2)
	if err != nil {
		return ChildSAKeys{}, err
	}
	outbound := splitESPKeys(profile, keymat[:dirLen])
	inbound := splitESPKeys(profile, keymat[dirLen:])
	return ChildSAKeys{Profile: profile, Outbound: outbound, Inbound: inbound}, nil
}

func ParseChildSAResult(init InitResult, inner []Payload, localSPI []byte) (ChildSAResult, error) {
	return ParseChildSAResultWithNonces(init, inner, localSPI, init.NonceI, init.NonceR)
}

func ParseChildSAResultWithNonces(init InitResult, inner []Payload, localSPI, nonceI, nonceR []byte) (ChildSAResult, error) {
	return parseChildSAResultWithNonces(init, inner, localSPI, nonceI, nonceR, nil, TrafficSelectors{}, TrafficSelectors{})
}

func parseChildSAResultWithOfferedSA(init InitResult, inner []Payload, localSPI []byte, offeredSA SecurityAssociation) (ChildSAResult, error) {
	return parseChildSAResultWithNonces(init, inner, localSPI, init.NonceI, init.NonceR, &offeredSA, TrafficSelectors{}, TrafficSelectors{})
}

func parseChildSAResultWithNonces(init InitResult, inner []Payload, localSPI, nonceI, nonceR []byte, offeredSA *SecurityAssociation, offeredTSi, offeredTSr TrafficSelectors) (ChildSAResult, error) {
	var out ChildSAResult
	for _, p := range inner {
		switch p.Type {
		case PayloadSA:
			sa, err := ParseSecurityAssociation(p.Body)
			if err != nil {
				return ChildSAResult{}, err
			}
			out.SelectedSA = sa
		case PayloadTSi:
			ts, err := ParseTrafficSelectors(p.Body)
			if err != nil {
				return ChildSAResult{}, err
			}
			out.TSi = ts
		case PayloadTSr:
			ts, err := ParseTrafficSelectors(p.Body)
			if err != nil {
				return ChildSAResult{}, err
			}
			out.TSr = ts
		case PayloadCP:
			cfg, err := ParseConfiguration(p.Body)
			if err != nil {
				return ChildSAResult{}, err
			}
			out.Configuration = &cfg
		case PayloadEAP:
			pkt, err := eapaka.ParsePacket(p.Body)
			if err != nil {
				return ChildSAResult{}, err
			}
			out.EAPSuccess = pkt.Code == eapaka.CodeSuccess
		}
	}
	if len(out.SelectedSA.Proposals) == 0 {
		return ChildSAResult{}, fmt.Errorf("%w: missing SA", ErrInvalidChildSA)
	}
	if offeredSA != nil {
		if err := ValidateSelectedSA(*offeredSA, out.SelectedSA); err != nil {
			return ChildSAResult{}, err
		}
	}
	if len(out.SelectedSA.Proposals[0].SPI) == 0 {
		return ChildSAResult{}, fmt.Errorf("%w: missing responder ESP SPI", ErrInvalidChildSA)
	}
	if len(out.TSi.Selectors) == 0 {
		return ChildSAResult{}, fmt.Errorf("%w: missing TSi", ErrInvalidChildSA)
	}
	if len(out.TSr.Selectors) == 0 {
		return ChildSAResult{}, fmt.Errorf("%w: missing TSr", ErrInvalidChildSA)
	}
	if len(offeredTSi.Selectors) > 0 {
		if err := ValidateTrafficSelectorNarrowing(offeredTSi, out.TSi); err != nil {
			return ChildSAResult{}, fmt.Errorf("%w: TSi narrowing: %w", ErrInvalidChildSA, err)
		}
	}
	if len(offeredTSr.Selectors) > 0 {
		if err := ValidateTrafficSelectorNarrowing(offeredTSr, out.TSr); err != nil {
			return ChildSAResult{}, fmt.Errorf("%w: TSr narrowing: %w", ErrInvalidChildSA, err)
		}
	}
	keys, err := DeriveChildSAKeysWithNonces(init.Keys.Profile.PRF, init.Keys.SKD, nonceI, nonceR, out.SelectedSA)
	if err != nil {
		return ChildSAResult{}, err
	}
	out.LocalSPI = append([]byte(nil), localSPI...)
	out.RemoteSPI = append([]byte(nil), out.SelectedSA.Proposals[0].SPI...)
	out.Keys = keys
	return out, nil
}

func firstSecurityAssociation(payloads []Payload) (SecurityAssociation, bool, error) {
	for _, payload := range payloads {
		if payload.Type != PayloadSA {
			continue
		}
		sa, err := ParseSecurityAssociation(payload.Body)
		if err != nil {
			return SecurityAssociation{}, false, err
		}
		return sa, true, nil
	}
	return SecurityAssociation{}, false, nil
}

func splitESPKeys(profile ESPKeyProfile, material []byte) ESPKeys {
	return ESPKeys{
		EncryptionKey: append([]byte(nil), material[:profile.EncryptionKeyLength]...),
		IntegrityKey:  append([]byte(nil), material[profile.EncryptionKeyLength:profile.DirectionKeyLength()]...),
	}
}
