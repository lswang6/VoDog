package main

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func signedRecordingRequest(t *testing.T, base, path, byteRange, secret string) *http.Request {
	t.Helper()
	return signedRecordingMethodRequest(t, "GET", base, path, byteRange, secret)
}

func signedRecordingMethodRequest(t *testing.T, method, base, path, byteRange, secret string) *http.Request {
	t.Helper()
	timestamp := time.Now().Unix()
	nonce := fmt.Sprintf("recording-test-nonce-%d", time.Now().UnixNano())
	canonical := fmt.Sprintf("%s\n%s\n%d\n%s\n%s", method, path, timestamp, nonce, byteRange)
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(canonical))
	req, _ := http.NewRequest(method, base+path, nil)
	req.Header.Set("X-CC-Timestamp", fmt.Sprint(timestamp))
	req.Header.Set("X-CC-Nonce", nonce)
	req.Header.Set("X-CC-Signature", base64.RawURLEncoding.EncodeToString(mac.Sum(nil)))
	if byteRange != "" {
		req.Header.Set("Range", byteRange)
	}
	return req
}

func TestInternalRecordingReadIsAuthenticatedRangedAndIntegrityChecked(t *testing.T) {
	secret := "routed-recording-secret-at-least-32-bytes"
	id := "11111111-1111-1111-1111-111111111111"
	root := t.TempDir()
	dir := filepath.Join(root, id)
	if os.Mkdir(dir, 0700) != nil {
		t.Fatal("mkdir")
	}
	for _, item := range []struct{ name, body string }{{"remote_original.ogg", "remote-audio-bytes"}, {"caller_original.ogg", "caller-audio-bytes"}, {"timeline.jsonl", "{}\n"}} {
		if os.WriteFile(filepath.Join(dir, item.name), []byte(item.body), 0600) != nil {
			t.Fatal("write")
		}
	}
	if err := finalizeRecording(dir, id, true, "relay-secondary", int64(1)); err != nil {
		t.Fatal(err)
	}
	bridge := &bridge{secret: secret, recordDir: root, nodeID: "relay-secondary"}
	server := httptest.NewServer(bridge.recordingHandler())
	defer server.Close()
	unauthorized, _ := http.Get(server.URL + "/internal/recordings/" + id + "/manifest")
	if unauthorized.StatusCode != 401 {
		t.Fatalf("unauthorized=%d", unauthorized.StatusCode)
	}
	unauthorized.Body.Close()
	manifestPath := "/internal/recordings/" + id + "/manifest"
	response, err := http.DefaultClient.Do(signedRecordingRequest(t, server.URL, manifestPath, "", secret))
	if err != nil || response.StatusCode != 200 {
		t.Fatalf("manifest %v %d", err, response.StatusCode)
	}
	manifestBytes, _ := io.ReadAll(response.Body)
	response.Body.Close()
	if !containsAll(string(manifestBytes), `"nodeId": "relay-secondary"`, `"mediaEpoch": 1`) {
		t.Fatal("routing metadata missing")
	}
	trackPath := "/internal/recordings/" + id + "/tracks/remote_original"
	response, err = http.DefaultClient.Do(signedRecordingRequest(t, server.URL, trackPath, "bytes=2-7", secret))
	if err != nil || response.StatusCode != 206 {
		t.Fatalf("range %v %d", err, response.StatusCode)
	}
	body, _ := io.ReadAll(response.Body)
	response.Body.Close()
	if string(body) != "mote-a" {
		t.Fatalf("range=%q", body)
	}
	if os.WriteFile(filepath.Join(dir, "remote_original.ogg"), []byte("tampered-audio-data"), 0600) != nil {
		t.Fatal("tamper")
	}
	response, err = http.DefaultClient.Do(signedRecordingRequest(t, server.URL, trackPath, "", secret))
	if err != nil || response.StatusCode != 503 {
		t.Fatalf("corrupt %v %d", err, response.StatusCode)
	}
	response.Body.Close()
}

func containsAll(value string, items ...string) bool {
	for _, item := range items {
		if !strings.Contains(value, item) {
			return false
		}
	}
	return true
}
