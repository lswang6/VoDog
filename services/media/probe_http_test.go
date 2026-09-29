package main

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func signProbeClaim(t *testing.T, secret []byte, claim mediaProbeClaim) string {
	t.Helper()
	raw, err := json.Marshal(claim)
	if err != nil {
		t.Fatal(err)
	}
	body := base64.RawURLEncoding.EncodeToString(raw)
	mac := hmac.New(sha256.New, secret)
	mac.Write([]byte(body))
	return body + "." + base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}

func TestMediaProbeRequiresBoundSingleUseGrantAndExactOrigin(t *testing.T) {
	secret := []byte("probe-secret-at-least-thirty-two-bytes")
	now := time.Unix(1_788_960_000, 0)
	handler, err := NewMediaProbeHandler(MediaProbeHandlerOptions{Secret: secret, NodeID: "relay-secondary", AllowedOrigins: []string{"https://caller.example"}, NonceCapacity: 2, Now: func() time.Time { return now }})
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(handler)
	defer server.Close()
	claim := mediaProbeClaim{Purpose: mediaProbePurpose, Method: "POST", Path: "/probe", NodeID: "relay-secondary", SubjectHash: "sessionHash_1234567890", NetworkGeneration: "wifi:7", Expires: now.Unix() + 30, Nonce: "unique-probe-nonce-number-one"}
	request := func(token, origin, path string, body bool) *http.Response {
		t.Helper()
		var reader *strings.Reader
		if body {
			reader = strings.NewReader("x")
		} else {
			reader = strings.NewReader("")
		}
		req, _ := http.NewRequest("POST", server.URL+path, reader)
		req.Header.Set("Authorization", "Bearer "+token)
		if origin != "" {
			req.Header.Set("Origin", origin)
		}
		res, e := http.DefaultClient.Do(req)
		if e != nil {
			t.Fatal(e)
		}
		return res
	}
	token := signProbeClaim(t, secret, claim)
	res := request(token, "https://caller.example", "/probe", false)
	if res.StatusCode != 200 {
		t.Fatalf("first=%d", res.StatusCode)
	}
	var output struct {
		OK     bool   `json:"ok"`
		NodeID string `json:"nodeId"`
	}
	json.NewDecoder(res.Body).Decode(&output)
	res.Body.Close()
	if !output.OK || output.NodeID != "relay-secondary" {
		t.Fatalf("output=%+v", output)
	}
	res = request(token, "https://caller.example", "/probe", false)
	if res.StatusCode != 409 {
		t.Fatalf("replay=%d", res.StatusCode)
	}
	res.Body.Close()
	claim.Nonce = "unique-probe-nonce-number-two"
	res = request(signProbeClaim(t, secret, claim), "https://evil.example", "/probe", false)
	if res.StatusCode != 403 {
		t.Fatalf("origin=%d", res.StatusCode)
	}
	res.Body.Close()
	res = request(signProbeClaim(t, secret, claim), "", "/other", false)
	if res.StatusCode != 404 {
		t.Fatalf("path=%d", res.StatusCode)
	}
	res.Body.Close()
	res = request(signProbeClaim(t, secret, claim), "", "/probe", true)
	if res.StatusCode != 400 {
		t.Fatalf("body=%d", res.StatusCode)
	}
	res.Body.Close()
}

func TestMediaProbeNonceCacheIsBoundedAndExpires(t *testing.T) {
	secret := []byte("probe-secret-at-least-thirty-two-bytes")
	now := time.Unix(1_788_960_000, 0)
	handler, err := NewMediaProbeHandler(MediaProbeHandlerOptions{Secret: secret, NodeID: "relay-primary", NonceCapacity: 2, Now: func() time.Time { return now }})
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(handler)
	defer server.Close()
	call := func(nonce string) int {
		claim := mediaProbeClaim{Purpose: mediaProbePurpose, Method: "POST", Path: "/probe", NodeID: "relay-primary", SubjectHash: "sessionHash_1234567890", NetworkGeneration: "cell:2", Expires: now.Unix() + 30, Nonce: nonce}
		req, _ := http.NewRequest("POST", server.URL+"/probe", nil)
		req.Header.Set("Authorization", "Bearer "+signProbeClaim(t, secret, claim))
		res, e := http.DefaultClient.Do(req)
		if e != nil {
			t.Fatal(e)
		}
		res.Body.Close()
		return res.StatusCode
	}
	if got := call("unique-probe-nonce-number-01"); got != 200 {
		t.Fatal(got)
	}
	if got := call("unique-probe-nonce-number-02"); got != 200 {
		t.Fatal(got)
	}
	if got := call("unique-probe-nonce-number-03"); got != 429 {
		t.Fatalf("capacity=%d", got)
	}
	now = now.Add(31 * time.Second)
	if got := call(fmt.Sprintf("unique-probe-nonce-number-%02d", 4)); got != 200 {
		t.Fatalf("after expiry=%d", got)
	}
}

