package main

import (
	"bytes"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"github.com/pion/rtp"
	"github.com/pion/webrtc/v4"
	"io"
	"log"
	"math"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

const probeHTTPTimeout = 10 * time.Second

func newProbeHTTPClient(timeout time.Duration) *http.Client {
	return &http.Client{Timeout: timeout}
}

func TestEncryptedBridgeRoundTrip(t *testing.T) {
	secret := bytes.Repeat([]byte("s"), 32)
	b := &bridge{rooms: map[string]*room{}, verifier: GrantVerifier{Secret: secret}, recordDir: t.TempDir()}
	server := httptest.NewServer(http.HandlerFunc(b.offer))
	defer server.Close()
	id := "22222222-2222-2222-2222-222222222222"
	defer b.closeRoom(id, "test")
	runBridgeRoundTrip(t, server.URL, id, secret, webrtc.Configuration{})
}

func TestEncryptedBridgeRoundTripIsolatedRexmitTwo(t *testing.T) {
	t.Setenv("CC_MEDIA_PROBE_MAX_RETRANSMITS", "2")
	secret := bytes.Repeat([]byte("r"), 32)
	b := &bridge{rooms: map[string]*room{}, verifier: GrantVerifier{Secret: secret}, recordDir: t.TempDir(), dataChannelRetransmits: 2}
	server := httptest.NewServer(http.HandlerFunc(b.offer))
	defer server.Close()
	id := "23232323-2323-2323-2323-232323232323"
	defer b.closeRoom(id, "test")
	runBridgeRoundTrip(t, server.URL, id, secret, webrtc.Configuration{})
}

func TestEncryptedBridgeRoundTripIsolatedCopiesTwo(t *testing.T) {
	t.Setenv("CC_MEDIA_PROBE_COPIES", "2")
	secret := bytes.Repeat([]byte("d"), 32)
	b := &bridge{rooms: map[string]*room{}, verifier: GrantVerifier{Secret: secret}, recordDir: t.TempDir(), dataChannelCopies: 2, dataChannelCopyInterval: 5 * time.Millisecond}
	server := httptest.NewServer(http.HandlerFunc(b.offer))
	defer server.Close()
	id := "24242424-2424-2424-2424-242424242424"
	defer b.closeRoom(id, "test")
	runBridgeRoundTrip(t, server.URL, id, secret, webrtc.Configuration{})
	time.Sleep(25 * time.Millisecond)
	b.mu.Lock()
	r := b.rooms[id]
	b.mu.Unlock()
	if r == nil {
		t.Fatal("copies experiment room closed before stats inspection")
	}
	r.mu.Lock()
	stats := r.transport
	r.mu.Unlock()
	if stats.DownUniqueReceived == 0 || stats.DownDuplicate == 0 || stats.UpLogicalSent == 0 || stats.UpPhysicalCopies < 2 {
		t.Fatalf("copies experiment did not preserve logical and physical accounting: %+v", stats)
	}
	if stats.SCTPTuning != "off" {
		t.Fatalf("default SCTP tuning must be recorded as off: %q", stats.SCTPTuning)
	}
}

func TestEncryptedBridgeRoundTripIsolatedCopiesThreeAtZeroInterval(t *testing.T) {
	t.Setenv("CC_MEDIA_PROBE_COPIES", "3")
	t.Setenv("CC_MEDIA_PROBE_COPY_INTERVAL_MS", "0")
	secret := bytes.Repeat([]byte("t"), 32)
	b := &bridge{rooms: map[string]*room{}, verifier: GrantVerifier{Secret: secret}, recordDir: t.TempDir(), dataChannelCopies: 3, dataChannelCopyInterval: 0}
	server := httptest.NewServer(http.HandlerFunc(b.offer))
	defer server.Close()
	id := "26262626-2626-2626-2626-262626262626"
	defer b.closeRoom(id, "test")
	runBridgeRoundTrip(t, server.URL, id, secret, webrtc.Configuration{})
	time.Sleep(25 * time.Millisecond)
	b.mu.Lock()
	r := b.rooms[id]
	b.mu.Unlock()
	if r == nil {
		t.Fatal("copies experiment room closed before stats inspection")
	}
	r.mu.Lock()
	stats := r.transport
	r.mu.Unlock()
	if stats.UpLogicalSent == 0 || stats.UpPhysicalCopies < 3*stats.UpLogicalSent-3 {
		t.Fatalf("copies=3 did not emit three physical copies per logical packet: %+v", stats)
	}
}

// D9: the tuned peer must still complete a full bridge round trip, and the
// minimum congestion window must have reached the live SCTP association. The
// congestion window is read from the samples recorded while the association was
// still up, because the peers are torn down when the round trip returns.
func TestEncryptedBridgeRoundTripSCTPTuningV1(t *testing.T) {
	observed := func(t *testing.T, raw, id string, secret []byte) mediaTransportStats {
		t.Helper()
		tuning, err := configuredSCTPTuning(raw)
		if err != nil {
			t.Fatal(err)
		}
		b := &bridge{rooms: map[string]*room{}, verifier: GrantVerifier{Secret: secret}, recordDir: t.TempDir(), sctpTuning: tuning}
		server := httptest.NewServer(http.HandlerFunc(b.offer))
		defer server.Close()
		defer b.closeRoom(id, "test")
		runBridgeRoundTrip(t, server.URL, id, secret, webrtc.Configuration{})
		b.mu.Lock()
		r := b.rooms[id]
		b.mu.Unlock()
		if r == nil {
			t.Fatalf("tuning=%q room closed before stats inspection", raw)
		}
		r.mu.Lock()
		defer r.mu.Unlock()
		// Samples share a backing array with the live room, so copy it out under
		// the room lock rather than ranging over it after the unlock.
		stats := r.transport
		stats.Samples = append([]mediaTransportSample(nil), r.transport.Samples...)
		return stats
	}
	maxCongestionWindow := func(stats mediaTransportStats) uint32 {
		window := uint32(0)
		for _, sample := range stats.Samples {
			if sample.CongestionWindow > window {
				window = sample.CongestionWindow
			}
		}
		return window
	}
	off := observed(t, "off", "25252525-2525-2525-2525-252525252525", bytes.Repeat([]byte("g"), 32))
	tuned := observed(t, "v1", "28282828-2828-2828-2828-282828282828", bytes.Repeat([]byte("h"), 32))
	if off.SCTPTuning != "off" || tuned.SCTPTuning != "v1" {
		t.Fatalf("transport stats did not record the tuning: off=%q v1=%q", off.SCTPTuning, tuned.SCTPTuning)
	}
	if len(off.Samples) == 0 || len(tuned.Samples) == 0 {
		t.Fatalf("no transport samples: off=%d v1=%d", len(off.Samples), len(tuned.Samples))
	}
	offWindow, tunedWindow := maxCongestionWindow(off), maxCongestionWindow(tuned)
	t.Logf("congestion window: off=%d v1=%d", offWindow, tunedWindow)
	// pion/sctp clamps every setCWND write, including the initial window, at the
	// configured minimum, so this is a direct read of SetSCTPMinCwnd taking hold.
	if tunedWindow < sctpTuningV1MinCwnd {
		t.Fatalf("SetSCTPMinCwnd did not reach the association: cwnd=%d", tunedWindow)
	}
	if offWindow == 0 {
		t.Fatalf("untuned run recorded no congestion window; the comparison would be meaningless")
	}
}

// D1 pins the audit's inference that pion backfills the caller's Opus fmtp into
// the answer: what the Pixel leg actually negotiates is the client's line, not
// the bridge's local one.
func TestOfferAnswerEchoesCallerOpusFmtpLine(t *testing.T) {
	for _, callerFmtp := range []string{
		"minptime=10;useinbandfec=1;stereo=0;sprop-stereo=0;maxaveragebitrate=32000",
		"minptime=10;useinbandfec=1;stereo=0;sprop-stereo=0;maxaveragebitrate=32000;usedtx=1",
		// S70: the three ends and Voice cap their own encoders at wideband.
		"minptime=10;useinbandfec=1;stereo=0;sprop-stereo=0;maxaveragebitrate=32000;maxplaybackrate=16000;sprop-maxcapturerate=16000",
	} {
		t.Run(callerFmtp, func(t *testing.T) {
			secret := bytes.Repeat([]byte("f"), 32)
			b := &bridge{rooms: map[string]*room{}, verifier: GrantVerifier{Secret: secret}, recordDir: t.TempDir()}
			server := httptest.NewServer(http.HandlerFunc(b.offer))
			defer server.Close()
			id := "27272727-2727-2727-2727-27272727272" + string(rune('0'+len(callerFmtp)%10))
			defer b.closeRoom(id, "test")

			caller, err := webrtc.NewPeerConnection(webrtc.Configuration{})
			if err != nil {
				t.Fatal(err)
			}
			defer caller.Close()
			if _, err = caller.AddTransceiverFromKind(webrtc.RTPCodecTypeAudio); err != nil {
				t.Fatal(err)
			}
			offer, err := caller.CreateOffer(nil)
			if err != nil {
				t.Fatal(err)
			}
			payloadType := ""
			for _, line := range strings.Split(offer.SDP, "\r\n") {
				if strings.HasPrefix(line, "a=rtpmap:") && strings.Contains(strings.ToLower(line), "opus/48000/2") {
					payloadType = strings.TrimPrefix(strings.Split(line, " ")[0], "a=rtpmap:")
				}
			}
			if payloadType == "" {
				t.Fatal("caller offer has no Opus rtpmap")
			}
			expected := "a=fmtp:" + payloadType + " " + callerFmtp
			replaced := false
			lines := strings.Split(offer.SDP, "\r\n")
			for index, line := range lines {
				if strings.HasPrefix(line, "a=fmtp:"+payloadType+" ") {
					lines[index] = expected
					replaced = true
				}
			}
			if !replaced {
				t.Fatal("caller offer has no Opus fmtp line to rewrite")
			}
			offer.SDP = strings.Join(lines, "\r\n")

			body, err := json.Marshal(offer)
			if err != nil {
				t.Fatal(err)
			}
			request, err := http.NewRequest("POST", server.URL, bytes.NewReader(body))
			if err != nil {
				t.Fatal(err)
			}
			request.Header.Set("Authorization", "Bearer "+sign(Grant{CallID: id, Role: "client", Expires: time.Now().Unix() + 60, Nonce: "fmtp-" + id}, secret))
			response, err := newProbeHTTPClient(probeHTTPTimeout).Do(request)
			if err != nil {
				t.Fatal(err)
			}
			var answer webrtc.SessionDescription
			decodeErr := json.NewDecoder(response.Body).Decode(&answer)
			response.Body.Close()
			if decodeErr != nil || response.StatusCode != 200 {
				t.Fatalf("SDP: %d %v", response.StatusCode, decodeErr)
			}
			found := false
			for _, line := range strings.Split(answer.SDP, "\r\n") {
				if strings.HasPrefix(line, "a=fmtp:"+payloadType+" ") {
					found = true
					if line != expected {
						t.Fatalf("answer fmtp was not backfilled from the offer:\nwant %q\ngot  %q", expected, line)
					}
				}
			}
			if !found {
				t.Fatalf("answer has no fmtp line for payload type %s:\n%s", payloadType, answer.SDP)
			}
		})
	}
}

func TestLocalOpusFmtpLinePinsThirtyTwoKilobits(t *testing.T) {
	if opusMaxAverageBitrate != 32000 {
		t.Fatalf("opusMaxAverageBitrate=%d", opusMaxAverageBitrate)
	}
	if localOpusFmtpLine != "minptime=10;useinbandfec=1;stereo=0;sprop-stereo=0;maxaveragebitrate=32000" {
		t.Fatalf("localOpusFmtpLine=%q", localOpusFmtpLine)
	}
	if strings.Contains(localOpusFmtpLine, "usedtx") {
		t.Fatalf("D1 removes DTX from the unified contract: %q", localOpusFmtpLine)
	}
}

func TestClosingCallerPeerDoesNotCloseGatewayRoom(t *testing.T) {
	secret := bytes.Repeat([]byte("c"), 32)
	b := &bridge{rooms: map[string]*room{}, verifier: GrantVerifier{Secret: secret}, recordDir: t.TempDir()}
	server := httptest.NewServer(http.HandlerFunc(b.offer))
	defer server.Close()
	id := "21212121-2121-2121-2121-212121212121"
	defer b.closeRoom(id, "test")

	gateway, err := webrtc.NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		t.Fatal(err)
	}
	defer gateway.Close()
	ordered := false
	retries := uint16(0)
	if _, err = gateway.CreateDataChannel("cellular-opus-v1", &webrtc.DataChannelInit{Ordered: &ordered, MaxRetransmits: &retries}); err != nil {
		t.Fatal(err)
	}
	caller, err := webrtc.NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		t.Fatal(err)
	}
	track, err := webrtc.NewTrackLocalStaticRTP(webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeOpus, ClockRate: 48000, Channels: 2}, "caller", "vodog")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = caller.AddTrack(track); err != nil {
		t.Fatal(err)
	}

	connect := func(pc *webrtc.PeerConnection, role string) {
		t.Helper()
		offer, createErr := pc.CreateOffer(nil)
		if createErr != nil {
			t.Fatal(createErr)
		}
		gather := webrtc.GatheringCompletePromise(pc)
		if setErr := pc.SetLocalDescription(offer); setErr != nil {
			t.Fatal(setErr)
		}
		select {
		case <-gather:
		case <-time.After(5 * time.Second):
			t.Fatal("ICE gathering timeout")
		}
		body, _ := json.Marshal(pc.LocalDescription())
		req, _ := http.NewRequest("POST", server.URL, bytes.NewReader(body))
		req.Header.Set("Authorization", "Bearer "+sign(Grant{CallID: id, Role: role, Expires: time.Now().Unix() + 60, Nonce: "caller-close-proof-" + role}, secret))
		res, requestErr := http.DefaultClient.Do(req)
		if requestErr != nil {
			t.Fatal(requestErr)
		}
		var answer webrtc.SessionDescription
		decodeErr := json.NewDecoder(res.Body).Decode(&answer)
		res.Body.Close()
		if decodeErr != nil || res.StatusCode != http.StatusOK {
			t.Fatalf("%s answer: status=%d error=%v", role, res.StatusCode, decodeErr)
		}
		if setErr := pc.SetRemoteDescription(answer); setErr != nil {
			t.Fatal(setErr)
		}
	}
	connect(gateway, "gateway")
	connect(caller, "client")

	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) && (gateway.ConnectionState() != webrtc.PeerConnectionStateConnected || caller.ConnectionState() != webrtc.PeerConnectionStateConnected) {
		time.Sleep(10 * time.Millisecond)
	}
	if gateway.ConnectionState() != webrtc.PeerConnectionStateConnected || caller.ConnectionState() != webrtc.PeerConnectionStateConnected {
		t.Fatalf("peers did not connect: gateway=%s caller=%s", gateway.ConnectionState(), caller.ConnectionState())
	}
	if err = caller.Close(); err != nil {
		t.Fatal(err)
	}
	time.Sleep(250 * time.Millisecond)

	b.mu.Lock()
	room := b.rooms[id]
	b.mu.Unlock()
	if room == nil {
		t.Fatal("closing the caller peer closed the whole room")
	}
	room.mu.Lock()
	closed := room.closed
	bridgeGateway := room.peers["gateway"]
	room.mu.Unlock()
	if closed || bridgeGateway == nil {
		t.Fatalf("gateway room was not preserved: closed=%v gatewayPeer=%v", closed, bridgeGateway != nil)
	}
	if state := bridgeGateway.ConnectionState(); state == webrtc.PeerConnectionStateClosed || state == webrtc.PeerConnectionStateFailed {
		t.Fatalf("gateway bridge peer was closed with caller: %s", state)
	}
}
func TestRemoteEncryptedBridge(t *testing.T) {
	endpoint := os.Getenv("CC_MEDIA_PROBE_ENDPOINT")
	if endpoint == "" {
		t.Skip("explicit remote probe only")
	}
	if endpoint != "http://127.0.0.1:16883" {
		t.Fatal("probe only supports local SSH forward")
	}
	secret := []byte(os.Getenv("CC_MEDIA_PROBE_SECRET"))
	if len(secret) < 32 {
		t.Fatal("missing probe secret")
	}
	raw := make([]byte, 16)
	if _, e := rand.Read(raw); e != nil {
		t.Fatal(e)
	}
	id := fmt.Sprintf("%x-%x-%x-%x-%x", raw[0:4], raw[4:6], raw[6:8], raw[8:10], raw[10:16])
	defer func() {
		req, _ := http.NewRequest("POST", endpoint+"/close/"+id, nil)
		req.Header.Set("Authorization", "Bearer "+string(secret))
		req.Header.Set("X-Media-Epoch", "1")
		res, e := newProbeHTTPClient(probeHTTPTimeout).Do(req)
		if e != nil {
			t.Errorf("close failed: %v", e)
			return
		}
		res.Body.Close()
		if res.StatusCode != 204 {
			t.Error("close rejected")
		}
	}()
	turnURL, err := remoteProbeTURNURL(
		os.Getenv("CC_MEDIA_PROBE_NODE"),
		os.Getenv("CC_MEDIA_PROBE_TRANSPORT"),
		os.Getenv("CC_MEDIA_PROBE_TURN_URL"),
	)
	if err != nil {
		t.Fatal(err)
	}
	relay := &bridge{turnSecret: os.Getenv("CC_MEDIA_PROBE_TURN_SECRET"), turnUDPURL: turnURL}
	config := relay.config()
	runBridgeRoundTrip(t, endpoint+"/offer", id, secret, config)
	if t.Failed() {
		t.Log("synthetic relay-only Opus path completed with a failed quality threshold; not a cellular test; callId=" + id)
		return
	}
	t.Log("synthetic relay-only Opus quality threshold passed; not a cellular test; callId=" + id)
}

