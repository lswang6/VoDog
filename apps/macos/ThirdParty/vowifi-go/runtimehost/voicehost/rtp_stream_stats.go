package voicehost

import (
	"errors"
	"fmt"
	"sort"
	"time"

	"github.com/pion/rtcp"
)

var ErrRTPStreamStats = errors.New("invalid rtp stream stats")

// RTPStreamStats is a reception snapshot for one RTP SSRC.
type RTPStreamStats struct {
	SSRC               uint32
	Packets            uint64
	DuplicatePackets   uint64
	OutOfOrderPackets  uint64
	ExpectedPackets    uint64
	LostPackets        uint64
	FractionLost       uint8
	LastSequenceNumber uint32
	SequenceRollovers  uint32
	LastTimestamp      uint64
	TimestampRollovers uint32
	Jitter             uint32
	LastSenderReport   uint32
	Delay              uint32
}

type RTPStreamDiagnosisStatus string

const (
	RTPStreamDiagnosisStatusUnknown  RTPStreamDiagnosisStatus = "unknown"
	RTPStreamDiagnosisStatusOK       RTPStreamDiagnosisStatus = "ok"
	RTPStreamDiagnosisStatusWarning  RTPStreamDiagnosisStatus = "warning"
	RTPStreamDiagnosisStatusCritical RTPStreamDiagnosisStatus = "critical"
)

type RTPStreamDiagnosisReason string

const (
	RTPStreamDiagnosisReasonNoRTP         RTPStreamDiagnosisReason = "no_rtp"
	RTPStreamDiagnosisReasonPacketLoss    RTPStreamDiagnosisReason = "packet_loss"
	RTPStreamDiagnosisReasonJitter        RTPStreamDiagnosisReason = "jitter"
	RTPStreamDiagnosisReasonRTCPKeepalive RTPStreamDiagnosisReason = "rtcp_keepalive"
	RTPStreamDiagnosisReasonRoundTripTime RTPStreamDiagnosisReason = "round_trip_time"
)

const (
	defaultRTPDiagnosisMinExpectedPackets = 20
	defaultRTPDiagnosisLossWarning        = 13
	defaultRTPDiagnosisLossCritical       = 26
	defaultRTPDiagnosisJitterWarning      = 30 * time.Millisecond
	defaultRTPDiagnosisJitterCritical     = 100 * time.Millisecond
	defaultRTPDiagnosisRoundTripWarning   = 300 * time.Millisecond
	defaultRTPDiagnosisRoundTripCritical  = 800 * time.Millisecond
)

// RTPStreamDiagnosisConfig tunes the conservative thresholds used to classify a
// received RTP stream and remote RTCP reception reports. RTCP keepalive
// classification is enabled only when RTCPKeepaliveInterval is positive or
// RequireRTCP is true.
type RTPStreamDiagnosisConfig struct {
	ClockRate             int
	MinExpectedPackets    uint64
	LossWarningFraction   uint8
	LossCriticalFraction  uint8
	JitterWarning         time.Duration
	JitterCritical        time.Duration
	RoundTripWarning      time.Duration
	RoundTripCritical     time.Duration
	RTCPKeepaliveInterval time.Duration
	RTCPKeepaliveGrace    time.Duration
	RequireRTCP           bool
}

type RTPStreamDiagnosis struct {
	SSRC          uint32
	Status        RTPStreamDiagnosisStatus
	Reasons       []RTPStreamDiagnosisReason
	Loss          RTPStreamLossDiagnosis
	Jitter        RTPStreamJitterDiagnosis
	RTCPKeepalive RTPStreamRTCPKeepaliveDiagnosis
}

type RTPStreamLossDiagnosis struct {
	Status          RTPStreamDiagnosisStatus
	FractionLost    uint8
	LostPackets     uint64
	ExpectedPackets uint64
}

type RTPStreamJitterDiagnosis struct {
	Status   RTPStreamDiagnosisStatus
	Jitter   uint32
	Duration time.Duration
}

