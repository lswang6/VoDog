package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"testing"
	"time"

	"golang.org/x/sys/unix"
)

func TestPinnedFinalizedTimelineRequiresExactManifestAndStreamsZeroBytes(t *testing.T) {
	root := t.TempDir()
	callID := "44444444-4444-4444-8444-444444444444"
	dir := filepath.Join(root, callID)
	if err := os.Mkdir(dir, 0700); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"remote_original.ogg", "caller_original.ogg", "timeline.jsonl"} {
		if err := os.WriteFile(filepath.Join(dir, name), []byte("content-"+name), 0600); err != nil {
			t.Fatal(err)
		}
	}
	if err := finalizeRecording(dir, callID, true, "relay-secondary", int64(7)); err != nil {
		t.Fatal(err)
	}
	secret := "recording-backup-secret-at-least-32-bytes"
	bridge := &bridge{secret: secret, recordDir: root, nodeID: "relay-secondary"}
	mux := http.NewServeMux()
	mux.Handle("GET /internal/recordings/{callId}/finalized/{mediaEpoch}/{manifestSHA}/timeline", bridge.recordingBackupTimelineHandler())
	server := httptest.NewServer(mux)
	defer server.Close()

	request := func(epoch int64, manifestSHA string) *http.Response {
		path := "/internal/recordings/" + callID + "/finalized/" + strconv.FormatInt(epoch, 10) + "/" + manifestSHA + "/timeline"
		response, err := http.DefaultClient.Do(signedRecordingRequest(t, server.URL, path, "", secret))
		if err != nil {
			t.Fatal(err)
		}
		return response
	}
	raw, _ := os.ReadFile(filepath.Join(dir, "manifest.json"))
	digest := sha256.Sum256(raw)
	manifestSHA := hex.EncodeToString(digest[:])
	wrongSHA := manifestSHA
	if wrongSHA[0] == '0' {
		wrongSHA = "1" + wrongSHA[1:]
	} else {
		wrongSHA = "0" + wrongSHA[1:]
	}
	response := request(7, manifestSHA)
	if response.StatusCode != 200 {
		t.Fatalf("valid status=%d", response.StatusCode)
	}
	body, _ := io.ReadAll(response.Body)
	response.Body.Close()
	if string(body) != "content-timeline.jsonl" {
		t.Fatalf("body=%q", body)
	}
	for _, invalid := range []struct {
		epoch int64
		sha   string
	}{{8, manifestSHA}, {7, "A" + manifestSHA[1:]}, {7, wrongSHA}} {
		response = request(invalid.epoch, invalid.sha)
		if response.StatusCode == 200 {
			t.Fatal("invalid pin was accepted")
		}
		response.Body.Close()
	}
	queryPath := "/internal/recordings/" + callID + "/finalized/7/" + manifestSHA + "/timeline?ignored=1"
	queryResponse, err := http.DefaultClient.Do(signedRecordingRequest(t, server.URL, queryPath, "", secret))
	if err != nil || queryResponse.StatusCode == 200 {
		t.Fatalf("unsigned query accepted: status=%d err=%v", queryResponse.StatusCode, err)
	}
	queryResponse.Body.Close()

	var manifest recordingManifest
	if json.Unmarshal(raw, &manifest) != nil {
		t.Fatal("manifest parse")
	}
	empty := sha256.Sum256(nil)
	for index := range manifest.Artifacts {
		if manifest.Artifacts[index].Name == "timeline.jsonl" {
			manifest.Artifacts[index].Bytes = 0
			manifest.Artifacts[index].SHA256 = hex.EncodeToString(empty[:])
		}
	}
	updated, _ := json.MarshalIndent(manifest, "", "  ")
	if err := os.WriteFile(filepath.Join(dir, "timeline.jsonl"), nil, 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "manifest.json"), updated, 0600); err != nil {
		t.Fatal(err)
	}
	updatedDigest := sha256.Sum256(updated)
	response = request(7, hex.EncodeToString(updatedDigest[:]))
	zeroBody, _ := io.ReadAll(response.Body)
	response.Body.Close()
	if response.StatusCode != 200 || len(zeroBody) != 0 {
		t.Fatalf("zero timeline status=%d", response.StatusCode)
	}
}

