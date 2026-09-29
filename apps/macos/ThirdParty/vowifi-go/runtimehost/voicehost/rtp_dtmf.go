package voicehost

import (
	"encoding/binary"
	"fmt"
	"strings"
)

const (
	DefaultRTPDTMFPayloadType = 101
	DefaultRTPDTMFClockRate   = 8000
	DefaultRTPDTMFVolume      = 10
	DefaultRTPDTMFStepMS      = 50
	DefaultRTPDTMFEndPackets  = 3
)

type RTPDTMFDirection string

const (
	RTPDTMFClientToIMS RTPDTMFDirection = "client_to_ims"
	RTPDTMFIMSToClient RTPDTMFDirection = "ims_to_client"
)

type RTPDTMFHandler func(RTPDTMFEvent)

type RTPDTMFPacket struct {
	PayloadType     uint8
	Marker          bool
	SequenceNumber  uint16
	Timestamp       uint32
	SSRC            uint32
	Signal          string
	End             bool
	Volume          uint8
	DurationSamples uint16
	ClockRate       int
}

type RTPDTMFSequenceConfig struct {
	PayloadType    uint8
	Signal         string
	DurationMS     int
	StepMS         int
	EndPacketCount int
	Volume         uint8
	SequenceNumber uint16
	Timestamp      uint32
	SSRC           uint32
	ClockRate      int
}

type RTPDTMFEvent struct {
	Direction       RTPDTMFDirection
	PayloadType     uint8
	EventCode       uint8
	Signal          string
	End             bool
	Volume          uint8
	DurationSamples uint16
	DurationMS      int
	SequenceNumber  uint16
	Timestamp       uint32
	SSRC            uint32
	Marker          bool
	ClockRate       int
	Packet          []byte
}

type RTPDTMFSummary struct {
	Events    uint64
	EndEvents uint64
}

func BuildRTPDTMFPacket(in RTPDTMFPacket) ([]byte, error) {
	signal, err := NormalizeRTPDTMFSignal(in.Signal)
	if err != nil {
		return nil, err
	}
	eventCode, err := RTPDTMFEventCode(signal)
	if err != nil {
		return nil, err
	}
	payloadType := in.PayloadType
	if payloadType == 0 {
		payloadType = DefaultRTPDTMFPayloadType
	}
	if payloadType > 127 {
		return nil, fmt.Errorf("%w: RTP payload type %d exceeds 127", ErrInvalidDTMF, payloadType)
	}
	clockRate := in.ClockRate
	if clockRate <= 0 {
		clockRate = DefaultRTPDTMFClockRate
	}
	volume := in.Volume
	if volume == 0 {
		volume = DefaultRTPDTMFVolume
	}
	if volume > 63 {
		return nil, fmt.Errorf("%w: RTP DTMF volume %d exceeds 63", ErrInvalidDTMF, volume)
	}
	durationSamples := in.DurationSamples
	if durationSamples == 0 {
		durationSamples = uint16((DefaultDTMFDurationMS * clockRate) / 1000)
	}
	packet := make([]byte, 16)
	packet[0] = 0x80
	packet[1] = payloadType & 0x7f
	if in.Marker {
		packet[1] |= 0x80
	}
	binary.BigEndian.PutUint16(packet[2:4], in.SequenceNumber)
	binary.BigEndian.PutUint32(packet[4:8], in.Timestamp)
	binary.BigEndian.PutUint32(packet[8:12], in.SSRC)
	packet[12] = eventCode
	packet[13] = volume & 0x3f
	if in.End {
		packet[13] |= 0x80
	}
	binary.BigEndian.PutUint16(packet[14:16], durationSamples)
	return packet, nil
}

