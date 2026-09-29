package main

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"regexp"
	"strings"
	"sync"
	"time"
)

type Grant struct {
	CallID     string `json:"callId"`
	Role       string `json:"role"`
	MediaEpoch int64  `json:"mediaEpoch"`
	Expires    int64  `json:"exp"`
	Nonce      string `json:"nonce"`
	// Replace (S75c) is set by Control only for the leg's owner (the winning client
	// session or the call's gateway): its offer replaces the role's leg even when the
	// bridge still sees it Connected. Absent (older Control) = the S52 rule.
	Replace bool `json:"replace,omitempty"`
}
type GrantVerifier struct {
	Secret []byte
	mu     sync.Mutex
	used   map[string]int64
}

var safeID = regexp.MustCompile(`^[a-fA-F0-9]{8}-(?:[a-fA-F0-9]{4}-){3}[a-fA-F0-9]{12}$`)

func (v *GrantVerifier) Consume(token string) (Grant, error) {
	parts := strings.Split(token, ".")
	if len(parts) != 2 {
		return Grant{}, errors.New("invalid grant")
	}
	signature, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return Grant{}, errors.New("invalid grant")
	}
	mac := hmac.New(sha256.New, v.Secret)
	mac.Write([]byte(parts[0]))
	if len(v.Secret) < 32 || !hmac.Equal(signature, mac.Sum(nil)) {
		return Grant{}, errors.New("invalid grant")
	}
	payload, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil {
		return Grant{}, err
	}
	var g Grant
	if json.Unmarshal(payload, &g) != nil || !safeID.MatchString(g.CallID) || (g.Role != "gateway" && g.Role != "client") || len(g.Nonce) < 20 {
		return Grant{}, errors.New("invalid grant")
	}
	if g.MediaEpoch == 0 {
		g.MediaEpoch = 1
	} // compatibility with grants issued before node routing
	if g.MediaEpoch < 1 {
		return Grant{}, errors.New("invalid media epoch")
	}
	now := time.Now().Unix()
	if g.Expires <= now || g.Expires > now+120 {
		return Grant{}, errors.New("expired grant")
	}
	v.mu.Lock()
	defer v.mu.Unlock()
	if v.used == nil {
		v.used = map[string]int64{}
	}
	for n, e := range v.used {
		if e <= now {
			delete(v.used, n)
		}
	}
	if _, ok := v.used[g.Nonce]; ok {
		return Grant{}, errors.New("grant replay")
	}
	if len(v.used) > 10000 {
		return Grant{}, errors.New("grant capacity")
	}
	v.used[g.Nonce] = g.Expires
	return g, nil
}