func TestPinnedFinalizedTimelineRejectsDuplicateManifestKeys(t *testing.T) {
	root := t.TempDir()
	callID := "77777777-7777-4777-8777-777777777777"
	dir := filepath.Join(root, callID)
	if err := os.Mkdir(dir, 0700); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"remote_original.ogg", "caller_original.ogg", "timeline.jsonl"} {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(name), 0600); err != nil {
			t.Fatal(err)
		}
	}
	if err := finalizeRecording(dir, callID, true, "relay-secondary", int64(4)); err != nil {
		t.Fatal(err)
	}
	raw, _ := os.ReadFile(filepath.Join(dir, "manifest.json"))
	raw = append(raw[:len(raw)-1], []byte(",\n  \"complete\": true\n}")...)
	if err := os.WriteFile(filepath.Join(dir, "manifest.json"), raw, 0600); err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256(raw)
	bridge := &bridge{secret: "recording-backup-secret-at-least-32-bytes", recordDir: root, nodeID: "relay-secondary"}
	if _, _, timeline, _, err := bridge.openPinnedTimeline(callID, 4, hex.EncodeToString(digest[:])); err == nil {
		if timeline != nil {
			timeline.Close()
		}
		t.Fatal("duplicate manifest key accepted")
	}
}

func TestPinnedFinalizedTimelineRejectsFIFOWithoutBlocking(t *testing.T) {
	root := t.TempDir()
	callID := "66666666-6666-4666-8666-666666666666"
	dir := filepath.Join(root, callID)
	if err := os.Mkdir(dir, 0700); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"remote_original.ogg", "caller_original.ogg", "timeline.jsonl"} {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(name), 0600); err != nil {
			t.Fatal(err)
		}
	}
	if err := finalizeRecording(dir, callID, true, "relay-secondary", int64(3)); err != nil {
		t.Fatal(err)
	}
	raw, _ := os.ReadFile(filepath.Join(dir, "manifest.json"))
	digest := sha256.Sum256(raw)
	if err := os.Remove(filepath.Join(dir, "timeline.jsonl")); err != nil {
		t.Fatal(err)
	}
	if err := unix.Mkfifo(filepath.Join(dir, "timeline.jsonl"), 0600); err != nil {
		t.Fatal(err)
	}
	secret := "recording-backup-secret-at-least-32-bytes"
	bridge := &bridge{secret: secret, recordDir: root, nodeID: "relay-secondary"}
	mux := http.NewServeMux()
	mux.Handle("GET /internal/recordings/{callId}/finalized/{mediaEpoch}/{manifestSHA}/timeline", bridge.recordingBackupTimelineHandler())
	path := "/internal/recordings/" + callID + "/finalized/3/" + hex.EncodeToString(digest[:]) + "/timeline"
	req := signedRecordingRequest(t, "http://example.test", path, "", secret)
	response := httptest.NewRecorder()
	done := make(chan struct{})
	go func() { mux.ServeHTTP(response, req); close(done) }()
	select {
	case <-done:
		if response.Code == 200 {
			t.Fatal("FIFO was served")
		}
	case <-time.After(time.Second):
		t.Fatal("FIFO open blocked")
	}
}

func TestPinnedFinalizedTimelineRejectsIncompleteCorruptAndSymlink(t *testing.T) {
	for _, test := range []string{"incomplete", "corrupt", "symlink"} {
		t.Run(test, func(t *testing.T) {
			root := t.TempDir()
			callID := "55555555-5555-4555-8555-555555555555"
			dir := filepath.Join(root, callID)
			if err := os.Mkdir(dir, 0700); err != nil {
				t.Fatal(err)
			}
			for _, name := range []string{"remote_original.ogg", "caller_original.ogg", "timeline.jsonl"} {
				if err := os.WriteFile(filepath.Join(dir, name), []byte(name), 0600); err != nil {
					t.Fatal(err)
				}
			}
			if err := finalizeRecording(dir, callID, test != "incomplete", "relay-secondary", int64(2)); err != nil {
				t.Fatal(err)
			}
			raw, _ := os.ReadFile(filepath.Join(dir, "manifest.json"))
			digest := sha256.Sum256(raw)
			if test == "corrupt" {
				if err := os.WriteFile(filepath.Join(dir, "timeline.jsonl"), []byte("changed"), 0600); err != nil {
					t.Fatal(err)
				}
			}
			if test == "symlink" {
				if err := os.Remove(filepath.Join(dir, "timeline.jsonl")); err != nil {
					t.Fatal(err)
				}
				if err := os.Symlink(filepath.Join(root, "outside"), filepath.Join(dir, "timeline.jsonl")); err != nil {
					t.Fatal(err)
				}
			}
			secret := "recording-backup-secret-at-least-32-bytes"
			bridge := &bridge{secret: secret, recordDir: root, nodeID: "relay-secondary"}
			mux := http.NewServeMux()
			mux.Handle("GET /internal/recordings/{callId}/finalized/{mediaEpoch}/{manifestSHA}/timeline", bridge.recordingBackupTimelineHandler())
			path := "/internal/recordings/" + callID + "/finalized/2/" + hex.EncodeToString(digest[:]) + "/timeline"
			req := signedRecordingRequest(t, "http://example.test", path, "", secret)
			response := httptest.NewRecorder()
			mux.ServeHTTP(response, req)
			if response.Code == 200 {
				t.Fatal("unsafe timeline was served")
			}
		})
	}
}