const (
	probePrimaryTurnUDP  = "turn:vodog.example.com:16801?transport=udp"
	probePrimaryTurnTLS  = "turns:vodog.example.com:16802?transport=tcp"
	probeSecondaryTurnTLS   = "turns:relay-secondary.example.com:16802?transport=tcp"
	probeSecondaryTurnIPUDP = "turn:203.0.113.20:16801?transport=udp"
)

// remoteProbeTURNURL binds a synthetic probe to the node named by the helper.
// Empty node and URL preserve the historical secondary-only developer baseline.
func remoteProbeTURNURL(node, transport, explicit string) (string, error) {
	if transport == "" {
		transport = "udp"
	}
	allowed := []string{}
	switch node {
	case "":
		if explicit != "" {
			return "", fmt.Errorf("CC_MEDIA_PROBE_NODE is required with an explicit TURN URL")
		}
		if transport == "udp" {
			return secondaryTurnUDPURL, nil
		}
		if transport == "tls" {
			return probeSecondaryTurnTLS, nil
		}
		return "", fmt.Errorf("unsupported probe TURN transport")
	case "relay-primary":
		if transport == "udp" {
			allowed = []string{probePrimaryTurnUDP}
		} else if transport == "tls" {
			allowed = []string{probePrimaryTurnTLS}
		}
	case "relay-secondary":
		if transport == "udp" {
			allowed = []string{secondaryTurnUDPURL, probeSecondaryTurnIPUDP}
		} else if transport == "tls" {
			allowed = []string{probeSecondaryTurnTLS}
		}
	default:
		return "", fmt.Errorf("unsupported probe TURN node")
	}
	if len(allowed) == 0 {
		return "", fmt.Errorf("unsupported probe TURN transport")
	}
	if explicit == "" {
		return "", fmt.Errorf("explicit probe TURN URL is required for node %s", node)
	}
	parsed, err := url.Parse(explicit)
	matched := false
	for _, candidate := range allowed {
		matched = matched || explicit == candidate
	}
	if err != nil || !matched || parsed.User != nil || parsed.Fragment != "" {
		return "", fmt.Errorf("probe TURN URL does not match node %s transport %s", node, transport)
	}
	return explicit, nil
}

