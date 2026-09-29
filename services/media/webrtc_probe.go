package main

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha1"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/pion/ice/v4"
	"github.com/pion/sdp/v3"
	"github.com/pion/webrtc/v4"
)

const (
	webRTCProbePurpose       = "media-webrtc-probe-v1"
	webRTCProbePath          = "/webrtc-probe/offer"
	webRTCProbeLabel         = "media-quality-v1"
	webRTCProbeFrameBytes    = 32
	webRTCProbeMaxSequence   = 249
	webRTCProbeMaxPackets    = 250
	webRTCProbeMaxTotalBytes = 128 * 1024
	webRTCProbeSDPBytes      = 64 * 1024
	webRTCProbeLifetime      = 5 * time.Second
	webRTCProbeICETimeout    = 2 * time.Second
)

type webRTCProbeClaim struct {
	Purpose           string `json:"purpose"`
	Method            string `json:"method"`
	Path              string `json:"path"`
	NodeID            string `json:"nodeId"`
	SubjectHash       string `json:"subjectHash"`
	NetworkGeneration string `json:"networkGeneration"`
	Role              string `json:"role"`
	Expires           int64  `json:"exp"`
	Nonce             string `json:"nonce"`
}

type webRTCProbePeer interface {
	OnDataChannel(func(webRTCProbeDataChannel))
	OnFailure(func())
	SetRemoteDescription(webrtc.SessionDescription) error
	Answer(context.Context) (webrtc.SessionDescription, error)
	Close() error
}

type webRTCProbeDataChannel interface {
	Label() string
	Ordered() bool
	MaxRetransmits() *uint16
	MaxPacketLifeTime() *uint16
	Negotiated() bool
	OnMessage(func([]byte, bool))
	OnError(func(error))
	OnClose(func())
	Send([]byte) error
}

type WebRTCProbeHandlerOptions struct {
	Secret         []byte
	NodeID         string
	AllowedOrigins []string
	TurnSecret     string
	TurnUDPURL     string
	NonceCapacity  int
	Now            func() time.Time
	// D9: off-by-default SCTP tuning; the zero value keeps the bare pion constructor.
	SCTPTuning sctpTuning

	// Tests inject a peer so they never gather host candidates or contact TURN.
	testPeerFactory func(webrtc.Configuration) (webRTCProbePeer, error)
	testLifetime    time.Duration
}

type webRTCProbeHandler struct {
	secret      []byte
	nodeID      string
	origins     map[string]struct{}
	turnSecret  string
	turnUDPURL  string
	capacity    int
	now         func() time.Time
	peerFactory func(webrtc.Configuration) (webRTCProbePeer, error)
	lifetime    time.Duration
	mu          sync.Mutex
	used        map[string]int64
	active      int
	subjects    map[string]struct{}
}

func NewWebRTCProbeHandler(options WebRTCProbeHandlerOptions) (http.Handler, error) {
	if len(options.Secret) < 32 || !probeNodeID.MatchString(options.NodeID) {
		return nil, errors.New("invalid WebRTC probe configuration")
	}
	origins := make(map[string]struct{}, len(options.AllowedOrigins))
	for _, raw := range options.AllowedOrigins {
		parsed, err := url.Parse(raw)
		if err != nil || parsed.Scheme != "https" || parsed.Host == "" || parsed.User != nil || parsed.Path != "" || parsed.RawQuery != "" || parsed.Fragment != "" {
			return nil, errors.New("invalid WebRTC probe origin")
		}
		origins[parsed.String()] = struct{}{}
	}
	capacity := options.NonceCapacity
	if capacity == 0 {
		capacity = defaultProbeNonceCapacity
	}
	if capacity < 1 || capacity > defaultProbeNonceCapacity {
		return nil, errors.New("invalid WebRTC probe nonce capacity")
	}
	now := options.Now
	if now == nil {
		now = time.Now
	}
	factory := options.testPeerFactory
	lifetime := options.testLifetime
	if factory == nil {
		if len(options.TurnSecret) < 32 || options.TurnUDPURL == "" {
			return nil, errors.New("WebRTC probe requires relay configuration")
		}
		turnURL, err := configuredMediaTurnUDPURL(options.NodeID, options.TurnUDPURL)
		if err != nil {
			return nil, errors.New("invalid WebRTC probe relay configuration")
		}
		options.TurnUDPURL = turnURL
		tuning := options.SCTPTuning
		factory = func(configuration webrtc.Configuration) (webRTCProbePeer, error) {
			peer, err := tuning.newPeerConnection(configuration)
			if err != nil {
				return nil, err
			}
			return &pionWebRTCProbePeer{peer: peer}, nil
		}
		lifetime = webRTCProbeLifetime
	} else if lifetime <= 0 {
		lifetime = webRTCProbeLifetime
	}
	return &webRTCProbeHandler{
		secret: append([]byte(nil), options.Secret...), nodeID: options.NodeID, origins: origins,
		turnSecret: options.TurnSecret, turnUDPURL: options.TurnUDPURL, capacity: capacity, now: now,
		peerFactory: factory, lifetime: lifetime, used: map[string]int64{}, subjects: map[string]struct{}{},
	}, nil
}

