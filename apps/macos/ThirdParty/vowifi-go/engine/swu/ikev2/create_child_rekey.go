package ikev2

import (
	"context"
	"crypto/rand"
	"fmt"
	"io"
)

type ChildSARekeyConfig struct {
	Transport  InitTransport
	Init       InitResult
	Keys       IKEKeys
	MessageID  uint32
	OldChildSA ChildSAResult
	ChildSA    SecurityAssociation
	ChildSPI   []byte
	RekeySPI   []byte
	TSi        TrafficSelectors
	TSr        TrafficSelectors
	Nonce      []byte
	Random     io.Reader
	IV         []byte
}

type ChildSARekeyPlan struct {
	Config       CreateChildSAConfig
	OldLocalSPI  []byte
	OldRemoteSPI []byte
	RekeySPI     []byte
	NewLocalSPI  []byte
}

func NewChildSARekeyPlan(cfg ChildSARekeyConfig) (ChildSARekeyPlan, error) {
	oldLocalSPI := append([]byte(nil), cfg.OldChildSA.LocalSPI...)
	if len(oldLocalSPI) != 4 {
		return ChildSARekeyPlan{}, fmt.Errorf("%w: old child local SPI length %d", ErrInvalidCreateChild, len(oldLocalSPI))
	}
	rekeySPI := append([]byte(nil), cfg.RekeySPI...)
	if len(rekeySPI) == 0 {
		rekeySPI = append([]byte(nil), oldLocalSPI...)
	}
	if len(rekeySPI) != 4 {
		return ChildSARekeyPlan{}, fmt.Errorf("%w: rekey SPI length %d", ErrInvalidCreateChild, len(rekeySPI))
	}
	childSA, childSPI, err := childSAForRekey(cfg)
	if err != nil {
		return ChildSARekeyPlan{}, err
	}
	tsi := cfg.TSi
	if len(tsi.Selectors) == 0 {
		tsi = cfg.OldChildSA.TSi
	}
	tsr := cfg.TSr
	if len(tsr.Selectors) == 0 {
		tsr = cfg.OldChildSA.TSr
	}
	return ChildSARekeyPlan{
		Config: CreateChildSAConfig{
			Transport: cfg.Transport,
			Init:      cfg.Init,
			Keys:      cfg.Keys,
			MessageID: cfg.MessageID,
			ChildSA:   childSA,
			ChildSPI:  childSPI,
			TSi:       cloneTrafficSelectors(tsi),
			TSr:       cloneTrafficSelectors(tsr),
			Nonce:     append([]byte(nil), cfg.Nonce...),
			RekeySPI:  rekeySPI,
			Random:    cfg.Random,
			IV:        append([]byte(nil), cfg.IV...),
		},
		OldLocalSPI:  oldLocalSPI,
		OldRemoteSPI: append([]byte(nil), cfg.OldChildSA.RemoteSPI...),
		RekeySPI:     append([]byte(nil), rekeySPI...),
		NewLocalSPI:  append([]byte(nil), childSPI...),
	}, nil
}

func RunCREATE_CHILD_SARekey(ctx context.Context, cfg ChildSARekeyConfig) (CreateChildSAResult, error) {
	plan, err := NewChildSARekeyPlan(cfg)
	if err != nil {
		return CreateChildSAResult{}, err
	}
	return RunCREATE_CHILD_SA(ctx, plan.Config)
}

func childSAForRekey(cfg ChildSARekeyConfig) (SecurityAssociation, []byte, error) {
	random := cfg.Random
	if random == nil {
		random = rand.Reader
	}
	childSPI := append([]byte(nil), cfg.ChildSPI...)
	if len(childSPI) == 0 && len(cfg.ChildSA.Proposals) > 0 {
		childSPI = append([]byte(nil), cfg.ChildSA.Proposals[0].SPI...)
	}
	if len(childSPI) == 0 {
		var err error
		childSPI, err = randomBytes(random, 4)
		if err != nil {
			return SecurityAssociation{}, nil, err
		}
	}
	if len(childSPI) != 4 {
		return SecurityAssociation{}, nil, fmt.Errorf("%w: child SPI length %d", ErrInvalidCreateChild, len(childSPI))
	}
	sa := cfg.ChildSA
	if len(sa.Proposals) == 0 {
		sa = cfg.OldChildSA.SelectedSA
	}
	if len(sa.Proposals) == 0 {
		sa = DefaultESPProposal(childSPI)
	} else {
		sa = cloneSecurityAssociation(sa)
		if len(sa.Proposals) != 1 {
			return SecurityAssociation{}, nil, fmt.Errorf("%w: proposal count %d", ErrInvalidCreateChild, len(sa.Proposals))
		}
		if sa.Proposals[0].ProtocolID != ProtocolESP {
			return SecurityAssociation{}, nil, fmt.Errorf("%w: protocol %d is not ESP", ErrInvalidCreateChild, sa.Proposals[0].ProtocolID)
		}
		sa.Proposals[0].SPI = append([]byte(nil), childSPI...)
	}
	return sa, childSPI, nil
}

func cloneTrafficSelectors(in TrafficSelectors) TrafficSelectors {
	out := TrafficSelectors{Selectors: make([]TrafficSelector, len(in.Selectors))}
	for i, selector := range in.Selectors {
		out.Selectors[i] = TrafficSelector{
			Type:       selector.Type,
			IPProtocol: selector.IPProtocol,
			StartPort:  selector.StartPort,
			EndPort:    selector.EndPort,
			StartAddr:  append([]byte(nil), selector.StartAddr...),
			EndAddr:    append([]byte(nil), selector.EndAddr...),
		}
	}
	return out
}