func TestRemoteProbeTURNURLSelectsExactNodeAndTransport(t *testing.T) {
	tests := []struct{ node, transport, explicit, want string }{
		{"relay-primary", "udp", probePrimaryTurnUDP, probePrimaryTurnUDP},
		{"relay-primary", "tls", probePrimaryTurnTLS, probePrimaryTurnTLS},
		{"relay-secondary", "udp", secondaryTurnUDPURL, secondaryTurnUDPURL},
		{"relay-secondary", "udp", probeSecondaryTurnIPUDP, probeSecondaryTurnIPUDP},
		{"relay-secondary", "tls", probeSecondaryTurnTLS, probeSecondaryTurnTLS},
		{"", "", "", secondaryTurnUDPURL},
		{"", "tls", "", probeSecondaryTurnTLS},
	}
	for _, test := range tests {
		got, err := remoteProbeTURNURL(test.node, test.transport, test.explicit)
		if err != nil || got != test.want {
			t.Fatalf("node=%q transport=%q got=%q err=%v", test.node, test.transport, got, err)
		}
	}
}

func TestRemoteProbeTURNURLRejectsAmbiguousOrMismatchedConfig(t *testing.T) {
	tests := []struct{ node, transport, explicit string }{
		{"relay-primary", "udp", ""},
		{"relay-primary", "udp", secondaryTurnUDPURL},
		{"relay-secondary", "tls", probePrimaryTurnTLS},
		{"other", "udp", secondaryTurnUDPURL},
		{"relay-primary", "tcp", probePrimaryTurnUDP},
		{"", "udp", probePrimaryTurnUDP},
		{"relay-primary", "udp", "turn:user@vodog.example.com:16801?transport=udp"},
	}
	for _, test := range tests {
		if got, err := remoteProbeTURNURL(test.node, test.transport, test.explicit); err == nil {
			t.Fatalf("accepted node=%q transport=%q URL=%q as %q", test.node, test.transport, test.explicit, got)
		}
	}
}

func TestConfiguredDataChannelReliabilityDefaultsToRexmitZero(t *testing.T) {
	for _, listen := range []string{"127.0.0.1:16881", "127.0.0.1:16882"} {
		got, err := configuredDataChannelReliability(listen, "", "", "", "")
		if err != nil || got.maxRetransmits != 0 || got.packetLifetimeMS != 0 || got.copies != 1 || got.copyInterval() != 5*time.Millisecond {
			t.Fatalf("listen=%s got=%+v err=%v", listen, got, err)
		}
	}
}

func TestConfiguredDataChannelReliabilityAllowsIsolatedRexmitTwo(t *testing.T) {
	got, err := configuredDataChannelReliability("127.0.0.1:16882", "", "2", "", "")
	if err != nil || got.maxRetransmits != 2 || got.packetLifetimeMS != 0 {
		t.Fatalf("got=%+v err=%v", got, err)
	}
}

// The copies matrix is deliberately 1..3 with an interval modifier of 0 or 5ms:
// copies=1 is the production default written out explicitly, and the interval is
// a modifier rather than a mode so it never participates in mutual exclusion.
func TestConfiguredDataChannelReliabilityAllowsIsolatedCopiesMatrix(t *testing.T) {
	tests := []struct {
		copies, interval     string
		expectCopies         uint8
		expectIntervalMillis int64
	}{
		{"1", "", 1, 5},
		{"2", "", 2, 5},
		{"3", "", 3, 5},
		{"2", "0", 2, 0},
		{"3", "5", 3, 5},
		{"", "0", 1, 0},
	}
	for _, test := range tests {
		got, err := configuredDataChannelReliability("127.0.0.1:16882", "", "", test.copies, test.interval)
		if err != nil || got.maxRetransmits != 0 || got.packetLifetimeMS != 0 || got.copies != test.expectCopies || got.copyInterval().Milliseconds() != test.expectIntervalMillis {
			t.Fatalf("copies=%q interval=%q got=%+v err=%v", test.copies, test.interval, got, err)
		}
	}
}

func TestConfiguredDataChannelReliabilityFailsClosed(t *testing.T) {
	tests := []struct{ listen, lifetime, retransmits, copies, interval string }{
		{"127.0.0.1:16881", "", "2", "", ""},
		{"127.0.0.1:16881", "120", "", "", ""},
		{"127.0.0.1:16881", "", "", "2", ""},
		{"127.0.0.1:16881", "", "", "1", ""},
		{"127.0.0.1:16881", "", "", "", "5"},
		{"127.0.0.1:16882", "120", "2", "", ""},
		{"127.0.0.1:16882", "120", "", "2", ""},
		{"127.0.0.1:16882", "", "2", "2", ""},
		{"127.0.0.1:16882", "", "0", "", ""},
		{"127.0.0.1:16882", "", "1", "", ""},
		{"127.0.0.1:16882", "", "3", "", ""},
		{"127.0.0.1:16882", "100", "", "", ""},
		{"127.0.0.1:16882", "", "", "0", ""},
		{"127.0.0.1:16882", "", "", "4", ""},
		{"127.0.0.1:16882", "", "", "-1", ""},
		{"127.0.0.1:16882", "", "", "two", ""},
		{"127.0.0.1:16882", "", "", "2", "3"},
		{"127.0.0.1:16882", "", "", "2", "10"},
		{"127.0.0.1:16882", "", "", "2", "-5"},
		{"127.0.0.1:16882", "", "", "2", "five"},
	}
	for _, test := range tests {
		if got, err := configuredDataChannelReliability(test.listen, test.lifetime, test.retransmits, test.copies, test.interval); err == nil {
			t.Fatalf("accepted listen=%q lifetime=%q retransmits=%q copies=%q interval=%q as %+v", test.listen, test.lifetime, test.retransmits, test.copies, test.interval, got)
		}
	}
}

func TestConfiguredSCTPTuningIsOffByDefaultAndFailsClosed(t *testing.T) {
	for _, raw := range []string{"", "off"} {
		got, err := configuredSCTPTuning(raw)
		if err != nil || got.name != "" || got.label() != "off" || got.minCwnd != 0 || got.rtoMax != 0 {
			t.Fatalf("raw=%q got=%+v err=%v", raw, got, err)
		}
	}
	got, err := configuredSCTPTuning("v1")
	if err != nil || got.label() != "v1" || got.minCwnd != 8*1200 || got.rtoMax != 2*time.Second {
		t.Fatalf("v1 got=%+v err=%v", got, err)
	}
	for _, raw := range []string{"on", "V1", "v2", "1", "true", "off ", " v1"} {
		if got, err := configuredSCTPTuning(raw); err == nil {
			t.Fatalf("accepted CC_MEDIA_SCTP_TUNING=%q as %+v", raw, got)
		}
	}
}

