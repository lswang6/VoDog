package main

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/pion/interceptor"
	"github.com/pion/rtcp"
	"github.com/pion/rtp"
	"github.com/pion/webrtc/v4"
	"github.com/pion/webrtc/v4/pkg/media/oggwriter"
)

func TestDownSequenceForwardsLateAndSettlesMissing(t *testing.T) {
	r := &room{}
	type step struct {
		seq             uint32
		late, forwarded bool
	}
	for _, s := range []step{
		{100, false, true},
		{103, false, true},  // 101, 102 missing
		{101, true, true},   // late, fills a gap
		{101, false, false}, // duplicate of a late packet
		{103, false, false}, // duplicate of the newest
		{160, false, true},  // 104..159 missing (56)
		{109, false, false}, // 51 behind: too old
		{110, true, true},   // 50 behind: edge of the window
	} {
		late, forwarded := r.acceptDownSequence(s.seq)
		if late != s.late || forwarded != s.forwarded {
			t.Fatalf("seq %d: late=%v forwarded=%v want %v %v", s.seq, late, forwarded, s.late, s.forwarded)
		}
	}
	got := r.transport
	// Never filled: 102, 104..109, 111..159 = 1 + 6 + 49.
	if got.DownSequenceMissing != 56 || got.DownLateForwarded != 2 || got.DownLate != 3 || got.DownDuplicate != 2 || got.DownOutOfOrderDrop != 3 {
		t.Fatalf("counters %+v", got)
	}
	// A leg replacement resets the window; uint32 wrap is forward progress.
	r = &room{}
	r.acceptDownSequence(0xffffffff)
	if late, ok := r.acceptDownSequence(1); late || !ok || r.transport.DownSequenceMissing != 1 {
		t.Fatalf("wrap: late=%v ok=%v %+v", late, ok, r.transport)
	}
	if late, ok := r.acceptDownSequence(0); !late || !ok || r.transport.DownSequenceMissing != 0 {
		t.Fatalf("late across wrap: late=%v ok=%v %+v", late, ok, r.transport)
	}
	// A straggler from before the first packet never under-counts.
	if _, ok := r.acceptDownSequence(0xfffffffe); ok || r.transport.DownSequenceMissing != 0 {
		t.Fatalf("pre-start straggler forwarded: %+v", r.transport)
	}
}

// blockingWriter parks the recorder goroutine on its first write.
type blockingWriter struct {
	entered chan struct{}
	release chan struct{}
	once    sync.Once
	mu      sync.Mutex
	buf     bytes.Buffer
}

func (w *blockingWriter) Write(p []byte) (int, error) {
	w.once.Do(func() {
		close(w.entered)
		<-w.release
	})
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.buf.Write(p)
}
func (w *blockingWriter) Close() error { return nil }

func testOgg(t *testing.T) *oggwriter.OggWriter {
	t.Helper()
	w, err := oggwriter.NewWith(io.Discard, 48000, 1)
	if err != nil {
		t.Fatal(err)
	}
	return w
}

func TestRecordingQueueFullDropsAndCounts(t *testing.T) {
	timeline := &blockingWriter{entered: make(chan struct{}), release: make(chan struct{})}
	r := &room{created: time.Now()}
	r.recorder = startRoomRecorder(testOgg(t), testOgg(t), timeline, recordingQueueSize)
	packet := &rtp.Packet{Header: rtp.Header{Version: 2, Timestamp: 960}, Payload: []byte{0xf8, 0xff, 0xfe}}
	r.record(r.recorder.down, packet, "remote_original", 1, 0, 20, false)
	<-timeline.entered // the writer holds job 1; the queue is empty again
	for i := 0; i < recordingQueueSize; i++ {
		r.record(r.recorder.up, packet, "caller_original", uint32(i), 0, 20, false)
	}
	if r.transport.RecordingDrops != 0 {
		t.Fatalf("dropped before the queue was full: %d", r.transport.RecordingDrops)
	}
	r.record(r.recorder.up, packet, "caller_original", 9999, 0, 20, true)
	if r.transport.RecordingDrops != 1 {
		t.Fatalf("full queue did not drop: %d", r.transport.RecordingDrops)
	}
	close(timeline.release)
	r.recorder.close()
	if r.recorder.failed || r.recorder.downPackets.Load() != 1 || r.recorder.upPackets.Load() != recordingQueueSize {
		t.Fatalf("drained %+v", r.recorder)
	}
	if lines := strings.Count(timeline.buf.String(), "\n"); lines != recordingQueueSize+1 {
		t.Fatalf("timeline lines=%d", lines)
	}
}

