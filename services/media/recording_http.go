package main

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)

type recordingRequestAuth struct {
	mu   sync.Mutex
	used map[string]int64
}

func (s *bridge) recordingHandler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		controller := http.NewResponseController(w)
		// Hashing is bounded separately from streaming. Once bytes start flowing,
		// each successful write renews a short idle deadline instead of inheriting
		// the server-wide 20 second total-response deadline.
		_ = controller.SetWriteDeadline(time.Now().Add(2 * time.Minute))
		if (r.Method != "GET" && r.Method != "DELETE") || !s.authorizeRecordingRequest(r) {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		parts := strings.Split(strings.TrimPrefix(r.URL.Path, "/internal/recordings/"), "/")
		// S29 §2.4: retention deletes one finalized recording directory. The signed
		// canonical string already carries the method, so the same authorization applies.
		if r.Method == "DELETE" {
			s.deleteRecording(w, r, parts)
			return
		}
		if len(parts) < 2 || !safeID.MatchString(parts[0]) {
			http.NotFound(w, r)
			return
		}
		id := parts[0]
		manifest, raw, found, corrupt := s.readRecordingManifest(id)
		if corrupt {
			recordingUnavailable(w, id, "-", "manifest_corrupt")
			return
		}
		if !found {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Cache-Control", "private, no-store")
		if len(parts) == 2 && parts[1] == "manifest" {
			w.Header().Set("Content-Type", "application/json")
			w.Header().Set("Content-Length", strconv.Itoa(len(raw)))
			_, _ = w.Write(raw)
			return
		}
		if len(parts) != 3 || parts[1] != "tracks" || (parts[2] != "remote_original" && parts[2] != "caller_original") {
			http.NotFound(w, r)
			return
		}
		name := parts[2] + ".ogg"
		var artifact *recordingArtifact
		for i := range manifest.Artifacts {
			if manifest.Artifacts[i].Name == name {
				artifact = &manifest.Artifacts[i]
				break
			}
		}
		if artifact == nil || artifact.Bytes <= 0 {
			http.NotFound(w, r)
			return
		}
		dir := filepath.Join(s.recordDir, id)
		dirStat, err := os.Lstat(dir)
		if err != nil || !dirStat.IsDir() || dirStat.Mode()&os.ModeSymlink != 0 {
			recordingUnavailable(w, id, parts[2], "dir_not_regular")
			return
		}
		trackPath := filepath.Join(dir, name)
		trackStat, err := os.Lstat(trackPath)
		if err != nil || !trackStat.Mode().IsRegular() || trackStat.Mode()&os.ModeSymlink != 0 {
			recordingUnavailable(w, id, parts[2], "track_not_regular")
			return
		}
		file, err := os.Open(trackPath)
		if err != nil {
			// Stays 404 (unchanged HTTP contract); only the log line is new.
			log.Printf("media.recording_unavailable call=%s track=%s reason=open_failed", id, parts[2])
			http.NotFound(w, r)
			return
		}
		defer file.Close()
		stat, err := file.Stat()
		if err != nil || !stat.Mode().IsRegular() || stat.Size() != artifact.Bytes {
			recordingUnavailable(w, id, parts[2], "size_mismatch")
			return
		}
		hash := sha256.New()
		if _, err = io.Copy(hash, contextReader{ctx: r.Context(), reader: file}); err != nil {
			return
		}
		if hex.EncodeToString(hash.Sum(nil)) != artifact.SHA256 {
			recordingUnavailable(w, id, parts[2], "sha256_mismatch")
			return
		}
		if _, err = file.Seek(0, io.SeekStart); err != nil {
			recordingUnavailable(w, id, parts[2], "seek_failed")
			return
		}
		w.Header().Set("Content-Type", "audio/ogg")
		w.Header().Set("ETag", `"`+artifact.SHA256+`"`)
		http.ServeContent(&recordingIdleWriter{ResponseWriter: w, controller: controller, idle: 30 * time.Second}, r, name, stat.ModTime(), file)
	})
}

// deleteRecording removes one finalized recording directory for Control's retention job.
// It refuses while the call still owns a room and refuses a directory without a manifest,
// so an in-progress capture can never be reclaimed out from under the writer.
func (s *bridge) deleteRecording(w http.ResponseWriter, r *http.Request, parts []string) {
	if len(parts) != 1 || !safeID.MatchString(parts[0]) || s.recordDir == "" {
		http.NotFound(w, r)
		return
	}
	id := parts[0]
	s.mu.Lock()
	_, open := s.rooms[id]
	s.mu.Unlock()
	if open {
		http.Error(w, "call is active", http.StatusConflict)
		return
	}
	dir := filepath.Join(s.recordDir, id)
	info, err := os.Lstat(dir)
	if err != nil || !info.IsDir() {
		http.NotFound(w, r)
		return
	}
	// A missing manifest means the capture never finalized; deletion is the writer's job, not ours.
	manifest, err := os.Lstat(filepath.Join(dir, "manifest.json"))
	if err != nil || !manifest.Mode().IsRegular() {
		http.Error(w, "recording is not finalized", http.StatusConflict)
		return
	}
	if err := os.RemoveAll(dir); err != nil {
		recordingUnavailable(w, id, "-", "delete_failed")
		return
	}
	w.Header().Set("Cache-Control", "private, no-store")
	w.WriteHeader(http.StatusNoContent)
}

