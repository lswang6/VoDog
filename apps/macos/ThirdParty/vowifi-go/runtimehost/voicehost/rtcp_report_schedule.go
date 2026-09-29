package voicehost

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"
)

const maxRTCPUint32 = ^uint32(0)

type RTCPReportKind string

const (
	RTCPReportKindReceiver RTCPReportKind = "receiver"
	RTCPReportKindSender   RTCPReportKind = "sender"
)

type RTPRelayRTCPReportScheduleConfig struct {
	Enabled            bool
	Interval           time.Duration
	ClientToIMS        bool
	IMSToClient        bool
	Kind               RTCPReportKind
	SenderSSRC         uint32
	ClientToIMSSSRC    uint32
	IMSToClientSSRC    uint32
	ClientToIMSCNAME   string
	IMSToClientCNAME   string
	ClientToIMSRTPTime uint32
	IMSToClientRTPTime uint32
	ClientToIMSPackets uint32
	IMSToClientPackets uint32
	ClientToIMSOctets  uint32
	IMSToClientOctets  uint32
	RunImmediately     bool
	StopOnError        bool
}

type rtpRelayRTCPReportScheduler struct {
	session  *RTPRelaySession
	cancel   context.CancelFunc
	done     chan struct{}
	stopOnce sync.Once
}

func (s *RTPRelaySession) StartRTCPReportSchedule(ctx context.Context, cfg RTPRelayRTCPReportScheduleConfig) error {
	if s == nil {
		return ErrRTPRelayConfig
	}
	cfg = normalizeRTCPReportScheduleConfig(cfg)
	s.rtcpReportScheduleMu.Lock()
	defer s.rtcpReportScheduleMu.Unlock()
	if s.closedForRTCPReportSchedule() {
		return fmt.Errorf("%w: relay is closed", ErrRTPRelayConfig)
	}
	if s.rtcpReportSchedule != nil {
		s.rtcpReportSchedule.stop()
		s.rtcpReportSchedule = nil
	}
	if !cfg.Enabled {
		return nil
	}
	if cfg.Interval <= 0 {
		return fmt.Errorf("%w: RTCP report schedule interval must be positive", ErrRTPRelayConfig)
	}
	if ctx == nil {
		ctx = context.Background()
	}
	childCtx, cancel := context.WithCancel(ctx)
	scheduler := &rtpRelayRTCPReportScheduler{
		session: s,
		cancel:  cancel,
		done:    make(chan struct{}),
	}
	s.rtcpReportSchedule = scheduler
	go scheduler.run(childCtx, cfg)
	return nil
}

func (s *RTPRelaySession) StopRTCPReportSchedule() {
	if s == nil {
		return
	}
	s.rtcpReportScheduleMu.Lock()
	scheduler := s.rtcpReportSchedule
	s.rtcpReportSchedule = nil
	s.rtcpReportScheduleMu.Unlock()
	if scheduler != nil {
		scheduler.stop()
	}
}

func (s *RTPRelaySession) HasRTCPReportSchedule() bool {
	if s == nil {
		return false
	}
	s.rtcpReportScheduleMu.Lock()
	defer s.rtcpReportScheduleMu.Unlock()
	return s.rtcpReportSchedule != nil
}

func (s *rtpRelayRTCPReportScheduler) stop() {
	if s == nil {
		return
	}
	s.stopOnce.Do(func() {
		if s.cancel != nil {
			s.cancel()
		}
		if s.done != nil {
			<-s.done
		}
	})
}

func (s *rtpRelayRTCPReportScheduler) run(ctx context.Context, cfg RTPRelayRTCPReportScheduleConfig) {
	defer close(s.done)
	if cfg.RunImmediately {
		if err := s.send(ctx, cfg); err != nil && cfg.StopOnError {
			return
		}
	}
	ticker := time.NewTicker(cfg.Interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if err := s.send(ctx, cfg); err != nil && cfg.StopOnError {
				return
			}
		}
	}
}

func (s *rtpRelayRTCPReportScheduler) send(ctx context.Context, cfg RTPRelayRTCPReportScheduleConfig) error {
	if s == nil || s.session == nil {
		return ErrRTPRelayConfig
	}
	var err error
	if cfg.ClientToIMS {
		err = errors.Join(err, s.sendDirection(ctx, cfg, RTCPFeedbackClientToIMS))
	}
	if cfg.IMSToClient {
		err = errors.Join(err, s.sendDirection(ctx, cfg, RTCPFeedbackIMSToClient))
	}
	return err
}