// A late packet is written to the timeline with late:true but never to the Ogg,
// and closeRoom finalizes only after the writer has drained.
func TestLatePacketIsTimelineOnlyAndCloseDrainsBeforeManifest(t *testing.T) {
	b := &bridge{rooms: map[string]*room{}, recordDir: t.TempDir()}
	id := "70707070-7070-7070-7070-707070707070"
	r, err := b.getRoom(id)
	if err != nil {
		t.Fatal(err)
	}
	payload := []byte{0xf8, 0xff, 0xfe}
	r.mu.Lock()
	for _, step := range []struct {
		seq  uint32
		late bool
	}{{1, false}, {3, false}, {2, true}} {
		for _, direction := range []string{"remote_original", "caller_original"} {
			ogg := r.recorder.down
			if direction == "caller_original" {
				ogg = r.recorder.up
			}
			r.record(ogg, &rtp.Packet{Header: rtp.Header{Version: 2, SequenceNumber: uint16(step.seq), Timestamp: step.seq * 960}, Payload: payload}, direction, step.seq, uint64(step.seq)*20000, 20, step.late)
		}
	}
	r.mu.Unlock()
	b.closeRoom(id, "test")
	if r.downPackets != 2 || r.upPackets != 2 {
		t.Fatalf("late packet reached the Ogg: down=%d up=%d", r.downPackets, r.upPackets)
	}
	raw, err := os.ReadFile(filepath.Join(b.recordDir, id, "timeline.jsonl"))
	if err != nil {
		t.Fatal(err)
	}
	lines := strings.Split(strings.TrimSpace(string(raw)), "\n")
	if len(lines) != 6 {
		t.Fatalf("timeline lines=%d", len(lines))
	}
	for index, line := range lines {
		var entry map[string]any
		if err := json.Unmarshal([]byte(line), &entry); err != nil {
			t.Fatal(err)
		}
		_, late := entry["late"]
		if late != (index >= 4) || (late && entry["late"] != true) {
			t.Fatalf("line %d late flag: %s", index, line)
		}
	}
	var manifest recordingManifest
	manifestRaw, err := os.ReadFile(filepath.Join(b.recordDir, id, "manifest.json"))
	if err != nil || json.Unmarshal(manifestRaw, &manifest) != nil || !manifest.Complete {
		t.Fatalf("manifest %v %s", err, manifestRaw)
	}
	for _, artifact := range manifest.Artifacts {
		if artifact.Name == "timeline.jsonl" && artifact.Bytes != int64(len(raw)) {
			t.Fatalf("manifest hashed a timeline still being written: %d != %d", artifact.Bytes, len(raw))
		}
	}
	stats, err := os.ReadFile(filepath.Join(b.recordDir, id, "transport-stats.json"))
	if err != nil || !strings.Contains(string(stats), `"recordingDrops":0`) || !strings.Contains(string(stats), `"downLateForwarded":0`) || !strings.Contains(string(stats), `"downSequenceMissing":0`) {
		t.Fatalf("transport stats keys: %v %s", err, stats)
	}
}

