package main

import (
	"bytes"
	"log"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/pion/rtp"
	"github.com/pion/webrtc/v4"
)

func TestS73RejoinWindowEnv(t *testing.T) {
	for raw, want := range map[string]time.Duration{"": 60 * time.Second, "0": 0, "15": 15 * time.Second, "600": 600 * time.Second} {
		if got, err := configuredRejoinWindow(raw); err != nil || got != want {
			t.Fatalf("%q: %v %v", raw, got, err)
		}
	}
	for _, raw := range []string{"-1", "601", "1.5", "60s", "x"} {
		if _, err := configuredRejoinWindow(raw); err == nil {
			t.Fatalf("%q accepted", raw)
		}
	}
}

// s73Room builds a room whose client leg is a bare (never connected) peer.
// ponytail: Failed takes pion ~30 s, so legFailed is invoked directly, as
// TestRecoverCallbackClosesOnlyItsEpochRoom does for recoverCallback.
func s73Room(t *testing.T, b *bridge, id string) (*room, *webrtc.PeerConnection) {
	t.Helper()
	r, err := b.getRoom(id)
	if err != nil {
		t.Fatal(err)
	}
	pc, err := webrtc.NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { pc.Close() })
	r.mu.Lock()
	r.peers["client"] = pc
	r.mu.Unlock()
	return r, pc
}

func roomOpen(b *bridge, id string) bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.rooms[id] != nil
}

func TestS73RejoinWindowExpiryClosesRoom(t *testing.T) {
	b := &bridge{rooms: map[string]*room{}, recordDir: t.TempDir(), rejoinWindow: 100 * time.Millisecond}
	id := "73737373-7373-7373-7373-737373737301"
	w := &roomClosedWriter{manifest: filepath.Join(b.recordDir, id, "manifest.json")}
	log.SetOutput(w)
	defer log.SetOutput(os.Stderr)
	r, pc := s73Room(t, b, id)
	b.legFailed(r, "client", pc, "failed")
	if !roomOpen(b, id) {
		t.Fatal("a failed leg closed the room inside the window")
	}
	// room_closed is logged after finalize, which follows the map delete.
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) && w.roomClosed() == "" {
		time.Sleep(10 * time.Millisecond)
	}
	if roomOpen(b, id) {
		t.Fatal("window expiry did not close the room")
	}
	line := w.roomClosed()
	if !strings.Contains(line, "reason=rejoin_timeout") || !strings.Contains(line, "rejoins=0") {
		t.Fatalf("room_closed line %q", line)
	}
	// Nothing ever flowed, so like pc_failed the directory is given back.
	if _, err := b.getRoom(id); err != nil {
		t.Fatalf("empty rejoin_timeout room left a tombstone: %v", err)
	}
	b.closeRoom(id, "test")
}

func TestS73RejoinWindowZeroIsLegacyClose(t *testing.T) {
	b := &bridge{rooms: map[string]*room{}, recordDir: t.TempDir()}
	id := "73737373-7373-7373-7373-737373737302"
	w := &roomClosedWriter{manifest: filepath.Join(b.recordDir, id, "manifest.json")}
	log.SetOutput(w)
	defer log.SetOutput(os.Stderr)
	r, pc := s73Room(t, b, id)
	b.legFailed(r, "client", pc, "failed")
	if roomOpen(b, id) {
		t.Fatal("window=0 kept the room after a failed leg")
	}
	if line := w.roomClosed(); !strings.Contains(line, "reason=pc_failed") {
		t.Fatalf("room_closed line %q", line)
	}
}

