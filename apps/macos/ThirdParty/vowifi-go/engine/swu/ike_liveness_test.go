package swu

import (
	"bytes"
	"errors"
	"testing"
	"time"
)

func TestIKELivenessSchedulerKeepsNATMappingWarm(t *testing.T) {
	start := time.Unix(1000, 0)
	state, err := NewIKELivenessState(IKELivenessConfig{
		KeepaliveInterval:  20 * time.Second,
		DPDInterval:        time.Minute,
		DPDTimeout:         10 * time.Second,
		MaxMissedDPDProbes: 3,
	}, start)
	if err != nil {
		t.Fatalf("NewIKELivenessState() error = %v", err)
	}
	if decision := state.Advance(start.Add(19 * time.Second)); decision.Action != IKELivenessNoAction {
		t.Fatalf("Advance(19s) action=%s, want none", decision.Action)
	}
	decision := state.Advance(start.Add(20 * time.Second))
	if decision.Action != IKELivenessSendKeepalive || decision.NextDue.Before(start.Add(40*time.Second)) {
		t.Fatalf("Advance(20s) decision=%+v", decision)
	}
	if got := NATTKeepalivePayload(); !bytes.Equal(got, []byte{0xff}) {
		t.Fatalf("NATTKeepalivePayload()=%x, want ff", got)
	}
}

func TestIKELivenessSchedulerSendsDPDAndResetsOnInbound(t *testing.T) {
	start := time.Unix(2000, 0)
	state, err := NewIKELivenessState(IKELivenessConfig{
		DisableKeepalive:   true,
		KeepaliveInterval:  20 * time.Second,
		DPDInterval:        30 * time.Second,
		DPDTimeout:         10 * time.Second,
		MaxMissedDPDProbes: 3,
	}, start)
	if err != nil {
		t.Fatalf("NewIKELivenessState() error = %v", err)
	}
	decision := state.Advance(start.Add(30 * time.Second))
	if decision.Action != IKELivenessSendDPD || decision.ProbeID != 1 || decision.MissedDPDProbes != 0 {
		t.Fatalf("first DPD decision=%+v", decision)
	}
	state.RecordInbound(start.Add(32 * time.Second))
	snapshot := state.Snapshot()
	if snapshot.OutstandingDPD || snapshot.MissedDPDProbes != 0 {
		t.Fatalf("snapshot after inbound=%+v", snapshot)
	}
	if decision := state.Advance(start.Add(50 * time.Second)); decision.Action != IKELivenessNoAction {
		t.Fatalf("Advance after inbound action=%s, want none", decision.Action)
	}
}

func TestIKELivenessSchedulerRetriesAndDeclaresDead(t *testing.T) {
	start := time.Unix(3000, 0)
	state, err := NewIKELivenessState(IKELivenessConfig{
		DisableKeepalive:   true,
		DPDInterval:        30 * time.Second,
		DPDTimeout:         10 * time.Second,
		MaxMissedDPDProbes: 2,
	}, start)
	if err != nil {
		t.Fatalf("NewIKELivenessState() error = %v", err)
	}
	first := state.Advance(start.Add(30 * time.Second))
	if first.Action != IKELivenessSendDPD || first.ProbeID != 1 {
		t.Fatalf("first=%+v", first)
	}
	retry := state.Advance(start.Add(40 * time.Second))
	if retry.Action != IKELivenessSendDPD || retry.ProbeID != 2 || retry.MissedDPDProbes != 1 {
		t.Fatalf("retry=%+v", retry)
	}
	dead := state.Advance(start.Add(50 * time.Second))
	if dead.Action != IKELivenessDeclareDead || !dead.Dead || dead.MissedDPDProbes != 2 {
		t.Fatalf("dead=%+v", dead)
	}
	if got := state.Advance(start.Add(time.Minute)); got.Action != IKELivenessNoAction || !got.Dead {
		t.Fatalf("after dead=%+v", got)
	}
}

func TestIKELivenessRejectsInvalidConfig(t *testing.T) {
	_, err := NewIKELivenessState(IKELivenessConfig{KeepaliveInterval: -time.Second}, time.Unix(1, 0))
	if !errors.Is(err, ErrInvalidIKELiveness) {
		t.Fatalf("NewIKELivenessState(negative) err=%v, want ErrInvalidIKELiveness", err)
	}
	_, err = NewIKELivenessState(IKELivenessConfig{
		DPDInterval: 10 * time.Second,
		DPDTimeout:  11 * time.Second,
	}, time.Unix(1, 0))
	if !errors.Is(err, ErrInvalidIKELiveness) {
		t.Fatalf("NewIKELivenessState(timeout > interval) err=%v, want ErrInvalidIKELiveness", err)
	}
}
