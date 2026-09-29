package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"sync/atomic"
	"time"

	"github.com/pion/rtp"
	"github.com/pion/webrtc/v4/pkg/media/oggwriter"
)

type recordingArtifact struct {
	Name   string `json:"name"`
	Bytes  int64  `json:"bytes"`
	SHA256 string `json:"sha256"`
}
type recordingManifest struct {
	Version     int                 `json:"version"`
	CallID      string              `json:"callId"`
	NodeID      string              `json:"nodeId"`
	MediaEpoch  int64               `json:"mediaEpoch"`
	FinalizedAt time.Time           `json:"finalizedAt"`
	Complete    bool                `json:"complete"`
	Artifacts   []recordingArtifact `json:"artifacts"`
}

// Each timestamp is relative to its source track. Receive time aligns both tracks;
// packet metadata preserves loss gaps which a standalone Ogg player may conceal.
// Late (S70 reordered) packets appear here with late:true but never in the Ogg.
func recordTiming(w io.Writer, direction string, seq uint32, timestampUS uint64, durationMS uint16, elapsedUS int64, receivedAt time.Time, late bool) error {
	return json.NewEncoder(w).Encode(struct {
		Direction         string    `json:"direction"`
		Sequence          uint32    `json:"sequence"`
		SourceTimestampUS uint64    `json:"sourceTimestampUs"`
		DurationMS        uint16    `json:"durationMs"`
		ReceivedElapsedUS int64     `json:"receivedElapsedUs"`
		ReceivedAt        time.Time `json:"receivedAt"`
		Late              bool      `json:"late,omitempty"`
	}{direction, seq, timestampUS, durationMS, elapsedUS, receivedAt.UTC(), late})
}

// recordingQueueSize bounds a room's pending Ogg/timeline writes (S70); a full
// queue drops the entry and counts recordingDrops instead of stalling forwarding.
const recordingQueueSize = 512

// recordingJob is one timeline line plus, for an in-order packet, its Ogg page.
// Receive times are captured at enqueue so disk latency never skews them.
type recordingJob struct {
	ogg         *oggwriter.OggWriter // nil: timeline only (late packet)
	packet      *rtp.Packet
	direction   string
	sequence    uint32
	timestampUS uint64
	durationMS  uint16
	elapsedUS   int64
	receivedAt  time.Time
	late        bool
}

// roomRecorder owns a room's recording files. Only its goroutine touches them;
// the counters are atomic so S75 room_stats can read them live.
type roomRecorder struct {
	jobs                   chan recordingJob
	done                   chan struct{}
	down, up               *oggwriter.OggWriter
	timeline               io.WriteCloser
	failed                 bool
	downPackets, upPackets atomic.Uint64
}

func startRoomRecorder(down, up *oggwriter.OggWriter, timeline io.WriteCloser, capacity int) *roomRecorder {
	w := &roomRecorder{jobs: make(chan recordingJob, capacity), done: make(chan struct{}), down: down, up: up, timeline: timeline}
	go w.run()
	return w
}

// enqueue never blocks; the caller serializes enqueue and close (room lock).
func (w *roomRecorder) enqueue(job recordingJob) bool {
	select {
	case w.jobs <- job:
		return true
	default:
		return false
	}
}

// close drains every queued job, closes the files and returns once no further
// write can happen, so the manifest hashes see the final bytes.
func (w *roomRecorder) close() {
	close(w.jobs)
	<-w.done
}

func (w *roomRecorder) run() {
	defer close(w.done)
	for job := range w.jobs {
		w.write(job)
	}
	for _, c := range []io.Closer{w.down, w.up, w.timeline} {
		if c.Close() != nil {
			w.failed = true
		}
	}
}

// write records one job. A panic (e.g. inside oggwriter on a malformed payload)
// marks the recording failed instead of killing the process and every live call;
// the loop keeps draining so close() still returns.
func (w *roomRecorder) write(job recordingJob) {
	defer func() {
		if recover() != nil {
			w.failed = true
		}
	}()
	if job.ogg != nil {
		if job.ogg.WriteRTP(job.packet) != nil {
			w.failed = true
		} else if job.ogg == w.down {
			w.downPackets.Add(1)
		} else {
			w.upPackets.Add(1)
		}
	}
	if recordTiming(w.timeline, job.direction, job.sequence, job.timestampUS, job.durationMS, job.elapsedUS, job.receivedAt, job.late) != nil {
		w.failed = true
	}
}

func finalizeRecording(dir, id string, complete bool, routing ...any) error {
	nodeID := "relay-primary"
	mediaEpoch := int64(1)
	if len(routing) > 0 {
		if value, ok := routing[0].(string); ok && value != "" {
			nodeID = value
		}
	}
	if len(routing) > 1 {
		if value, ok := routing[1].(int64); ok && value > 0 {
			mediaEpoch = value
		}
	}
	m := recordingManifest{Version: 1, CallID: id, NodeID: nodeID, MediaEpoch: mediaEpoch, FinalizedAt: time.Now().UTC(), Complete: complete}
	for _, name := range []string{"remote_original.ogg", "caller_original.ogg", "timeline.jsonl"} {
		p := filepath.Join(dir, name)
		f, e := os.Open(p)
		if e != nil {
			return e
		}
		h := sha256.New()
		n, e := io.Copy(h, f)
		f.Close()
		if e != nil {
			return e
		}
		if e = os.Chmod(p, 0600); e != nil {
			return e
		}
		m.Artifacts = append(m.Artifacts, recordingArtifact{name, n, hex.EncodeToString(h.Sum(nil))})
	}
	b, e := json.MarshalIndent(m, "", "  ")
	if e != nil {
		return e
	}
	p := filepath.Join(dir, "manifest.json.tmp")
	if e = os.WriteFile(p, b, 0600); e != nil {
		return e
	}
	return os.Rename(p, filepath.Join(dir, "manifest.json"))
}
