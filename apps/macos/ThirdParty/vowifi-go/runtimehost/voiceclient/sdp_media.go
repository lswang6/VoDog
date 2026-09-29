package voiceclient

import (
	"errors"
	"fmt"
	"net"
	"strconv"
	"strings"
)

var ErrInvalidVoiceSDP = errors.New("invalid voice SDP")

const (
	VoiceSDPCodecAMR            = "AMR"
	VoiceSDPCodecAMRWB          = "AMR-WB"
	VoiceSDPCodecTelephoneEvent = "telephone-event"
)

type VoiceSDPCodec struct {
	Payload      int
	EncodingName string
	ClockRate    int
	Channels     int
	FMTP         string
}

type VoiceSDPMedia struct {
	Port         int
	RTPProfile   string
	Payloads     []int
	RTCPPort     int
	ExplicitRTCP bool
	RTCPMux      bool
	Codecs       []VoiceSDPCodec
}

type VoiceSDPMediaDirection struct {
	Direction           string
	SessionDirection    string
	AudioDirection      string
	SessionConnectionIP string
	AudioConnectionIP   string
	EffectiveIP         string
	AudioPort           int
	Held                bool
	Disabled            bool
	CanSend             bool
	CanReceive          bool
}

func ParseVoiceSDPMedia(body []byte) (VoiceSDPMedia, error) {
	lines := voiceSDPLines(body)
	var out VoiceSDPMedia
	var payloadOrder []int
	codecsByPayload := make(map[int]VoiceSDPCodec)
	inAudio := false
	sawAudio := false
	for _, line := range lines {
		if line == "" {
			continue
		}
		lower := strings.ToLower(line)
		if strings.HasPrefix(lower, "m=") {
			if inAudio {
				break
			}
			inAudio = false
			fields := strings.Fields(line)
			if len(fields) >= 4 && strings.EqualFold(fields[0], "m=audio") {
				port, err := parseVoiceSDPPort(fields[1])
				if err != nil {
					return VoiceSDPMedia{}, fmt.Errorf("%w: invalid audio port", ErrInvalidVoiceSDP)
				}
				payloads, err := parseVoiceSDPPayloads(fields[3:])
				if err != nil {
					return VoiceSDPMedia{}, err
				}
				out.Port = port
				out.RTPProfile = strings.TrimSpace(fields[2])
				out.Payloads = append([]int(nil), payloads...)
				payloadOrder = append([]int(nil), payloads...)
				inAudio = true
				sawAudio = true
			}
			continue
		}
		if !inAudio {
			continue
		}
		switch {
		case strings.EqualFold(strings.TrimSpace(line), "a=rtcp-mux"):
			out.RTCPMux = true
			out.RTCPPort = out.Port
		case strings.HasPrefix(lower, "a=rtcp:"):
			port, ok, err := parseVoiceSDPRTCPLine(line)
			if err != nil {
				return VoiceSDPMedia{}, err
			}
			if ok {
				out.ExplicitRTCP = true
				out.RTCPPort = port
			}
		case strings.HasPrefix(lower, "a=rtpmap:"):
			codec, ok, err := parseVoiceSDPRTPMapLine(line)
			if err != nil {
				return VoiceSDPMedia{}, err
			}
			if ok {
				if existing, exists := codecsByPayload[codec.Payload]; exists {
					codec.FMTP = existing.FMTP
				}
				codecsByPayload[codec.Payload] = codec
			}
		case strings.HasPrefix(lower, "a=fmtp:"):
			payload, fmtp, ok, err := parseVoiceSDPFmtpLine(line)
			if err != nil {
				return VoiceSDPMedia{}, err
			}
			if ok {
				codec := codecsByPayload[payload]
				codec.Payload = payload
				codec.FMTP = fmtp
				codecsByPayload[payload] = codec
			}
		}
	}
	if !sawAudio {
		return VoiceSDPMedia{}, fmt.Errorf("%w: missing audio m-line", ErrInvalidVoiceSDP)
	}
	if !out.RTCPMux && out.RTCPPort == 0 && out.Port > 0 && out.Port < 65535 {
		out.RTCPPort = out.Port + 1
	}
	out.Codecs = make([]VoiceSDPCodec, 0, len(payloadOrder))
	for _, payload := range payloadOrder {
		codec, ok := codecsByPayload[payload]
		if !ok {
			codec, _ = staticVoiceSDPCodec(payload)
		}
		codec.Payload = payload
		if codec.Channels <= 0 && strings.TrimSpace(codec.EncodingName) != "" {
			codec.Channels = 1
		}
		out.Codecs = append(out.Codecs, codec)
	}
	return out, nil
}