// webrtc.NewPeerConnection is NewAPI().NewPeerConnection, and NewAPI registers
// the default codecs plus the default interceptor registry whenever neither was
// supplied. Passing only a SettingEngine must therefore leave the negotiated
// RTCP feedback and header extensions byte-for-byte identical.
func TestSCTPTuningKeepsDefaultCodecsAndInterceptors(t *testing.T) {
	describe := func(tuning sctpTuning, lossFloorPct ...uint8) (string, string) {
		t.Helper()
		floor := uint8(0)
		if len(lossFloorPct) > 0 {
			floor = lossFloorPct[0]
		}
		pc, err := newMediaPeerConnection(tuning, floor, webrtc.Configuration{})
		if err != nil {
			t.Fatalf("tuning=%q peer connection: %v", tuning.label(), err)
		}
		defer pc.Close()
		if _, err = pc.AddTransceiverFromKind(webrtc.RTPCodecTypeAudio); err != nil {
			t.Fatalf("tuning=%q transceiver: %v", tuning.label(), err)
		}
		offer, err := pc.CreateOffer(nil)
		if err != nil {
			t.Fatalf("tuning=%q offer: %v", tuning.label(), err)
		}
		feedback, extensions := []string{}, []string{}
		for _, line := range strings.Split(offer.SDP, "\r\n") {
			if strings.HasPrefix(line, "a=rtcp-fb:") {
				feedback = append(feedback, line)
			}
			if strings.HasPrefix(line, "a=extmap:") {
				extensions = append(extensions, line)
			}
		}
		sort.Strings(feedback)
		sort.Strings(extensions)
		return strings.Join(feedback, "\n"), strings.Join(extensions, "\n")
	}
	offFeedback, offExtensions := describe(sctpTuning{})
	v1Feedback, v1Extensions := describe(sctpTuning{name: "v1", minCwnd: 8 * 1200, rtoMax: 2 * time.Second})
	if offFeedback != v1Feedback || offExtensions != v1Extensions {
		t.Fatalf("tuned peer lost default interceptor registration:\noff fb=%q ext=%q\nv1 fb=%q ext=%q", offFeedback, offExtensions, v1Feedback, v1Extensions)
	}
	// S70: the RR loss floor rebuilds the default registry itself; alone and
	// composed with SCTP tuning it must negotiate exactly the same feedback.
	for _, tuning := range []sctpTuning{{}, {name: "v1", minCwnd: 8 * 1200, rtoMax: 2 * time.Second}} {
		floorFeedback, floorExtensions := describe(tuning, 5)
		if floorFeedback != offFeedback || floorExtensions != offExtensions {
			t.Fatalf("loss floor (tuning=%s) changed default interceptor registration:\noff fb=%q ext=%q\nfloor fb=%q ext=%q", tuning.label(), offFeedback, offExtensions, floorFeedback, floorExtensions)
		}
	}
	if !strings.Contains(offFeedback, "transport-cc") {
		t.Fatalf("default interceptors did not register transport-cc feedback: %q", offFeedback)
	}
}

func TestProbeHTTPClientBoundsRequest(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		<-r.Context().Done()
	}))
	defer server.Close()
	started := time.Now()
	_, err := newProbeHTTPClient(25*time.Millisecond).Post(server.URL, "application/json", nil)
	if err == nil || time.Since(started) > time.Second {
		t.Fatalf("bounded request err=%v elapsed=%s", err, time.Since(started))
	}
}