type RTPStreamRTCPKeepaliveDiagnosis struct {
	Status           RTPStreamDiagnosisStatus
	LastSenderReport uint32
	Delay            time.Duration
	StaleAfter       time.Duration
	Missing          bool
}

// RTPStreamStatsTracker keeps RTP reception statistics split by SSRC.
type RTPStreamStatsTracker struct {
	streams       map[uint32]*rtpStreamStatsState
	senderReports map[uint32]rtpStreamSenderReportState
}

// NewRTPStreamStatsTracker returns an empty tracker. The zero value is also usable.
func NewRTPStreamStatsTracker() *RTPStreamStatsTracker {
	return &RTPStreamStatsTracker{}
}

// DiagnoseRTPStreamStats classifies RTP stream snapshots without touching the
// network or requiring a live relay. The output preserves input order.
func DiagnoseRTPStreamStats(stats []RTPStreamStats, cfg RTPStreamDiagnosisConfig) []RTPStreamDiagnosis {
	if len(stats) == 0 {
		return nil
	}
	out := make([]RTPStreamDiagnosis, 0, len(stats))
	for _, stream := range stats {
		out = append(out, stream.Diagnose(cfg))
	}
	return out
}

// Diagnose classifies packet loss, jitter, and RTCP keepalive freshness for one
// RTP stream snapshot.
func (s RTPStreamStats) Diagnose(cfg RTPStreamDiagnosisConfig) RTPStreamDiagnosis {
	cfg = normalizeRTPStreamDiagnosisConfig(cfg)
	diagnosis := RTPStreamDiagnosis{
		SSRC:          s.SSRC,
		Status:        RTPStreamDiagnosisStatusUnknown,
		Loss:          diagnoseRTPStreamLoss(s, cfg),
		Jitter:        diagnoseRTPStreamJitter(s, cfg),
		RTCPKeepalive: diagnoseRTPStreamRTCPKeepalive(s, cfg),
	}
	if s.Packets == 0 {
		diagnosis.Status = RTPStreamDiagnosisStatusCritical
		diagnosis.Reasons = append(diagnosis.Reasons, RTPStreamDiagnosisReasonNoRTP)
		return diagnosis
	}
	diagnosis.addMetric(diagnosis.Loss.Status, RTPStreamDiagnosisReasonPacketLoss)
	diagnosis.addMetric(diagnosis.Jitter.Status, RTPStreamDiagnosisReasonJitter)
	diagnosis.addMetric(diagnosis.RTCPKeepalive.Status, RTPStreamDiagnosisReasonRTCPKeepalive)
	return diagnosis
}

// ObserveRTPPacket parses one RTP packet and updates the matching SSRC stream.
func (t *RTPStreamStatsTracker) ObserveRTPPacket(packet []byte, arrival time.Time, clockRate int) (RTPStreamStats, error) {
	if clockRate <= 0 {
		return RTPStreamStats{}, fmt.Errorf("%w: clock rate must be positive", ErrRTPStreamStats)
	}
	header, _, err := parseRTPPacket(packet)
	if err != nil {
		return RTPStreamStats{}, err
	}
	if t.streams == nil {
		t.streams = make(map[uint32]*rtpStreamStatsState)
	}
	state := t.streams[header.SSRC]
	if state == nil {
		state = newRTPStreamStatsState(header, arrival)
		if senderReport, ok := t.senderReports[header.SSRC]; ok {
			state.senderReport = senderReport
		}
		t.streams[header.SSRC] = state
		return state.snapshotAt(arrival), nil
	}
	state.observe(header, arrival, clockRate)
	return state.snapshotAt(arrival), nil
}