// recordingUnavailable answers the unchanged 503 and logs why (S69).
func recordingUnavailable(w http.ResponseWriter, id, track, reason string) {
	log.Printf("media.recording_unavailable call=%s track=%s reason=%s", id, track, reason)
	http.Error(w, "recording unavailable", http.StatusServiceUnavailable)
}

type recordingIdleWriter struct {
	http.ResponseWriter
	controller *http.ResponseController
	idle       time.Duration
}

func (w *recordingIdleWriter) Write(p []byte) (int, error) {
	_ = w.controller.SetWriteDeadline(time.Now().Add(w.idle))
	return w.ResponseWriter.Write(p)
}

func (s *bridge) readRecordingManifest(id string) (recordingManifest, []byte, bool, bool) {
	var manifest recordingManifest
	path := filepath.Join(s.recordDir, id, "manifest.json")
	stat, err := os.Lstat(path)
	if os.IsNotExist(err) {
		return manifest, nil, false, false
	}
	if err != nil || !stat.Mode().IsRegular() || stat.Mode()&os.ModeSymlink != 0 || stat.Size() > 65536 {
		return manifest, nil, false, true
	}
	raw, err := os.ReadFile(path)
	if err != nil || json.Unmarshal(raw, &manifest) != nil || manifest.Version != 1 || manifest.CallID != id || manifest.NodeID != s.nodeID || manifest.MediaEpoch < 1 || len(manifest.Artifacts) != 3 {
		return manifest, nil, false, true
	}
	seen := map[string]bool{}
	for _, artifact := range manifest.Artifacts {
		if seen[artifact.Name] || (artifact.Name != "remote_original.ogg" && artifact.Name != "caller_original.ogg" && artifact.Name != "timeline.jsonl") || artifact.Bytes < 0 || len(artifact.SHA256) != 64 {
			return manifest, nil, false, true
		}
		seen[artifact.Name] = true
	}
	return manifest, raw, true, false
}

// recordingCanonicalString is the signed contract shared with Control's RemoteRecordingStore
// and infra/retention.py. The method is part of it, so a GET signature cannot authorize a DELETE.
func recordingCanonicalString(r *http.Request, timestamp int64, nonce string) string {
	return fmt.Sprintf("%s\n%s\n%d\n%s\n%s", r.Method, r.URL.EscapedPath(), timestamp, nonce, r.Header.Get("Range"))
}

func (s *bridge) authorizeRecordingRequest(r *http.Request) bool {
	timestamp, err := strconv.ParseInt(r.Header.Get("X-CC-Timestamp"), 10, 64)
	if err != nil || timestamp < time.Now().Unix()-30 || timestamp > time.Now().Unix()+30 {
		return false
	}
	nonce := r.Header.Get("X-CC-Nonce")
	if len(nonce) < 20 || len(nonce) > 100 {
		return false
	}
	signature, err := base64.RawURLEncoding.DecodeString(r.Header.Get("X-CC-Signature"))
	if err != nil {
		return false
	}
	canonical := recordingCanonicalString(r, timestamp, nonce)
	mac := hmac.New(sha256.New, []byte(s.secret))
	_, _ = mac.Write([]byte(canonical))
	if !hmac.Equal(signature, mac.Sum(nil)) {
		return false
	}
	s.recordingAuth.mu.Lock()
	defer s.recordingAuth.mu.Unlock()
	if s.recordingAuth.used == nil {
		s.recordingAuth.used = map[string]int64{}
	}
	now := time.Now().Unix()
	for key, expiry := range s.recordingAuth.used {
		if expiry < now {
			delete(s.recordingAuth.used, key)
		}
	}
	if _, exists := s.recordingAuth.used[nonce]; exists || len(s.recordingAuth.used) > 10000 {
		return false
	}
	s.recordingAuth.used[nonce] = timestamp + 31
	return true
}

type contextReader struct {
	ctx    context.Context
	reader io.Reader
}

func (r contextReader) Read(p []byte) (int, error) {
	select {
	case <-r.ctx.Done():
		return 0, r.ctx.Err()
	default:
		return r.reader.Read(p)
	}
}