func runBridgeRoundTrip(t *testing.T, endpoint, id string, secret []byte, config webrtc.Configuration) {
	t.Helper()
	gw, e := webrtc.NewPeerConnection(config)
	if e != nil {
		t.Fatal(e)
	}
	defer gw.Close()
	client, e := webrtc.NewPeerConnection(config)
	if e != nil {
		t.Fatal(e)
	}
	defer client.Close()
	gw.OnConnectionStateChange(func(s webrtc.PeerConnectionState) { t.Log("gateway peer:", s.String()) })
	client.OnConnectionStateChange(func(s webrtc.PeerConnectionState) { t.Log("client peer:", s.String()) })
	ordered := false
	retries := uint16(0)
	init := &webrtc.DataChannelInit{Ordered: &ordered, MaxRetransmits: &retries}
	rawLifetime := os.Getenv("CC_MEDIA_PROBE_MAX_PACKET_LIFETIME_MS")
	rawRetransmits := os.Getenv("CC_MEDIA_PROBE_MAX_RETRANSMITS")
	rawCopies := os.Getenv("CC_MEDIA_PROBE_COPIES")
	modes := 0
	for _, raw := range []string{rawLifetime, rawRetransmits, rawCopies} {
		if raw != "" {
			modes++
		}
	}
	if modes > 1 {
		t.Fatal("probe packet lifetime, max retransmits, and copies are mutually exclusive")
	}
	copies := 1
	copyInterval := time.Duration(defaultDataChannelCopyIntervalMS) * time.Millisecond
	if raw := os.Getenv("CC_MEDIA_PROBE_COPY_INTERVAL_MS"); raw != "" {
		value, err := strconv.Atoi(raw)
		if err != nil || (value != 0 && value != 5) {
			t.Fatal("probe copy interval must be 0 or 5 milliseconds")
		}
		copyInterval = time.Duration(value) * time.Millisecond
	}
	if raw := rawLifetime; raw != "" {
		value, err := strconv.Atoi(raw)
		if err != nil || (value != 120 && value != 200) {
			t.Fatal("probe packet lifetime must be 120 or 200")
		}
		lifetime := uint16(value)
		init = &webrtc.DataChannelInit{Ordered: &ordered, MaxPacketLifeTime: &lifetime}
	} else if rawRetransmits != "" {
		if rawRetransmits != "2" {
			t.Fatal("probe max retransmits must be exactly 2")
		}
		retries = 2
	} else if rawCopies != "" {
		value, err := strconv.Atoi(rawCopies)
		if err != nil || value < 1 || value > 3 {
			t.Fatal("probe copies must be 1, 2 or 3")
		}
		copies = value
	}
	dc, e := gw.CreateDataChannel("cellular-opus-v1", init)
	if e != nil {
		t.Fatal(e)
	}
	opened := make(chan struct{})
	dc.OnOpen(func() { close(opened) })
	up := make(chan Packet, 1)
	var upCount, upPhysicalReceived, downCount, dcPhysicalCopies, dcSendErrors, rtpSendErrors, dcBackpressureDrops atomic.Uint64
	var upLogical logicalSequenceCounter
	upSequence := newSequenceDiagnostic(32)
	downSequence := newSequenceDiagnostic(16)
	var upArrival, downArrival arrivalDiagnostic
	dc.OnMessage(func(m webrtc.DataChannelMessage) {
		p, e := decodePacket(m.Data)
		if e == nil {
			upPhysicalReceived.Add(1)
			upSequence.accept(p.Sequence)
			if !upLogical.accept(p.Sequence) {
				return
			}
			upCount.Add(1)
			upArrival.accept(p.TimestampUS)
			select {
			case up <- p:
			default:
			}
		}
	})
	track, e := webrtc.NewTrackLocalStaticRTP(webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeOpus, ClockRate: 48000, Channels: 2}, "mic", "client")
	if e != nil {
		t.Fatal(e)
	}
	if _, e = client.AddTrack(track); e != nil {
		t.Fatal(e)
	}
	down := make(chan []byte, 1)
	client.OnTrack(func(r *webrtc.TrackRemote, _ *webrtc.RTPReceiver) {
		for {
			p, _, e := r.ReadRTP()
			if e != nil {
				return
			}
			downCount.Add(1)
			downSequence.accept(uint32(p.SequenceNumber))
			downArrival.accept(uint64(p.Timestamp) * 1000 / 48)
			select {
			case down <- p.Payload:
			default:
			}
		}
	})
	for _, pair := range []struct {
		pc   *webrtc.PeerConnection
		role string
	}{{gw, "gateway"}, {client, "client"}} {
		offer, e := pair.pc.CreateOffer(nil)
		if e != nil {
			t.Fatal(e)
		}
		gather := webrtc.GatheringCompletePromise(pair.pc)
		if e = pair.pc.SetLocalDescription(offer); e != nil {
			t.Fatal(e)
		}
		select {
		case <-gather:
		case <-time.After(5 * time.Second):
			t.Fatal("client ICE timeout")
		}
		body, _ := json.Marshal(pair.pc.LocalDescription())
		req, _ := http.NewRequest("POST", endpoint, bytes.NewReader(body))
		req.Header.Set("Authorization", "Bearer "+sign(Grant{CallID: id, Role: pair.role, Expires: time.Now().Unix() + 60, Nonce: fmt.Sprintf("integration-%s-%s", id, pair.role)}, secret))
		res, e := newProbeHTTPClient(probeHTTPTimeout).Do(req)
		if e != nil {
			t.Fatalf("%s offer failed: %v", pair.role, e)
		}
		var answer webrtc.SessionDescription
		e = json.NewDecoder(res.Body).Decode(&answer)
		res.Body.Close()
		if e != nil || res.StatusCode != 200 {
			t.Fatalf("SDP: %d %v", res.StatusCode, e)
		}
		t.Logf("%s ICE candidates local=%d remote=%d", pair.role, strings.Count(pair.pc.LocalDescription().SDP, "a=candidate:"), strings.Count(answer.SDP, "a=candidate:"))
		if e = pair.pc.SetRemoteDescription(answer); e != nil {
			t.Fatal(e)
		}
	}
	select {
	case <-opened:
	case <-time.After(8 * time.Second):
		t.Fatal("data channel did not open")
	}
	payload := []byte{0xf8, 0xff, 0xfe}
	payloads := [][]byte{payload}
	skippedFixturePackets := 0
	if fixtures := os.Getenv("CC_MEDIA_PROBE_OPUS_FIXTURES"); fixtures != "" {
		payloads, skippedFixturePackets, e = loadOpusFixturePackets(filepath.SplitList(fixtures))
		if e != nil {
			t.Fatal(e)
		}
		minBytes, maxBytes := len(payloads[0]), 0
		for _, frame := range payloads {
			if len(frame) < minBytes {
				minBytes = len(frame)
			}
			if len(frame) > maxBytes {
				maxBytes = len(frame)
			}
		}
		t.Logf("real ffmpeg-decodable Opus fixtures: packets=%d skippedNon20ms=%d payloadBytesMin=%d payloadBytesMax=%d", len(payloads), skippedFixturePackets, minBytes, maxBytes)
	}
	validPayloads := map[string]struct{}{}
	for _, frame := range payloads {
		validPayloads[string(frame)] = struct{}{}
	}
	deadline := time.Now().Add(8 * time.Second)
	longSeconds := 0
	if os.Getenv("CC_MEDIA_PROBE_SECONDS") != "" {
		longSeconds, e = strconv.Atoi(os.Getenv("CC_MEDIA_PROBE_SECONDS"))
		if e != nil || longSeconds < 30 || longSeconds > 600 {
			t.Fatal("probe duration must be 30..600 seconds")
		}
		deadline = time.Now().Add(time.Duration(longSeconds) * time.Second)
	}
	receivedDown, receivedUp := false, false
	var sent uint64
	started := time.Now()
	ticker := time.NewTicker(20 * time.Millisecond)
	defer ticker.Stop()
	for seq := uint32(1); time.Now().Before(deadline) && (longSeconds > 0 || !receivedDown || !receivedUp); seq++ {
		payload = payloads[int(seq-1)%len(payloads)]
		sent++
		encoded := encodePacket(Packet{DurationMS: 20, Sequence: seq, TimestampUS: uint64(seq) * 20000, Opus: payload})
		// Same backpressure gate as main.go's uplink sender: a copy is dropped
		// rather than queued once the already in-flight bytes plus this packet
		// exceed one bounded RTT of audio. At copyIndex 0 this is exactly the
		// main.go gate; later copies are gated too so the copies experiment can
		// never be the thing that builds the SCTP send queue it is measuring.
		packetBytes := uint64(len(encoded))
		srtt := 0.0
		if association := gw.SCTP(); association != nil {
			srtt = association.Stats().SmoothedRoundTripTime
		}
		budget := mediaFlightBudget(packetBytes, 20, srtt)
		for copyIndex := 0; copyIndex < copies; copyIndex++ {
			if copyIndex > 0 {
				time.Sleep(copyInterval)
				if dc.ReadyState() != webrtc.DataChannelStateOpen {
					break
				}
			}
			if dc.BufferedAmount()+packetBytes > budget {
				dcBackpressureDrops.Add(uint64(copies - copyIndex))
				break
			}
			dcPhysicalCopies.Add(1)
			if dc.Send(encoded) != nil {
				dcSendErrors.Add(1)
			}
		}
		if track.WriteRTP(&rtp.Packet{Header: rtp.Header{Version: 2, SequenceNumber: uint16(seq), Timestamp: seq * 960, SSRC: 2}, Payload: payload}) != nil {
			rtpSendErrors.Add(1)
		}
		select {
		case got := <-down:
			if _, ok := validPayloads[string(got)]; !ok {
				t.Fatal("downlink changed")
			}
			receivedDown = true
		default:
		}
		select {
		case got := <-up:
			if _, ok := validPayloads[string(got.Opus)]; got.Direction != 1 || !ok {
				t.Fatal("uplink changed")
			}
			receivedUp = true
		default:
		}
		<-ticker.C
	}
	sendElapsed := time.Since(started)
	if !receivedDown || !receivedUp {
		t.Fatalf("bridge direction missing down=%v up=%v gateway=%s client=%s", receivedDown, receivedUp, gw.ConnectionState(), client.ConnectionState())
	}
	if longSeconds > 0 {
		time.Sleep(2 * time.Second)
		upSequences := upSequence.snapshot()
		downSequences := downSequence.snapshot()
		upJitter := upArrival.snapshot()
		downJitter := downArrival.snapshot()
		gwSCTP, clientSCTP := gw.SCTP().Stats(), client.SCTP().Stats()
		upLogicalStats := upLogical.snapshot()
		downPhysical := dcPhysicalCopies.Load()
		downFailures := dcSendErrors.Load()
		t.Logf("probe logical delivery: copies=%d downLogicalSent=%d downPhysicalCopies=%d downPhysicalSuccess=%d downPhysicalFailures=%d downUniqueReceived=%d upPhysicalReceived=%d upUniqueReceived=%d upDuplicate=%d upLate=%d probeCopyIntervalMs=%d probeCopyBackpressureDrops=%d", copies, sent, downPhysical, downPhysical-downFailures, downFailures, downCount.Load(), upPhysicalReceived.Load(), upLogicalStats.unique, upLogicalStats.duplicate, upLogicalStats.late, copyInterval.Milliseconds(), dcBackpressureDrops.Load())
		t.Logf("sustained fixture Opus: requestedSeconds=%d sendElapsed=%.3fs sent=%d downReceived=%d upReceived=%d dcSendErrors=%d rtpSendErrors=%d downFirst=%d downLast=%d downForwardGapPositions=%d downRecoveredLate=%d downUnrecoveredGaps=%d downDuplicateOrUntrackedLate=%d upFirst=%d upLast=%d upForwardGapPositions=%d upRecoveredLate=%d upUnrecoveredGaps=%d upDuplicateOrUntrackedLate=%d", longSeconds, sendElapsed.Seconds(), sent, downCount.Load(), upCount.Load(), dcSendErrors.Load(), rtpSendErrors.Load(), downSequences.first, downSequences.last, downSequences.forwardGaps, downSequences.recoveredLate, downSequences.unrecovered, downSequences.otherLate, upSequences.first, upSequences.last, upSequences.forwardGaps, upSequences.recoveredLate, upSequences.unrecovered, upSequences.otherLate)
		logPeerStats(t, "gateway", gw)
		logPeerStats(t, "client", client)
		t.Logf("gateway SCTP: srttMs=%.1f cwnd=%d rwnd=%d mtu=%d bytesSent=%d bytesReceived=%d buffered=%d", gwSCTP.SmoothedRoundTripTime*1000, gwSCTP.CongestionWindow, gwSCTP.ReceiverWindow, gwSCTP.MTU, gwSCTP.BytesSent, gwSCTP.BytesReceived, dc.BufferedAmount())
		t.Logf("client SCTP: srttMs=%.1f cwnd=%d rwnd=%d mtu=%d bytesSent=%d bytesReceived=%d", clientSCTP.SmoothedRoundTripTime*1000, clientSCTP.CongestionWindow, clientSCTP.ReceiverWindow, clientSCTP.MTU, clientSCTP.BytesSent, clientSCTP.BytesReceived)
		t.Logf("measured arrival timing ms (diagnostic, not a low-delay claim): down[p50Jitter=%.2f p95Jitter=%.2f p99Jitter=%.2f maxJitter=%.2f maxRelativeSourceLag=%.2f] up[p50Jitter=%.2f p95Jitter=%.2f p99Jitter=%.2f maxJitter=%.2f maxRelativeSourceLag=%.2f]", downJitter.p50, downJitter.p95, downJitter.p99, downJitter.max, downJitter.maxRelativeSourceLag, upJitter.p50, upJitter.p95, upJitter.p99, upJitter.max, upJitter.maxRelativeSourceLag)
		if downCount.Load()*100 < sent*95 || upCount.Load()*100 < sent*95 {
			t.Error("sustained probe received fewer than 95 percent of packets")
		}
	}
}