func TestS73StaleRejoinTimerDoesNotCloseRejoinedRoom(t *testing.T) {
	b := &bridge{rooms: map[string]*room{}, recordDir: t.TempDir(), rejoinWindow: time.Hour}
	id := "73737373-7373-7373-7373-737373737303"
	defer b.closeRoom(id, "test")
	r, pc := s73Room(t, b, id)
	b.legFailed(r, "client", pc, "failed")
	r.mu.Lock()
	gen := r.rejoin["client"].gen
	r.mu.Unlock()
	b.legConnected(r, "client")
	b.legConnected(r, "client") // a second Connected (or an initial connect) is a no-op
	b.rejoinExpired(r, "client", gen)
	if !roomOpen(b, id) {
		t.Fatal("a stale timer closed a rejoined room")
	}
	r.mu.Lock()
	rejoins := r.rejoins
	r.mu.Unlock()
	if rejoins != 1 {
		t.Fatalf("rejoins=%d", rejoins)
	}
}

func TestS73BadRetryOfferInsideWindowKeepsRoom(t *testing.T) {
	secret := bytes.Repeat([]byte("s"), 32)
	b := &bridge{rooms: map[string]*room{}, verifier: GrantVerifier{Secret: secret}, recordDir: t.TempDir(), rejoinWindow: time.Hour}
	server := httptest.NewServer(http.HandlerFunc(b.offer))
	defer server.Close()
	id := "73737373-7373-7373-7373-737373737304"
	defer b.closeRoom(id, "test")
	r, pc := s73Room(t, b, id)
	b.legFailed(r, "client", pc, "failed")
	req, _ := http.NewRequest("POST", server.URL, strings.NewReader(`{"type":"offer","sdp":"v=0\r\n"}`))
	req.Header.Set("Authorization", "Bearer "+sign(Grant{CallID: id, Role: "client", Expires: time.Now().Unix() + 60, Nonce: "s73-bad-retry-nonce-0001"}, secret))
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != 400 {
		t.Fatalf("bad retry returned %d", res.StatusCode)
	}
	if !roomOpen(b, id) {
		t.Fatal("a bad retry offer closed a room inside its rejoin window")
	}
}

