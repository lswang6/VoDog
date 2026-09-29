package voicehost

import (
	"context"
	"errors"
	"strings"
	"testing"
)

func TestBuildAndParseDTMFRelayBody(t *testing.T) {
	body, err := BuildDTMFRelayBody("a", 120)
	if err != nil {
		t.Fatalf("BuildDTMFRelayBody() error = %v", err)
	}
	if string(body) != "Signal=A\r\nDuration=120\r\n" {
		t.Fatalf("body=%q", body)
	}
	signal, duration, err := ParseDTMFRelayBody(body)
	if err != nil {
		t.Fatalf("ParseDTMFRelayBody() error = %v", err)
	}
	if signal != "A" || duration != 120 {
		t.Fatalf("signal=%q duration=%d", signal, duration)
	}
}

func TestBuildDTMFRelayBodyDefaultsDuration(t *testing.T) {
	body, err := BuildDTMFRelayBody("#", 0)
	if err != nil {
		t.Fatalf("BuildDTMFRelayBody(default) error = %v", err)
	}
	if !strings.Contains(string(body), "Signal=#\r\n") || !strings.Contains(string(body), "Duration=160\r\n") {
		t.Fatalf("body=%q", body)
	}
}

func TestParseDTMFRelayBodyAcceptsLFAndWhitespace(t *testing.T) {
	signal, duration, err := ParseDTMFRelayBody([]byte(" Signal = * \n Duration = 90 \n"))
	if err != nil {
		t.Fatalf("ParseDTMFRelayBody() error = %v", err)
	}
	if signal != "*" || duration != 90 {
		t.Fatalf("signal=%q duration=%d", signal, duration)
	}
}

func TestDTMFRelayRejectsInvalidValues(t *testing.T) {
	tests := []struct {
		name string
		body []byte
	}{
		{name: "missing signal", body: []byte("Duration=90\r\n")},
		{name: "multi signal", body: []byte("Signal=12\r\nDuration=90\r\n")},
		{name: "unsupported signal", body: []byte("Signal=X\r\nDuration=90\r\n")},
		{name: "missing duration", body: []byte("Signal=1\r\n")},
		{name: "bad duration", body: []byte("Signal=1\r\nDuration=bad\r\n")},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if _, _, err := ParseDTMFRelayBody(tt.body); !errors.Is(err, ErrInvalidDTMF) {
				t.Fatalf("ParseDTMFRelayBody() err=%v, want ErrInvalidDTMF", err)
			}
		})
	}
	if _, err := BuildDTMFRelayBody("1", MaxDTMFDurationMS+1); !errors.Is(err, ErrInvalidDTMF) {
		t.Fatalf("BuildDTMFRelayBody(max) err=%v, want ErrInvalidDTMF", err)
	}
}

func TestBuildDialogDTMFInfoRequest(t *testing.T) {
	req, err := BuildDialogDTMFInfoRequest(DialogDTMFRequest{
		DeviceID:   " dev-1 ",
		CallID:     " call-1 ",
		Signal:     "5",
		DurationMS: 100,
		Headers:    map[string]string{"X-Test": "dtmf"},
	})
	if err != nil {
		t.Fatalf("BuildDialogDTMFInfoRequest() error = %v", err)
	}
	if req.DeviceID != "dev-1" || req.CallID != "call-1" || req.ContentType != DTMFRelayContentType || req.InfoPackage != DTMFInfoPackage {
		t.Fatalf("request=%+v", req)
	}
	if req.Headers["X-Test"] != "dtmf" || string(req.Body) != "Signal=5\r\nDuration=100\r\n" {
		t.Fatalf("headers/body=%+v/%q", req.Headers, req.Body)
	}
	req.Headers["X-Test"] = "changed"
	if req2, err := BuildDialogDTMFInfoRequest(DialogDTMFRequest{CallID: "call-1", Signal: "5", Headers: map[string]string{"X-Test": "dtmf"}}); err != nil || req2.Headers["X-Test"] != "dtmf" {
		t.Fatalf("headers were not cloned req=%+v err=%v", req2, err)
	}
}

func TestIMSOutboundAgentSendDialogRTPDTMFRequiresRelay(t *testing.T) {
	agent := &IMSOutboundAgent{}
	agent.storeDialog("call-1", imsDialogState{})
	result, err := agent.SendDialogRTPDTMF(context.Background(), DialogRTPDTMFRequest{CallID: "call-1", Signal: "5"})
	if !errors.Is(err, ErrRTPRelayConfig) {
		t.Fatalf("SendDialogRTPDTMF() err=%v, want ErrRTPRelayConfig", err)
	}
	if result.Accepted || result.StatusCode != 409 {
		t.Fatalf("result=%+v", result)
	}
}

