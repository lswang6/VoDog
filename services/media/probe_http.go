package main

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"sync"
	"time"
)

const (
	mediaProbePurpose         = "media-probe-v1"
	mediaProbePath            = "/probe"
	defaultProbeNonceCapacity = 4096
)

var (
	probeNodeID            = regexp.MustCompile(`^[a-z][a-z0-9_-]{0,31}$`)
	probeSubject           = regexp.MustCompile(`^[A-Za-z0-9_-]{16,64}$`)
	probeNetworkGeneration = regexp.MustCompile(`^[A-Za-z0-9._:-]{1,96}$`)
)

type mediaProbeClaim struct {
	Purpose           string `json:"purpose"`
	Method            string `json:"method"`
	Path              string `json:"path"`
	NodeID            string `json:"nodeId"`
	SubjectHash       string `json:"subjectHash"`
	NetworkGeneration string `json:"networkGeneration"`
	Expires           int64  `json:"exp"`
	Nonce             string `json:"nonce"`
}

type MediaProbeHandlerOptions struct {
	Secret         []byte
	NodeID         string
	AllowedOrigins []string
	NonceCapacity  int
	Now            func() time.Time
}

type mediaProbeHandler struct {
	secret   []byte
	nodeID   string
	origins  map[string]struct{}
	capacity int
	now      func() time.Time
	mu       sync.Mutex
	used     map[string]int64
}

// NewMediaProbeHandler creates a cheap reachability/HTTPS RTT endpoint. It
// never returns TURN credentials and never creates a PeerConnection.
func NewMediaProbeHandler(options MediaProbeHandlerOptions) (http.Handler, error) {
	if len(options.Secret) < 32 || !probeNodeID.MatchString(options.NodeID) {
		return nil, errors.New("invalid media probe configuration")
	}
	origins := make(map[string]struct{}, len(options.AllowedOrigins))
	for _, raw := range options.AllowedOrigins {
		parsed, err := url.Parse(raw)
		if err != nil || parsed.Scheme != "https" || parsed.Host == "" || parsed.User != nil || parsed.Path != "" || parsed.RawQuery != "" || parsed.Fragment != "" {
			return nil, errors.New("invalid media probe origin")
		}
		origins[parsed.String()] = struct{}{}
	}
	capacity := options.NonceCapacity
	if capacity == 0 {
		capacity = defaultProbeNonceCapacity
	}
	if capacity < 1 || capacity > 100000 {
		return nil, errors.New("invalid media probe nonce capacity")
	}
	now := options.Now
	if now == nil {
		now = time.Now
	}
	return &mediaProbeHandler{secret: append([]byte(nil), options.Secret...), nodeID: options.NodeID, origins: origins, capacity: capacity, now: now, used: map[string]int64{}}, nil
}

func (h *mediaProbeHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "private, no-store")
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Vary", "Origin")
	if r.URL.Path != mediaProbePath || r.URL.RawQuery != "" {
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
	// The contract is an empty POST. Reject chunked/unknown-length bodies before
	// reading so a client cannot hold a handler open by never finishing a body.
	if r.ContentLength != 0 || len(r.TransferEncoding) != 0 {
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
	json.NewEncoder(w).Encode(struct {
		OK     bool   `json:"ok"`
		NodeID string `json:"nodeId"`
	}{true, claim.NodeID})
}

var (
	errProbeUnauthorized = errors.New("unauthorized")
	errProbeReplay       = errors.New("replay")
	errProbeCapacity     = errors.New("capacity")
)

func (h *mediaProbeHandler) consume(token string) (mediaProbeClaim, error) {
	if len(token) < 32 || len(token) > 4096 {
		return mediaProbeClaim{}, errProbeUnauthorized
	}
	parts := strings.Split(token, ".")
	if len(parts) != 2 {
		return mediaProbeClaim{}, errProbeUnauthorized
	}
	signature, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return mediaProbeClaim{}, errProbeUnauthorized
	}
	mac := hmac.New(sha256.New, h.secret)
	mac.Write([]byte(parts[0]))
	if !hmac.Equal(signature, mac.Sum(nil)) {
		return mediaProbeClaim{}, errProbeUnauthorized
	}
	raw, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil || len(raw) > 2048 {
		return mediaProbeClaim{}, errProbeUnauthorized
	}
	var claim mediaProbeClaim
	if json.Unmarshal(raw, &claim) != nil || claim.Purpose != mediaProbePurpose || claim.Method != http.MethodPost || claim.Path != mediaProbePath || claim.NodeID != h.nodeID || !probeSubject.MatchString(claim.SubjectHash) || !probeNetworkGeneration.MatchString(claim.NetworkGeneration) || len(claim.Nonce) < 20 || len(claim.Nonce) > 128 {
		return mediaProbeClaim{}, errProbeUnauthorized
	}
	now := h.now().Unix()
	if claim.Expires <= now || claim.Expires > now+60 {
		return mediaProbeClaim{}, errProbeUnauthorized
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	for nonce, expires := range h.used {
		if expires <= now {
			delete(h.used, nonce)
		}
	}
	if _, ok := h.used[claim.Nonce]; ok {
		return mediaProbeClaim{}, errProbeReplay
	}
	if len(h.used) >= h.capacity {
		return mediaProbeClaim{}, errProbeCapacity
	}
	h.used[claim.Nonce] = claim.Expires
	return claim, nil
}

func statusForProbeError(err error) int {
	if errors.Is(err, errProbeReplay) {
		return http.StatusConflict
	}
	if errors.Is(err, errProbeCapacity) {
		return http.StatusTooManyRequests
	}
	return http.StatusUnauthorized
}
func (h *mediaProbeHandler) reject(w http.ResponseWriter, status int) {
	w.WriteHeader(status)
	io.WriteString(w, `{"error":"probe_rejected"}`)
}