func loadOpusFixturePackets(paths []string) ([][]byte, int, error) {
	var packets [][]byte
	skipped := 0
	for _, path := range paths {
		raw, err := os.ReadFile(path)
		if err != nil {
			return nil, 0, err
		}
		pending := []byte{}
		for offset := 0; offset < len(raw); {
			if offset+27 > len(raw) || string(raw[offset:offset+4]) != "OggS" {
				return nil, 0, fmt.Errorf("invalid Ogg fixture")
			}
			segments := int(raw[offset+26])
			if offset+27+segments > len(raw) {
				return nil, 0, io.ErrUnexpectedEOF
			}
			table := raw[offset+27 : offset+27+segments]
			cursor := offset + 27 + segments
			for _, sizeByte := range table {
				size := int(sizeByte)
				if cursor+size > len(raw) {
					return nil, 0, io.ErrUnexpectedEOF
				}
				pending = append(pending, raw[cursor:cursor+size]...)
				cursor += size
				if size < 255 {
					if !bytes.HasPrefix(pending, []byte("OpusHead")) && !bytes.HasPrefix(pending, []byte("OpusTags")) {
						duration, durationErr := opusDurationMS(pending)
						if durationErr != nil {
							return nil, 0, fmt.Errorf("invalid Opus fixture packet: %w", durationErr)
						}
						if duration == 20 {
							packets = append(packets, append([]byte(nil), pending...))
						} else {
							skipped++
						}
					}
					pending = pending[:0]
				}
			}
			offset = cursor
		}
		if len(pending) != 0 {
			return nil, 0, io.ErrUnexpectedEOF
		}
	}
	if len(packets) < 10 {
		return nil, 0, fmt.Errorf("not enough 20ms Opus fixture packets")
	}
	return packets, skipped, nil
}

const maxTrackedSequenceGap = 4096

type logicalSequenceSummary struct {
	unique    uint64
	duplicate uint64
	late      uint64
}

type logicalSequenceCounter struct {
	mu   sync.Mutex
	seen bool
	last uint32
	logicalSequenceSummary
}

func (c *logicalSequenceCounter) accept(sequence uint32) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	if !c.seen {
		c.seen = true
		c.last = sequence
		c.unique++
		return true
	}
	delta := int32(sequence - c.last)
	if delta == 0 {
		c.duplicate++
		return false
	}
	if delta < 0 {
		c.late++
		return false
	}
	c.last = sequence
	c.unique++
	return true
}

func (c *logicalSequenceCounter) snapshot() logicalSequenceSummary {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.logicalSequenceSummary
}

func TestLogicalSequenceCounterDoesNotInflateUniqueDelivery(t *testing.T) {
	var counter logicalSequenceCounter
	accepted := 0
	for _, sequence := range []uint32{10, 10, 12, 11, 12, 13} {
		if counter.accept(sequence) {
			accepted++
		}
	}
	got := counter.snapshot()
	if accepted != 3 || got.unique != 3 || got.duplicate != 2 || got.late != 1 {
		t.Fatalf("unexpected logical delivery accounting: accepted=%d stats=%+v", accepted, got)
	}
}

type sequenceSummary struct {
	first         uint64
	last          uint64
	forwardGaps   uint64
	recoveredLate uint64
	unrecovered   uint64
	otherLate     uint64
}

// sequenceDiagnostic distinguishes a forward gap from permanent loss. A packet
// arriving after a gap retracts that position from unrecovered. bits=16 handles
// RTP sequence wrap; bits=32 handles the VoDog packet sequence.
type sequenceDiagnostic struct {
	mu            sync.Mutex
	bits          uint8
	lastRaw       uint32
	firstLogical  uint64
	lastLogical   uint64
	seen          bool
	forwardGaps   uint64
	recoveredLate uint64
	otherLate     uint64
	missing       map[uint64]struct{}
}

func newSequenceDiagnostic(bits uint8) *sequenceDiagnostic {
	if bits != 16 && bits != 32 {
		panic("sequence diagnostic only supports 16 or 32 bits")
	}
	return &sequenceDiagnostic{bits: bits, missing: make(map[uint64]struct{})}
}

func (s *sequenceDiagnostic) accept(sequence uint32) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.bits == 16 {
		sequence &= math.MaxUint16
	}
	if !s.seen {
		s.seen = true
		s.lastRaw = sequence
		s.firstLogical = uint64(sequence)
		s.lastLogical = uint64(sequence)
		return
	}
	var delta int64
	if s.bits == 16 {
		delta = int64(int16(uint16(sequence) - uint16(s.lastRaw)))
	} else {
		delta = int64(int32(sequence - s.lastRaw))
	}
	if delta <= 0 {
		candidate := s.lastLogical
		if uint64(-delta) <= candidate {
			candidate -= uint64(-delta)
		}
		if _, ok := s.missing[candidate]; ok {
			delete(s.missing, candidate)
			s.recoveredLate++
		} else {
			s.otherLate++
		}
		return
	}
	if delta > 1 {
		gap := uint64(delta - 1)
		s.forwardGaps += gap
		if gap <= maxTrackedSequenceGap {
			for candidate := s.lastLogical + 1; candidate < s.lastLogical+uint64(delta); candidate++ {
				s.missing[candidate] = struct{}{}
			}
		}
	}
	s.lastLogical += uint64(delta)
	s.lastRaw = sequence
}
func (s *sequenceDiagnostic) snapshot() sequenceSummary {
	s.mu.Lock()
	defer s.mu.Unlock()
	return sequenceSummary{
		first:         s.firstLogical,
		last:          s.lastLogical,
		forwardGaps:   s.forwardGaps,
		recoveredLate: s.recoveredLate,
		unrecovered:   s.forwardGaps - s.recoveredLate,
		otherLate:     s.otherLate,
	}
}

type peerStatsSummary struct {
	InboundRTP            []webrtc.InboundRTPStreamStats  `json:"inboundRtp,omitempty"`
	OutboundRTP           []webrtc.OutboundRTPStreamStats `json:"outboundRtp,omitempty"`
	DataChannel           []webrtc.DataChannelStats       `json:"dataChannel,omitempty"`
	SelectedCandidatePair *selectedCandidatePairSummary   `json:"selectedCandidatePair,omitempty"`
}

type selectedCandidatePairSummary struct {
	Local  candidateSummary `json:"local"`
	Remote candidateSummary `json:"remote"`
}

type candidateSummary struct {
	Protocol      string                  `json:"protocol"`
	CandidateType webrtc.ICECandidateType `json:"candidateType"`
	RelayProtocol string                  `json:"relayProtocol,omitempty"`
	URL           string                  `json:"url,omitempty"`
}

func safeCandidateSummary(candidate webrtc.ICECandidateStats) candidateSummary {
	cleanURL := candidate.URL
	if parsed, err := url.Parse(cleanURL); err == nil && parsed.User != nil {
		parsed.User = nil
		cleanURL = parsed.String()
	}
	return candidateSummary{Protocol: candidate.Protocol, CandidateType: candidate.CandidateType, RelayProtocol: candidate.RelayProtocol, URL: cleanURL}
}

func logPeerStats(t *testing.T, role string, pc *webrtc.PeerConnection) {
	t.Helper()
	summary := peerStatsSummary{}
	report := pc.GetStats()
	selectedPairID := ""
	pairs := map[string]webrtc.ICECandidatePairStats{}
	candidates := map[string]webrtc.ICECandidateStats{}
	for _, raw := range report {
		switch stat := raw.(type) {
		case webrtc.InboundRTPStreamStats:
			summary.InboundRTP = append(summary.InboundRTP, stat)
		case webrtc.OutboundRTPStreamStats:
			summary.OutboundRTP = append(summary.OutboundRTP, stat)
		case webrtc.DataChannelStats:
			summary.DataChannel = append(summary.DataChannel, stat)
		case webrtc.TransportStats:
			if stat.SelectedCandidatePairID != "" {
				selectedPairID = stat.SelectedCandidatePairID
			}
		case webrtc.ICECandidatePairStats:
			pairs[stat.ID] = stat
		case webrtc.ICECandidateStats:
			candidates[stat.ID] = stat
		}
	}
	if pair, ok := pairs[selectedPairID]; ok {
		local, localOK := candidates[pair.LocalCandidateID]
		remote, remoteOK := candidates[pair.RemoteCandidateID]
		if localOK && remoteOK {
			summary.SelectedCandidatePair = &selectedCandidatePairSummary{Local: safeCandidateSummary(local), Remote: safeCandidateSummary(remote)}
		}
	}
	raw, err := json.Marshal(summary)
	if err != nil {
		t.Fatalf("marshal %s peer stats: %v", role, err)
	}
	t.Logf("%s peer stats: %s", role, raw)
}

func TestSequenceDiagnosticRecoversLateAndHandlesRTPWrap(t *testing.T) {
	diagnostic := newSequenceDiagnostic(16)
	for _, sequence := range []uint32{65534, 0, 65535, 1, 1} {
		diagnostic.accept(sequence)
	}
	got := diagnostic.snapshot()
	if got.forwardGaps != 1 || got.recoveredLate != 1 || got.unrecovered != 0 || got.otherLate != 1 {
		t.Fatalf("unexpected sequence diagnostic: %+v", got)
	}
}

