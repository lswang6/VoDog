package main

import (
	"log"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/pion/rtp"
)

var logKeys = regexp.MustCompile(`(\w+)=`)

func keysOf(line string) []string {
	var keys []string
	for _, m := range logKeys.FindAllStringSubmatch(line, -1) {
		keys = append(keys, m[1])
	}
	return keys
}

func (w *roomClosedWriter) count(event string) (n int, last string) {
	w.mu.Lock()
	defer w.mu.Unlock()
	for _, line := range w.lines {
		if strings.Contains(line, event) {
			n, last = n+1, line
		}
	}
	return
}

// S75: a room with a leg logs cumulative room_stats with room_closed's counter
// set; an empty room and a closed room log nothing.
func TestS75RoomStatsMatchesRoomClosedAndStopsOnClose(t *testing.T) {
	b := &bridge{rooms: map[string]*room{}, recordDir: t.TempDir()}
	id := "75757575-7575-7575-7575-757575757501"
	w := &roomClosedWriter{manifest: filepath.Join(b.recordDir, id, "manifest.json")}
	log.SetOutput(w)
	defer log.SetOutput(os.Stderr)
	r, err := b.getRoom(id)
	if err != nil {
		t.Fatal(err)
	}
	b.logRoomStats()
	if n, _ := w.count("media.room_stats"); n != 0 {
		t.Fatal("room without a leg logged room_stats")
	}
	s73Room(t, b, id) // same room, adds a client leg
	r.mu.Lock()
	r.record(r.recorder.down, &rtp.Packet{Header: rtp.Header{Version: 2}, Payload: []byte{0xf8, 0xff, 0xfe}}, "remote_original", 1, 0, 20, false)
	r.mu.Unlock()
	deadline := time.Now().Add(3 * time.Second)
	for r.recorder.downPackets.Load() == 0 && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	b.logRoomStats()
	n, stats := w.count("media.room_stats")
	if n != 1 || !strings.Contains(stats, "call="+id+" elapsed_ms=") || !strings.Contains(stats, " down_pkts=1 ") {
		t.Fatalf("room_stats %d %q", n, stats)
	}
	b.closeRoom(id, "test")
	closed := w.roomClosed()
	want := []string{"call", "elapsed_ms"}
	for _, k := range keysOf(closed) {
		if k != "call" && k != "elapsed_ms" && k != "reason" && k != "peers" && k != "recording" {
			want = append(want, k)
		}
	}
	if got := keysOf(stats); strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("room_stats keys %v, room_closed counters %v", got, want)
	}
	b.logRoomStats()
	if n, _ := w.count("media.room_stats"); n != 1 {
		t.Fatal("closed room kept logging room_stats")
	}
	t.Log(strings.TrimSpace(stats))
}
