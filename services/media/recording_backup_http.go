package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"regexp"
	"strconv"
	"time"

	"golang.org/x/sys/unix"
)

var recordingBackupSHA = regexp.MustCompile(`^[0-9a-f]{64}$`)

const recordingBackupMaxArtifactBytes = 512 * 1024 * 1024

func (s *bridge) recordingBackupTimelineHandler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		controller := http.NewResponseController(w)
		_ = controller.SetWriteDeadline(time.Now().Add(2 * time.Minute))
		if r.Method != http.MethodGet || r.URL.RawQuery != "" || !s.authorizeRecordingRequest(r) {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		callID := r.PathValue("callId")
		epoch, epochErr := strconv.ParseInt(r.PathValue("mediaEpoch"), 10, 64)
		expectedManifestSHA := r.PathValue("manifestSHA")
		if !safeID.MatchString(callID) || epochErr != nil || epoch < 1 || !recordingBackupSHA.MatchString(expectedManifestSHA) {
			http.NotFound(w, r)
			return
		}

		manifest, rawManifest, timeline, artifact, err := s.openPinnedTimeline(callID, epoch, expectedManifestSHA)
		if err != nil {
			reason := "open_failed"
			if errors.Is(err, os.ErrInvalid) {
				reason = "manifest_invalid"
			} else if errors.Is(err, unix.ELOOP) || errors.Is(err, unix.ENOTDIR) {
				reason = "symlink"
			}
			recordingUnavailable(w, callID, "timeline", reason)
			return
		}
		defer timeline.Close()
		if !manifest.Complete || artifact == nil {
			recordingUnavailable(w, callID, "timeline", "incomplete")
			return
		}
		stat, err := timeline.Stat()
		if err != nil || !stat.Mode().IsRegular() || stat.Size() != artifact.Bytes {
			recordingUnavailable(w, callID, "timeline", "size_mismatch")
			return
		}
		hash := sha256.New()
		copied, copyErr := io.CopyN(hash, contextReader{ctx: r.Context(), reader: timeline}, artifact.Bytes)
		extra := make([]byte, 1)
		extraBytes, extraErr := timeline.Read(extra)
		if copyErr != nil || copied != artifact.Bytes || extraBytes != 0 || !errors.Is(extraErr, io.EOF) || hex.EncodeToString(hash.Sum(nil)) != artifact.SHA256 {
			recordingUnavailable(w, callID, "timeline", "sha256_mismatch")
			return
		}
		if _, err = timeline.Seek(0, io.SeekStart); err != nil {
			recordingUnavailable(w, callID, "timeline", "seek_failed")
			return
		}
		// Re-open the manifest through the pinned directory before sending bytes.
		_, finalRaw, found, corrupt := s.readRecordingManifest(callID)
		if corrupt || !found || !bytes.Equal(rawManifest, finalRaw) {
			recordingUnavailable(w, callID, "timeline", "manifest_changed")
			return
		}
		w.Header().Set("Cache-Control", "private, no-store")
		w.Header().Set("Content-Type", "application/x-ndjson")
		w.Header().Set("ETag", `"`+artifact.SHA256+`"`)
		http.ServeContent(&recordingIdleWriter{ResponseWriter: w, controller: controller, idle: 30 * time.Second}, r, "timeline.jsonl", stat.ModTime(), timeline)
	})
}

func (s *bridge) openPinnedTimeline(callID string, epoch int64, expectedManifestSHA string) (recordingManifest, []byte, *os.File, *recordingArtifact, error) {
	var empty recordingManifest
	rootFD, err := unix.Open(s.recordDir, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
	if err != nil {
		return empty, nil, nil, nil, err
	}
	defer unix.Close(rootFD)
	dirFD, err := unix.Openat(rootFD, callID, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
	if err != nil {
		return empty, nil, nil, nil, err
	}
	defer unix.Close(dirFD)
	manifestFD, err := unix.Openat(dirFD, "manifest.json", unix.O_RDONLY|unix.O_NONBLOCK|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
	if err != nil {
		return empty, nil, nil, nil, err
	}
	manifestFile := os.NewFile(uintptr(manifestFD), "manifest.json")
	defer manifestFile.Close()
	stat, err := manifestFile.Stat()
	if err != nil || !stat.Mode().IsRegular() || stat.Size() > 65536 {
		return empty, nil, nil, nil, os.ErrInvalid
	}
	raw, err := io.ReadAll(io.LimitReader(manifestFile, 65537))
	var manifest recordingManifest
	if err != nil || len(raw) > 65536 || rejectDuplicateJSONKeys(raw) != nil || json.Unmarshal(raw, &manifest) != nil || manifest.Version != 1 || manifest.CallID != callID ||
		manifest.NodeID != s.nodeID || manifest.MediaEpoch != epoch || !manifest.Complete || len(manifest.Artifacts) != 3 {
		return empty, nil, nil, nil, os.ErrInvalid
	}
	digest := sha256.Sum256(raw)
	if hex.EncodeToString(digest[:]) != expectedManifestSHA {
		return empty, nil, nil, nil, os.ErrInvalid
	}
	seen := map[string]bool{}
	var timelineArtifact *recordingArtifact
	for index := range manifest.Artifacts {
		artifact := &manifest.Artifacts[index]
		if seen[artifact.Name] || (artifact.Name != "remote_original.ogg" && artifact.Name != "caller_original.ogg" && artifact.Name != "timeline.jsonl") ||
			artifact.Bytes < 0 || artifact.Bytes > recordingBackupMaxArtifactBytes || !recordingBackupSHA.MatchString(artifact.SHA256) {
			return empty, nil, nil, nil, os.ErrInvalid
		}
		seen[artifact.Name] = true
		if artifact.Name == "timeline.jsonl" {
			timelineArtifact = artifact
		}
	}
	if timelineArtifact == nil {
		return empty, nil, nil, nil, os.ErrInvalid
	}
	timelineFD, err := unix.Openat(dirFD, "timeline.jsonl", unix.O_RDONLY|unix.O_NONBLOCK|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
	if err != nil {
		return empty, nil, nil, nil, err
	}
	return manifest, raw, os.NewFile(uintptr(timelineFD), "timeline.jsonl"), timelineArtifact, nil
}

func rejectDuplicateJSONKeys(raw []byte) error {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	var value func() error
	value = func() error {
		token, err := decoder.Token()
		if err != nil {
			return err
		}
		delimiter, ok := token.(json.Delim)
		if !ok {
			return nil
		}
		switch delimiter {
		case '{':
			seen := map[string]struct{}{}
			for decoder.More() {
				keyToken, keyErr := decoder.Token()
				key, keyOK := keyToken.(string)
				if keyErr != nil || !keyOK {
					return errors.New("invalid object key")
				}
				if _, exists := seen[key]; exists {
					return errors.New("duplicate object key")
				}
				seen[key] = struct{}{}
				if err = value(); err != nil {
					return err
				}
			}
		case '[':
			for decoder.More() {
				if err = value(); err != nil {
					return err
				}
			}
		default:
			return errors.New("invalid JSON delimiter")
		}
		_, err = decoder.Token()
		return err
	}
	if err := value(); err != nil {
		return err
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return errors.New("trailing JSON")
	}
	return nil
}
