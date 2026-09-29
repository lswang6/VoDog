package voiceclient

import (
	"errors"
	"testing"
)

func TestParseVoiceSDPMediaCapturesAMRCodecsAndRTCP(t *testing.T) {
	raw := []byte("v=0\r\n" +
		"o=- 1 1 IN IP4 192.0.2.10\r\n" +
		"s=-\r\n" +
		"c=IN IP4 192.0.2.10\r\n" +
		"m=audio 49170 RTP/AVP 97 96 110\r\n" +
		"a=rtcp:49171 IN IP4 192.0.2.10\r\n" +
		"a=rtpmap:97 AMR-WB/16000\r\n" +
		"a=fmtp:97 octet-align=1;mode-set=0,1,2;mode-change-period=2;mode-change-capability=2;interleaving=4\r\n" +
		"a=rtpmap:96 AMR/8000/1\r\n" +
		"a=fmtp:96 octet-align=1;mode-set=2,7;crc=0\r\n" +
		"a=rtpmap:110 telephone-event/16000\r\n" +
		"a=fmtp:110 0-16\r\n" +
		"m=video 9 RTP/AVP 99\r\n" +
		"a=rtpmap:99 H264/90000\r\n")

	media, err := ValidateIMSVoiceSDP(raw)
	if err != nil {
		t.Fatalf("ValidateIMSVoiceSDP() error = %v", err)
	}
	if media.Port != 49170 || media.RTCPPort != 49171 || !media.ExplicitRTCP || media.RTPProfile != "RTP/AVP" {
		t.Fatalf("media transport=%+v", media)
	}
	if len(media.Payloads) != 3 || media.Payloads[0] != 97 || media.Payloads[1] != 96 || media.Payloads[2] != 110 {
		t.Fatalf("payloads=%v", media.Payloads)
	}
	if len(media.Codecs) != 3 {
		t.Fatalf("codecs=%+v", media.Codecs)
	}
	if media.Codecs[0].EncodingName != VoiceSDPCodecAMRWB || media.Codecs[0].ClockRate != 16000 ||
		media.Codecs[0].FMTP != "octet-align=1;mode-set=0,1,2;mode-change-period=2;mode-change-capability=2;interleaving=4" {
		t.Fatalf("AMR-WB codec=%+v", media.Codecs[0])
	}
	if !VoiceSDPCodecIsAMR(media.Codecs[1]) || media.Codecs[1].ClockRate != 8000 || media.Codecs[1].Channels != 1 {
		t.Fatalf("AMR codec=%+v", media.Codecs[1])
	}
	if !VoiceSDPCodecIsTelephoneEvent(media.Codecs[2]) || media.Codecs[2].FMTP != "0-16" {
		t.Fatalf("telephone-event codec=%+v", media.Codecs[2])
	}
	params := ParseVoiceSDPFmtpParameters(media.Codecs[0].FMTP)
	if params["octet-align"] != "1" || params["mode-set"] != "0,1,2" ||
		params["mode-change-period"] != "2" || params["mode-change-capability"] != "2" || params["interleaving"] != "4" {
		t.Fatalf("AMR-WB fmtp params=%v", params)
	}
}

func TestParseVoiceSDPMediaDefaultsStaticCodecsAndRTCP(t *testing.T) {
	media, err := ValidateIMSVoiceSDP([]byte("v=0\nm=audio 4000 RTP/AVP 0 8\n"))
	if err != nil {
		t.Fatalf("ValidateIMSVoiceSDP(static) error = %v", err)
	}
	if media.RTCPPort != 4001 || media.ExplicitRTCP || media.RTCPMux {
		t.Fatalf("RTCP defaults=%+v", media)
	}
	if len(media.Codecs) != 2 ||
		media.Codecs[0].EncodingName != "PCMU" || media.Codecs[0].ClockRate != 8000 ||
		media.Codecs[1].EncodingName != "PCMA" || media.Codecs[1].ClockRate != 8000 {
		t.Fatalf("static codecs=%+v", media.Codecs)
	}

	muxed, err := ValidateIMSVoiceSDP([]byte("v=0\r\nm=audio 5000 RTP/AVP 0\r\na=rtcp-mux\r\n"))
	if err != nil {
		t.Fatalf("ValidateIMSVoiceSDP(rtcp-mux) error = %v", err)
	}
	if !muxed.RTCPMux || muxed.RTCPPort != muxed.Port {
		t.Fatalf("rtcp-mux media=%+v", muxed)
	}
}

