package voicehost

import (
	"errors"
	"strings"
	"testing"

	"github.com/pion/rtcp"
)

func TestParseAndSelectSDPRTCPFeedbackAttributes(t *testing.T) {
	raw := []byte("v=0\r\n" +
		"c=IN IP4 203.0.113.8\r\n" +
		"m=audio 49170 RTP/SAVPF 96 110 111\r\n" +
		"a=rtcp-fb:* nack pli\r\n" +
		"a=rtcp-fb:96 goog-remb\r\n" +
		"a=rtcp-fb:110 transport-cc\r\n" +
		"a=rtcp-fb:111 nack\r\n")
	attrs, err := ParseSDPRTCPFeedbackAttributes(raw)
	if err != nil {
		t.Fatalf("ParseSDPRTCPFeedbackAttributes() error = %v", err)
	}
	if len(attrs) != 4 || attrs[0].Payload != "*" || attrs[0].Type != "nack" || attrs[0].Parameter != "pli" {
		t.Fatalf("attrs=%+v", attrs)
	}

	selected := SelectSDPRTCPFeedbackAnswer(attrs, []SDPRTCPFeedbackAttribute{
		{Payload: "96", Type: "nack", Parameter: "pli"},
		{Payload: "*", Type: "goog-remb"},
		{Payload: "*", Type: "transport-cc"},
	}, []int{96, 110})
	if len(selected) != 3 {
		t.Fatalf("selected=%+v", selected)
	}
	if selected[0].Payload != "96" || selected[0].Type != "nack" || selected[0].Parameter != "pli" {
		t.Fatalf("selected[0]=%+v", selected[0])
	}
	if selected[1].Payload != "96" || selected[1].Type != "goog-remb" {
		t.Fatalf("selected[1]=%+v", selected[1])
	}
	if selected[2].Payload != "110" || selected[2].Type != "transport-cc" {
		t.Fatalf("selected[2]=%+v", selected[2])
	}

	_, _, err = ParseSDPRTCPFeedbackLine("a=rtcp-fb:abc nack")
	if !errors.Is(err, ErrInvalidSDPSecurity) {
		t.Fatalf("ParseSDPRTCPFeedbackLine(invalid) err=%v, want ErrInvalidSDPSecurity", err)
	}
}

func TestBuildSDPRTCPFeedbackPolicyClassifiesWildcardAndPayloadFeedback(t *testing.T) {
	raw := []byte("v=0\r\n" +
		"m=audio 49170 RTP/SAVPF 96 97\r\n" +
		"a=rtcp-fb:* nack pli\r\n" +
		"a=rtcp-fb:* ccm fir\r\n" +
		"a=rtcp-fb:96 transport-cc\r\n" +
		"a=rtcp-fb:97 nack\r\n" +
		"a=rtcp-fb:97 goog-remb\r\n" +
		"a=rtcp-fb:97 nack rpsi\r\n" +
		"a=rtcp-fb:97 nack sli\r\n")
	attrs, err := ParseSDPRTCPFeedbackAttributes(raw)
	if err != nil {
		t.Fatalf("ParseSDPRTCPFeedbackAttributes() error = %v", err)
	}

	policy96 := BuildSDPRTCPFeedbackPolicy(attrs, 96)
	if policy96.Payload != 96 ||
		!policy96.Allows(RTCPFeedbackPictureLossIndication) ||
		!policy96.Allows(RTCPFeedbackFullIntraRequest) ||
		!policy96.Allows(RTCPFeedbackTransportLayerCongestionControl) ||
		policy96.Allows(RTCPFeedbackTransportLayerNack) ||
		policy96.Allows(RTCPFeedbackReceiverEstimatedMaximumBitrate) ||
		policy96.Allows(RTCPFeedbackSliceLossIndication) {
		t.Fatalf("policy96=%+v", policy96)
	}

	policy97 := BuildSDPRTCPFeedbackPolicy(attrs, 97)
	if policy97.Payload != 97 ||
		!policy97.Allows(RTCPFeedbackPictureLossIndication) ||
		!policy97.Allows(RTCPFeedbackFullIntraRequest) ||
		!policy97.Allows(RTCPFeedbackTransportLayerNack) ||
		!policy97.Allows(RTCPFeedbackReceiverEstimatedMaximumBitrate) ||
		!policy97.Allows(RTCPFeedbackSliceLossIndication) ||
		policy97.Allows(RTCPFeedbackTransportLayerCongestionControl) ||
		policy97.Allows(RTCPFeedbackRapidResynchronizationRequest) ||
		policy97.Allows(RTCPFeedbackUnknown) {
		t.Fatalf("policy97=%+v", policy97)
	}
}