type jitterSummary struct{ p50, p95, p99, max, maxRelativeSourceLag float64 }
type arrivalDiagnostic struct {
	mu                   sync.Mutex
	seen                 bool
	firstSource          uint64
	firstArrival         time.Time
	lastSource           uint64
	lastArrival          time.Time
	maxRelativeSourceLag float64
	samples              []float64
}

func (a *arrivalDiagnostic) accept(sourceUS uint64) {
	a.mu.Lock()
	defer a.mu.Unlock()
	now := time.Now()
	if a.seen {
		if sourceUS <= a.lastSource {
			return
		}
		sourceDelta := float64(sourceUS-a.lastSource) / 1000
		arrivalDelta := float64(now.Sub(a.lastArrival).Microseconds()) / 1000
		delta := math.Abs(arrivalDelta - sourceDelta)
		a.samples = append(a.samples, delta)
		relativeSource := float64(sourceUS-a.firstSource) / 1000
		relativeArrival := float64(now.Sub(a.firstArrival).Microseconds()) / 1000
		a.maxRelativeSourceLag = math.Max(a.maxRelativeSourceLag, relativeArrival-relativeSource)
	}
	if !a.seen {
		a.firstSource = sourceUS
		a.firstArrival = now
	}
	a.seen = true
	a.lastSource = sourceUS
	a.lastArrival = now
}
func (a *arrivalDiagnostic) snapshot() jitterSummary {
	a.mu.Lock()
	defer a.mu.Unlock()
	if len(a.samples) == 0 {
		return jitterSummary{}
	}
	values := append([]float64(nil), a.samples...)
	sort.Float64s(values)
	at := func(q float64) float64 { return values[int(math.Ceil(q*float64(len(values))))-1] }
	return jitterSummary{at(.50), at(.95), at(.99), values[len(values)-1], math.Max(0, a.maxRelativeSourceLag)}
}

func TestClosedCallCannotOverwriteRecordings(t *testing.T) {
	b := &bridge{rooms: map[string]*room{}, recordDir: t.TempDir()}
	id := "33333333-3333-3333-3333-333333333333"
	if _, err := b.getRoom(id); err != nil {
		t.Fatal(err)
	}
	b.closeRoom(id, "test")
	raw, err := os.ReadFile(filepath.Join(b.recordDir, id, "manifest.json"))
	if err != nil {
		t.Fatal(err)
	}
	var manifest recordingManifest
	if json.Unmarshal(raw, &manifest) != nil || manifest.Complete || len(manifest.Artifacts) != 3 {
		t.Fatal("recording manifest invalid")
	}
	for _, artifact := range manifest.Artifacts {
		data, err := os.ReadFile(filepath.Join(b.recordDir, id, artifact.Name))
		if err != nil {
			t.Fatal(err)
		}
		digest := sha256.Sum256(data)
		if artifact.SHA256 != hex.EncodeToString(digest[:]) || artifact.Bytes != int64(len(data)) {
			t.Fatal("checksum mismatch")
		}
	}
	if _, err := b.getRoom(id); err == nil {
		t.Fatal("closed call was recreated and recordings overwritten")
	}
}

func TestConcurrentRoomCapacityMatchesTurnQuota(t *testing.T) {
	if maxConcurrentRooms != 6 {
		t.Fatalf("room ceiling must stay aligned with coturn total-quota=24 at four allocations per call, got %d", maxConcurrentRooms)
	}
	secret := bytes.Repeat([]byte("c"), 32)
	b := &bridge{rooms: map[string]*room{}, verifier: GrantVerifier{Secret: secret}, recordDir: t.TempDir()}
	server := httptest.NewServer(http.HandlerFunc(b.offer))
	defer server.Close()
	id := func(n int) string { return fmt.Sprintf("6666666%x-6666-6666-6666-666666666666", n) }
	for n := 0; n < maxConcurrentRooms; n++ {
		if _, err := b.getRoom(id(n)); err != nil {
			t.Fatalf("room %d below the ceiling was rejected: %v", n+1, err)
		}
		defer b.closeRoom(id(n), "test")
	}
	if _, err := b.getRoom(id(maxConcurrentRooms)); err == nil || err.Error() != "media capacity reached" {
		t.Fatalf("room %d above the ceiling was admitted: %v", maxConcurrentRooms+1, err)
	}
	// offer() only wraps getRoom, but the 503 is what the control plane routes on.
	req, _ := http.NewRequest("POST", server.URL, strings.NewReader(`{"type":"offer","sdp":"v=0\r\n"}`))
	req.Header.Set("Authorization", "Bearer "+sign(Grant{CallID: id(maxConcurrentRooms), Role: "client", Expires: time.Now().Unix() + 60, Nonce: "capacity-overflow-nonce-0001"}, secret))
	res, err := newProbeHTTPClient(probeHTTPTimeout).Do(req)
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != 503 {
		t.Fatalf("offer beyond capacity returned %d", res.StatusCode)
	}
	b.closeRoom(id(0), "test")
	if _, err := b.getRoom(id(maxConcurrentRooms)); err != nil {
		t.Fatalf("released slot was not reusable: %v", err)
	}
	defer b.closeRoom(id(maxConcurrentRooms), "test")
}

func TestIdleJanitorKeepsLongButActiveRoom(t *testing.T) {
	b := &bridge{rooms: map[string]*room{}, recordDir: t.TempDir()}
	id := "77777777-7777-7777-7777-777777777777"
	r, err := b.getRoom(id)
	if err != nil {
		t.Fatal(err)
	}
	defer b.closeRoom(id, "test")
	r.created = time.Now().Add(-3 * time.Hour)
	r.touch()
	b.closeIdleRooms()
	if b.rooms[id] == nil {
		t.Fatal("a 3 h old room with recent activity was closed")
	}
	r.lastActivity.Store(time.Now().Add(-roomIdleLimit - time.Minute).UnixNano())
	b.closeIdleRooms()
	if b.rooms[id] != nil {
		t.Fatal("an idle room was not closed")
	}
}

// postOffer sends pc's offer for role and, on 200, applies the answer when apply is true.
func postOffer(t *testing.T, endpoint, id, role, nonce string, secret []byte, pc *webrtc.PeerConnection, apply bool) int {
	t.Helper()
	return postGrantOffer(t, endpoint, Grant{CallID: id, Role: role, Expires: time.Now().Unix() + 60, Nonce: nonce}, secret, pc, apply)
}

func postGrantOffer(t *testing.T, endpoint string, g Grant, secret []byte, pc *webrtc.PeerConnection, apply bool) int {
	t.Helper()
	if pc.LocalDescription() == nil {
		offer, err := pc.CreateOffer(nil)
		if err != nil {
			t.Fatal(err)
		}
		gather := webrtc.GatheringCompletePromise(pc)
		if err = pc.SetLocalDescription(offer); err != nil {
			t.Fatal(err)
		}
		<-gather
	}
	body, _ := json.Marshal(pc.LocalDescription())
	req, _ := http.NewRequest("POST", endpoint, bytes.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+sign(g, secret))
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	if res.StatusCode == http.StatusOK && apply {
		var answer webrtc.SessionDescription
		if err = json.NewDecoder(res.Body).Decode(&answer); err != nil {
			t.Fatal(err)
		}
		if err = pc.SetRemoteDescription(answer); err != nil {
			t.Fatal(err)
		}
	}
	return res.StatusCode
}

func newGatewayOfferPeer(t *testing.T) *webrtc.PeerConnection {
	t.Helper()
	pc, err := webrtc.NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { pc.Close() })
	ordered := false
	retries := uint16(0)
	if _, err = pc.CreateDataChannel("cellular-opus-v1", &webrtc.DataChannelInit{Ordered: &ordered, MaxRetransmits: &retries}); err != nil {
		t.Fatal(err)
	}
	return pc
}

func TestSameRoleOfferReplacesUnconnectedLegOnly(t *testing.T) {
	secret := bytes.Repeat([]byte("r"), 32)
	b := &bridge{rooms: map[string]*room{}, verifier: GrantVerifier{Secret: secret}, recordDir: t.TempDir()}
	server := httptest.NewServer(http.HandlerFunc(b.offer))
	defer server.Close()
	id := "88888888-8888-8888-8888-888888888888"
	defer b.closeRoom(id, "test")

	// The first gateway offer is answered but never applied, so its bridge leg never connects.
	if code := postOffer(t, server.URL, id, "gateway", "replace-first-nonce-0001", secret, newGatewayOfferPeer(t), false); code != 200 {
		t.Fatalf("first offer: %d", code)
	}
	b.mu.Lock()
	r := b.rooms[id]
	b.mu.Unlock()
	r.mu.Lock()
	first := r.peers["gateway"]
	r.mu.Unlock()

	retry := newGatewayOfferPeer(t)
	if code := postOffer(t, server.URL, id, "gateway", "replace-retry-nonce-0001", secret, retry, true); code != 200 {
		t.Fatalf("retry of an unconnected leg was not accepted: %d", code)
	}
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) && retry.ConnectionState() != webrtc.PeerConnectionStateConnected {
		time.Sleep(10 * time.Millisecond)
	}
	if retry.ConnectionState() != webrtc.PeerConnectionStateConnected {
		t.Fatalf("replacement leg did not connect: %s", retry.ConnectionState())
	}
	r.mu.Lock()
	closed, current := r.closed, r.peers["gateway"]
	r.mu.Unlock()
	if closed || current == nil || current == first {
		t.Fatalf("leg was not replaced in place: closed=%v replaced=%v", closed, current != first)
	}
	if first.ConnectionState() != webrtc.PeerConnectionStateClosed {
		t.Fatalf("replaced leg left open: %s", first.ConnectionState())
	}

	// Once the leg is Connected, a same-role offer is still a conflict.
	if code := postOffer(t, server.URL, id, "gateway", "replace-third-nonce-0001", secret, newGatewayOfferPeer(t), false); code != 409 {
		t.Fatalf("offer over a connected leg returned %d, want 409", code)
	}
}