func ValidateIMSVoiceSDP(body []byte) (VoiceSDPMedia, error) {
	media, err := ParseVoiceSDPMedia(body)
	if err != nil {
		return VoiceSDPMedia{}, err
	}
	if err := ValidateIMSVoiceSDPMedia(media); err != nil {
		return VoiceSDPMedia{}, err
	}
	return media, nil
}

func ValidateIMSVoiceSDPMedia(media VoiceSDPMedia) error {
	if media.Port < 0 || media.Port > 65535 {
		return fmt.Errorf("%w: invalid audio port", ErrInvalidVoiceSDP)
	}
	if strings.TrimSpace(media.RTPProfile) == "" {
		return fmt.Errorf("%w: missing RTP profile", ErrInvalidVoiceSDP)
	}
	if media.RTCPMux && media.RTCPPort != 0 && media.RTCPPort != media.Port {
		return fmt.Errorf("%w: conflicting RTCP mux port", ErrInvalidVoiceSDP)
	}
	hasAudioCodec := false
	for _, codec := range media.Codecs {
		codec = normalizeVoiceSDPCodec(codec)
		if codec.Payload < 0 || codec.Payload > 127 {
			return fmt.Errorf("%w: invalid RTP payload", ErrInvalidVoiceSDP)
		}
		if codec.EncodingName == "" && codec.Payload >= 96 {
			return fmt.Errorf("%w: dynamic payload missing rtpmap", ErrInvalidVoiceSDP)
		}
		if VoiceSDPCodecIsTelephoneEvent(codec) {
			continue
		}
		if codec.EncodingName != "" {
			hasAudioCodec = true
		}
		if VoiceSDPCodecIsAMR(codec) {
			if err := validateVoiceSDPAMRCodec(codec); err != nil {
				return err
			}
		}
	}
	if media.Port > 0 && !hasAudioCodec {
		return fmt.Errorf("%w: missing audio codec", ErrInvalidVoiceSDP)
	}
	return nil
}

func ParseVoiceSDPMediaDirection(body []byte) (VoiceSDPMediaDirection, error) {
	lines := voiceSDPLines(body)
	var out VoiceSDPMediaDirection
	beforeFirstMedia := true
	inFirstAudio := false
	sawAudio := false
	for _, line := range lines {
		if line == "" {
			continue
		}
		lower := strings.ToLower(line)
		if strings.HasPrefix(lower, "m=") {
			if sawAudio && inFirstAudio {
				break
			}
			beforeFirstMedia = false
			inFirstAudio = false
			fields := strings.Fields(line)
			if len(fields) >= 4 && strings.EqualFold(fields[0], "m=audio") {
				port, err := parseVoiceSDPPort(fields[1])
				if err != nil {
					return VoiceSDPMediaDirection{}, fmt.Errorf("%w: invalid audio port", ErrInvalidVoiceSDP)
				}
				out.AudioPort = port
				inFirstAudio = true
				sawAudio = true
			}
			continue
		}
		if direction, ok, err := parseVoiceSDPDirectionLine(line); err != nil {
			return VoiceSDPMediaDirection{}, err
		} else if ok {
			if beforeFirstMedia {
				out.SessionDirection = direction
				continue
			}
			if inFirstAudio {
				out.AudioDirection = direction
			}
			continue
		}
		if ip, ok, err := parseVoiceSDPConnectionLine(line); err != nil {
			return VoiceSDPMediaDirection{}, err
		} else if ok {
			if beforeFirstMedia {
				out.SessionConnectionIP = ip
				continue
			}
			if inFirstAudio {
				out.AudioConnectionIP = ip
			}
		}
	}
	if !sawAudio {
		return VoiceSDPMediaDirection{}, fmt.Errorf("%w: missing audio m-line", ErrInvalidVoiceSDP)
	}
	out.EffectiveIP = out.AudioConnectionIP
	if out.EffectiveIP == "" {
		out.EffectiveIP = out.SessionConnectionIP
	}
	out.Direction = firstNonEmpty(out.AudioDirection, out.SessionDirection, "sendrecv")
	out.Disabled = out.AudioPort == 0 || voiceSDPConnectionIPIsUnspecified(out.EffectiveIP)
	if out.Disabled {
		out.Direction = "inactive"
	}
	out.CanSend, out.CanReceive = voiceSDPDirectionCapabilities(out.Direction)
	out.Held = !out.CanSend || !out.CanReceive
	return out, nil
}

