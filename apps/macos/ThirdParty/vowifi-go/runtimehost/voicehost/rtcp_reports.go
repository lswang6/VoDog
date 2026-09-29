package voicehost

import (
	"strings"
	"time"

	"github.com/pion/rtcp"
)

const maxRTCPReceiverReportBlocks = 31
const maxRTCPPositiveLostPackets = 0x7fffff
const ntpEpochOffsetSeconds = 2208988800
const rtcpCompactNTPUnitsPerSecond = 1 << 16
const maxRTCPCompactDelay = ^uint32(0)

type RTCPSenderReportConfig struct {
	SSRC           uint32
	NTPTime        uint64
	WallClock      time.Time
	RTPTime        uint32
	PacketCount    uint32
	OctetCount     uint32
	ReceptionStats []RTPStreamStats
}

type RTCPSourceDescriptionConfig struct {
	SSRC  uint32
	CNAME string
	Name  string
	Tool  string
}

// BuildGoodbye builds an RTCP BYE packet for media sources that are no longer active.
func BuildGoodbye(sources []uint32, reason string) *rtcp.Goodbye {
	return &rtcp.Goodbye{
		Sources: append([]uint32(nil), sources...),
		Reason:  strings.TrimSpace(reason),
	}
}

// BuildReceiverReport converts RTP reception snapshots into an RTCP RR packet.
// A ReceiverReport can carry at most 31 report blocks, so extra streams are ignored.
func BuildReceiverReport(senderSSRC uint32, stats []RTPStreamStats) *rtcp.ReceiverReport {
	return &rtcp.ReceiverReport{
		SSRC:    senderSSRC,
		Reports: rtcpReceptionReportBlocks(stats),
	}
}

// BuildSenderReport converts local sender counters and optional reception
// snapshots into an RTCP SR packet.
func BuildSenderReport(cfg RTCPSenderReportConfig) *rtcp.SenderReport {
	ntpTime := cfg.NTPTime
	if ntpTime == 0 && !cfg.WallClock.IsZero() {
		ntpTime = rtcpNTPTime(cfg.WallClock)
	}
	return &rtcp.SenderReport{
		SSRC:        cfg.SSRC,
		NTPTime:     ntpTime,
		RTPTime:     cfg.RTPTime,
		PacketCount: cfg.PacketCount,
		OctetCount:  cfg.OctetCount,
		Reports:     rtcpReceptionReportBlocks(cfg.ReceptionStats),
	}
}

// BuildSourceDescription builds an RTCP SDES chunk for the local media source.
// CNAME should be stable for the lifetime of the RTP session.
func BuildSourceDescription(cfg RTCPSourceDescriptionConfig) *rtcp.SourceDescription {
	items := make([]rtcp.SourceDescriptionItem, 0, 3)
	if cname := strings.TrimSpace(cfg.CNAME); cname != "" {
		items = append(items, rtcp.SourceDescriptionItem{Type: rtcp.SDESCNAME, Text: cname})
	}
	if name := strings.TrimSpace(cfg.Name); name != "" {
		items = append(items, rtcp.SourceDescriptionItem{Type: rtcp.SDESName, Text: name})
	}
	if tool := strings.TrimSpace(cfg.Tool); tool != "" {
		items = append(items, rtcp.SourceDescriptionItem{Type: rtcp.SDESTool, Text: tool})
	}
	return &rtcp.SourceDescription{
		Chunks: []rtcp.SourceDescriptionChunk{{
			Source: cfg.SSRC,
			Items:  items,
		}},
	}
}

func rtcpReceptionReportBlocks(stats []RTPStreamStats) []rtcp.ReceptionReport {
	reports := make([]rtcp.ReceptionReport, 0, min(len(stats), maxRTCPReceiverReportBlocks))
	for _, stream := range stats {
		if len(reports) == maxRTCPReceiverReportBlocks {
			break
		}
		reports = append(reports, rtcp.ReceptionReport{
			SSRC:               stream.SSRC,
			FractionLost:       stream.FractionLost,
			TotalLost:          rtcpReportLostPackets(stream.LostPackets),
			LastSequenceNumber: stream.LastSequenceNumber,
			Jitter:             stream.Jitter,
			LastSenderReport:   stream.LastSenderReport,
			Delay:              stream.Delay,
		})
	}
	return reports
}

func rtcpReportLostPackets(lost uint64) uint32 {
	if lost > maxRTCPPositiveLostPackets {
		return maxRTCPPositiveLostPackets
	}
	return uint32(lost)
}

func rtcpNTPTime(t time.Time) uint64 {
	seconds := t.Unix() + ntpEpochOffsetSeconds
	if seconds < 0 {
		return 0
	}
	fraction := (uint64(t.Nanosecond()) << 32) / uint64(time.Second)
	return uint64(seconds)<<32 | fraction
}

func rtcpLastSenderReport(ntpTime uint64) uint32 {
	return uint32(ntpTime >> 16)
}

func rtcpCompactDelay(d time.Duration) uint32 {
	if d <= 0 {
		return 0
	}
	seconds := uint64(d / time.Second)
	remainder := uint64(d % time.Second)
	if seconds >= rtcpCompactNTPUnitsPerSecond {
		return maxRTCPCompactDelay
	}
	units := seconds*rtcpCompactNTPUnitsPerSecond + remainder*rtcpCompactNTPUnitsPerSecond/uint64(time.Second)
	if units > uint64(maxRTCPCompactDelay) {
		return maxRTCPCompactDelay
	}
	return uint32(units)
}

func rtcpCompactDelayDuration(delay uint32) time.Duration {
	seconds := delay / rtcpCompactNTPUnitsPerSecond
	fraction := delay % rtcpCompactNTPUnitsPerSecond
	return time.Duration(seconds)*time.Second + time.Duration(fraction)*time.Second/rtcpCompactNTPUnitsPerSecond
}
