package ikev2

import (
	"context"
	"crypto/rand"
	"errors"
	"fmt"
	"io"
)

var ErrInvalidCreateChild = errors.New("invalid ikev2 create child sa exchange")

func CreateChildSANotifyActionFromError(err error) (NotifyAction, bool) {
	return NotifyActionFromError(err)
}

type CreateChildSAConfig struct {
	Transport InitTransport
	Init      InitResult
	Keys      IKEKeys
	MessageID uint32
	ChildSA   SecurityAssociation
	ChildSPI  []byte
	TSi       TrafficSelectors
	TSr       TrafficSelectors
	Nonce     []byte
	RekeySPI  []byte
	Random    io.Reader
	IV        []byte
}

type CreateChildSAResult struct {
	RequestBytes  []byte
	ResponseBytes []byte
	RequestNonce  []byte
	ResponseNonce []byte
	ResponseInner []Payload
	ChildSA       ChildSAResult
	NextMessageID uint32
	Rekeyed       bool
}

func RunCREATE_CHILD_SA(ctx context.Context, cfg CreateChildSAConfig) (CreateChildSAResult, error) {
	if cfg.Transport == nil {
		return CreateChildSAResult{}, fmt.Errorf("%w: transport is nil", ErrInvalidCreateChild)
	}
	keys := cfg.Keys
	if keys.Profile.RequiredLength() == 0 {
		keys = cfg.Init.Keys
	}
	if err := validateKeySet(keys); err != nil {
		return CreateChildSAResult{}, err
	}
	if cfg.Init.InitiatorSPI == 0 || cfg.Init.ResponderSPI == 0 {
		return CreateChildSAResult{}, fmt.Errorf("%w: missing IKE SPIs", ErrInvalidCreateChild)
	}
	if cfg.MessageID == 0 {
		return CreateChildSAResult{}, fmt.Errorf("%w: message_id is zero", ErrInvalidCreateChild)
	}
	payloads, requestNonce, localSPI, err := BuildCreateChildSAPayloads(cfg)
	if err != nil {
		return CreateChildSAResult{}, err
	}
	offeredSA, ok, err := firstSecurityAssociation(payloads)
	if err != nil {
		return CreateChildSAResult{}, err
	}
	if !ok {
		return CreateChildSAResult{}, fmt.Errorf("%w: missing request SA", ErrInvalidCreateChild)
	}
	iv, err := createChildIV(cfg.Random, keys.Profile, cfg.IV)
	if err != nil {
		return CreateChildSAResult{}, err
	}
	_, reqBytes, err := ProtectMessage(createChildHeader(cfg.Init, cfg.MessageID, true), keys, true, payloads, iv)
	if err != nil {
		return CreateChildSAResult{}, err
	}
	respBytes, err := cfg.Transport.ExchangeIKE(ctx, reqBytes)
	if err != nil {
		return CreateChildSAResult{}, err
	}
	_, inner, err := unprotectCreateChildResponse(respBytes, cfg.Init, keys, cfg.MessageID)
	if err != nil {
		return CreateChildSAResult{}, err
	}
	if err := FirstNotifyError(inner); err != nil {
		return CreateChildSAResult{}, fmt.Errorf("%w: %w", ErrInvalidCreateChild, err)
	}
	responseNonce, err := firstNonce(inner)
	if err != nil {
		return CreateChildSAResult{}, err
	}
	parseInit := cfg.Init
	parseInit.Keys = keys
	child, err := parseChildSAResultWithNonces(parseInit, inner, localSPI, requestNonce, responseNonce, &offeredSA, trafficSelectorsOrIPv4Any(cfg.TSi), trafficSelectorsOrIPv4Any(cfg.TSr))
	if err != nil {
		return CreateChildSAResult{}, err
	}
	child.NextMessageID = cfg.MessageID + 1
	return CreateChildSAResult{
		RequestBytes:  append([]byte(nil), reqBytes...),
		ResponseBytes: append([]byte(nil), respBytes...),
		RequestNonce:  append([]byte(nil), requestNonce...),
		ResponseNonce: append([]byte(nil), responseNonce...),
		ResponseInner: clonePayloads(inner),
		ChildSA:       child,
		NextMessageID: cfg.MessageID + 1,
		Rekeyed:       len(cfg.RekeySPI) > 0,
	}, nil
}

func BuildCreateChildSAPayloads(cfg CreateChildSAConfig) ([]Payload, []byte, []byte, error) {
	random := cfg.Random
	if random == nil {
		random = rand.Reader
	}
	childSA, localSPI, err := createChildProposal(cfg, random)
	if err != nil {
		return nil, nil, nil, err
	}
	nonce := append([]byte(nil), cfg.Nonce...)
	if len(nonce) == 0 {
		nonce, err = randomBytes(random, DefaultNonceLength)
		if err != nil {
			return nil, nil, nil, err
		}
	}
	if len(nonce) == 0 {
		return nil, nil, nil, fmt.Errorf("%w: nonce is empty", ErrInvalidCreateChild)
	}
	saPayload, err := SecurityAssociationPayload(childSA)
	if err != nil {
		return nil, nil, nil, err
	}
	tsi := cfg.TSi
	if len(tsi.Selectors) == 0 {
		tsi = IPv4AnyTrafficSelectors()
	}
	tsiPayload, err := TrafficSelectorsPayload(PayloadTSi, tsi)
	if err != nil {
		return nil, nil, nil, err
	}
	tsr := cfg.TSr
	if len(tsr.Selectors) == 0 {
		tsr = IPv4AnyTrafficSelectors()
	}
	tsrPayload, err := TrafficSelectorsPayload(PayloadTSr, tsr)
	if err != nil {
		return nil, nil, nil, err
	}
	payloads := make([]Payload, 0, 5)
	if len(cfg.RekeySPI) > 0 {
		if len(cfg.RekeySPI) != 4 {
			return nil, nil, nil, fmt.Errorf("%w: rekey SPI length %d", ErrInvalidCreateChild, len(cfg.RekeySPI))
		}
		rekey, err := NotifyPayload(Notify{
			ProtocolID: ProtocolESP,
			NotifyType: NotifyRekeySA,
			SPI:        append([]byte(nil), cfg.RekeySPI...),
		})
		if err != nil {
			return nil, nil, nil, err
		}
		payloads = append(payloads, rekey)
	}
	payloads = append(payloads, saPayload, NoncePayload(nonce), tsiPayload, tsrPayload)
	return payloads, nonce, localSPI, nil
}