type panicReader struct{}

func (panicReader) Read([]byte) (int, error) {
	panic("handler must not read an unknown-length body")
}
func (panicReader) Close() error { return nil }

func TestMediaProbeRejectsCrossNodeExpiredMethodPathCORSAndStreamingBody(t *testing.T) {
	secret := []byte("probe-secret-at-least-thirty-two-bytes")
	otherSecret := []byte("other-probe-secret-at-least-32-bytes")
	now := time.Unix(1_788_960_000, 0)
	handler, err := NewMediaProbeHandler(MediaProbeHandlerOptions{Secret: secret, NodeID: "relay-secondary", AllowedOrigins: []string{"https://caller.example"}, Now: func() time.Time { return now }})
	if err != nil {
		t.Fatal(err)
	}
	claim := mediaProbeClaim{Purpose: mediaProbePurpose, Method: "POST", Path: "/probe", NodeID: "relay-secondary", SubjectHash: "sessionHash_1234567890", NetworkGeneration: "wifi:7", Expires: now.Unix() + 30, Nonce: "unique-probe-nonce-security-01"}
	serve := func(req *http.Request) int {
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)
		return rec.Code
	}
	request := func(method, path, origin, token string) *http.Request {
		req := httptest.NewRequest(method, path, nil)
		if origin != "" {
			req.Header.Set("Origin", origin)
		}
		if token != "" {
			req.Header.Set("Authorization", "Bearer "+token)
		}
		return req
	}
	if got := serve(request("POST", "/probe", "", signProbeClaim(t, otherSecret, claim))); got != 401 {
		t.Fatalf("cross-node signature=%d", got)
	}
	claim.Expires = now.Unix()
	claim.Nonce = "unique-probe-nonce-security-02"
	if got := serve(request("POST", "/probe", "", signProbeClaim(t, secret, claim))); got != 401 {
		t.Fatalf("expired=%d", got)
	}
	claim.Expires = now.Unix() + 30
	claim.Method = "GET"
	claim.Nonce = "unique-probe-nonce-security-03"
	if got := serve(request("POST", "/probe", "", signProbeClaim(t, secret, claim))); got != 401 {
		t.Fatalf("bound method=%d", got)
	}
	claim.Method = "POST"
	claim.Path = "/other"
	claim.Nonce = "unique-probe-nonce-security-04"
	if got := serve(request("POST", "/probe", "", signProbeClaim(t, secret, claim))); got != 401 {
		t.Fatalf("bound path=%d", got)
	}
	if got := serve(request("OPTIONS", "/probe?unexpected=1", "https://caller.example", "")); got != 404 {
		t.Fatalf("options path=%d", got)
	}
	allowed := request("OPTIONS", "/probe", "https://caller.example", "")
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, allowed)
	if recorder.Code != 204 || recorder.Header().Get("Access-Control-Allow-Origin") != "https://caller.example" {
		t.Fatalf("cors=%d %q", recorder.Code, recorder.Header().Get("Access-Control-Allow-Origin"))
	}
	streaming := request("POST", "/probe", "", "")
	streaming.ContentLength = -1
	streaming.TransferEncoding = []string{"chunked"}
	streaming.Body = panicReader{}
	if got := serve(streaming); got != 400 {
		t.Fatalf("streaming body=%d", got)
	}
	bare := httptest.NewRequest("POST", "/probe", nil)
	bare.Header.Set("Authorization", signProbeClaim(t, secret, claim))
	if got := serve(bare); got != 401 {
		t.Fatalf("bare token=%d", got)
	}
}