func TestBuildAndParseRTPDTMFPacket(t *testing.T) {
	packet, err := BuildRTPDTMFPacket(RTPDTMFPacket{
		PayloadType:     110,
		Marker:          true,
		SequenceNumber:  77,
		Timestamp:       0x01020304,
		SSRC:            0x11223344,
		Signal:          "#",
		End:             true,
		Volume:          6,
		DurationSamples: 800,
		ClockRate:       16000,
	})
	if err != nil {
		t.Fatalf("BuildRTPDTMFPacket() error = %v", err)
	}
	event, ok, err := ParseRTPDTMFEvent(RTPDTMFClientToIMS, packet, map[uint8]int{110: 16000})
	if err != nil {
		t.Fatalf("ParseRTPDTMFEvent() error = %v", err)
	}
	if !ok {
		t.Fatalf("ParseRTPDTMFEvent() ok=false")
	}
	if event.Direction != RTPDTMFClientToIMS || event.PayloadType != 110 || event.EventCode != 11 || event.Signal != "#" || !event.End || !event.Marker {
		t.Fatalf("event=%+v", event)
	}
	if event.Volume != 6 || event.DurationSamples != 800 || event.DurationMS != 50 || event.SequenceNumber != 77 || event.Timestamp != 0x01020304 || event.SSRC != 0x11223344 {
		t.Fatalf("event timing/header=%+v", event)
	}
	if _, ok, err := ParseRTPDTMFEvent(RTPDTMFClientToIMS, packet, map[uint8]int{101: 8000}); err != nil || ok {
		t.Fatalf("ParseRTPDTMFEvent(non dtmf) ok=%v err=%v", ok, err)
	}
}

func TestRewriteRTPDTMFPayloadTypeScalesDuration(t *testing.T) {
	packet, err := BuildRTPDTMFPacket(RTPDTMFPacket{PayloadType: 110, Marker: true, SequenceNumber: 7, Timestamp: 3200, SSRC: 0x01020304, Signal: "9", DurationSamples: 1600, ClockRate: 16000})
	if err != nil {
		t.Fatalf("BuildRTPDTMFPacket() error = %v", err)
	}
	rewritten, remapped, err := RewriteRTPDTMFPayloadType(packet, map[uint8]int{110: 16000}, map[uint8]int{101: 8000})
	if err != nil {
		t.Fatalf("RewriteRTPDTMFPayloadType() error = %v", err)
	}
	if !remapped {
		t.Fatalf("RewriteRTPDTMFPayloadType() remapped=false")
	}
	if string(packet) == string(rewritten) {
		t.Fatalf("RewriteRTPDTMFPayloadType() did not rewrite packet")
	}
	if packet[1]&0x7f != 110 {
		t.Fatalf("source packet mutated: %x", packet)
	}
	event, ok, err := ParseRTPDTMFEvent(RTPDTMFClientToIMS, rewritten, map[uint8]int{101: 8000})
	if err != nil || !ok {
		t.Fatalf("ParseRTPDTMFEvent(rewritten) ok=%v err=%v", ok, err)
	}
	if event.PayloadType != 101 || event.DurationSamples != 800 || event.DurationMS != 100 || event.Signal != "9" || !event.Marker || event.Timestamp != 3200 {
		t.Fatalf("event=%+v", event)
	}
	if same, remapped, err := RewriteRTPDTMFPayloadType(rewritten, map[uint8]int{101: 8000}, map[uint8]int{101: 8000}); err != nil || remapped || string(same) != string(rewritten) {
		t.Fatalf("RewriteRTPDTMFPayloadType(same) remapped=%v err=%v", remapped, err)
	}
}

