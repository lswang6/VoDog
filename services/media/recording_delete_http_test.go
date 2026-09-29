package main

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

// The same vector is pinned in infra/test_retention.py; the retention job signs its
// DELETE requests in Python and both sides must stay byte-identical.
func TestRecordingDeleteCanonicalStringMatchesTheRetentionJob(t *testing.T) {
	secret := "routed-recording-secret-at-least-32-bytes"
	request, _ := http.NewRequest("DELETE", "https://node.example/internal/recordings/11111111-1111-1111-1111-111111111111", nil)
	canonical := recordingCanonicalString(request, 1757740000, "MW5vbmNlLXZhbHVlLWZvci10ZXN0")
	if canonical != "DELETE\n/internal/recordings/11111111-1111-1111-1111-111111111111\n1757740000\nMW5vbmNlLXZhbHVlLWZvci10ZXN0\n" {
		t.Fatalf("canonical=%q", canonical)
	}
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(canonical))
	if got := base64.RawURLEncoding.EncodeToString(mac.Sum(nil)); got != "1p1pcwz0UlplGxRjHfzGBZRDbftOm4ECqRzmtrvE6ZU" {
		t.Fatalf("signature=%s", got)
	}
}

// S29 §2.4: retention deletes a finalized recording directory over the same signed
// internal API. An unsigned request, an open room, a missing manifest and a missing
// directory must all leave the bytes on disk.
func TestInternalRecordingDeleteRequiresSignatureFinalizedManifestAndClosedRoom(t *testing.T) {
	secret := "routed-recording-secret-at-least-32-bytes"
	id := "22222222-2222-2222-2222-222222222222"
	root := t.TempDir()
	dir := filepath.Join(root, id)
	writeFinalizedRecording(t, dir, id)
	bridge := &bridge{secret: secret, recordDir: root, nodeID: "relay-secondary"}
	server := httptest.NewServer(bridge.recordingHandler())
	defer server.Close()
	path := "/internal/recordings/" + id

	unsignedRequest, _ := http.NewRequest("DELETE", server.URL+path, nil)
	unauthorized, err := http.DefaultClient.Do(unsignedRequest)
	if err != nil || unauthorized.StatusCode != 401 {
		t.Fatalf("unsigned delete %v %d", err, unauthorized.StatusCode)
	}
	unauthorized.Body.Close()

	tampered := signedRecordingMethodRequest(t, "DELETE", server.URL, path, "", "a-different-secret-of-sufficient-length")
	forged, err := http.DefaultClient.Do(tampered)
	if err != nil || forged.StatusCode != 401 {
		t.Fatalf("forged delete %v %d", err, forged.StatusCode)
	}
	forged.Body.Close()

	// A GET signature must not authorize a DELETE: the method is part of the canonical string.
	crossMethod := signedRecordingMethodRequest(t, "GET", server.URL, path, "", secret)
	crossMethod.Method = "DELETE"
	replayed, err := http.DefaultClient.Do(crossMethod)
	if err != nil || replayed.StatusCode != 401 {
		t.Fatalf("cross-method delete %v %d", err, replayed.StatusCode)
	}
	replayed.Body.Close()

	bridge.mu.Lock()
	bridge.rooms = map[string]*room{id: {}}
	bridge.mu.Unlock()
	busy, err := http.DefaultClient.Do(signedRecordingMethodRequest(t, "DELETE", server.URL, path, "", secret))
	if err != nil || busy.StatusCode != 409 {
		t.Fatalf("open room delete %v %d", err, busy.StatusCode)
	}
	busy.Body.Close()
	bridge.mu.Lock()
	delete(bridge.rooms, id)
	bridge.mu.Unlock()

	if _, err := os.Stat(filepath.Join(dir, "manifest.json")); err != nil {
		t.Fatalf("recording removed by a refused delete: %v", err)
	}

	unfinalizedID := "33333333-3333-3333-3333-333333333333"
	unfinalized := filepath.Join(root, unfinalizedID)
	if os.Mkdir(unfinalized, 0700) != nil {
		t.Fatal("mkdir")
	}
	if os.WriteFile(filepath.Join(unfinalized, "remote_original.ogg"), []byte("in-flight"), 0600) != nil {
		t.Fatal("write")
	}
	conflict, err := http.DefaultClient.Do(signedRecordingMethodRequest(t, "DELETE", server.URL, "/internal/recordings/"+unfinalizedID, "", secret))
	if err != nil || conflict.StatusCode != 409 {
		t.Fatalf("unfinalized delete %v %d", err, conflict.StatusCode)
	}
	conflict.Body.Close()
	if _, err := os.Stat(unfinalized); err != nil {
		t.Fatalf("unfinalized recording removed: %v", err)
	}

	missingPath := "/internal/recordings/44444444-4444-4444-4444-444444444444"
	missing, err := http.DefaultClient.Do(signedRecordingMethodRequest(t, "DELETE", server.URL, missingPath, "", secret))
	if err != nil || missing.StatusCode != 404 {
		t.Fatalf("missing delete %v %d", err, missing.StatusCode)
	}
	missing.Body.Close()

	malformed, err := http.DefaultClient.Do(signedRecordingMethodRequest(t, "DELETE", server.URL, "/internal/recordings/not-a-uuid", "", secret))
	if err != nil || malformed.StatusCode != 404 {
		t.Fatalf("malformed delete %v %d", err, malformed.StatusCode)
	}
	malformed.Body.Close()

	subPath := path + "/manifest"
	sub, err := http.DefaultClient.Do(signedRecordingMethodRequest(t, "DELETE", server.URL, subPath, "", secret))
	if err != nil || sub.StatusCode != 404 {
		t.Fatalf("sub-resource delete %v %d", err, sub.StatusCode)
	}
	sub.Body.Close()

	deleted, err := http.DefaultClient.Do(signedRecordingMethodRequest(t, "DELETE", server.URL, path, "", secret))
	if err != nil || deleted.StatusCode != 204 {
		t.Fatalf("delete %v %d", err, deleted.StatusCode)
	}
	deleted.Body.Close()
	if _, err := os.Stat(dir); !os.IsNotExist(err) {
		t.Fatalf("recording directory survived delete: %v", err)
	}

	repeat, err := http.DefaultClient.Do(signedRecordingMethodRequest(t, "DELETE", server.URL, path, "", secret))
	if err != nil || repeat.StatusCode != 404 {
		t.Fatalf("repeat delete %v %d", err, repeat.StatusCode)
	}
	repeat.Body.Close()
}

func writeFinalizedRecording(t *testing.T, dir, id string) {
	t.Helper()
	if os.Mkdir(dir, 0700) != nil {
		t.Fatal("mkdir")
	}
	for _, item := range []struct{ name, body string }{
		{"remote_original.ogg", "remote-audio-bytes"},
		{"caller_original.ogg", "caller-audio-bytes"},
		{"timeline.jsonl", "{}\n"},
	} {
		if os.WriteFile(filepath.Join(dir, item.name), []byte(item.body), 0600) != nil {
			t.Fatal("write")
		}
	}
	if err := finalizeRecording(dir, id, true, "relay-secondary", int64(1)); err != nil {
		t.Fatal(err)
	}
}
