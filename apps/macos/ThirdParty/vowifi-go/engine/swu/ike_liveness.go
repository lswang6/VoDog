package swu

import (
	"errors"
	"fmt"
	"time"
)

var ErrInvalidIKELiveness = errors.New("invalid swu ike liveness")

const (
	defaultIKEKeepaliveInterval = 20 * time.Second
	defaultIKEDPDInterval       = 60 * time.Second
	defaultIKEDPDTimeout        = 15 * time.Second
	defaultIKEMissedDPDProbes   = 3
)

type IKELivenessAction uint8

const (
	IKELivenessNoAction IKELivenessAction = iota
	IKELivenessSendKeepalive
	IKELivenessSendDPD
	IKELivenessDeclareDead
)

func (a IKELivenessAction) String() string {
	switch a {
	case IKELivenessNoAction:
		return "none"
	case IKELivenessSendKeepalive:
		return "keepalive"
	case IKELivenessSendDPD:
		return "dpd"
	case IKELivenessDeclareDead:
		return "dead"
	default:
		return fmt.Sprintf("ike liveness action %d", a)
	}
}

type IKELivenessConfig struct {
	KeepaliveInterval  time.Duration
	DPDInterval        time.Duration
	DPDTimeout         time.Duration
	MaxMissedDPDProbes int
	DisableKeepalive   bool
	DisableDPD         bool
}

type IKELivenessDecision struct {
	Action          IKELivenessAction
	ProbeID         uint32
	MissedDPDProbes int
	IdleFor         time.Duration
	Deadline        time.Time
	NextDue         time.Time
	Dead            bool
	Reason          string
}

type IKELivenessSnapshot struct {
	LastInbound      time.Time
	LastOutbound     time.Time
	LastDPDProbe     time.Time
	OutstandingDPD   bool
	ProbeID          uint32
	MissedDPDProbes  int
	Dead             bool
	KeepaliveEnabled bool
	DPDEnabled       bool
}

type IKELivenessState struct {
	cfg              IKELivenessConfig
	lastInbound      time.Time
	lastOutbound     time.Time
	lastDPDProbe     time.Time
	outstandingDPD   bool
	probeID          uint32
	missedDPDProbes  int
	dead             bool
	keepaliveEnabled bool
	dpdEnabled       bool
}

func NewIKELivenessState(cfg IKELivenessConfig, establishedAt time.Time) (*IKELivenessState, error) {
	normalized, keepaliveEnabled, dpdEnabled, err := normalizeIKELivenessConfig(cfg)
	if err != nil {
		return nil, err
	}
	if establishedAt.IsZero() {
		establishedAt = time.Now()
	}
	return &IKELivenessState{
		cfg:              normalized,
		lastInbound:      establishedAt,
		lastOutbound:     establishedAt,
		keepaliveEnabled: keepaliveEnabled,
		dpdEnabled:       dpdEnabled,
	}, nil
}

func NATTKeepalivePayload() []byte {
	return []byte{0xff}
}

func (s *IKELivenessState) RecordInbound(at time.Time) {
	if s == nil {
		return
	}
	if at.IsZero() {
		at = time.Now()
	}
	if at.After(s.lastInbound) || s.lastInbound.IsZero() {
		s.lastInbound = at
	}
	s.outstandingDPD = false
	s.missedDPDProbes = 0
	s.dead = false
}

func (s *IKELivenessState) RecordOutbound(at time.Time) {
	if s == nil {
		return
	}
	if at.IsZero() {
		at = time.Now()
	}
	if at.After(s.lastOutbound) || s.lastOutbound.IsZero() {
		s.lastOutbound = at
	}
}

func (s *IKELivenessState) RecordLivenessResult(at time.Time, ok bool) {
	if s == nil {
		return
	}
	if ok {
		s.RecordInbound(at)
		return
	}
	if at.IsZero() {
		at = time.Now()
	}
	if !s.outstandingDPD || s.dead {
		return
	}
	s.missedDPDProbes++
	if s.missedDPDProbes >= s.cfg.MaxMissedDPDProbes {
		s.dead = true
	}
}

func (s *IKELivenessState) Advance(now time.Time) IKELivenessDecision {
	if s == nil {
		return IKELivenessDecision{
			Action: IKELivenessNoAction,
			Reason: "liveness state is nil",
		}
	}
	if now.IsZero() {
		now = time.Now()
	}
	if s.dead {
		return s.decision(now, IKELivenessNoAction, "peer already declared dead")
	}
	if decision := s.advanceDPD(now); decision.Action != IKELivenessNoAction {
		return decision
	}
	if s.keepaliveEnabled && !now.Before(s.lastOutbound.Add(s.cfg.KeepaliveInterval)) {
		s.lastOutbound = now
		return s.decision(now, IKELivenessSendKeepalive, "keepalive interval elapsed")
	}
	return s.decision(now, IKELivenessNoAction, "not due")
}