func (h *webRTCProbeHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "private, no-store")
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Vary", "Origin")
	if r.URL.Path != webRTCProbePath || r.URL.RawQuery != "" {
		h.reject(w, http.StatusNotFound)
		return
	}
	origin := r.Header.Get("Origin")
	if origin != "" {
		if _, ok := h.origins[origin]; !ok {
			h.reject(w, http.StatusForbidden)
			return
		}
		w.Header().Set("Access-Control-Allow-Origin", origin)
	}
	if r.Method == http.MethodOptions {
		if origin == "" {
			h.reject(w, http.StatusForbidden)
			return
		}
		w.Header().Set("Access-Control-Allow-Methods", http.MethodPost)
		w.Header().Set("Access-Control-Allow-Headers", "Authorization, Content-Type")
		w.Header().Set("Access-Control-Max-Age", "60")
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if r.Method != http.MethodPost {
		h.reject(w, http.StatusMethodNotAllowed)
		return
	}
	if strings.ToLower(strings.TrimSpace(strings.Split(r.Header.Get("Content-Type"), ";")[0])) != "application/json" {
		h.reject(w, http.StatusBadRequest)
		return
	}
	authorization := r.Header.Get("Authorization")
	if !strings.HasPrefix(authorization, "Bearer ") || len(authorization) == len("Bearer ") {
		h.reject(w, http.StatusUnauthorized)
		return
	}
	claim, err := h.consume(strings.TrimPrefix(authorization, "Bearer "))
	if err != nil {
		h.reject(w, statusForProbeError(err))
		return
	}
	var offer struct {
		Type string `json:"type"`
		SDP  string `json:"sdp"`
	}
	r.Body = http.MaxBytesReader(w, r.Body, webRTCProbeSDPBytes+1024)
	if err = decodeStrictJSON(r.Body, &offer); err != nil || offer.Type != "offer" || !dataOnlyProbeSDP(offer.SDP) {
		h.reject(w, http.StatusBadRequest)
		return
	}
	if !h.acquire(claim.SubjectHash) {
		h.reject(w, http.StatusTooManyRequests)
		return
	}
	peer, err := h.peerFactory(h.relayConfiguration())
	if err != nil {
		h.release(claim.SubjectHash)
		h.reject(w, http.StatusServiceUnavailable)
		return
	}
	session := newWebRTCProbeSession(peer, func() { h.release(claim.SubjectHash) }, h.lifetime)
	peer.OnFailure(session.close)
	peer.OnDataChannel(session.attach)
	if err = peer.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeOffer, SDP: offer.SDP}); err != nil {
		session.close()
		h.reject(w, http.StatusBadRequest)
		return
	}
	iceContext, cancel := context.WithTimeout(r.Context(), webRTCProbeICETimeout)
	answer, err := peer.Answer(iceContext)
	cancel()
	if err != nil {
		session.close()
		if errors.Is(err, context.DeadlineExceeded) {
			h.reject(w, http.StatusGatewayTimeout)
		} else {
			h.reject(w, http.StatusBadRequest)
		}
		return
	}
	_ = json.NewEncoder(w).Encode(struct {
		Type string `json:"type"`
		SDP  string `json:"sdp"`
	}{Type: answer.Type.String(), SDP: answer.SDP})
}

func (h *webRTCProbeHandler) relayConfiguration() webrtc.Configuration {
	username := fmt.Sprintf("%d:quality-%s", h.now().Add(time.Minute).Unix(), base64.RawURLEncoding.EncodeToString(randomProbeBytes(12)))
	mac := hmac.New(sha1.New, []byte(h.turnSecret))
	_, _ = mac.Write([]byte(username))
	return webrtc.Configuration{
		ICEServers:         []webrtc.ICEServer{{URLs: []string{h.turnUDPURL}, Username: username, Credential: base64.StdEncoding.EncodeToString(mac.Sum(nil))}},
		ICETransportPolicy: webrtc.ICETransportPolicyRelay,
	}
}

func randomProbeBytes(size int) []byte {
	value := make([]byte, size)
	if _, err := rand.Read(value); err != nil {
		panic("crypto/rand failed")
	}
	return value
}