func BuildRTPDTMFSequence(cfg RTPDTMFSequenceConfig) ([][]byte, error) {
	signal, err := NormalizeRTPDTMFSignal(cfg.Signal)
	if err != nil {
		return nil, err
	}
	clockRate := cfg.ClockRate
	if clockRate <= 0 {
		clockRate = DefaultRTPDTMFClockRate
	}
	durationMS := cfg.DurationMS
	if durationMS <= 0 {
		durationMS = DefaultDTMFDurationMS
	}
	if durationMS > MaxDTMFDurationMS {
		return nil, fmt.Errorf("%w: duration %dms exceeds %dms", ErrInvalidDTMF, durationMS, MaxDTMFDurationMS)
	}
	stepMS := cfg.StepMS
	if stepMS <= 0 {
		stepMS = DefaultRTPDTMFStepMS
	}
	if stepMS > durationMS {
		stepMS = durationMS
	}
	endPackets := cfg.EndPacketCount
	if endPackets <= 0 {
		endPackets = DefaultRTPDTMFEndPackets
	}
	totalSamples, err := rtpDTMFSamplesForDuration(durationMS, clockRate)
	if err != nil {
		return nil, err
	}
	stepSamples, err := rtpDTMFSamplesForDuration(stepMS, clockRate)
	if err != nil {
		return nil, err
	}
	if stepSamples <= 0 {
		stepSamples = 1
	}
	var packets [][]byte
	sequence := cfg.SequenceNumber
	current := stepSamples
	if current > totalSamples {
		current = totalSamples
	}
	for len(packets) == 0 || current < totalSamples {
		packet, err := BuildRTPDTMFPacket(RTPDTMFPacket{
			PayloadType:     cfg.PayloadType,
			Marker:          len(packets) == 0,
			SequenceNumber:  sequence,
			Timestamp:       cfg.Timestamp,
			SSRC:            cfg.SSRC,
			Signal:          signal,
			Volume:          cfg.Volume,
			DurationSamples: uint16(current),
			ClockRate:       clockRate,
		})
		if err != nil {
			return nil, err
		}
		packets = append(packets, packet)
		sequence++
		current += stepSamples
		if current > totalSamples {
			current = totalSamples
		}
	}
	for i := 0; i < endPackets; i++ {
		packet, err := BuildRTPDTMFPacket(RTPDTMFPacket{
			PayloadType:     cfg.PayloadType,
			Marker:          len(packets) == 0,
			SequenceNumber:  sequence,
			Timestamp:       cfg.Timestamp,
			SSRC:            cfg.SSRC,
			Signal:          signal,
			End:             true,
			Volume:          cfg.Volume,
			DurationSamples: uint16(totalSamples),
			ClockRate:       clockRate,
		})
		if err != nil {
			return nil, err
		}
		packets = append(packets, packet)
		sequence++
	}
	return packets, nil
}

func InspectRTPDTMF(direction RTPDTMFDirection, packet []byte, payloadTypes map[uint8]int, handler RTPDTMFHandler) (RTPDTMFSummary, error) {
	var summary RTPDTMFSummary
	if len(payloadTypes) == 0 {
		return summary, nil
	}
	event, ok, err := ParseRTPDTMFEvent(direction, packet, payloadTypes)
	if err != nil || !ok {
		return summary, err
	}
	summary.Events = 1
	if event.End {
		summary.EndEvents = 1
	}
	emitRTPDTMF(handler, event)
	return summary, nil
}

func ParseRTPDTMFEvent(direction RTPDTMFDirection, packet []byte, payloadTypes map[uint8]int) (RTPDTMFEvent, bool, error) {
	header, payload, err := parseRTPPacket(packet)
	if err != nil {
		return RTPDTMFEvent{}, false, err
	}
	clockRate, ok := payloadTypes[header.PayloadType]
	if !ok {
		return RTPDTMFEvent{}, false, nil
	}
	if clockRate <= 0 {
		clockRate = DefaultRTPDTMFClockRate
	}
	if len(payload) < 4 {
		return RTPDTMFEvent{}, false, fmt.Errorf("%w: RTP DTMF payload too short", ErrInvalidDTMF)
	}
	signal := RTPDTMFSignalFromEventCode(payload[0])
	if signal == "" {
		return RTPDTMFEvent{}, false, fmt.Errorf("%w: unsupported RTP DTMF event %d", ErrInvalidDTMF, payload[0])
	}
	durationSamples := binary.BigEndian.Uint16(payload[2:4])
	durationMS := 0
	if clockRate > 0 {
		durationMS = int((uint32(durationSamples)*1000 + uint32(clockRate/2)) / uint32(clockRate))
	}
	return RTPDTMFEvent{
		Direction:       direction,
		PayloadType:     header.PayloadType,
		EventCode:       payload[0],
		Signal:          signal,
		End:             payload[1]&0x80 != 0,
		Volume:          payload[1] & 0x3f,
		DurationSamples: durationSamples,
		DurationMS:      durationMS,
		SequenceNumber:  header.SequenceNumber,
		Timestamp:       header.Timestamp,
		SSRC:            header.SSRC,
		Marker:          header.Marker,
		ClockRate:       clockRate,
		Packet:          append([]byte(nil), packet...),
	}, true, nil
}