func TestFailedOfferDropsOnlyItsOwnLeg(t *testing.T) {
	secret := bytes.Repeat([]byte("f"), 32)
	b := &bridge{rooms: map[string]*room{}, verifier: GrantVerifier{Secret: secret}, recordDir: t.TempDir()}
	server := httptest.NewServer(http.HandlerFunc(b.offer))
	defer server.Close()
	id := "99999999-9999-9999-9999-999999999999"
	defer b.closeRoom(id, "test")
	if code := postOffer(t, server.URL, id, "gateway", "failed-gateway-nonce-0001", secret, newGatewayOfferPeer(t), false); code != 200 {
		t.Fatalf("gateway offer: %d", code)
	}
	bad := func(nonce string) int {
		req, _ := http.NewRequest("POST", server.URL, strings.NewReader(`{"type":"offer","sdp":"v=0\r\n"}`))
		req.Header.Set("Authorization", "Bearer "+sign(Grant{CallID: id, Role: "client", Expires: time.Now().Unix() + 60, Nonce: nonce}, secret))
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		res.Body.Close()
		return res.StatusCode
	}
	if code := bad("failed-client-nonce-0001"); code != 400 {
		t.Fatalf("invalid client SDP returned %d", code)
	}
	b.mu.Lock()
	r := b.rooms[id]
	b.mu.Unlock()
	if r == nil {
		t.Fatal("a failed client offer closed the room")
	}
	r.mu.Lock()
	gateway, client := r.peers["gateway"], r.peers["client"]
	r.mu.Unlock()
	if gateway == nil || client != nil {
		t.Fatalf("failed offer did not drop only its own leg: gateway=%v client=%v", gateway != nil, client != nil)
	}
	// With the gateway leg gone too, a failed offer leaves no leg and closes the room.
	b.closeRoom(id, "test")
	lone := "99999999-9999-9999-9999-999999999990"
	id = lone
	if code := bad("failed-client-nonce-0002"); code != 400 {
		t.Fatalf("lone invalid offer returned %d", code)
	}
	b.mu.Lock()
	left := b.rooms[lone]
	b.mu.Unlock()
	if left != nil {
		t.Fatal("a room whose only leg failed was left open")
	}
}

// A panic in a pion callback is recovered by recoverCallback: the process keeps
// running and only the room of that epoch is closed. ponytail: the helper is
// invoked directly; driving a real pion callback into a panic needs a test hook.
func TestRecoverCallbackClosesOnlyItsEpochRoom(t *testing.T) {
	b := &bridge{rooms: map[string]*room{}, recordDir: t.TempDir()}
	id := "12121212-1212-1212-1212-121212121212"
	if _, err := b.getRoom(id, 2); err != nil {
		t.Fatal(err)
	}
	defer b.closeRoom(id, "test")
	boom := func(epoch int64) {
		defer b.recoverCallback(id, epoch, "client", "track")
		panic("boom")
	}
	boom(1)
	if b.rooms[id] == nil {
		t.Fatal("a stale epoch's panic closed the newer room")
	}
	boom(2)
	if b.rooms[id] != nil {
		t.Fatal("panic did not close its room")
	}
	// An empty room closed by a panic gives its directory back.
	if _, err := b.getRoom(id, 3); err != nil {
		t.Fatalf("room could not be rebuilt after panic: %v", err)
	}
}

func TestFailedEmptyRoomDirIsDiscardedButDataIsKept(t *testing.T) {
	secret := bytes.Repeat([]byte("d"), 32)
	b := &bridge{rooms: map[string]*room{}, verifier: GrantVerifier{Secret: secret}, recordDir: t.TempDir()}
	server := httptest.NewServer(http.HandlerFunc(b.offer))
	defer server.Close()
	id := "13131313-1313-1313-1313-131313131313"
	defer b.closeRoom(id, "test")
	req, _ := http.NewRequest("POST", server.URL, strings.NewReader(`{"type":"offer","sdp":"v=0\r\n"}`))
	req.Header.Set("Authorization", "Bearer "+sign(Grant{CallID: id, Role: "client", Expires: time.Now().Unix() + 60, Nonce: "discard-bad-nonce-000001"}, secret))
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != 400 {
		t.Fatalf("invalid SDP returned %d", res.StatusCode)
	}
	if _, err := os.Stat(filepath.Join(b.recordDir, id)); !os.IsNotExist(err) {
		t.Fatalf("empty failed room left its directory: %v", err)
	}
	if code := postOffer(t, server.URL, id, "gateway", "discard-retry-nonce-0001", secret, newGatewayOfferPeer(t), false); code != 200 {
		t.Fatalf("retry after an empty failed room returned %d, want 200", code)
	}

	// A room that forwarded media keeps its directory even when it fails.
	b.mu.Lock()
	r := b.rooms[id]
	b.mu.Unlock()
	r.mu.Lock()
	r.transport.UpSent = 1
	r.mu.Unlock()
	b.closeRoom(id, "pc_failed")
	raw, err := os.ReadFile(filepath.Join(b.recordDir, id, "transport-stats.json"))
	if err != nil {
		t.Fatalf("room with data lost its directory: %v", err)
	}
	for _, key := range []string{"upOversizedDrop", "upDurationInvalidDrop", "upClockRejectDrop"} {
		if !strings.Contains(string(raw), `"`+key+`"`) {
			t.Fatalf("transport-stats.json lacks %s", key)
		}
	}
	if code := postOffer(t, server.URL, id, "gateway", "discard-after-nonce-0001", secret, newGatewayOfferPeer(t), false); code != 503 {
		t.Fatalf("offer over a kept recording returned %d, want 503", code)
	}
}

// roomClosedWriter records log lines and, at the room_closed line, whether the
// manifest was already on disk: the S69 line must follow finalize.
type roomClosedWriter struct {
	mu             sync.Mutex
	manifest       string
	lines          []string
	manifestBefore bool
}

func (w *roomClosedWriter) Write(p []byte) (int, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	line := string(p)
	if strings.Contains(line, "media.room_closed") {
		_, err := os.Stat(w.manifest)
		w.manifestBefore = err == nil
	}
	w.lines = append(w.lines, line)
	return len(p), nil
}

func (w *roomClosedWriter) roomClosed() string {
	w.mu.Lock()
	defer w.mu.Unlock()
	for _, line := range w.lines {
		if strings.Contains(line, "media.room_closed") {
			return line
		}
	}
	return ""
}

func TestRoomClosedIsLoggedAfterFinalizeWithOutcome(t *testing.T) {
	for _, tc := range []struct {
		name, reason, want string
		packets            uint64
	}{
		{"ok", "test", "recording=ok", 1},
		{"failed", "test", "recording=failed", 0},
		{"discarded", "offer_failed", "recording=discarded", 0},
	} {
		t.Run(tc.name, func(t *testing.T) {
			b := &bridge{rooms: map[string]*room{}, recordDir: t.TempDir()}
			id := "46464646-4646-4646-4646-46464646464" + strconv.Itoa(len(tc.name))
			w := &roomClosedWriter{manifest: filepath.Join(b.recordDir, id, "manifest.json")}
			log.SetOutput(w)
			defer log.SetOutput(os.Stderr)
			r, err := b.getRoom(id)
			if err != nil {
				t.Fatal(err)
			}
			r.mu.Lock()
			r.downPackets, r.upPackets = tc.packets, tc.packets
			if tc.name != "discarded" { // any forwarded packet keeps the directory
				r.transport.DownForwarded, r.transport.DownSequenceMissing = 7, 2
			}
			r.mu.Unlock()
			b.closeRoom(id, tc.reason)
			line := w.roomClosed()
			wants := []string{tc.want, "reason=" + tc.reason, "up_sent=0", "up_max_src_lag_ms=0"}
			if tc.name != "discarded" {
				wants = append(wants, "down_forwarded=7", "down_seq_missing=2")
			}
			for _, want := range wants {
				if !strings.Contains(line, want) {
					t.Fatalf("room_closed line %q lacks %q", line, want)
				}
			}
			if tc.name != "discarded" && !w.manifestBefore {
				t.Fatal("room_closed was logged before the manifest was finalized")
			}
		})
	}
}
