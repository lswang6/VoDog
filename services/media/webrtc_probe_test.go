package main

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/pion/webrtc/v4"
)

const dataOnlyOffer = "v=0\r\n" +
	"o=- 1 1 IN IP4 127.0.0.1\r\n" +
	"s=-\r\n" +
	"t=0 0\r\n" +
	"m=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n" +
	"c=IN IP4 0.0.0.0\r\n" +
	"a=candidate:1 1 udp 16777215 203.0.113.10 50000 typ relay raddr 0.0.0.0 rport 0\r\n" +
	"a=end-of-candidates\r\n"

type fakeWebRTCProbePeer struct {
	mu          sync.Mutex
	onData      func(webRTCProbeDataChannel)
	onFailure   func()
	remote      webrtc.SessionDescription
	answerError error
	closed      bool
}

func (f *fakeWebRTCProbePeer) OnDataChannel(callback func(webRTCProbeDataChannel)) {
	f.onData = callback
}
func (f *fakeWebRTCProbePeer) OnFailure(callback func()) { f.onFailure = callback }
func (f *fakeWebRTCProbePeer) SetRemoteDescription(description webrtc.SessionDescription) error {
	f.remote = description
	return nil
}
func (f *fakeWebRTCProbePeer) Answer(ctx context.Context) (webrtc.SessionDescription, error) {
	if f.answerError != nil {
		return webrtc.SessionDescription{}, f.answerError
	}
	return webrtc.SessionDescription{Type: webrtc.SDPTypeAnswer, SDP: dataOnlyOffer}, nil
}
func (f *fakeWebRTCProbePeer) Close() error {
	f.mu.Lock()
	f.closed = true
	f.mu.Unlock()
	return nil
}
func (f *fakeWebRTCProbePeer) isClosed() bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.closed
}
func (f *fakeWebRTCProbePeer) fail()                                      { f.onFailure() }
func (f *fakeWebRTCProbePeer) dataChannel(channel webRTCProbeDataChannel) { f.onData(channel) }

type fakeWebRTCProbeDataChannel struct {
	label       string
	ordered     bool
	retransmits *uint16
	lifetime    *uint16
	negotiated  bool
	onMessage   func([]byte, bool)
	onError     func(error)
	onClose     func()
	sent        [][]byte
	sendError   error
}

func (f *fakeWebRTCProbeDataChannel) Label() string              { return f.label }
func (f *fakeWebRTCProbeDataChannel) Ordered() bool              { return f.ordered }
func (f *fakeWebRTCProbeDataChannel) MaxRetransmits() *uint16    { return f.retransmits }
func (f *fakeWebRTCProbeDataChannel) MaxPacketLifeTime() *uint16 { return f.lifetime }
func (f *fakeWebRTCProbeDataChannel) Negotiated() bool           { return f.negotiated }
func (f *fakeWebRTCProbeDataChannel) OnMessage(callback func([]byte, bool)) {
	f.onMessage = callback
}
func (f *fakeWebRTCProbeDataChannel) OnError(callback func(error)) { f.onError = callback }
func (f *fakeWebRTCProbeDataChannel) OnClose(callback func())      { f.onClose = callback }
func (f *fakeWebRTCProbeDataChannel) Send(data []byte) error {
	if f.sendError != nil {
		return f.sendError
	}
	f.sent = append(f.sent, append([]byte(nil), data...))
	return nil
}

func webRTCProbeToken(t *testing.T, secret []byte, claim any) string {
	t.Helper()
	raw, err := json.Marshal(claim)
	if err != nil {
		t.Fatal(err)
	}
	body := base64.RawURLEncoding.EncodeToString(raw)
	mac := hmac.New(sha256.New, secret)
	_, _ = mac.Write([]byte(body))
	return body + "." + base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}

func validWebRTCProbeClaim(now time.Time, subject, nonce string) webRTCProbeClaim {
	return webRTCProbeClaim{
		Purpose: webRTCProbePurpose, Method: http.MethodPost, Path: webRTCProbePath, NodeID: "relay-secondary",
		SubjectHash: subject, NetworkGeneration: "wifi:7", Role: "client", Expires: now.Unix() + 30, Nonce: nonce,
	}
}