func RewriteRTPDTMFPayloadType(packet []byte, sourcePayloadTypes, targetPayloadTypes map[uint8]int) ([]byte, bool, error) {
	if len(sourcePayloadTypes) == 0 || len(targetPayloadTypes) == 0 {
		return packet, false, nil
	}
	header, payload, err := parseRTPPacket(packet)
	if err != nil {
		return packet, false, err
	}
	sourceClock, ok := sourcePayloadTypes[header.PayloadType]
	if !ok {
		return packet, false, nil
	}
	if sourceClock <= 0 {
		sourceClock = DefaultRTPDTMFClockRate
	}
	if len(payload) < 4 {
		return packet, false, fmt.Errorf("%w: RTP DTMF payload too short", ErrInvalidDTMF)
	}
	if RTPDTMFSignalFromEventCode(payload[0]) == "" {
		return packet, false, fmt.Errorf("%w: unsupported RTP DTMF event %d", ErrInvalidDTMF, payload[0])
	}
	targetPayload, targetClock, ok := chooseRTPDTMFTargetPayload(header.PayloadType, sourceClock, targetPayloadTypes)
	if !ok {
		return packet, false, nil
	}
	if targetClock <= 0 {
		targetClock = DefaultRTPDTMFClockRate
	}
	duration := binary.BigEndian.Uint16(payload[2:4])
	targetDuration := scaleRTPDTMFDuration(duration, sourceClock, targetClock)
	if header.PayloadType == targetPayload && duration == targetDuration {
		return packet, false, nil
	}
	out := append([]byte(nil), packet...)
	out[1] = (out[1] & 0x80) | (targetPayload & 0x7f)
	binary.BigEndian.PutUint16(out[header.PayloadOffset+2:header.PayloadOffset+4], targetDuration)
	return out, true, nil
}

func NormalizeRTPDTMFSignal(signal string) (string, error) {
	signal = strings.ToUpper(strings.TrimSpace(signal))
	if signal == "FLASH" {
		return signal, nil
	}
	return NormalizeDTMFSignal(signal)
}

func RTPDTMFEventCode(signal string) (uint8, error) {
	signal, err := NormalizeRTPDTMFSignal(signal)
	if err != nil {
		return 0, err
	}
	switch signal {
	case "*":
		return 10, nil
	case "#":
		return 11, nil
	case "A":
		return 12, nil
	case "B":
		return 13, nil
	case "C":
		return 14, nil
	case "D":
		return 15, nil
	case "FLASH":
		return 16, nil
	default:
		if len(signal) == 1 && signal[0] >= '0' && signal[0] <= '9' {
			return signal[0] - '0', nil
		}
	}
	return 0, fmt.Errorf("%w: unsupported RTP DTMF signal %q", ErrInvalidDTMF, signal)
}

func RTPDTMFSignalFromEventCode(code uint8) string {
	switch {
	case code <= 9:
		return string(rune('0' + code))
	case code == 10:
		return "*"
	case code == 11:
		return "#"
	case code == 12:
		return "A"
	case code == 13:
		return "B"
	case code == 14:
		return "C"
	case code == 15:
		return "D"
	case code == 16:
		return "FLASH"
	default:
		return ""
	}
}

type rtpPacketHeader struct {
	PayloadType    uint8
	Marker         bool
	SequenceNumber uint16
	Timestamp      uint32
	SSRC           uint32
	PayloadOffset  int
}