func (s *IKELivenessState) Snapshot() IKELivenessSnapshot {
	if s == nil {
		return IKELivenessSnapshot{}
	}
	return IKELivenessSnapshot{
		LastInbound:      s.lastInbound,
		LastOutbound:     s.lastOutbound,
		LastDPDProbe:     s.lastDPDProbe,
		OutstandingDPD:   s.outstandingDPD,
		ProbeID:          s.probeID,
		MissedDPDProbes:  s.missedDPDProbes,
		Dead:             s.dead,
		KeepaliveEnabled: s.keepaliveEnabled,
		DPDEnabled:       s.dpdEnabled,
	}
}

func (s *IKELivenessState) advanceDPD(now time.Time) IKELivenessDecision {
	if !s.dpdEnabled {
		return s.decision(now, IKELivenessNoAction, "dpd disabled")
	}
	if s.outstandingDPD {
		deadline := s.lastDPDProbe.Add(s.cfg.DPDTimeout)
		if now.Before(deadline) {
			return s.decision(now, IKELivenessNoAction, "waiting for dpd response")
		}
		s.missedDPDProbes++
		if s.missedDPDProbes >= s.cfg.MaxMissedDPDProbes {
			s.dead = true
			return s.decision(now, IKELivenessDeclareDead, "dpd retry budget exhausted")
		}
		return s.sendDPD(now, "dpd response timeout")
	}
	if now.Before(s.lastInbound.Add(s.cfg.DPDInterval)) {
		return s.decision(now, IKELivenessNoAction, "peer traffic observed recently")
	}
	return s.sendDPD(now, "dpd interval elapsed")
}

func (s *IKELivenessState) sendDPD(now time.Time, reason string) IKELivenessDecision {
	s.probeID++
	s.outstandingDPD = true
	s.lastDPDProbe = now
	s.lastOutbound = now
	return s.decision(now, IKELivenessSendDPD, reason)
}

func (s *IKELivenessState) decision(now time.Time, action IKELivenessAction, reason string) IKELivenessDecision {
	deadline := time.Time{}
	if s.outstandingDPD {
		deadline = s.lastDPDProbe.Add(s.cfg.DPDTimeout)
	}
	nextDue := s.nextDue(now)
	idleFor := time.Duration(0)
	if !s.lastInbound.IsZero() && now.After(s.lastInbound) {
		idleFor = now.Sub(s.lastInbound)
	}
	return IKELivenessDecision{
		Action:          action,
		ProbeID:         s.probeID,
		MissedDPDProbes: s.missedDPDProbes,
		IdleFor:         idleFor,
		Deadline:        deadline,
		NextDue:         nextDue,
		Dead:            s.dead,
		Reason:          reason,
	}
}

func (s *IKELivenessState) nextDue(now time.Time) time.Time {
	var due time.Time
	if s.dpdEnabled {
		var dpdDue time.Time
		if s.outstandingDPD {
			dpdDue = s.lastDPDProbe.Add(s.cfg.DPDTimeout)
		} else {
			dpdDue = s.lastInbound.Add(s.cfg.DPDInterval)
		}
		due = earlierDue(due, dpdDue)
	}
	if s.keepaliveEnabled && !s.outstandingDPD {
		due = earlierDue(due, s.lastOutbound.Add(s.cfg.KeepaliveInterval))
	}
	if due.IsZero() || due.Before(now) {
		return now
	}
	return due
}

func normalizeIKELivenessConfig(cfg IKELivenessConfig) (IKELivenessConfig, bool, bool, error) {
	if cfg.KeepaliveInterval < 0 || cfg.DPDInterval < 0 || cfg.DPDTimeout < 0 || cfg.MaxMissedDPDProbes < 0 {
		return IKELivenessConfig{}, false, false, fmt.Errorf("%w: negative interval or retry value", ErrInvalidIKELiveness)
	}
	keepaliveEnabled := !cfg.DisableKeepalive
	if cfg.KeepaliveInterval == 0 {
		cfg.KeepaliveInterval = defaultIKEKeepaliveInterval
	}
	dpdEnabled := !cfg.DisableDPD
	if cfg.DPDInterval == 0 {
		cfg.DPDInterval = defaultIKEDPDInterval
	}
	if cfg.DPDTimeout == 0 {
		cfg.DPDTimeout = defaultIKEDPDTimeout
	}
	if cfg.MaxMissedDPDProbes == 0 {
		cfg.MaxMissedDPDProbes = defaultIKEMissedDPDProbes
	}
	if dpdEnabled && cfg.DPDTimeout > cfg.DPDInterval {
		return IKELivenessConfig{}, false, false, fmt.Errorf("%w: dpd timeout exceeds interval", ErrInvalidIKELiveness)
	}
	return cfg, keepaliveEnabled, dpdEnabled, nil
}

func earlierDue(current, candidate time.Time) time.Time {
	if candidate.IsZero() {
		return current
	}
	if current.IsZero() || candidate.Before(current) {
		return candidate
	}
	return current
}
