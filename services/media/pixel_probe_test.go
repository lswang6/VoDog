package main

import (
	"bytes"
	"crypto/rand"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/pion/webrtc/v4"
)

// Explicit operator-run probe. Only signaling travels over USB/SSH; every media
// packet uses relay-only ICE through the real TURN and media servers.
func TestPixelRemoteOpusRelay(t *testing.T) {
	if os.Getenv("CC_PIXEL_PROBE") != "1" {
		t.Skip("explicit physical Pixel probe only")
	}
	endpoint := os.Getenv("CC_MEDIA_PROBE_ENDPOINT")
	if endpoint != "http://127.0.0.1:16883" {
		t.Fatal("requires dedicated SSH forward")
	}
	secret := []byte(os.Getenv("CC_MEDIA_PROBE_SECRET"))
	turnSecret := os.Getenv("CC_MEDIA_PROBE_TURN_SECRET")
	if len(secret) < 32 || len(turnSecret) < 20 {
		t.Fatal("missing probe credentials")
	}
	raw := make([]byte, 16)
	if _, err := rand.Read(raw); err != nil {
		t.Fatal(err)
	}
	id := fmt.Sprintf("%x-%x-%x-%x-%x", raw[:4], raw[4:6], raw[6:8], raw[8:10], raw[10:])
	hc := &http.Client{Timeout: 25 * time.Second}
	defer func() {
		req, _ := http.NewRequest("POST", endpoint+"/close/"+id, nil)
		req.Header.Set("Authorization", "Bearer "+string(secret))
		req.Header.Set("X-Media-Epoch", "1")
		res, err := hc.Do(req)
		if err != nil {
			t.Error("room close failed")
			return
		}
		res.Body.Close()
		if res.StatusCode != 204 {
			t.Error("room close rejected")
		}
	}()
	relay := &bridge{turnSecret: turnSecret, turnUDPURL: secondaryTurnUDPURL}
	config := relay.config()
	if os.Getenv("CC_MEDIA_PROBE_TRANSPORT") == "tls" {
		config.ICEServers[0].URLs = []string{"turns:relay-secondary.example.com:16802?transport=tcp"}
	}
	exchange := func(role string, body []byte) ([]byte, error) {
		req, _ := http.NewRequest("POST", endpoint+"/offer", bytes.NewReader(body))
		req.Header.Set("Authorization", "Bearer "+sign(Grant{CallID: id, Role: role, Expires: time.Now().Unix() + 60, Nonce: id + "-" + role}, secret))
		res, err := hc.Do(req)
		if err != nil {
			return nil, fmt.Errorf("media connection failed")
		}
		defer res.Body.Close()
		if res.StatusCode != 200 {
			return nil, fmt.Errorf("media HTTP %d", res.StatusCode)
		}
		return io.ReadAll(io.LimitReader(res.Body, 128*1024))
	}
	client, err := webrtc.NewPeerConnection(config)
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	track, err := webrtc.NewTrackLocalStaticRTP(webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeOpus, ClockRate: 48000, Channels: 2}, "echo", "synthetic")
	if err != nil {
		t.Fatal(err)
	}
	sender, err := client.AddTrack(track)
	if err != nil {
		t.Fatal(err)
	}
	go func() {
		buf := make([]byte, 1500)
		for {
			if _, _, err := sender.Read(buf); err != nil {
				return
			}
		}
	}()
	var echoed atomic.Int64
	client.OnTrack(func(remote *webrtc.TrackRemote, _ *webrtc.RTPReceiver) {
		for {
			packet, _, err := remote.ReadRTP()
			if err != nil {
				return
			}
			if err = track.WriteRTP(packet); err != nil {
				return
			}
			echoed.Add(1)
		}
	})
	offer, err := client.CreateOffer(nil)
	if err != nil {
		t.Fatal(err)
	}
	gathered := webrtc.GatheringCompletePromise(client)
	if err = client.SetLocalDescription(offer); err != nil {
		t.Fatal(err)
	}
	select {
	case <-gathered:
	case <-time.After(15 * time.Second):
		t.Fatal("client ICE gathering timed out")
	}
	body, _ := json.Marshal(client.LocalDescription())
	answer, err := exchange("client", body)
	if err != nil {
		t.Fatal(err)
	}
	var desc webrtc.SessionDescription
	if err = json.Unmarshal(answer, &desc); err != nil {
		t.Fatal("invalid answer")
	}
	if err = client.SetRemoteDescription(desc); err != nil {
		t.Fatal(err)
	}
	done := make(chan struct{})
	var once sync.Once
	var offered atomic.Bool
	gatewayConfig := relay.config()
	if os.Getenv("CC_MEDIA_PROBE_TRANSPORT") == "tls" {
		gatewayConfig.ICEServers[0].URLs = []string{"turns:relay-secondary.example.com:16802?transport=tcp"}
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/config", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "GET" {
			w.WriteHeader(405)
			return
		}
		json.NewEncoder(w).Encode(map[string]any{"callId": id, "iceTransportPolicy": "relay", "iceServers": gatewayConfig.ICEServers})
	})
	mux.HandleFunc("/offer", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "POST" {
			w.WriteHeader(405)
			return
		}
		if !offered.CompareAndSwap(false, true) {
			w.WriteHeader(409)
			return
		}
		body, err := io.ReadAll(io.LimitReader(r.Body, 128*1024))
		if err != nil {
			w.WriteHeader(400)
			return
		}
		answer, err := exchange("gateway", body)
		if err != nil {
			w.WriteHeader(502)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.Write(answer)
	})
	mux.HandleFunc("/done", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "POST" {
			w.WriteHeader(405)
			return
		}
		w.WriteHeader(204)
		once.Do(func() { close(done) })
	})
	listener, err := net.Listen("tcp", "127.0.0.1:16884")
	if err != nil {
		t.Fatal(err)
	}
	server := &http.Server{Handler: mux, ReadHeaderTimeout: 3 * time.Second, ReadTimeout: 30 * time.Second, WriteTimeout: 30 * time.Second}
	defer server.Close()
	go server.Serve(listener)
	t.Log("PIXEL_PROBE_READY signaling=127.0.0.1:16884 callId=" + id)
	select {
	case <-done:
	case <-time.After(150 * time.Second):
		t.Fatal("Pixel probe did not complete")
	}
	if echoed.Load() < 30 {
		t.Fatalf("insufficient echoed Opus packets: %d", echoed.Load())
	}
	t.Logf("Pixel real relay Opus packets=%d; synthetic audio only", echoed.Load())
}

// Peer allocations must not accidentally share the same per-user TURN quota.
func TestTurnCredentialsAreUniquePerPeer(t *testing.T) {
	b := &bridge{turnSecret: "synthetic-test-secret", turnUDPURL: secondaryTurnUDPURL}
	first := b.config()
	second := b.config()
	if first.ICEServers[0].Username == second.ICEServers[0].Username {
		t.Fatal("different peers share a TURN allocation identity")
	}
	if first.ICETransportPolicy != webrtc.ICETransportPolicyRelay {
		t.Fatal("relay-only policy lost")
	}
}