func (h *webRTCProbeHandler) consume(token string) (webRTCProbeClaim, error) {
	if len(token) < 32 || len(token) > 4096 {
		return webRTCProbeClaim{}, errProbeUnauthorized
	}
	parts := strings.Split(token, ".")
	if len(parts) != 2 {
		return webRTCProbeClaim{}, errProbeUnauthorized
	}
	signature, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return webRTCProbeClaim{}, errProbeUnauthorized
	}
	mac := hmac.New(sha256.New, h.secret)
	_, _ = mac.Write([]byte(parts[0]))
	if !hmac.Equal(signature, mac.Sum(nil)) {
		return webRTCProbeClaim{}, errProbeUnauthorized
	}
	raw, err := base64.RawURLEncoding.DecodeString(parts[0])
	var claim webRTCProbeClaim
	if err != nil || len(raw) > 2048 || decodeStrictJSON(bytes.NewReader(raw), &claim) != nil ||
		claim.Purpose != webRTCProbePurpose || claim.Method != http.MethodPost || claim.Path != webRTCProbePath ||
		claim.NodeID != h.nodeID || !probeSubject.MatchString(claim.SubjectHash) ||
		!probeNetworkGeneration.MatchString(claim.NetworkGeneration) || (claim.Role != "client" && claim.Role != "gateway") ||
		len(claim.Nonce) < 20 || len(claim.Nonce) > 128 {
		return webRTCProbeClaim{}, errProbeUnauthorized
	}
	now := h.now().Unix()
	if claim.Expires <= now || claim.Expires > now+30 {
		return webRTCProbeClaim{}, errProbeUnauthorized
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	for nonce, expires := range h.used {
		if expires <= now {
			delete(h.used, nonce)
		}
	}
	if _, exists := h.used[claim.Nonce]; exists {
		return webRTCProbeClaim{}, errProbeReplay
	}
	if len(h.used) >= h.capacity {
		return webRTCProbeClaim{}, errProbeCapacity
	}
	h.used[claim.Nonce] = claim.Expires
	return claim, nil
}

func (h *webRTCProbeHandler) acquire(subject string) bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.active >= 2 {
		return false
	}
	if _, exists := h.subjects[subject]; exists {
		return false
	}
	h.active++
	h.subjects[subject] = struct{}{}
	return true
}

func (h *webRTCProbeHandler) release(subject string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if _, exists := h.subjects[subject]; !exists {
		return
	}
	delete(h.subjects, subject)
	h.active--
}

func (h *webRTCProbeHandler) reject(w http.ResponseWriter, status int) {
	w.WriteHeader(status)
	_, _ = io.WriteString(w, `{"error":"webrtc_probe_rejected"}`)
}

func decodeStrictJSON(reader io.Reader, target any) error {
	decoder := json.NewDecoder(reader)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return err
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return errors.New("trailing JSON")
	}
	return nil
}

func dataOnlyProbeSDP(raw string) bool {
	if raw == "" || len(raw) > webRTCProbeSDPBytes {
		return false
	}
	var description sdp.SessionDescription
	if description.UnmarshalString(raw) != nil || len(description.MediaDescriptions) != 1 {
		return false
	}
	media := description.MediaDescriptions[0].MediaName
	if media.Media != "application" || len(media.Formats) != 1 || media.Formats[0] != "webrtc-datachannel" {
		return false
	}
	if strings.Join(media.Protos, "/") != "UDP/DTLS/SCTP" {
		return false
	}
	candidateCount := 0
	endOfCandidates := false
	for _, attribute := range description.MediaDescriptions[0].Attributes {
		switch attribute.Key {
		case "candidate":
			if attribute.Value == "" {
				return false
			}
			candidate, err := ice.UnmarshalCandidate(attribute.Value)
			if err != nil || candidate.Type() != ice.CandidateTypeRelay || !candidate.NetworkType().IsUDP() {
				return false
			}
			candidateCount++
		case "end-of-candidates":
			if attribute.Value != "" {
				return false
			}
			endOfCandidates = true
		}
	}
	return candidateCount > 0 && endOfCandidates
}

type webRTCProbeSession struct {
	peer    webRTCProbePeer
	release func()
	once    sync.Once
	mu      sync.Mutex
	dcSeen  bool
	seen    [webRTCProbeMaxPackets]bool
	packets int
	bytes   int
	timer   *time.Timer
	done    chan struct{}
}

func newWebRTCProbeSession(peer webRTCProbePeer, release func(), lifetime time.Duration) *webRTCProbeSession {
	timer := time.NewTimer(lifetime)
	session := &webRTCProbeSession{peer: peer, release: release, timer: timer, done: make(chan struct{})}
	go func() {
		select {
		case <-timer.C:
			session.close()
		case <-session.done:
		}
	}()
	return session
}