// ObserveRTCPSenderReport records the newest SR timing for an RTP source so
// future RTCP reception reports can include LSR/DLSR timing fields.
func (t *RTPStreamStatsTracker) ObserveRTCPSenderReport(ssrc uint32, ntpTime uint64, arrival time.Time) (RTPStreamStats, bool) {
	if ntpTime == 0 {
		return RTPStreamStats{}, false
	}
	if arrival.IsZero() {
		arrival = time.Now()
	}
	report := rtpStreamSenderReportState{
		lastSenderReport: rtcpLastSenderReport(ntpTime),
		arrival:          arrival,
	}
	if t.senderReports == nil {
		t.senderReports = make(map[uint32]rtpStreamSenderReportState)
	}
	t.senderReports[ssrc] = report
	state := t.streams[ssrc]
	if state == nil {
		return RTPStreamStats{}, false
	}
	state.senderReport = report
	return state.snapshotAt(arrival), true
}

// ObserveRTCPPacket parses one RTCP datagram and records any Sender Reports it
// contains. Snapshots are returned only for SSRCs whose RTP stream is already
// being tracked; Sender Reports for future streams are still remembered.
func (t *RTPStreamStatsTracker) ObserveRTCPPacket(packet []byte, arrival time.Time) ([]RTPStreamStats, error) {
	if t == nil {
		return nil, fmt.Errorf("%w: tracker is nil", ErrRTPStreamStats)
	}
	packets, err := rtcp.Unmarshal(packet)
	if err != nil {
		return nil, err
	}
	return t.observeRTCPPackets(packets, arrival), nil
}

// Stats returns deterministic snapshots ordered by SSRC.
func (t *RTPStreamStatsTracker) Stats() []RTPStreamStats {
	return t.StatsAt(time.Now())
}

// StatsAt returns deterministic snapshots ordered by SSRC with DLSR measured
// against now for streams that have observed an RTCP sender report.
func (t *RTPStreamStatsTracker) StatsAt(now time.Time) []RTPStreamStats {
	if t == nil || len(t.streams) == 0 {
		return nil
	}
	out := make([]RTPStreamStats, 0, len(t.streams))
	for _, state := range t.streams {
		out = append(out, state.snapshotAt(now))
	}
	sort.Slice(out, func(i, j int) bool {
		return out[i].SSRC < out[j].SSRC
	})
	return out
}

// StatsForSSRC returns a snapshot for one SSRC when the tracker has observed it.
func (t *RTPStreamStatsTracker) StatsForSSRC(ssrc uint32) (RTPStreamStats, bool) {
	return t.StatsForSSRCAt(ssrc, time.Now())
}

// StatsForSSRCAt returns a snapshot for one SSRC with DLSR measured against now.
func (t *RTPStreamStatsTracker) StatsForSSRCAt(ssrc uint32, now time.Time) (RTPStreamStats, bool) {
	if t == nil {
		return RTPStreamStats{}, false
	}
	state := t.streams[ssrc]
	if state == nil {
		return RTPStreamStats{}, false
	}
	return state.snapshotAt(now), true
}

func diagnoseRTPStreamLoss(s RTPStreamStats, cfg RTPStreamDiagnosisConfig) RTPStreamLossDiagnosis {
	diagnosis := RTPStreamLossDiagnosis{
		Status:          RTPStreamDiagnosisStatusUnknown,
		FractionLost:    s.FractionLost,
		LostPackets:     s.LostPackets,
		ExpectedPackets: s.ExpectedPackets,
	}
	if s.Packets == 0 || s.ExpectedPackets < cfg.MinExpectedPackets {
		return diagnosis
	}
	switch {
	case s.FractionLost >= cfg.LossCriticalFraction:
		diagnosis.Status = RTPStreamDiagnosisStatusCritical
	case s.FractionLost >= cfg.LossWarningFraction:
		diagnosis.Status = RTPStreamDiagnosisStatusWarning
	default:
		diagnosis.Status = RTPStreamDiagnosisStatusOK
	}
	return diagnosis
}