func parseRTPPacket(packet []byte) (rtpPacketHeader, []byte, error) {
	if len(packet) < 12 {
		return rtpPacketHeader{}, nil, fmt.Errorf("%w: RTP packet too short", ErrInvalidDTMF)
	}
	if packet[0]>>6 != 2 {
		return rtpPacketHeader{}, nil, fmt.Errorf("%w: unsupported RTP version", ErrInvalidDTMF)
	}
	csrcCount := int(packet[0] & 0x0f)
	headerLen := 12 + csrcCount*4
	if len(packet) < headerLen {
		return rtpPacketHeader{}, nil, fmt.Errorf("%w: RTP CSRC list truncated", ErrInvalidDTMF)
	}
	if packet[0]&0x10 != 0 {
		if len(packet) < headerLen+4 {
			return rtpPacketHeader{}, nil, fmt.Errorf("%w: RTP extension header truncated", ErrInvalidDTMF)
		}
		extWords := int(binary.BigEndian.Uint16(packet[headerLen+2 : headerLen+4]))
		headerLen += 4 + extWords*4
		if len(packet) < headerLen {
			return rtpPacketHeader{}, nil, fmt.Errorf("%w: RTP extension payload truncated", ErrInvalidDTMF)
		}
	}
	end := len(packet)
	if packet[0]&0x20 != 0 {
		pad := int(packet[len(packet)-1])
		if pad == 0 || pad > end-headerLen {
			return rtpPacketHeader{}, nil, fmt.Errorf("%w: invalid RTP padding", ErrInvalidDTMF)
		}
		end -= pad
	}
	return rtpPacketHeader{
		PayloadType:    packet[1] & 0x7f,
		Marker:         packet[1]&0x80 != 0,
		SequenceNumber: binary.BigEndian.Uint16(packet[2:4]),
		Timestamp:      binary.BigEndian.Uint32(packet[4:8]),
		SSRC:           binary.BigEndian.Uint32(packet[8:12]),
		PayloadOffset:  headerLen,
	}, packet[headerLen:end], nil
}

func emitRTPDTMF(handler RTPDTMFHandler, event RTPDTMFEvent) {
	if handler == nil {
		return
	}
	defer func() {
		_ = recover()
	}()
	handler(event)
}

func rtpDTMFPayloadTypesFromSDP(info SDPInfo) map[uint8]int {
	out := cloneRTPDTMFPayloadTypes(info.TelephoneEventPayloads)
	if len(out) == 0 && sdpPayloadsContain(info.Payloads, DefaultRTPDTMFPayloadType) {
		out = map[uint8]int{DefaultRTPDTMFPayloadType: DefaultRTPDTMFClockRate}
	}
	for payload, clockRate := range out {
		if clockRate <= 0 {
			out[payload] = DefaultRTPDTMFClockRate
		}
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

func cloneRTPDTMFPayloadTypes(in map[uint8]int) map[uint8]int {
	if len(in) == 0 {
		return nil
	}
	out := make(map[uint8]int, len(in))
	for payload, clockRate := range in {
		out[payload] = clockRate
	}
	return out
}

func chooseRTPDTMFTargetPayload(sourcePayload uint8, sourceClock int, targetPayloadTypes map[uint8]int) (uint8, int, bool) {
	if len(targetPayloadTypes) == 0 {
		return 0, 0, false
	}
	if targetClock, ok := targetPayloadTypes[sourcePayload]; ok {
		if targetClock <= 0 {
			targetClock = DefaultRTPDTMFClockRate
		}
		return sourcePayload, targetClock, true
	}
	if sourceClock <= 0 {
		sourceClock = DefaultRTPDTMFClockRate
	}
	var bestPayload uint8
	var bestClock int
	found := false
	for payload, clock := range targetPayloadTypes {
		if clock <= 0 {
			clock = DefaultRTPDTMFClockRate
		}
		if clock == sourceClock && (!found || payload < bestPayload) {
			bestPayload = payload
			bestClock = clock
			found = true
		}
	}
	if found {
		return bestPayload, bestClock, true
	}
	for payload, clock := range targetPayloadTypes {
		if clock <= 0 {
			clock = DefaultRTPDTMFClockRate
		}
		if !found || payload < bestPayload {
			bestPayload = payload
			bestClock = clock
			found = true
		}
	}
	return bestPayload, bestClock, found
}

func scaleRTPDTMFDuration(duration uint16, sourceClock, targetClock int) uint16 {
	if duration == 0 || sourceClock <= 0 || targetClock <= 0 || sourceClock == targetClock {
		return duration
	}
	scaled := (uint64(duration)*uint64(targetClock) + uint64(sourceClock/2)) / uint64(sourceClock)
	if scaled == 0 {
		return 1
	}
	if scaled > 0xffff {
		return 0xffff
	}
	return uint16(scaled)
}

func rtpDTMFSamplesForDuration(durationMS, clockRate int) (int, error) {
	if durationMS <= 0 {
		return 0, fmt.Errorf("%w: duration is empty", ErrInvalidDTMF)
	}
	if clockRate <= 0 {
		clockRate = DefaultRTPDTMFClockRate
	}
	samples := (durationMS * clockRate) / 1000
	if samples <= 0 {
		samples = 1
	}
	if samples > 0xffff {
		return 0, fmt.Errorf("%w: RTP DTMF duration %d samples exceeds 65535", ErrInvalidDTMF, samples)
	}
	return samples, nil
}