func validWebRTCProbeBody() string {
	raw, _ := json.Marshal(map[string]string{"type": "offer", "sdp": dataOnlyOffer})
	return string(raw)
}

func TestWebRTCProbeRequiresStrictPurposeRoleClaimBodyAndCORS(t *testing.T) {
	secret := []byte("webrtc-probe-secret-at-least-32-bytes")
	now := time.Unix(1_788_960_000, 0)
	peers := []*fakeWebRTCProbePeer{}
	handler, err := NewWebRTCProbeHandler(WebRTCProbeHandlerOptions{
		Secret: secret, NodeID: "relay-secondary", AllowedOrigins: []string{"https://caller.example"}, Now: func() time.Time { return now },
		TurnSecret: "turn-secret-at-least-thirty-two-bytes", TurnUDPURL: "turn:relay.example:3478?transport=udp",
		testPeerFactory: func(configuration webrtc.Configuration) (webRTCProbePeer, error) {
			if configuration.ICETransportPolicy != webrtc.ICETransportPolicyRelay || len(configuration.ICEServers) != 1 {
				t.Fatalf("non-relay configuration: %+v", configuration)
			}
			peer := &fakeWebRTCProbePeer{}
			peers = append(peers, peer)
			return peer, nil
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	serve := func(method, path, origin, token, body string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(method, path, strings.NewReader(body))
		if body != "" {
			req.Header.Set("Content-Type", "application/json")
		}
		if origin != "" {
			req.Header.Set("Origin", origin)
		}
		if token != "" {
			req.Header.Set("Authorization", "Bearer "+token)
		}
		recorder := httptest.NewRecorder()
		handler.ServeHTTP(recorder, req)
		return recorder
	}
	claim := validWebRTCProbeClaim(now, "sessionHash_1234567890", "quality-probe-nonce-number-01")
	response := serve("POST", webRTCProbePath, "https://caller.example", webRTCProbeToken(t, secret, claim), validWebRTCProbeBody())
	if response.Code != 200 || response.Header().Get("Access-Control-Allow-Origin") != "https://caller.example" || len(peers) != 1 {
		t.Fatalf("valid=%d origin=%q peers=%d body=%s", response.Code, response.Header().Get("Access-Control-Allow-Origin"), len(peers), response.Body.String())
	}
	if peers[0].remote.Type != webrtc.SDPTypeOffer || peers[0].remote.SDP != dataOnlyOffer {
		t.Fatalf("remote=%+v", peers[0].remote)
	}
	peers[0].fail()
	response = serve("OPTIONS", webRTCProbePath, "https://caller.example", "", "")
	if response.Code != 204 {
		t.Fatalf("options=%d", response.Code)
	}
	for index, mutate := range []func(map[string]any){
		func(value map[string]any) { value["purpose"] = "media-probe-v1" },
		func(value map[string]any) { value["role"] = "server" },
		func(value map[string]any) { value["callId"] = "11111111-1111-4111-8111-111111111111" },
		func(value map[string]any) { value["path"] = "/probe" },
	} {
		raw, _ := json.Marshal(validWebRTCProbeClaim(now, "otherSessionHash_123456", "quality-probe-security-nonce-"+string(rune('a'+index))))
		var value map[string]any
		_ = json.Unmarshal(raw, &value)
		mutate(value)
		if got := serve("POST", webRTCProbePath, "", webRTCProbeToken(t, secret, value), validWebRTCProbeBody()).Code; got != 401 {
			t.Fatalf("claim case %d=%d", index, got)
		}
	}
	for index, body := range []string{
		`{"type":"offer","sdp":"` + strings.ReplaceAll(dataOnlyOffer, "\r\n", "\\r\\n") + `","callId":"x"}`,
		`{"type":"answer","sdp":"x"}`,
		`{"type":"offer","sdp":"v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n"}`,
	} {
		claim = validWebRTCProbeClaim(now, "bodySessionHash_1234567", "quality-probe-body-nonce-0"+string(rune('1'+index)))
		if got := serve("POST", webRTCProbePath, "", webRTCProbeToken(t, secret, claim), body).Code; got != 400 {
			t.Fatalf("body case %d=%d", index, got)
		}
	}
	for index, expires := range []int64{now.Unix(), now.Unix() + 31} {
		claim = validWebRTCProbeClaim(now, "expirySessionHash_12345", "quality-probe-expiry-nonce-"+string(rune('a'+index)))
		claim.Expires = expires
		if got := serve("POST", webRTCProbePath, "", webRTCProbeToken(t, secret, claim), validWebRTCProbeBody()).Code; got != 401 {
			t.Fatalf("expiry case %d=%d", index, got)
		}
	}
	claim = validWebRTCProbeClaim(now, "gatewaySubjectHash_12345", "quality-probe-gateway-nonce-01")
	claim.Role = "gateway"
	if consumed, consumeErr := handler.(*webRTCProbeHandler).consume(webRTCProbeToken(t, secret, claim)); consumeErr != nil || consumed.Role != "gateway" {
		t.Fatalf("gateway role was not accepted: claim=%+v err=%v", consumed, consumeErr)
	}
	if got := serve("POST", webRTCProbePath, "https://evil.example", "ignored", validWebRTCProbeBody()).Code; got != 403 {
		t.Fatalf("origin=%d", got)
	}
}

func TestWebRTCProbeCapsAndAbsoluteLifetimeReleasePeers(t *testing.T) {
	secret := []byte("webrtc-probe-secret-at-least-32-bytes")
	now := time.Unix(1_788_960_000, 0)
	peers := []*fakeWebRTCProbePeer{}
	handler, err := NewWebRTCProbeHandler(WebRTCProbeHandlerOptions{
		Secret: secret, NodeID: "relay-secondary", Now: func() time.Time { return now }, testLifetime: 20 * time.Millisecond,
		testPeerFactory: func(webrtc.Configuration) (webRTCProbePeer, error) {
			peer := &fakeWebRTCProbePeer{}
			peers = append(peers, peer)
			return peer, nil
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	request := func(subject string, nonce int) int {
		claim := validWebRTCProbeClaim(now, subject, "quality-capacity-nonce-000"+string(rune('a'+nonce)))
		req := httptest.NewRequest("POST", webRTCProbePath, strings.NewReader(validWebRTCProbeBody()))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Authorization", "Bearer "+webRTCProbeToken(t, secret, claim))
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, req)
		return response.Code
	}
	if got := request("subjectCapacityHash_001", 0); got != 200 {
		t.Fatal(got)
	}
	if got := request("subjectCapacityHash_001", 1); got != 429 {
		t.Fatalf("per subject=%d", got)
	}
	if got := request("subjectCapacityHash_002", 2); got != 200 {
		t.Fatal(got)
	}
	if got := request("subjectCapacityHash_003", 3); got != 429 {
		t.Fatalf("per node=%d", got)
	}
	deadline := time.Now().Add(time.Second)
	for (!peers[0].isClosed() || !peers[1].isClosed()) && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	if !peers[0].isClosed() || !peers[1].isClosed() {
		t.Fatal("absolute lifetime did not close peers")
	}
	if got := request("subjectCapacityHash_003", 4); got != 200 {
		t.Fatalf("capacity not released=%d", got)
	}
	peers[2].fail()
}

func TestWebRTCProbeFrameEchoAndProtocolViolationsClose(t *testing.T) {
	peer := &fakeWebRTCProbePeer{}
	released := 0
	session := newWebRTCProbeSession(peer, func() { released++ }, time.Hour)
	peer.OnFailure(session.close)
	peer.OnDataChannel(session.attach)
	zero := uint16(0)
	channel := &fakeWebRTCProbeDataChannel{label: webRTCProbeLabel, retransmits: &zero}
	peer.dataChannel(channel)
	frame := make([]byte, webRTCProbeFrameBytes)
	copy(frame, "CCQ1")
	binary.BigEndian.PutUint32(frame[4:8], 17)
	binary.BigEndian.PutUint64(frame[8:16], 0xfedcba9876543210)
	channel.onMessage(frame, false)
	if len(channel.sent) != 1 || !bytes.Equal(channel.sent[0], frame) || peer.isClosed() {
		t.Fatalf("echoes=%d closed=%v", len(channel.sent), peer.isClosed())
	}
	channel.onMessage(frame, false)
	if !peer.isClosed() || released != 1 || len(channel.sent) != 1 {
		t.Fatalf("duplicate closed=%v released=%d echoes=%d", peer.isClosed(), released, len(channel.sent))
	}
	channel.onError(errors.New("data channel failed"))
	if released != 1 {
		t.Fatal("data channel error released session twice")
	}

	for name, mutate := range map[string]func([]byte) bool{
		"text":        func([]byte) bool { return true },
		"magic":       func(value []byte) bool { value[0] = 'X'; return false },
		"sequence":    func(value []byte) bool { binary.BigEndian.PutUint32(value[4:8], 250); return false },
		"padding":     func(value []byte) bool { value[16] = 1; return false },
		"short-frame": func(value []byte) bool { return false },
	} {
		t.Run(name, func(t *testing.T) {
			candidatePeer := &fakeWebRTCProbePeer{}
			candidateSession := newWebRTCProbeSession(candidatePeer, func() {}, time.Hour)
			candidatePeer.OnDataChannel(candidateSession.attach)
			candidateChannel := &fakeWebRTCProbeDataChannel{label: webRTCProbeLabel, retransmits: &zero}
			candidatePeer.dataChannel(candidateChannel)
			candidate := append([]byte(nil), frame...)
			isString := mutate(candidate)
			if name == "short-frame" {
				candidate = candidate[:31]
			}
			candidateChannel.onMessage(candidate, isString)
			if !candidatePeer.isClosed() || len(candidateChannel.sent) != 0 {
				t.Fatal("protocol violation was not closed")
			}
		})
	}

	for name, channel := range map[string]*fakeWebRTCProbeDataChannel{
		"ordered":    {label: webRTCProbeLabel, ordered: true, retransmits: &zero},
		"reliable":   {label: webRTCProbeLabel},
		"lifetime":   {label: webRTCProbeLabel, retransmits: &zero, lifetime: &zero},
		"negotiated": {label: webRTCProbeLabel, retransmits: &zero, negotiated: true},
		"label":      {label: "other", retransmits: &zero},
	} {
		t.Run(name, func(t *testing.T) {
			candidatePeer := &fakeWebRTCProbePeer{}
			candidateSession := newWebRTCProbeSession(candidatePeer, func() {}, time.Hour)
			candidateSession.attach(channel)
			if !candidatePeer.isClosed() {
				t.Fatal("invalid channel remained open")
			}
		})
	}
	candidatePeer := &fakeWebRTCProbePeer{}
	candidateSession := newWebRTCProbeSession(candidatePeer, func() {}, time.Hour)
	first := &fakeWebRTCProbeDataChannel{label: webRTCProbeLabel, retransmits: &zero}
	candidateSession.attach(first)
	candidateSession.attach(&fakeWebRTCProbeDataChannel{label: webRTCProbeLabel, retransmits: &zero})
	if !candidatePeer.isClosed() {
		t.Fatal("second data channel remained open")
	}
	for name, failChannel := range map[string]func(*fakeWebRTCProbeDataChannel){
		"callback-error": func(channel *fakeWebRTCProbeDataChannel) { channel.onError(errors.New("data channel failure")) },
		"callback-close": func(channel *fakeWebRTCProbeDataChannel) { channel.onClose() },
		"send-error": func(channel *fakeWebRTCProbeDataChannel) {
			channel.sendError = errors.New("send failed")
			channel.onMessage(frame, false)
		},
	} {
		t.Run(name, func(t *testing.T) {
			failedPeer := &fakeWebRTCProbePeer{}
			failedSession := newWebRTCProbeSession(failedPeer, func() {}, time.Hour)
			failedChannel := &fakeWebRTCProbeDataChannel{label: webRTCProbeLabel, retransmits: &zero}
			failedSession.attach(failedChannel)
			failChannel(failedChannel)
			if !failedPeer.isClosed() {
				t.Fatal("data channel failure did not close peer")
			}
		})
	}
}

func TestWebRTCProbeProductionRequiresRelayAndICEFailureCleansUp(t *testing.T) {
	secret := []byte("webrtc-probe-secret-at-least-32-bytes")
	if _, err := NewWebRTCProbeHandler(WebRTCProbeHandlerOptions{Secret: secret, NodeID: "relay-secondary"}); err == nil {
		t.Fatal("production handler accepted missing relay configuration")
	}
	if _, err := NewWebRTCProbeHandler(WebRTCProbeHandlerOptions{Secret: secret, NodeID: "relay-secondary", TurnSecret: "turn-secret", TurnUDPURL: "stun:relay.example:3478"}); err == nil {
		t.Fatal("production handler accepted a non-TURN relay URL")
	}
	if _, err := NewWebRTCProbeHandler(WebRTCProbeHandlerOptions{Secret: secret, NodeID: "relay-secondary", TurnSecret: "short", TurnUDPURL: "turn:relay.example:3478?transport=udp"}); err == nil {
		t.Fatal("production handler accepted a short TURN secret")
	}
	peer := &fakeWebRTCProbePeer{answerError: context.DeadlineExceeded}
	now := time.Unix(1_788_960_000, 0)
	handler, err := NewWebRTCProbeHandler(WebRTCProbeHandlerOptions{
		Secret: secret, NodeID: "relay-secondary", Now: func() time.Time { return now },
		testPeerFactory: func(webrtc.Configuration) (webRTCProbePeer, error) { return peer, nil },
	})
	if err != nil {
		t.Fatal(err)
	}
	claim := validWebRTCProbeClaim(now, "timeoutSessionHash_12345", "quality-timeout-nonce-001")
	req := httptest.NewRequest("POST", webRTCProbePath, strings.NewReader(validWebRTCProbeBody()))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+webRTCProbeToken(t, secret, claim))
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, req)
	if response.Code != 504 || !peer.isClosed() {
		t.Fatalf("status=%d closed=%v", response.Code, peer.isClosed())
	}
	if !errors.Is(peer.answerError, context.DeadlineExceeded) {
		t.Fatal("test setup failed")
	}
}

func TestDataOnlyProbeSDPRequiresCompleteUDPRelayCandidates(t *testing.T) {
	relay := "a=candidate:1 1 udp 16777215 203.0.113.10 50000 typ relay raddr 0.0.0.0 rport 0\r\n"
	base := "v=0\r\n" +
		"o=- 1 1 IN IP4 127.0.0.1\r\n" +
		"s=-\r\n" +
		"t=0 0\r\n" +
		"m=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n" +
		"c=IN IP4 0.0.0.0\r\n"
	tests := map[string]struct {
		candidates string
		want       bool
	}{
		"valid-relay":     {relay + "a=end-of-candidates\r\n", true},
		"host":            {"a=candidate:1 1 udp 2130706431 192.0.2.10 50000 typ host\r\na=end-of-candidates\r\n", false},
		"srflx":           {"a=candidate:1 1 udp 1694498815 198.51.100.10 50000 typ srflx raddr 192.0.2.10 rport 50000\r\na=end-of-candidates\r\n", false},
		"tcp-relay":       {"a=candidate:1 1 tcp 16777215 203.0.113.10 50000 typ relay raddr 0.0.0.0 rport 0 tcptype passive\r\na=end-of-candidates\r\n", false},
		"malformed":       {"a=candidate:not-a-candidate\r\na=end-of-candidates\r\n", false},
		"empty":           {"a=candidate:\r\na=end-of-candidates\r\n", false},
		"missing":         {"a=end-of-candidates\r\n", false},
		"still-trickling": {relay, false},
		"mixed-host":      {relay + "a=candidate:2 1 udp 2130706431 192.0.2.10 50001 typ host\r\na=end-of-candidates\r\n", false},
	}
	for name, test := range tests {
		t.Run(name, func(t *testing.T) {
			if got := dataOnlyProbeSDP(base + test.candidates); got != test.want {
				t.Fatalf("dataOnlyProbeSDP()=%v want %v", got, test.want)
			}
		})
	}
}