func diagnoseRTPStreamJitter(s RTPStreamStats, cfg RTPStreamDiagnosisConfig) RTPStreamJitterDiagnosis {
	diagnosis := RTPStreamJitterDiagnosis{
		Status: RTPStreamDiagnosisStatusUnknown,
		Jitter: s.Jitter,
	}
	if s.Packets < 2 || cfg.ClockRate <= 0 {
		return diagnosis
	}
	diagnosis.Duration = rtpTimestampUnitsDuration(s.Jitter, cfg.ClockRate)
	switch {
	case diagnosis.Duration >= cfg.JitterCritical:
		diagnosis.Status = RTPStreamDiagnosisStatusCritical
	case diagnosis.Duration >= cfg.JitterWarning:
		diagnosis.Status = RTPStreamDiagnosisStatusWarning
	default:
		diagnosis.Status = RTPStreamDiagnosisStatusOK
	}
	return diagnosis
}

func diagnoseRTPStreamRTCPKeepalive(s RTPStreamStats, cfg RTPStreamDiagnosisConfig) RTPStreamRTCPKeepaliveDiagnosis {
	diagnosis := RTPStreamRTCPKeepaliveDiagnosis{
		Status:           RTPStreamDiagnosisStatusUnknown,
		LastSenderReport: s.LastSenderReport,
		Delay:            rtcpCompactDelayDuration(s.Delay),
	}
	if cfg.RTCPKeepaliveInterval > 0 {
		diagnosis.StaleAfter = cfg.RTCPKeepaliveInterval + cfg.RTCPKeepaliveGrace
	}
	if s.LastSenderReport == 0 {
		if cfg.RequireRTCP && s.Packets > 0 && s.ExpectedPackets >= cfg.MinExpectedPackets {
			diagnosis.Status = RTPStreamDiagnosisStatusWarning
			diagnosis.Missing = true
		}
		return diagnosis
	}
	if diagnosis.StaleAfter <= 0 {
		if cfg.RequireRTCP {
			diagnosis.Status = RTPStreamDiagnosisStatusOK
		}
		return diagnosis
	}
	switch {
	case diagnosis.Delay >= 2*diagnosis.StaleAfter:
		diagnosis.Status = RTPStreamDiagnosisStatusCritical
	case diagnosis.Delay > diagnosis.StaleAfter:
		diagnosis.Status = RTPStreamDiagnosisStatusWarning
	default:
		diagnosis.Status = RTPStreamDiagnosisStatusOK
	}
	return diagnosis
}

func normalizeRTPStreamDiagnosisConfig(cfg RTPStreamDiagnosisConfig) RTPStreamDiagnosisConfig {
	if cfg.MinExpectedPackets == 0 {
		cfg.MinExpectedPackets = defaultRTPDiagnosisMinExpectedPackets
	}
	if cfg.LossWarningFraction == 0 {
		cfg.LossWarningFraction = defaultRTPDiagnosisLossWarning
	}
	if cfg.LossCriticalFraction == 0 {
		cfg.LossCriticalFraction = defaultRTPDiagnosisLossCritical
	}
	if cfg.LossCriticalFraction < cfg.LossWarningFraction {
		cfg.LossCriticalFraction = cfg.LossWarningFraction
	}
	if cfg.JitterWarning <= 0 {
		cfg.JitterWarning = defaultRTPDiagnosisJitterWarning
	}
	if cfg.JitterCritical <= 0 {
		cfg.JitterCritical = defaultRTPDiagnosisJitterCritical
	}
	if cfg.JitterCritical < cfg.JitterWarning {
		cfg.JitterCritical = cfg.JitterWarning
	}
	if cfg.RoundTripWarning <= 0 {
		cfg.RoundTripWarning = defaultRTPDiagnosisRoundTripWarning
	}
	if cfg.RoundTripCritical <= 0 {
		cfg.RoundTripCritical = defaultRTPDiagnosisRoundTripCritical
	}
	if cfg.RoundTripCritical < cfg.RoundTripWarning {
		cfg.RoundTripCritical = cfg.RoundTripWarning
	}
	if cfg.RTCPKeepaliveInterval > 0 && cfg.RTCPKeepaliveGrace <= 0 {
		cfg.RTCPKeepaliveGrace = cfg.RTCPKeepaliveInterval
	}
	return cfg
}