func TestRaiseFractionLostFloorsReceiverAndSenderReports(t *testing.T) {
	floor := lossFloorFraction(5)
	if floor != 12 || lossFloorFraction(9) != 23 || lossFloorFraction(0) != 0 {
		t.Fatalf("fractions %d %d", floor, lossFloorFraction(9))
	}
	rr := &rtcp.ReceiverReport{Reports: []rtcp.ReceptionReport{{SSRC: 1, FractionLost: 0}, {SSRC: 2, FractionLost: 40}}}
	sr := &rtcp.SenderReport{Reports: []rtcp.ReceptionReport{{SSRC: 3, FractionLost: 3}}}
	pli := &rtcp.PictureLossIndication{MediaSSRC: 4}
	compound := &rtcp.CompoundPacket{&rtcp.ReceiverReport{Reports: []rtcp.ReceptionReport{{SSRC: 5}}}}
	var written []rtcp.Packet
	writer := (&rtcpLossFloor{fraction: floor}).BindRTCPWriter(interceptor.RTCPWriterFunc(func(pkts []rtcp.Packet, _ interceptor.Attributes) (int, error) {
		written = pkts
		return 0, nil
	}))
	if _, err := writer.Write([]rtcp.Packet{rr, sr, pli, compound}, nil); err != nil {
		t.Fatal(err)
	}
	if len(written) != 4 || rr.Reports[0].FractionLost != 12 || rr.Reports[1].FractionLost != 40 || sr.Reports[0].FractionLost != 12 || (*compound)[0].(*rtcp.ReceiverReport).Reports[0].FractionLost != 12 {
		t.Fatalf("floor not applied as max(actual, floor): rr=%+v sr=%+v compound=%+v", rr.Reports, sr.Reports, (*compound)[0])
	}
	// The rewritten packet still marshals (the transport serializes it next).
	if _, err := rtcp.Marshal(written[:3]); err != nil {
		t.Fatal(err)
	}
}

func TestS70EnvParsing(t *testing.T) {
	for raw, want := range map[string]uint8{"": 0, "0": 0, "1": 1, "5": 5, "9": 9} {
		if got, err := configuredRRLossFloorPct(raw); err != nil || got != want {
			t.Fatalf("floor %q: %d %v", raw, got, err)
		}
	}
	for _, raw := range []string{"10", "50", "-1", "5%", " 5", "x"} {
		if _, err := configuredRRLossFloorPct(raw); err == nil {
			t.Fatalf("floor %q accepted", raw)
		}
	}
	for raw, want := range map[string]uint64{"": 0, "0": 0, "2": 2, "20": 20} {
		if got, err := configuredTestDropEveryN(raw); err != nil || got != want {
			t.Fatalf("drop %q: %d %v", raw, got, err)
		}
	}
	for _, raw := range []string{"1", "-2", "x", "2.5"} {
		if _, err := configuredTestDropEveryN(raw); err == nil {
			t.Fatalf("drop %q accepted", raw)
		}
	}
	off := &bridge{}
	every20 := &bridge{testDropEveryN: 20}
	drops := 0
	for received := uint64(1); received <= 100; received++ {
		if off.testDrop(received) {
			t.Fatal("drop knob off still drops")
		}
		if every20.testDrop(received) {
			drops++
		}
	}
	if drops != 5 {
		t.Fatalf("every 20th of 100 dropped %d", drops)
	}
}

