package ikev2

import (
	"bytes"
	"context"
	"errors"
	"testing"
)

func TestNewChildSARekeyPlanInheritsOldChildParameters(t *testing.T) {
	init := fakeInitResult(t)
	oldChild := ChildSAResult{
		SelectedSA: DefaultESPProposal([]byte{0xde, 0xad, 0xbe, 0xef}),
		LocalSPI:   []byte{0x11, 0x22, 0x33, 0x44},
		RemoteSPI:  []byte{0xde, 0xad, 0xbe, 0xef},
		TSi:        IPv4AnyTrafficSelectors(),
		TSr:        IPv4AnyTrafficSelectors(),
	}
	plan, err := NewChildSARekeyPlan(ChildSARekeyConfig{
		Init:       init,
		MessageID:  12,
		OldChildSA: oldChild,
		ChildSPI:   []byte{0xaa, 0xbb, 0xcc, 0xdd},
		Nonce:      bytes.Repeat([]byte{0x33}, 32),
	})
	if err != nil {
		t.Fatalf("NewChildSARekeyPlan() error = %v", err)
	}
	if plan.Config.MessageID != 12 || !bytes.Equal(plan.Config.RekeySPI, oldChild.LocalSPI) ||
		!bytes.Equal(plan.Config.ChildSPI, []byte{0xaa, 0xbb, 0xcc, 0xdd}) ||
		!bytes.Equal(plan.NewLocalSPI, []byte{0xaa, 0xbb, 0xcc, 0xdd}) {
		t.Fatalf("plan=%+v", plan)
	}
	if got := plan.Config.ChildSA.Proposals[0].SPI; !bytes.Equal(got, []byte{0xaa, 0xbb, 0xcc, 0xdd}) {
		t.Fatalf("request proposal SPI=%x", got)
	}
	if got := oldChild.SelectedSA.Proposals[0].SPI; !bytes.Equal(got, []byte{0xde, 0xad, 0xbe, 0xef}) {
		t.Fatalf("old selected SA mutated, SPI=%x", got)
	}
	if len(plan.Config.TSi.Selectors) != 1 || len(plan.Config.TSr.Selectors) != 1 {
		t.Fatalf("traffic selectors not inherited: TSi=%+v TSr=%+v", plan.Config.TSi, plan.Config.TSr)
	}
}

func TestRunCREATECHILDSARekeyUsesRekeyNotify(t *testing.T) {
	init := fakeInitResult(t)
	oldChild := ChildSAResult{
		SelectedSA: DefaultESPProposal([]byte{0xde, 0xad, 0xbe, 0xef}),
		LocalSPI:   []byte{0x11, 0x22, 0x33, 0x44},
		RemoteSPI:  []byte{0xde, 0xad, 0xbe, 0xef},
		TSi:        IPv4AnyTrafficSelectors(),
		TSr:        IPv4AnyTrafficSelectors(),
	}
	transport := &createChildTransport{
		t:             t,
		init:          init,
		messageID:     13,
		localSPI:      []byte{0xaa, 0xbb, 0xcc, 0xdd},
		remoteSPI:     []byte{0xca, 0xfe, 0xba, 0xbe},
		responseNonce: bytes.Repeat([]byte{0x44}, 32),
		rekeySPI:      oldChild.LocalSPI,
	}
	res, err := RunCREATE_CHILD_SARekey(context.Background(), ChildSARekeyConfig{
		Transport:  transport,
		Init:       init,
		MessageID:  13,
		OldChildSA: oldChild,
		ChildSPI:   transport.localSPI,
		Nonce:      bytes.Repeat([]byte{0x55}, 32),
		IV:         bytes.Repeat([]byte{0x97}, init.Keys.Profile.EncryptionBlockSize),
	})
	if err != nil {
		t.Fatalf("RunCREATE_CHILD_SARekey() error = %v", err)
	}
	if !transport.sawRekey || !res.Rekeyed || !bytes.Equal(res.ChildSA.LocalSPI, transport.localSPI) ||
		!bytes.Equal(res.ChildSA.RemoteSPI, transport.remoteSPI) {
		t.Fatalf("sawRekey=%t res=%+v", transport.sawRekey, res)
	}
}

func TestNewChildSARekeyPlanRejectsInvalidSPIs(t *testing.T) {
	_, err := NewChildSARekeyPlan(ChildSARekeyConfig{
		OldChildSA: ChildSAResult{LocalSPI: []byte{1, 2, 3}},
		ChildSPI:   []byte{0xaa, 0xbb, 0xcc, 0xdd},
	})
	if !errors.Is(err, ErrInvalidCreateChild) {
		t.Fatalf("NewChildSARekeyPlan(old spi) err=%v, want ErrInvalidCreateChild", err)
	}
	_, err = NewChildSARekeyPlan(ChildSARekeyConfig{
		OldChildSA: ChildSAResult{LocalSPI: []byte{1, 2, 3, 4}},
		ChildSPI:   []byte{0xaa},
	})
	if !errors.Is(err, ErrInvalidCreateChild) {
		t.Fatalf("NewChildSARekeyPlan(child spi) err=%v, want ErrInvalidCreateChild", err)
	}
}