func (d *RTPStreamDiagnosis) addMetric(status RTPStreamDiagnosisStatus, reason RTPStreamDiagnosisReason) {
	if rtpStreamDiagnosisStatusRank(status) > rtpStreamDiagnosisStatusRank(d.Status) {
		d.Status = status
	}
	if rtpStreamDiagnosisStatusRank(status) >= rtpStreamDiagnosisStatusRank(RTPStreamDiagnosisStatusWarning) {
		d.Reasons = append(d.Reasons, reason)
	}
}

func rtpStreamDiagnosisStatusRank(status RTPStreamDiagnosisStatus) int {
	switch status {
	case RTPStreamDiagnosisStatusOK:
		return 1
	case RTPStreamDiagnosisStatusWarning:
		return 2
	case RTPStreamDiagnosisStatusCritical:
		return 3
	default:
		return 0
	}
}

func rtpTimestampUnitsDuration(units uint32, clockRate int) time.Duration {
	if clockRate <= 0 {
		return 0
	}
	seconds := uint64(units) / uint64(clockRate)
	remainder := uint64(units) % uint64(clockRate)
	return time.Duration(seconds)*time.Second + time.Duration(remainder)*time.Second/time.Duration(clockRate)
}

type rtpStreamStatsState struct {
	stats         RTPStreamStats
	baseSeq       uint32
	maxSeq        uint32
	seenSequences map[uint32]struct{}
	baseArrival   time.Time
	baseTimestamp uint64
	lastTimestamp uint64
	lastTransit   int64
	jitter        float64
	senderReport  rtpStreamSenderReportState
}

type rtpStreamSenderReportState struct {
	lastSenderReport uint32
	arrival          time.Time
}

func newRTPStreamStatsState(header rtpPacketHeader, arrival time.Time) *rtpStreamStatsState {
	seq := uint32(header.SequenceNumber)
	state := &rtpStreamStatsState{
		stats: RTPStreamStats{
			SSRC:               header.SSRC,
			Packets:            1,
			ExpectedPackets:    1,
			LastSequenceNumber: seq,
			LastTimestamp:      uint64(header.Timestamp),
		},
		baseSeq:       seq,
		maxSeq:        seq,
		seenSequences: map[uint32]struct{}{seq: {}},
		baseArrival:   arrival,
		baseTimestamp: uint64(header.Timestamp),
		lastTimestamp: uint64(header.Timestamp),
	}
	return state
}

func (s *rtpStreamStatsState) observe(header rtpPacketHeader, arrival time.Time, clockRate int) {
	seq := extendRTPSequence(s.maxSeq, header.SequenceNumber)
	if _, ok := s.seenSequences[seq]; ok {
		s.stats.DuplicatePackets++
		return
	}
	s.seenSequences[seq] = struct{}{}
	s.stats.Packets++

	if seq > s.maxSeq {
		timestamp := extendRTPTimestamp(s.lastTimestamp, header.Timestamp)
		s.maxSeq = seq
		s.lastTimestamp = timestamp
		s.updateRolloverStats()
		s.updateJitter(timestamp, arrival, clockRate)
	} else {
		s.stats.OutOfOrderPackets++
	}
	s.recalculateLoss()
}

func (s *rtpStreamStatsState) updateJitter(timestamp uint64, arrival time.Time, clockRate int) {
	arrivalOffset := rtpDurationUnits(arrival.Sub(s.baseArrival), clockRate)
	timestampOffset := rtpExtendedTimestampOffset(timestamp, s.baseTimestamp)
	transit := arrivalOffset - timestampOffset
	delta := transit - s.lastTransit
	if delta < 0 {
		delta = -delta
	}
	// RFC3550 estimates interarrival jitter as J = J + (|D| - J) / 16.
	s.jitter += (float64(delta) - s.jitter) / 16
	s.lastTransit = transit
	s.stats.Jitter = uint32(s.jitter)
}

func (s *rtpStreamStatsState) updateRolloverStats() {
	s.stats.SequenceRollovers = uint32(s.maxSeq >> 16)
	s.stats.LastTimestamp = s.lastTimestamp
	s.stats.TimestampRollovers = uint32(s.lastTimestamp >> 32)
}