func TestSelectSDPRTCPFeedbackAnswerNegotiatesPolicy(t *testing.T) {
	offer := []SDPRTCPFeedbackAttribute{
		{Payload: "*", Type: "nack", Parameter: "pli"},
		{Payload: "*", Type: "ccm", Parameter: "fir"},
		{Payload: "96", Type: "transport-cc"},
		{Payload: "97", Type: "nack"},
	}
	local := []SDPRTCPFeedbackAttribute{
		{Payload: "*", Type: "nack", Parameter: "pli"},
		{Payload: "*", Type: "ccm", Parameter: "fir"},
		{Payload: "*", Type: "transport-cc"},
	}

	selected := SelectSDPRTCPFeedbackAnswer(offer, local, []int{96, 97})
	if len(selected) != 3 {
		t.Fatalf("selected=%+v", selected)
	}
	if selected[0].Payload != "*" || selected[0].RTCPFeedbackKind() != RTCPFeedbackPictureLossIndication ||
		selected[1].Payload != "*" || selected[1].RTCPFeedbackKind() != RTCPFeedbackFullIntraRequest ||
		selected[2].Payload != "96" || selected[2].RTCPFeedbackKind() != RTCPFeedbackTransportLayerCongestionControl {
		t.Fatalf("selected=%+v", selected)
	}

	policy96 := BuildSDPRTCPFeedbackPolicy(selected, 96)
	if !policy96.Allows(RTCPFeedbackPictureLossIndication) ||
		!policy96.Allows(RTCPFeedbackFullIntraRequest) ||
		!policy96.Allows(RTCPFeedbackTransportLayerCongestionControl) ||
		policy96.Allows(RTCPFeedbackTransportLayerNack) {
		t.Fatalf("policy96=%+v", policy96)
	}

	policy97 := BuildSDPRTCPFeedbackPolicy(selected, 97)
	if !policy97.Allows(RTCPFeedbackPictureLossIndication) ||
		!policy97.Allows(RTCPFeedbackFullIntraRequest) ||
		policy97.Allows(RTCPFeedbackTransportLayerCongestionControl) ||
		policy97.Allows(RTCPFeedbackTransportLayerNack) {
		t.Fatalf("policy97=%+v", policy97)
	}
}

func TestRewriteSDPRTCPFeedbackReplacesOnlyAudioFeedback(t *testing.T) {
	body := []byte("v=0\r\n" +
		"c=IN IP4 203.0.113.8\r\n" +
		"m=audio 49170 RTP/SAVPF 96\r\n" +
		"a=rtcp-fb:* nack\r\n" +
		"a=rtpmap:96 AMR/8000\r\n" +
		"m=video 50000 RTP/SAVPF 120\r\n" +
		"a=rtcp-fb:120 nack\r\n")
	rewritten := string(RewriteSDPRTCPFeedback(body, []SDPRTCPFeedbackAttribute{
		{Payload: "96", Type: "nack", Parameter: "pli"},
		{Payload: "*", Type: "trr-int", Parameter: "100"},
	}))
	for _, want := range []string{
		"m=audio 49170 RTP/SAVPF 96\r\n",
		"a=rtcp-fb:96 nack pli\r\n",
		"a=rtcp-fb:* trr-int 100\r\n",
		"a=rtpmap:96 AMR/8000\r\n",
		"m=video 50000 RTP/SAVPF 120\r\n",
		"a=rtcp-fb:120 nack\r\n",
	} {
		if !strings.Contains(rewritten, want) {
			t.Fatalf("rewritten missing %q:\n%s", want, rewritten)
		}
	}
	if strings.Contains(rewritten, "a=rtcp-fb:* nack\r\n") {
		t.Fatalf("rewritten kept old audio feedback:\n%s", rewritten)
	}
}