func createChildProposal(cfg CreateChildSAConfig, random io.Reader) (SecurityAssociation, []byte, error) {
	sa := cfg.ChildSA
	spi := append([]byte(nil), cfg.ChildSPI...)
	if len(sa.Proposals) == 0 {
		if len(spi) == 0 {
			var err error
			spi, err = randomBytes(random, 4)
			if err != nil {
				return SecurityAssociation{}, nil, err
			}
		}
		if len(spi) != 4 {
			return SecurityAssociation{}, nil, fmt.Errorf("%w: child SPI length %d", ErrInvalidCreateChild, len(spi))
		}
		return DefaultESPProposal(spi), spi, nil
	}
	if len(sa.Proposals) != 1 {
		return SecurityAssociation{}, nil, fmt.Errorf("%w: proposal count %d", ErrInvalidCreateChild, len(sa.Proposals))
	}
	sa = cloneSecurityAssociation(sa)
	if len(spi) == 0 {
		spi = append([]byte(nil), sa.Proposals[0].SPI...)
	} else {
		sa.Proposals[0].SPI = append([]byte(nil), spi...)
	}
	if len(spi) != 4 {
		return SecurityAssociation{}, nil, fmt.Errorf("%w: child SPI length %d", ErrInvalidCreateChild, len(spi))
	}
	return sa, spi, nil
}

func unprotectCreateChildResponse(raw []byte, init InitResult, keys IKEKeys, messageID uint32) (Message, []Payload, error) {
	msg, inner, err := UnprotectMessage(raw, keys, false)
	if err != nil {
		return Message{}, nil, err
	}
	h := msg.Header
	if h.InitiatorSPI != init.InitiatorSPI || h.ResponderSPI != init.ResponderSPI ||
		h.ExchangeType != ExchangeCREATE_CHILD_SA || h.MessageID != messageID || h.Flags&FlagResponse == 0 {
		return Message{}, nil, fmt.Errorf("%w: unexpected CREATE_CHILD_SA response header", ErrInvalidCreateChild)
	}
	return msg, inner, nil
}

func createChildHeader(init InitResult, messageID uint32, fromInitiator bool) Header {
	flags := uint8(0)
	if fromInitiator {
		flags |= FlagInitiator
	} else {
		flags |= FlagResponse
	}
	return Header{
		InitiatorSPI: init.InitiatorSPI,
		ResponderSPI: init.ResponderSPI,
		ExchangeType: ExchangeCREATE_CHILD_SA,
		Flags:        flags,
		MessageID:    messageID,
	}
}

func firstNonce(payloads []Payload) ([]byte, error) {
	for _, payload := range payloads {
		if payload.Type == PayloadNonce {
			if len(payload.Body) == 0 {
				return nil, fmt.Errorf("%w: empty nonce", ErrInvalidCreateChild)
			}
			return append([]byte(nil), payload.Body...), nil
		}
	}
	return nil, fmt.Errorf("%w: missing nonce", ErrInvalidCreateChild)
}

func createChildIV(random io.Reader, profile KeyMaterialProfile, override []byte) ([]byte, error) {
	if len(override) > 0 {
		if len(override) != profile.EncryptionBlockSize {
			return nil, fmt.Errorf("%w: IV length %d != %d", ErrInvalidCreateChild, len(override), profile.EncryptionBlockSize)
		}
		return append([]byte(nil), override...), nil
	}
	return RandomIV(random, profile)
}

func cloneSecurityAssociation(in SecurityAssociation) SecurityAssociation {
	out := SecurityAssociation{Proposals: make([]Proposal, len(in.Proposals))}
	for i, proposal := range in.Proposals {
		out.Proposals[i] = Proposal{
			Number:     proposal.Number,
			ProtocolID: proposal.ProtocolID,
			SPI:        append([]byte(nil), proposal.SPI...),
			Transforms: make([]Transform, len(proposal.Transforms)),
		}
		for j, transform := range proposal.Transforms {
			out.Proposals[i].Transforms[j] = Transform{
				Type:       transform.Type,
				ID:         transform.ID,
				Attributes: make([]TransformAttribute, len(transform.Attributes)),
			}
			for k, attr := range transform.Attributes {
				out.Proposals[i].Transforms[j].Attributes[k] = TransformAttribute{
					Type:  attr.Type,
					Value: append([]byte(nil), attr.Value...),
				}
			}
		}
	}
	return out
}