// A real call: the client leg fails, a new client leg rejoins within the window,
// the room and its recording survive and the gateway DataChannel sequence keeps
// climbing across both legs (D4).
func TestS73RejoinedClientLegKeepsRoomRecordingAndSeq(t *testing.T) {
	secret := bytes.Repeat([]byte("j"), 32)
	b := &bridge{rooms: map[string]*room{}, verifier: GrantVerifier{Secret: secret}, recordDir: t.TempDir(), rejoinWindow: 30 * time.Second}
	server := httptest.NewServer(http.HandlerFunc(b.offer))
	defer server.Close()
	id := "73737373-7373-7373-7373-737373737305"
	defer b.closeRoom(id, "test")

	gateway, err := webrtc.NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		t.Fatal(err)
	}
	defer gateway.Close()
	ordered, retries := false, uint16(0)
	dc, err := gateway.CreateDataChannel("cellular-opus-v1", &webrtc.DataChannelInit{Ordered: &ordered, MaxRetransmits: &retries})
	if err != nil {
		t.Fatal(err)
	}
	opened := make(chan struct{})
	dc.OnOpen(func() { close(opened) })
	var mu sync.Mutex
	var seqs []uint32
	var stamps []uint64
	dc.OnMessage(func(m webrtc.DataChannelMessage) {
		if p, e := decodePacket(m.Data); e == nil {
			mu.Lock()
			seqs = append(seqs, p.Sequence)
			stamps = append(stamps, p.TimestampUS)
			mu.Unlock()
		}
	})
	received := func() int {
		mu.Lock()
		defer mu.Unlock()
		return len(seqs)
	}
	if code := postOffer(t, server.URL, id, "gateway", "s73-gateway-nonce-0001", secret, gateway, true); code != 200 {
		t.Fatalf("gateway offer: %d", code)
	}
	select {
	case <-opened:
	case <-time.After(5 * time.Second):
		t.Fatal("gateway DataChannel did not open")
	}

	payload := []byte{0xf8, 0xff, 0xfe} // one 20 ms Opus frame
	leg := func(nonce string, firstSeq uint16) *webrtc.PeerConnection {
		t.Helper()
		pc, e := webrtc.NewPeerConnection(webrtc.Configuration{})
		if e != nil {
			t.Fatal(e)
		}
		t.Cleanup(func() { pc.Close() })
		track, e := webrtc.NewTrackLocalStaticRTP(webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeOpus, ClockRate: 48000, Channels: 2}, "mic", "client")
		if e != nil {
			t.Fatal(e)
		}
		if _, e = pc.AddTrack(track); e != nil {
			t.Fatal(e)
		}
		if code := postOffer(t, server.URL, id, "client", nonce, secret, pc, true); code != 200 {
			t.Fatalf("client offer %s: %d", nonce, code)
		}
		deadline := time.Now().Add(5 * time.Second)
		for time.Now().Before(deadline) && pc.ConnectionState() != webrtc.PeerConnectionStateConnected {
			time.Sleep(10 * time.Millisecond)
		}
		if pc.ConnectionState() != webrtc.PeerConnectionStateConnected {
			t.Fatalf("client leg %s did not connect: %s", nonce, pc.ConnectionState())
		}
		before := received()
		for i := 0; i < 25; i++ {
			seq := firstSeq + uint16(i)
			if e = track.WriteRTP(&rtp.Packet{Header: rtp.Header{Version: 2, SequenceNumber: seq, Timestamp: uint32(seq) * 960}, Payload: payload}); e != nil {
				t.Fatal(e)
			}
			time.Sleep(20 * time.Millisecond)
		}
		deadline = time.Now().Add(3 * time.Second)
		for time.Now().Before(deadline) && received()-before < 20 {
			time.Sleep(10 * time.Millisecond)
		}
		if got := received() - before; got < 20 {
			t.Fatalf("leg %s: gateway got %d of 25 packets", nonce, got)
		}
		return pc
	}

	leg("s73-client-nonce-0001", 1000)
	firstLeg := received()
	b.mu.Lock()
	r := b.rooms[id]
	b.mu.Unlock()
	r.mu.Lock()
	bridgeClient := r.peers["client"]
	r.mu.Unlock()
	b.legFailed(r, "client", bridgeClient, "failed")
	r.mu.Lock()
	gone := r.peers["client"] == nil
	r.mu.Unlock()
	if !gone || !roomOpen(b, id) {
		t.Fatalf("failed leg: client removed=%v room open=%v", gone, roomOpen(b, id))
	}

	// The new leg's RTP numbering restarts elsewhere; the bridge sequence must not.
	leg("s73-client-nonce-0002", 7)
	deadline := time.Now().Add(3 * time.Second)
	rejoins := 0
	for time.Now().Before(deadline) && rejoins == 0 {
		r.mu.Lock()
		rejoins = r.rejoins
		r.mu.Unlock()
		time.Sleep(10 * time.Millisecond)
	}
	if rejoins != 1 {
		t.Fatalf("rejoin not counted: %d", rejoins)
	}
	mu.Lock()
	got := append([]uint32(nil), seqs...)
	mu.Unlock()
	for i := 1; i < len(got); i++ {
		if got[i] <= got[i-1] {
			t.Fatalf("gateway sequence went backwards across legs at %d: %v", i, got)
		}
	}
	mu.Lock()
	times := append([]uint64(nil), stamps...)
	mu.Unlock()
	for i := 1; i < len(times); i++ {
		if times[i] <= times[i-1] {
			t.Fatalf("gateway timestamp went backwards across legs at %d: %v", i, times)
		}
	}
	if last := got[len(got)-1]; last <= uint32(firstLeg) {
		t.Fatalf("second leg restarted numbering: last=%d first leg=%d", last, firstLeg)
	}

	w := &roomClosedWriter{manifest: filepath.Join(b.recordDir, id, "manifest.json")}
	log.SetOutput(w)
	defer log.SetOutput(os.Stderr)
	b.closeRoom(id, "test")
	if line := w.roomClosed(); !strings.Contains(line, "rejoins=1") {
		t.Fatalf("room_closed line %q", line)
	}
	r.mu.Lock()
	up := r.upPackets
	r.mu.Unlock()
	if up < 40 {
		t.Fatalf("recording did not continue across the rejoin: up_pkts=%d", up)
	}
}