func TestInspectRTCPFeedbackReportsReceptionBlocks(t *testing.T) {
	raw, err := rtcp.Marshal([]rtcp.Packet{
		&rtcp.ReceiverReport{
			SSRC: 0x11111111,
			Reports: []rtcp.ReceptionReport{{
				SSRC:               0x22222222,
				FractionLost:       32,
				TotalLost:          7,
				LastSequenceNumber: 0x00010010,
				Jitter:             41,
				LastSenderReport:   0x12345678,
				Delay:              0x00001000,
			}},
		},
		&rtcp.SenderReport{
			SSRC:        0x33333333,
			NTPTime:     0x0102030405060708,
			RTPTime:     0x11223344,
			PacketCount: 19,
			OctetCount:  3040,
			Reports: []rtcp.ReceptionReport{{
				SSRC:               0x44444444,
				FractionLost:       8,
				TotalLost:          2,
				LastSequenceNumber: 0x00020020,
				Jitter:             11,
			}},
		},
	})
	if err != nil {
		t.Fatalf("rtcp.Marshal() error = %v", err)
	}

	var events []RTCPFeedbackEvent
	summary, err := InspectRTCPFeedback(RTCPFeedbackIMSToClient, raw, func(event RTCPFeedbackEvent) {
		events = append(events, event)
	})
	if err != nil {
		t.Fatalf("InspectRTCPFeedback() error = %v", err)
	}
	if summary.Packets != 2 || summary.ReceiverReports != 1 || summary.SenderReports != 1 {
		t.Fatalf("summary=%+v", summary)
	}
	if len(events) != 2 {
		t.Fatalf("events=%d, want 2", len(events))
	}

	rr := events[0]
	if rr.Direction != RTCPFeedbackIMSToClient || rr.Kind != RTCPFeedbackReceiverReport || rr.SSRC != 0x11111111 || rr.ReportCount != 1 {
		t.Fatalf("receiver report event=%+v", rr)
	}
	if len(rr.Reports) != 1 {
		t.Fatalf("receiver report blocks=%+v", rr.Reports)
	}
	if got := rr.Reports[0]; got.SSRC != 0x22222222 || got.FractionLost != 32 || got.TotalLost != 7 ||
		got.LastSequenceNumber != 0x00010010 || got.Jitter != 41 || got.LastSenderReport != 0x12345678 || got.Delay != 0x00001000 {
		t.Fatalf("receiver report block=%+v", got)
	}

	sr := events[1]
	if sr.Kind != RTCPFeedbackSenderReport || sr.SSRC != 0x33333333 || sr.ReportCount != 1 {
		t.Fatalf("sender report event=%+v", sr)
	}
	if sr.NTPTime != 0x0102030405060708 || sr.RTPTime != 0x11223344 || sr.PacketCount != 19 || sr.OctetCount != 3040 {
		t.Fatalf("sender report timing/counters=%+v", sr)
	}
	if len(sr.Reports) != 1 {
		t.Fatalf("sender report blocks=%+v", sr.Reports)
	}
	if got := sr.Reports[0]; got.SSRC != 0x44444444 || got.FractionLost != 8 || got.TotalLost != 2 ||
		got.LastSequenceNumber != 0x00020020 || got.Jitter != 11 {
		t.Fatalf("sender report block=%+v", got)
	}
}