func TestParseVoiceSDPMediaDirectionUsesAudioOverride(t *testing.T) {
	direction, err := ParseVoiceSDPMediaDirection([]byte("v=0\r\n" +
		"c=IN IP4 203.0.113.8\r\n" +
		"a=sendonly\r\n" +
		"m=audio 49170 RTP/AVP 0\r\n" +
		"c=IN IP4 198.51.100.44\r\n" +
		"a=recvonly\r\n"))
	if err != nil {
		t.Fatalf("ParseVoiceSDPMediaDirection() error = %v", err)
	}
	if direction.Direction != "recvonly" ||
		direction.SessionDirection != "sendonly" ||
		direction.AudioDirection != "recvonly" ||
		direction.SessionConnectionIP != "203.0.113.8" ||
		direction.AudioConnectionIP != "198.51.100.44" ||
		direction.EffectiveIP != "198.51.100.44" ||
		!direction.Held ||
		direction.Disabled ||
		direction.CanSend ||
		!direction.CanReceive {
		t.Fatalf("direction=%+v", direction)
	}
}

func TestParseVoiceSDPMediaDirectionTreatsLegacyHoldAsInactive(t *testing.T) {
	for _, raw := range []string{
		"v=0\r\nc=IN IP4 203.0.113.8\r\nm=audio 49170 RTP/AVP 0\r\nc=IN IP4 0.0.0.0\r\na=sendrecv\r\n",
		"v=0\r\nc=IN IP6 2001:db8::1\r\nm=audio 0 RTP/AVP 0\r\na=sendrecv\r\n",
	} {
		direction, err := ParseVoiceSDPMediaDirection([]byte(raw))
		if err != nil {
			t.Fatalf("ParseVoiceSDPMediaDirection() error = %v", err)
		}
		if direction.Direction != "inactive" || !direction.Held || !direction.Disabled ||
			direction.CanSend || direction.CanReceive {
			t.Fatalf("direction=%+v, want inactive held media", direction)
		}
	}
}

func TestParseVoiceSDPMediaDirectionRejectsMalformedDirectionAndConnection(t *testing.T) {
	for _, raw := range []string{
		"v=0\r\nm=audio 49170 RTP/AVP 0\r\na=sendmostly\r\n",
		"v=0\r\nm=audio 49170 RTP/AVP 0\r\nc=IN IP4 not-an-ip\r\n",
	} {
		_, err := ParseVoiceSDPMediaDirection([]byte(raw))
		if !errors.Is(err, ErrInvalidVoiceSDP) {
			t.Fatalf("ParseVoiceSDPMediaDirection(%q) err=%v, want ErrInvalidVoiceSDP", raw, err)
		}
	}
}

func TestValidateIMSVoiceSDPRejectsMalformedAMR(t *testing.T) {
	tests := map[string]string{
		"narrowband clock": "v=0\r\nm=audio 49170 RTP/AVP 96\r\na=rtpmap:96 AMR/16000\r\n",
		"wideband clock":   "v=0\r\nm=audio 49170 RTP/AVP 97\r\na=rtpmap:97 AMR-WB/8000\r\n",
		"octet align":      "v=0\r\nm=audio 49170 RTP/AVP 96\r\na=rtpmap:96 AMR/8000\r\na=fmtp:96 octet-align=2\r\n",
		"interleaving":     "v=0\r\nm=audio 49170 RTP/AVP 96\r\na=rtpmap:96 AMR/8000\r\na=fmtp:96 interleaving=0\r\n",
		"mode set":         "v=0\r\nm=audio 49170 RTP/AVP 97\r\na=rtpmap:97 AMR-WB/16000\r\na=fmtp:97 octet-align=1;mode-set=0,9\r\n",
		"static payload":   "v=0\r\nm=audio 49170 RTP/AVP 8\r\na=rtpmap:8 AMR/8000\r\n",
	}
	for name, raw := range tests {
		t.Run(name, func(t *testing.T) {
			_, err := ValidateIMSVoiceSDP([]byte(raw))
			if !errors.Is(err, ErrInvalidVoiceSDP) {
				t.Fatalf("ValidateIMSVoiceSDP() err=%v, want ErrInvalidVoiceSDP", err)
			}
		})
	}
}