func TestBuildRTPDTMFSequence(t *testing.T) {
	packets, err := BuildRTPDTMFSequence(RTPDTMFSequenceConfig{
		PayloadType:    110,
		Signal:         "A",
		DurationMS:     160,
		StepMS:         50,
		EndPacketCount: 3,
		Volume:         7,
		SequenceNumber: 100,
		Timestamp:      0x01020304,
		SSRC:           0x11223344,
		ClockRate:      8000,
	})
	if err != nil {
		t.Fatalf("BuildRTPDTMFSequence() error = %v", err)
	}
	if len(packets) != 6 {
		t.Fatalf("packets=%d, want 6", len(packets))
	}
	wantDurations := []uint16{400, 800, 1200, 1280, 1280, 1280}
	for i, packet := range packets {
		event, ok, err := ParseRTPDTMFEvent(RTPDTMFClientToIMS, packet, map[uint8]int{110: 8000})
		if err != nil || !ok {
			t.Fatalf("ParseRTPDTMFEvent(%d) ok=%v err=%v", i, ok, err)
		}
		if event.Signal != "A" || event.PayloadType != 110 || event.Volume != 7 || event.Timestamp != 0x01020304 || event.SSRC != 0x11223344 {
			t.Fatalf("event[%d]=%+v", i, event)
		}
		if event.SequenceNumber != uint16(100+i) || event.DurationSamples != wantDurations[i] {
			t.Fatalf("event[%d] seq/duration=%d/%d", i, event.SequenceNumber, event.DurationSamples)
		}
		if event.Marker != (i == 0) {
			t.Fatalf("event[%d] marker=%v", i, event.Marker)
		}
		if event.End != (i >= 3) {
			t.Fatalf("event[%d] end=%v", i, event.End)
		}
	}
}

func TestBuildRTPDTMFSequenceDefaultsAndRejectsOversizedDuration(t *testing.T) {
	packets, err := BuildRTPDTMFSequence(RTPDTMFSequenceConfig{Signal: "5", DurationMS: 30, StepMS: 50, SequenceNumber: 1})
	if err != nil {
		t.Fatalf("BuildRTPDTMFSequence(defaults) error = %v", err)
	}
	if len(packets) != 4 {
		t.Fatalf("packets=%d, want 4", len(packets))
	}
	for i, packet := range packets {
		event, ok, err := ParseRTPDTMFEvent(RTPDTMFClientToIMS, packet, map[uint8]int{DefaultRTPDTMFPayloadType: DefaultRTPDTMFClockRate})
		if err != nil || !ok {
			t.Fatalf("ParseRTPDTMFEvent(%d) ok=%v err=%v", i, ok, err)
		}
		if event.DurationSamples != 240 || event.DurationMS != 30 || event.SequenceNumber != uint16(i+1) || event.End != (i >= 1) {
			t.Fatalf("event[%d]=%+v", i, event)
		}
	}
	if _, err := BuildRTPDTMFSequence(RTPDTMFSequenceConfig{Signal: "5", DurationMS: 9000, ClockRate: 8000}); !errors.Is(err, ErrInvalidDTMF) {
		t.Fatalf("BuildRTPDTMFSequence(long) err=%v, want ErrInvalidDTMF", err)
	}
	if _, err := BuildRTPDTMFSequence(RTPDTMFSequenceConfig{Signal: "5", DurationMS: 5000, ClockRate: 48000}); !errors.Is(err, ErrInvalidDTMF) {
		t.Fatalf("BuildRTPDTMFSequence(samples) err=%v, want ErrInvalidDTMF", err)
	}
}

func TestRTPDTMFRejectsInvalidValues(t *testing.T) {
	if _, err := BuildRTPDTMFPacket(RTPDTMFPacket{PayloadType: 128, Signal: "1"}); !errors.Is(err, ErrInvalidDTMF) {
		t.Fatalf("BuildRTPDTMFPacket(payload) err=%v, want ErrInvalidDTMF", err)
	}
	if _, err := BuildRTPDTMFPacket(RTPDTMFPacket{Signal: "X"}); !errors.Is(err, ErrInvalidDTMF) {
		t.Fatalf("BuildRTPDTMFPacket(signal) err=%v, want ErrInvalidDTMF", err)
	}
	packet, err := BuildRTPDTMFPacket(RTPDTMFPacket{Signal: "1"})
	if err != nil {
		t.Fatalf("BuildRTPDTMFPacket() error = %v", err)
	}
	if _, _, err := ParseRTPDTMFEvent(RTPDTMFClientToIMS, packet[:15], map[uint8]int{DefaultRTPDTMFPayloadType: DefaultRTPDTMFClockRate}); !errors.Is(err, ErrInvalidDTMF) {
		t.Fatalf("ParseRTPDTMFEvent(short) err=%v, want ErrInvalidDTMF", err)
	}
	packet[12] = 99
	if _, _, err := ParseRTPDTMFEvent(RTPDTMFClientToIMS, packet, map[uint8]int{DefaultRTPDTMFPayloadType: DefaultRTPDTMFClockRate}); !errors.Is(err, ErrInvalidDTMF) {
		t.Fatalf("ParseRTPDTMFEvent(code) err=%v, want ErrInvalidDTMF", err)
	}
}