func (s *rtpRelayRTCPReportScheduler) sendDirection(ctx context.Context, cfg RTPRelayRTCPReportScheduleConfig, direction RTCPFeedbackDirection) error {
	switch cfg.Kind {
	case RTCPReportKindSender:
		_, err := s.session.SendSenderReport(ctx, scheduledSenderReportRequest(s.session, cfg, direction))
		return err
	default:
		_, err := s.session.SendReceiverReport(ctx, RTPRelayReceiverReportRequest{
			Direction:  direction,
			SenderSSRC: scheduledReceiverReportSSRC(cfg, direction),
		})
		return err
	}
}

func normalizeRTCPReportScheduleConfig(cfg RTPRelayRTCPReportScheduleConfig) RTPRelayRTCPReportScheduleConfig {
	if !cfg.Enabled {
		return cfg
	}
	if !cfg.ClientToIMS && !cfg.IMSToClient {
		cfg.ClientToIMS = true
		cfg.IMSToClient = true
	}
	switch RTCPReportKind(strings.ToLower(strings.TrimSpace(string(cfg.Kind)))) {
	case RTCPReportKindSender:
		cfg.Kind = RTCPReportKindSender
	default:
		cfg.Kind = RTCPReportKindReceiver
	}
	return cfg
}

func scheduledReceiverReportSSRC(cfg RTPRelayRTCPReportScheduleConfig, direction RTCPFeedbackDirection) uint32 {
	switch direction {
	case RTCPFeedbackClientToIMS:
		if cfg.ClientToIMSSSRC != 0 {
			return cfg.ClientToIMSSSRC
		}
	case RTCPFeedbackIMSToClient:
		if cfg.IMSToClientSSRC != 0 {
			return cfg.IMSToClientSSRC
		}
	}
	return cfg.SenderSSRC
}

func scheduledSenderReportRequest(session *RTPRelaySession, cfg RTPRelayRTCPReportScheduleConfig, direction RTCPFeedbackDirection) RTPRelaySenderReportRequest {
	packetCount := cfg.ClientToIMSPackets
	octetCount := cfg.ClientToIMSOctets
	if packetCount == 0 && octetCount == 0 && session != nil {
		packetCount, octetCount = session.rtcpSenderReportCounters(direction)
	}
	req := RTPRelaySenderReportRequest{
		Direction:   direction,
		SSRC:        scheduledReceiverReportSSRC(cfg, direction),
		WallClock:   time.Now(),
		RTPTime:     cfg.ClientToIMSRTPTime,
		PacketCount: packetCount,
		OctetCount:  octetCount,
		CNAME:       strings.TrimSpace(cfg.ClientToIMSCNAME),
	}
	if direction == RTCPFeedbackIMSToClient {
		packetCount = cfg.IMSToClientPackets
		octetCount = cfg.IMSToClientOctets
		if packetCount == 0 && octetCount == 0 && session != nil {
			packetCount, octetCount = session.rtcpSenderReportCounters(direction)
		}
		req.RTPTime = cfg.IMSToClientRTPTime
		req.PacketCount = packetCount
		req.OctetCount = octetCount
		req.CNAME = strings.TrimSpace(cfg.IMSToClientCNAME)
	}
	return req
}

func (s *RTPRelaySession) closedForRTCPReportSchedule() bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.closed
}

func (s *RTPRelaySession) rtcpSenderReportCounters(direction RTCPFeedbackDirection) (uint32, uint32) {
	switch direction {
	case RTCPFeedbackClientToIMS:
		return rtcpClampUint32(s.clientToIMSRTPPackets.Load()), rtcpClampUint32(s.clientToIMSRTPBytes.Load())
	case RTCPFeedbackIMSToClient:
		return rtcpClampUint32(s.imsToClientRTPPackets.Load()), rtcpClampUint32(s.imsToClientRTPBytes.Load())
	default:
		return 0, 0
	}
}

func rtcpClampUint32(v uint64) uint32 {
	if v > uint64(maxRTCPUint32) {
		return maxRTCPUint32
	}
	return uint32(v)
}