// End to end: a floored peer's RTCP reaches the RTP sender with FractionLost at
// the floor on a lossless loopback, while the unfloored control reports 0.
func TestLossFloorReachesRTPSenderReceiverReport(t *testing.T) {
	for _, tc := range []struct {
		floor  uint8
		tuning sctpTuning
		want   uint8
	}{{0, sctpTuning{}, 0}, {5, sctpTuning{}, 12}, {5, sctpTuning{name: "v1", minCwnd: sctpTuningV1MinCwnd, rtoMax: sctpTuningV1RTOMax}, 12}} {
		t.Run(tc.tuning.label()+"-"+string(rune('0'+tc.floor)), func(t *testing.T) {
			sender, err := webrtc.NewPeerConnection(webrtc.Configuration{})
			if err != nil {
				t.Fatal(err)
			}
			defer sender.Close()
			receiver, err := newMediaPeerConnection(tc.tuning, tc.floor, webrtc.Configuration{})
			if err != nil {
				t.Fatal(err)
			}
			defer receiver.Close()
			track, err := webrtc.NewTrackLocalStaticRTP(webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeOpus, ClockRate: 48000, Channels: 2}, "mic", "client")
			if err != nil {
				t.Fatal(err)
			}
			rtpSender, err := sender.AddTrack(track)
			if err != nil {
				t.Fatal(err)
			}
			receiver.OnTrack(func(remote *webrtc.TrackRemote, _ *webrtc.RTPReceiver) {
				for {
					if _, _, err := remote.ReadRTP(); err != nil {
						return
					}
				}
			})
			offer, err := sender.CreateOffer(nil)
			if err != nil {
				t.Fatal(err)
			}
			gather := webrtc.GatheringCompletePromise(sender)
			if err = sender.SetLocalDescription(offer); err != nil {
				t.Fatal(err)
			}
			<-gather
			if err = receiver.SetRemoteDescription(*sender.LocalDescription()); err != nil {
				t.Fatal(err)
			}
			answer, err := receiver.CreateAnswer(nil)
			if err != nil {
				t.Fatal(err)
			}
			gather = webrtc.GatheringCompletePromise(receiver)
			if err = receiver.SetLocalDescription(answer); err != nil {
				t.Fatal(err)
			}
			<-gather
			if err = sender.SetRemoteDescription(*receiver.LocalDescription()); err != nil {
				t.Fatal(err)
			}
			reports := make(chan uint8, 16)
			go func() {
				for {
					pkts, _, err := rtpSender.ReadRTCP()
					if err != nil {
						return
					}
					for _, p := range pkts {
						if rr, ok := p.(*rtcp.ReceiverReport); ok && len(rr.Reports) > 0 {
							select {
							case reports <- rr.Reports[0].FractionLost:
							default:
							}
						}
					}
				}
			}()
			stop := make(chan struct{})
			defer close(stop)
			go func() {
				ticker := time.NewTicker(20 * time.Millisecond)
				defer ticker.Stop()
				for seq := uint16(1); ; seq++ {
					select {
					case <-stop:
						return
					case <-ticker.C:
					}
					_ = track.WriteRTP(&rtp.Packet{Header: rtp.Header{Version: 2, SequenceNumber: seq, Timestamp: uint32(seq) * 960}, Payload: []byte{0xf8, 0xff, 0xfe}})
				}
			}()
			select {
			case got := <-reports:
				if got != tc.want {
					t.Fatalf("RR FractionLost=%d want %d", got, tc.want)
				}
			case <-time.After(15 * time.Second): // loopback ICE here takes up to ~7 s
				t.Fatalf("no receiver report reached the sender (sender=%s receiver=%s)", sender.ConnectionState(), receiver.ConnectionState())
			}
		})
	}
}

// Through the bridge: the floored peer carries a full round trip, and the drop
// knob skips exactly every Nth up packet after recording.
func TestEncryptedBridgeRoundTripWithLossFloorAndTestDrop(t *testing.T) {
	secret := bytes.Repeat([]byte("q"), 32)
	b := &bridge{rooms: map[string]*room{}, verifier: GrantVerifier{Secret: secret}, recordDir: t.TempDir(), rrLossFloorPct: 5, testDropEveryN: 2}
	server := httptest.NewServer(http.HandlerFunc(b.offer))
	defer server.Close()
	id := "70707070-7070-7070-7070-707070707071"
	defer b.closeRoom(id, "test")
	runBridgeRoundTrip(t, server.URL, id, secret, webrtc.Configuration{})
	b.mu.Lock()
	r := b.rooms[id]
	b.mu.Unlock()
	r.mu.Lock()
	stats := r.transport
	r.mu.Unlock()
	// Every even-numbered packet is a test drop unless an earlier gate took it.
	other := stats.UpChannelUnavailable + stats.UpBackpressureDrops
	if stats.UpReceived == 0 || stats.UpTestDrops > stats.UpReceived/2 || stats.UpTestDrops+other < stats.UpReceived/2 || stats.UpSent+stats.UpTestDrops+other != stats.UpReceived {
		t.Fatalf("drop knob: %+v", stats)
	}
}