func (s *webRTCProbeSession) attach(channel webRTCProbeDataChannel) {
	s.mu.Lock()
	invalid := s.dcSeen || channel.Label() != webRTCProbeLabel || channel.Ordered() || channel.Negotiated() || channel.MaxPacketLifeTime() != nil
	retransmits := channel.MaxRetransmits()
	invalid = invalid || retransmits == nil || *retransmits != 0
	if !invalid {
		s.dcSeen = true
	}
	s.mu.Unlock()
	if invalid {
		s.close()
		return
	}
	channel.OnError(func(error) { s.close() })
	channel.OnClose(s.close)
	channel.OnMessage(func(data []byte, isString bool) { s.message(channel, data, isString) })
}

func (s *webRTCProbeSession) message(channel webRTCProbeDataChannel, data []byte, isString bool) {
	if isString || len(data) != webRTCProbeFrameBytes || string(data[:4]) != "CCQ1" {
		s.close()
		return
	}
	sequence := binary.BigEndian.Uint32(data[4:8])
	if sequence > webRTCProbeMaxSequence {
		s.close()
		return
	}
	for _, value := range data[16:] {
		if value != 0 {
			s.close()
			return
		}
	}
	s.mu.Lock()
	invalid := s.seen[sequence] || s.packets >= webRTCProbeMaxPackets || s.bytes+len(data) > webRTCProbeMaxTotalBytes
	if !invalid {
		s.seen[sequence] = true
		s.packets++
		s.bytes += len(data)
	}
	s.mu.Unlock()
	if invalid || channel.Send(append([]byte(nil), data...)) != nil {
		s.close()
	}
}

func (s *webRTCProbeSession) close() {
	s.once.Do(func() {
		s.timer.Stop()
		close(s.done)
		_ = s.peer.Close()
		s.release()
	})
}

type pionWebRTCProbePeer struct{ peer *webrtc.PeerConnection }

func (p *pionWebRTCProbePeer) OnDataChannel(callback func(webRTCProbeDataChannel)) {
	p.peer.OnDataChannel(func(channel *webrtc.DataChannel) { callback(pionWebRTCProbeDataChannel{channel}) })
}
func (p *pionWebRTCProbePeer) OnFailure(callback func()) {
	p.peer.OnConnectionStateChange(func(state webrtc.PeerConnectionState) {
		if state == webrtc.PeerConnectionStateFailed || state == webrtc.PeerConnectionStateClosed {
			callback()
		}
	})
}
func (p *pionWebRTCProbePeer) SetRemoteDescription(description webrtc.SessionDescription) error {
	return p.peer.SetRemoteDescription(description)
}
func (p *pionWebRTCProbePeer) Answer(ctx context.Context) (webrtc.SessionDescription, error) {
	answer, err := p.peer.CreateAnswer(nil)
	if err != nil {
		return webrtc.SessionDescription{}, err
	}
	gathering := webrtc.GatheringCompletePromise(p.peer)
	if err = p.peer.SetLocalDescription(answer); err != nil {
		return webrtc.SessionDescription{}, err
	}
	select {
	case <-ctx.Done():
		return webrtc.SessionDescription{}, ctx.Err()
	case <-gathering:
	}
	if p.peer.LocalDescription() == nil {
		return webrtc.SessionDescription{}, errors.New("missing local description")
	}
	return *p.peer.LocalDescription(), nil
}
func (p *pionWebRTCProbePeer) Close() error { return p.peer.Close() }

type pionWebRTCProbeDataChannel struct{ channel *webrtc.DataChannel }

func (p pionWebRTCProbeDataChannel) Label() string           { return p.channel.Label() }
func (p pionWebRTCProbeDataChannel) Ordered() bool           { return p.channel.Ordered() }
func (p pionWebRTCProbeDataChannel) MaxRetransmits() *uint16 { return p.channel.MaxRetransmits() }
func (p pionWebRTCProbeDataChannel) MaxPacketLifeTime() *uint16 {
	return p.channel.MaxPacketLifeTime()
}
func (p pionWebRTCProbeDataChannel) Negotiated() bool       { return p.channel.Negotiated() }
func (p pionWebRTCProbeDataChannel) Send(data []byte) error { return p.channel.Send(data) }
func (p pionWebRTCProbeDataChannel) OnError(callback func(error)) {
	p.channel.OnError(callback)
}
func (p pionWebRTCProbeDataChannel) OnClose(callback func()) { p.channel.OnClose(callback) }
func (p pionWebRTCProbeDataChannel) OnMessage(callback func([]byte, bool)) {
	p.channel.OnMessage(func(message webrtc.DataChannelMessage) { callback(message.Data, message.IsString) })
}