func (s *rtpStreamStatsState) recalculateLoss() {
	expected := uint64(s.maxSeq-s.baseSeq) + 1
	s.stats.ExpectedPackets = expected
	if expected > s.stats.Packets {
		s.stats.LostPackets = expected - s.stats.Packets
	} else {
		s.stats.LostPackets = 0
	}
	if expected == 0 || s.stats.LostPackets == 0 {
		s.stats.FractionLost = 0
		return
	}
	fraction := s.stats.LostPackets * 256 / expected
	if fraction > 255 {
		fraction = 255
	}
	s.stats.FractionLost = uint8(fraction)
}

func (s *rtpStreamStatsState) snapshotAt(now time.Time) RTPStreamStats {
	stats := s.stats
	stats.LastSequenceNumber = s.maxSeq
	stats.SequenceRollovers = uint32(s.maxSeq >> 16)
	stats.LastTimestamp = s.lastTimestamp
	stats.TimestampRollovers = uint32(s.lastTimestamp >> 32)
	stats.LastSenderReport = s.senderReport.lastSenderReport
	if !now.IsZero() && !s.senderReport.arrival.IsZero() {
		stats.Delay = rtcpCompactDelay(now.Sub(s.senderReport.arrival))
	} else {
		stats.Delay = 0
	}
	return stats
}

func (t *RTPStreamStatsTracker) observeRTCPPackets(packets []rtcp.Packet, arrival time.Time) []RTPStreamStats {
	if len(packets) == 0 {
		return nil
	}
	if arrival.IsZero() {
		arrival = time.Now()
	}
	updated := make(map[uint32]RTPStreamStats)
	var observe func(rtcp.Packet)
	observe = func(packet rtcp.Packet) {
		switch p := packet.(type) {
		case *rtcp.SenderReport:
			if stats, ok := t.ObserveRTCPSenderReport(p.SSRC, p.NTPTime, arrival); ok {
				updated[stats.SSRC] = stats
			}
		case *rtcp.CompoundPacket:
			for _, inner := range *p {
				observe(inner)
			}
		}
	}
	for _, packet := range packets {
		observe(packet)
	}
	if len(updated) == 0 {
		return nil
	}
	out := make([]RTPStreamStats, 0, len(updated))
	for _, stats := range updated {
		out = append(out, stats)
	}
	sort.Slice(out, func(i, j int) bool {
		return out[i].SSRC < out[j].SSRC
	})
	return out
}

func extendRTPSequence(maxSeq uint32, seq uint16) uint32 {
	cycles := maxSeq & 0xffff0000
	maxLow := uint16(maxSeq)
	switch {
	case seq < maxLow && maxLow-seq > 0x8000:
		cycles += 1 << 16
	case seq > maxLow && seq-maxLow > 0x8000 && cycles >= 1<<16:
		cycles -= 1 << 16
	}
	return cycles | uint32(seq)
}

func extendRTPTimestamp(reference uint64, timestamp uint32) uint64 {
	cycles := reference & 0xffffffff00000000
	refLow := uint32(reference)
	switch {
	case timestamp < refLow && refLow-timestamp > 0x80000000:
		cycles += 1 << 32
	case timestamp > refLow && timestamp-refLow > 0x80000000 && cycles >= 1<<32:
		cycles -= 1 << 32
	}
	return cycles | uint64(timestamp)
}

func rtpExtendedTimestampOffset(timestamp, base uint64) int64 {
	if timestamp >= base {
		return int64(timestamp - base)
	}
	return -int64(base - timestamp)
}

func rtpDurationUnits(d time.Duration, clockRate int) int64 {
	sign := int64(1)
	if d < 0 {
		sign = -1
		d = -d
	}
	seconds := d / time.Second
	remainder := d % time.Second
	units := int64(seconds)*int64(clockRate) + int64(remainder)*int64(clockRate)/int64(time.Second)
	return sign * units
}