// S75c: the owner's offer (grant replace=true) replaces a leg the bridge still sees
// Connected, through the same rejoin path as a Disconnected leg; without the flag a
// Connected leg is still a 409.
func TestS75cForcedReplaceOfConnectedLegRejoins(t *testing.T) {
	secret := bytes.Repeat([]byte("c"), 32)
	b := &bridge{rooms: map[string]*room{}, verifier: GrantVerifier{Secret: secret}, recordDir: t.TempDir(), rejoinWindow: 30 * time.Second}
	server := httptest.NewServer(http.HandlerFunc(b.offer))
	defer server.Close()
	id := "75c75c75-7575-7575-7575-757575757501"
	defer b.closeRoom(id, "test")
	grant := func(nonce string, replace bool) Grant {
		return Grant{CallID: id, Role: "gateway", Expires: time.Now().Unix() + 60, Nonce: nonce, Replace: replace}
	}
	connect := func(pc *webrtc.PeerConnection) {
		t.Helper()
		deadline := time.Now().Add(5 * time.Second)
		for time.Now().Before(deadline) && pc.ConnectionState() != webrtc.PeerConnectionStateConnected {
			time.Sleep(10 * time.Millisecond)
		}
		if pc.ConnectionState() != webrtc.PeerConnectionStateConnected {
			t.Fatalf("leg did not connect: %s", pc.ConnectionState())
		}
	}
	first := newGatewayOfferPeer(t)
	if code := postGrantOffer(t, server.URL, grant("s75c-first-nonce-000001", false), secret, first, true); code != 200 {
		t.Fatalf("first offer: %d", code)
	}
	connect(first)
	b.mu.Lock()
	r := b.rooms[id]
	b.mu.Unlock()
	legConnected := func() bool {
		r.mu.Lock()
		defer r.mu.Unlock()
		return r.peers["gateway"] != nil && r.peers["gateway"].ConnectionState() == webrtc.PeerConnectionStateConnected
	}
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) && !legConnected() {
		time.Sleep(10 * time.Millisecond)
	}
	r.mu.Lock()
	oldLeg, recorder := r.peers["gateway"], r.recorder
	r.mu.Unlock()
	if !legConnected() {
		t.Fatal("bridge leg never reached Connected")
	}

	// Not the owner (no flag): today's rule.
	if code := postGrantOffer(t, server.URL, grant("s75c-plain-nonce-000001", false), secret, newGatewayOfferPeer(t), false); code != 409 {
		t.Fatalf("unforced offer over a connected leg returned %d, want 409", code)
	}
	// The owner: replaces it.
	second := newGatewayOfferPeer(t)
	if code := postGrantOffer(t, server.URL, grant("s75c-forced-nonce-00001", true), secret, second, true); code != 200 {
		t.Fatalf("forced offer over a connected leg returned %d, want 200", code)
	}
	connect(second)
	deadline = time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		r.mu.Lock()
		n := r.rejoins
		r.mu.Unlock()
		if n == 1 {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if oldLeg.ConnectionState() != webrtc.PeerConnectionStateClosed {
		t.Fatalf("replaced leg left open: %s", oldLeg.ConnectionState())
	}
	r.mu.Lock()
	closed, current, rejoins, sameRecorder := r.closed, r.peers["gateway"], r.rejoins, r.recorder == recorder
	pending := r.rejoinPendingLocked()
	r.mu.Unlock()
	if closed || !roomOpen(b, id) || current == nil || current == oldLeg {
		t.Fatalf("room lost or leg not replaced: closed=%v replaced=%v", closed, current != oldLeg)
	}
	if rejoins != 1 || pending || recorder == nil || !sameRecorder {
		t.Fatalf("rejoins=%d pending=%v sameRecorder=%v", rejoins, pending, sameRecorder)
	}
}