func TestInspectRTCPFeedbackReportsPLIAndFIRAndXR(t *testing.T) {
	raw, err := rtcp.Marshal([]rtcp.Packet{
		&rtcp.PictureLossIndication{
			SenderSSRC: 0x11111111,
			MediaSSRC:  0x22222222,
		},
		&rtcp.FullIntraRequest{
			SenderSSRC: 0x33333333,
			MediaSSRC:  0x44444444,
			FIR: []rtcp.FIREntry{
				{SSRC: 0x55555555, SequenceNumber: 7},
				{SSRC: 0x66666666, SequenceNumber: 8},
			},
		},
		&rtcp.ExtendedReport{
			SenderSSRC: 0x77777777,
			Reports: []rtcp.ReportBlock{
				&rtcp.ReceiverReferenceTimeReportBlock{NTPTimestamp: 0x0102030405060708},
				&rtcp.DLRRReportBlock{Reports: []rtcp.DLRRReport{{
					SSRC:   0x88888888,
					LastRR: 0x00010002,
					DLRR:   0x00030004,
				}}},
			},
		},
	})
	if err != nil {
		t.Fatalf("rtcp.Marshal() error = %v", err)
	}

	var events []RTCPFeedbackEvent
	summary, err := InspectRTCPFeedback(RTCPFeedbackClientToIMS, raw, func(event RTCPFeedbackEvent) {
		events = append(events, event)
	})
	if err != nil {
		t.Fatalf("InspectRTCPFeedback() error = %v", err)
	}
	if summary.Packets != 3 || summary.PictureLossIndications != 1 || summary.FullIntraRequests != 1 || summary.ExtendedReports != 1 {
		t.Fatalf("summary=%+v", summary)
	}
	if len(events) != 3 {
		t.Fatalf("events=%d, want 3", len(events))
	}

	byKind := make(map[RTCPFeedbackKind]RTCPFeedbackEvent, len(events))
	for _, event := range events {
		byKind[event.Kind] = event
	}

	pli := byKind[RTCPFeedbackPictureLossIndication]
	if pli.PacketType != "206" || pli.SenderSSRC != 0x11111111 || pli.MediaSSRC != 0x22222222 ||
		!uint32SliceContains(pli.DestinationSSRCs, 0x22222222) {
		t.Fatalf("PLI event=%+v", pli)
	}

	fir := byKind[RTCPFeedbackFullIntraRequest]
	if fir.PacketType != "206" || fir.SenderSSRC != 0x33333333 || fir.MediaSSRC != 0x44444444 || fir.FIRCount != 2 ||
		!uint32SliceContains(fir.DestinationSSRCs, 0x55555555) || !uint32SliceContains(fir.DestinationSSRCs, 0x66666666) {
		t.Fatalf("FIR event=%+v", fir)
	}

	xr := byKind[RTCPFeedbackExtendedReport]
	if xr.PacketType != "207" || xr.SSRC != 0x77777777 || xr.SenderSSRC != 0x77777777 || xr.ReportCount != 2 ||
		!uint32SliceContains(xr.DestinationSSRCs, 0x77777777) || !uint32SliceContains(xr.DestinationSSRCs, 0x88888888) {
		t.Fatalf("XR event=%+v", xr)
	}
}

func TestInspectRTCPFeedbackReportsGoodbyeSourcesAndReason(t *testing.T) {
	raw, err := rtcp.Marshal([]rtcp.Packet{
		BuildGoodbye([]uint32{0x11111111, 0x22222222}, "call cleared"),
	})
	if err != nil {
		t.Fatalf("rtcp.Marshal() error = %v", err)
	}

	var events []RTCPFeedbackEvent
	summary, err := InspectRTCPFeedback(RTCPFeedbackIMSToClient, raw, func(event RTCPFeedbackEvent) {
		events = append(events, event)
	})
	if err != nil {
		t.Fatalf("InspectRTCPFeedback() error = %v", err)
	}
	if summary.Packets != 1 || summary.Goodbyes != 1 {
		t.Fatalf("summary=%+v", summary)
	}
	if len(events) != 1 {
		t.Fatalf("events=%d, want 1", len(events))
	}
	event := events[0]
	if event.Direction != RTCPFeedbackIMSToClient || event.Kind != RTCPFeedbackGoodbye || event.PacketType != "203" {
		t.Fatalf("event=%+v", event)
	}
	if event.SSRC != 0x11111111 || event.GoodbyeReason != "call cleared" ||
		!uint32SlicesEqual(event.GoodbyeSSRCs, []uint32{0x11111111, 0x22222222}) ||
		!uint32SlicesEqual(event.DestinationSSRCs, []uint32{0x11111111, 0x22222222}) {
		t.Fatalf("goodbye event=%+v", event)
	}
	event.GoodbyeSSRCs[0] = 0
	if reparsed, err := rtcp.Unmarshal(raw); err != nil || reparsed[0].(*rtcp.Goodbye).Sources[0] != 0x11111111 {
		t.Fatalf("GoodbyeSSRCs were not isolated from packet sources, packets=%+v err=%v", reparsed, err)
	}
}

func uint32SliceContains(values []uint32, want uint32) bool {
	for _, value := range values {
		if value == want {
			return true
		}
	}
	return false
}

func uint32SlicesEqual(got, want []uint32) bool {
	if len(got) != len(want) {
		return false
	}
	for i := range got {
		if got[i] != want[i] {
			return false
		}
	}
	return true
}
