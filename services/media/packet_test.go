package main

import (
	"bytes"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"testing"
	"time"
)

func TestPacket(t *testing.T) {
	p := Packet{Direction: 0, DurationMS: 20, Sequence: 40, TimestampUS: 800000, Opus: []byte{0xf8, 0xff, 0xfe}}
	b := encodePacket(p)
	r, e := decodePacket(b)
	if e != nil || r.Sequence != p.Sequence || !bytes.Equal(r.Opus, p.Opus) {
		t.Fatal(r, e)
	}
	for _, bad := range [][]byte{nil, make([]byte, 1100), append([]byte{2}, b[1:]...), append([]byte{1, 4}, b[2:]...)} {
		if _, e := decodePacket(bad); e == nil {
			t.Fatal("accepted invalid packet")
		}
	}
}
func sign(g Grant, key []byte) string {
	raw, _ := json.Marshal(g)
	p := base64.RawURLEncoding.EncodeToString(raw)
	m := hmac.New(sha256.New, key)
	m.Write([]byte(p))
	return p + "." + base64.RawURLEncoding.EncodeToString(m.Sum(nil))
}
func TestGrant(t *testing.T) {
	key := bytes.Repeat([]byte("k"), 32)
	v := GrantVerifier{Secret: key}
	g := Grant{CallID: "11111111-1111-1111-1111-111111111111", Role: "gateway", Expires: time.Now().Unix() + 60, Nonce: "unique-test-nonce-1234567"}
	token := sign(g, key)
	if _, e := v.Consume(token); e != nil {
		t.Fatal(e)
	}
	if _, e := v.Consume(token); e == nil {
		t.Fatal("replay allowed")
	}
	g.Nonce = "second-test-nonce-123456"
	g.Expires = time.Now().Unix() - 1
	if _, e := v.Consume(sign(g, key)); e == nil {
		t.Fatal("expired accepted")
	}
	g.Expires = time.Now().Unix() + 60
	if _, e := v.Consume(sign(g, []byte("wrong-secret"))); e == nil {
		t.Fatal("bad signature accepted")
	}
}

func TestMediaFlightBudgetAccountsForAcknowledgementDelay(t *testing.T) {
	// 200ms RTT + 200ms delayed ACK + 60ms margin = 23 20ms packets.
	if got := mediaFlightBudget(56, 20, 0.2); got != 116*23 {
		t.Fatalf("healthy RTT budget=%d", got)
	}
	if got := mediaFlightBudget(56, 20, 1000); got != 116*63 {
		t.Fatalf("unbounded RTT budget=%d", got)
	}
	if got := mediaFlightBudget(56, 20, 0); got != 116*38 {
		t.Fatalf("startup budget=%d", got)
	}
	if mediaFlightBudget(56, 0, 0) != 0 {
		t.Fatal("zero duration accepted")
	}
	if got := mediaFlightBudget(200, 20, 0.2); got != 200*23 {
		t.Fatalf("large packets must keep their own size, budget=%d", got)
	}
}

// S70d: speech-sized packets fill BufferedAmount, then speech stops and 24 B silence
// frames arrive. They must fit while the backlog is within a speech-sized budget.
func TestMediaFlightBudgetSilenceAfterSpeechBurst(t *testing.T) {
	speech := uint64(headerSize + 100)
	budget := mediaFlightBudget(speech, 20, 0.2)
	buffered := speech * 20 // 20 of 23 packets in flight
	for i := 0; i < 3; i++ {
		silence := uint64(headerSize + 8)
		if buffered+silence > mediaFlightBudget(silence, 20, 0.2) {
			t.Fatalf("silence packet %d dropped: buffered=%d budget=%d", i, buffered, budget)
		}
		buffered += silence
	}
}