func VoiceSDPCodecIsAMR(codec VoiceSDPCodec) bool {
	name := strings.ToUpper(strings.TrimSpace(codec.EncodingName))
	return name == VoiceSDPCodecAMR || name == VoiceSDPCodecAMRWB
}

func VoiceSDPCodecIsTelephoneEvent(codec VoiceSDPCodec) bool {
	return strings.EqualFold(strings.TrimSpace(codec.EncodingName), VoiceSDPCodecTelephoneEvent)
}

func ParseVoiceSDPFmtpParameters(fmtp string) map[string]string {
	parts := splitVoiceSDPFmtpParameters(fmtp)
	if len(parts) == 0 {
		return nil
	}
	out := make(map[string]string, len(parts))
	for _, part := range parts {
		key, value, ok := strings.Cut(part, "=")
		if !ok {
			continue
		}
		key = strings.ToLower(strings.TrimSpace(key))
		value = strings.TrimSpace(value)
		if key != "" && value != "" {
			out[key] = value
		}
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

func voiceSDPLines(body []byte) []string {
	text := strings.ReplaceAll(string(body), "\r\n", "\n")
	raw := strings.Split(text, "\n")
	out := raw[:0]
	for _, line := range raw {
		if line = strings.TrimSpace(line); line != "" {
			out = append(out, line)
		}
	}
	return out
}

func parseVoiceSDPPort(value string) (int, error) {
	port, err := strconv.Atoi(strings.TrimSpace(value))
	if err != nil || port < 0 || port > 65535 {
		return 0, ErrInvalidVoiceSDP
	}
	return port, nil
}

func parseVoiceSDPPayloads(values []string) ([]int, error) {
	out := make([]int, 0, len(values))
	for _, value := range values {
		payload, err := parseVoiceSDPPayload(value)
		if err != nil {
			return nil, err
		}
		out = append(out, payload)
	}
	if len(out) == 0 {
		return nil, fmt.Errorf("%w: missing RTP payloads", ErrInvalidVoiceSDP)
	}
	return out, nil
}

func parseVoiceSDPPayload(value string) (int, error) {
	payload, err := strconv.Atoi(strings.TrimSpace(value))
	if err != nil || payload < 0 || payload > 127 {
		return 0, fmt.Errorf("%w: invalid RTP payload", ErrInvalidVoiceSDP)
	}
	return payload, nil
}

func parseVoiceSDPRTCPLine(line string) (int, bool, error) {
	value, ok := cutVoiceSDPAttributeValue(line, "a=rtcp:")
	if !ok {
		return 0, false, nil
	}
	fields := strings.Fields(value)
	if len(fields) == 0 {
		return 0, true, fmt.Errorf("%w: invalid RTCP attribute", ErrInvalidVoiceSDP)
	}
	port, err := parseVoiceSDPPort(fields[0])
	if err != nil {
		return 0, true, fmt.Errorf("%w: invalid RTCP port", ErrInvalidVoiceSDP)
	}
	return port, true, nil
}

func parseVoiceSDPRTPMapLine(line string) (VoiceSDPCodec, bool, error) {
	value, ok := cutVoiceSDPAttributeValue(line, "a=rtpmap:")
	if !ok {
		return VoiceSDPCodec{}, false, nil
	}
	payloadText, encoding, ok := cutVoiceSDPField(value)
	if !ok || strings.TrimSpace(encoding) == "" {
		return VoiceSDPCodec{}, true, fmt.Errorf("%w: malformed rtpmap", ErrInvalidVoiceSDP)
	}
	payload, err := parseVoiceSDPPayload(payloadText)
	if err != nil {
		return VoiceSDPCodec{}, true, err
	}
	parts := strings.Split(strings.Fields(encoding)[0], "/")
	if len(parts) < 2 || strings.TrimSpace(parts[0]) == "" {
		return VoiceSDPCodec{}, true, fmt.Errorf("%w: malformed rtpmap encoding", ErrInvalidVoiceSDP)
	}
	clockRate, err := strconv.Atoi(strings.TrimSpace(parts[1]))
	if err != nil || clockRate <= 0 {
		return VoiceSDPCodec{}, true, fmt.Errorf("%w: invalid rtpmap clock", ErrInvalidVoiceSDP)
	}
	channels := 1
	if len(parts) >= 3 && strings.TrimSpace(parts[2]) != "" {
		channels, err = strconv.Atoi(strings.TrimSpace(parts[2]))
		if err != nil || channels <= 0 {
			return VoiceSDPCodec{}, true, fmt.Errorf("%w: invalid rtpmap channels", ErrInvalidVoiceSDP)
		}
	}
	return VoiceSDPCodec{
		Payload:      payload,
		EncodingName: strings.TrimSpace(parts[0]),
		ClockRate:    clockRate,
		Channels:     channels,
	}, true, nil
}

func parseVoiceSDPFmtpLine(line string) (int, string, bool, error) {
	value, ok := cutVoiceSDPAttributeValue(line, "a=fmtp:")
	if !ok {
		return 0, "", false, nil
	}
	payloadText, fmtp, ok := cutVoiceSDPField(value)
	if !ok {
		return 0, "", true, fmt.Errorf("%w: malformed fmtp", ErrInvalidVoiceSDP)
	}
	payload, err := parseVoiceSDPPayload(payloadText)
	if err != nil {
		return 0, "", true, err
	}
	return payload, strings.TrimSpace(fmtp), true, nil
}

func parseVoiceSDPDirectionLine(line string) (string, bool, error) {
	trimmed := strings.ToLower(strings.TrimSpace(line))
	if !strings.HasPrefix(trimmed, "a=") {
		return "", false, nil
	}
	switch trimmed {
	case "a=sendrecv":
		return "sendrecv", true, nil
	case "a=sendonly":
		return "sendonly", true, nil
	case "a=recvonly":
		return "recvonly", true, nil
	case "a=inactive":
		return "inactive", true, nil
	default:
		if strings.HasPrefix(trimmed, "a=send") || strings.HasPrefix(trimmed, "a=recv") || trimmed == "a=hold" {
			return "", true, fmt.Errorf("%w: invalid media direction", ErrInvalidVoiceSDP)
		}
		return "", false, nil
	}
}

func parseVoiceSDPConnectionLine(line string) (string, bool, error) {
	fields := strings.Fields(line)
	if len(fields) == 0 || !strings.EqualFold(fields[0], "c=IN") {
		return "", false, nil
	}
	if len(fields) < 3 || (!strings.EqualFold(fields[1], "IP4") && !strings.EqualFold(fields[1], "IP6")) {
		return "", true, fmt.Errorf("%w: invalid connection line", ErrInvalidVoiceSDP)
	}
	ip := strings.TrimSpace(fields[2])
	if net.ParseIP(ip) == nil {
		return "", true, fmt.Errorf("%w: invalid connection address", ErrInvalidVoiceSDP)
	}
	return ip, true, nil
}

func voiceSDPConnectionIPIsUnspecified(value string) bool {
	ip := net.ParseIP(strings.TrimSpace(value))
	return ip != nil && ip.IsUnspecified()
}

func voiceSDPDirectionCapabilities(direction string) (bool, bool) {
	switch strings.ToLower(strings.TrimSpace(direction)) {
	case "sendrecv":
		return true, true
	case "sendonly":
		return true, false
	case "recvonly":
		return false, true
	default:
		return false, false
	}
}

func cutVoiceSDPAttributeValue(line, prefix string) (string, bool) {
	line = strings.TrimSpace(line)
	if !strings.HasPrefix(strings.ToLower(line), strings.ToLower(prefix)) {
		return "", false
	}
	return strings.TrimSpace(line[len(prefix):]), true
}

func cutVoiceSDPField(value string) (string, string, bool) {
	fields := strings.Fields(strings.TrimSpace(value))
	if len(fields) < 2 {
		return "", "", false
	}
	return fields[0], strings.Join(fields[1:], " "), true
}

func normalizeVoiceSDPCodec(codec VoiceSDPCodec) VoiceSDPCodec {
	codec.EncodingName = strings.TrimSpace(codec.EncodingName)
	codec.FMTP = strings.TrimSpace(codec.FMTP)
	if codec.Channels <= 0 && codec.EncodingName != "" {
		codec.Channels = 1
	}
	if codec.EncodingName == "" {
		if static, ok := staticVoiceSDPCodec(codec.Payload); ok {
			if codec.ClockRate <= 0 {
				codec.ClockRate = static.ClockRate
			}
			codec.EncodingName = static.EncodingName
			codec.Channels = static.Channels
		}
	}
	return codec
}

func staticVoiceSDPCodec(payload int) (VoiceSDPCodec, bool) {
	switch payload {
	case 0:
		return VoiceSDPCodec{Payload: payload, EncodingName: "PCMU", ClockRate: 8000, Channels: 1}, true
	case 8:
		return VoiceSDPCodec{Payload: payload, EncodingName: "PCMA", ClockRate: 8000, Channels: 1}, true
	default:
		return VoiceSDPCodec{Payload: payload}, false
	}
}

func validateVoiceSDPAMRCodec(codec VoiceSDPCodec) error {
	codec = normalizeVoiceSDPCodec(codec)
	wantClock := 8000
	maxMode := 7
	if strings.EqualFold(codec.EncodingName, VoiceSDPCodecAMRWB) {
		wantClock = 16000
		maxMode = 8
	}
	if codec.Payload < 96 {
		return fmt.Errorf("%w: AMR payload must be dynamic", ErrInvalidVoiceSDP)
	}
	if codec.ClockRate != wantClock {
		return fmt.Errorf("%w: invalid %s clock rate", ErrInvalidVoiceSDP, codec.EncodingName)
	}
	if codec.Channels > 1 {
		return fmt.Errorf("%w: invalid %s channels", ErrInvalidVoiceSDP, codec.EncodingName)
	}
	params := ParseVoiceSDPFmtpParameters(codec.FMTP)
	for _, key := range []string{"octet-align", "crc", "robust-sorting", "mode-change-neighbor"} {
		if value, ok := params[key]; ok && !voiceSDPFmtpBool(value) {
			return fmt.Errorf("%w: invalid AMR %s", ErrInvalidVoiceSDP, key)
		}
	}
	if modeSet, ok := params["mode-set"]; ok && !validVoiceSDPAMRModeSet(modeSet, maxMode) {
		return fmt.Errorf("%w: invalid AMR mode-set", ErrInvalidVoiceSDP)
	}
	for _, key := range []string{"mode-change-period", "mode-change-capability"} {
		if value, ok := params[key]; ok && !voiceSDPFmtpOneOrTwo(value) {
			return fmt.Errorf("%w: invalid AMR %s", ErrInvalidVoiceSDP, key)
		}
	}
	if value, ok := params["interleaving"]; ok && !voiceSDPFmtpPositiveInt(value) {
		return fmt.Errorf("%w: invalid AMR interleaving", ErrInvalidVoiceSDP)
	}
	if value, ok := params["max-red"]; ok && !voiceSDPFmtpNonNegativeInt(value) {
		return fmt.Errorf("%w: invalid AMR max-red", ErrInvalidVoiceSDP)
	}
	return nil
}

func voiceSDPFmtpBool(value string) bool {
	value = strings.TrimSpace(value)
	return value == "0" || value == "1"
}

func voiceSDPFmtpNonNegativeInt(value string) bool {
	n, err := strconv.Atoi(strings.TrimSpace(value))
	return err == nil && n >= 0
}

func voiceSDPFmtpPositiveInt(value string) bool {
	n, err := strconv.Atoi(strings.TrimSpace(value))
	return err == nil && n > 0
}

func voiceSDPFmtpOneOrTwo(value string) bool {
	value = strings.TrimSpace(value)
	return value == "1" || value == "2"
}

func validVoiceSDPAMRModeSet(value string, maxMode int) bool {
	parts := strings.Split(value, ",")
	if len(parts) == 0 {
		return false
	}
	for _, part := range parts {
		mode, err := strconv.Atoi(strings.TrimSpace(part))
		if err != nil || mode < 0 || mode > maxMode {
			return false
		}
	}
	return true
}

func splitVoiceSDPFmtpParameters(fmtp string) []string {
	fmtp = strings.TrimSpace(fmtp)
	if fmtp == "" {
		return nil
	}
	segments := strings.Split(fmtp, ";")
	out := make([]string, 0, len(segments))
	for _, segment := range segments {
		segment = strings.TrimSpace(segment)
		if segment == "" {
			continue
		}
		if strings.Contains(segment, "=") {
			if strings.Count(segment, "=") > 1 && strings.ContainsAny(segment, " \t") {
				for _, field := range strings.Fields(segment) {
					if strings.Contains(field, "=") {
						out = append(out, field)
					}
				}
				continue
			}
			out = append(out, segment)
			continue
		}
		for _, field := range strings.Fields(segment) {
			if strings.Contains(field, "=") {
				out = append(out, field)
			}
		}
	}
	return out
}
