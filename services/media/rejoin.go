package main

import (
	"errors"
	"log"
	"strconv"
	"time"

	"github.com/pion/webrtc/v4"
)

// S73 D2: a failed leg no longer closes the room. The role gets a rejoin window;
// a new leg of that role reaching Connected inside it cancels the timer, otherwise
// the room closes with rejoin_timeout. 0 keeps the pre-S73 immediate pc_failed close.
const defaultRejoinWindow = 60 * time.Second

func configuredRejoinWindow(raw string) (time.Duration, error) {
	if raw == "" {
		return defaultRejoinWindow, nil
	}
	value, err := strconv.Atoi(raw)
	if err != nil || value < 0 || value > 600 {
		return 0, errors.New("CC_MEDIA_REJOIN_WINDOW_S must be unset or an integer 0-600")
	}
	return time.Duration(value) * time.Second, nil
}

// rejoinState is one role's pending window; gen invalidates timers that were
// stopped too late to be cancelled (time.Timer.Stop does not wait for a fired func).
type rejoinState struct {
	timer   *time.Timer
	gen     uint64
	since   time.Time
	pending bool
}

// startRejoinLocked arms (or re-arms) the role's window; the caller holds r.mu.
func (s *bridge) startRejoinLocked(r *room, role string) {
	if r.rejoin == nil {
		r.rejoin = map[string]*rejoinState{}
	}
	st := r.rejoin[role]
	if st == nil {
		st = &rejoinState{}
		r.rejoin[role] = st
	}
	if st.timer != nil {
		st.timer.Stop()
	}
	st.gen++
	st.since = time.Now()
	st.pending = true
	gen := st.gen
	st.timer = time.AfterFunc(s.rejoinWindow, func() { s.rejoinExpired(r, role, gen) })
}

// rejoinPendingLocked reports whether any role is inside its window; the caller holds r.mu.
func (r *room) rejoinPendingLocked() bool {
	for _, st := range r.rejoin {
		if st.pending {
			return true
		}
	}
	return false
}

// clearLegLocked drops the role's per-leg state, as a same-role replacement does.
func (r *room) clearLegLocked(role string) {
	if role == "gateway" {
		r.dc = nil
		r.seen = false
	} else {
		r.upTimingSeen = false
	}
}

// legFailed handles the current leg of role going Failed (or Closed unasked).
func (s *bridge) legFailed(r *room, role string, pc *webrtc.PeerConnection, cause string) {
	if s.rejoinWindow <= 0 {
		s.closeRoom(r.id, "pc_failed")
		return
	}
	r.mu.Lock()
	if r.closed || r.peers[role] != pc {
		r.mu.Unlock()
		return
	}
	delete(r.peers, role)
	r.clearLegLocked(role)
	s.startRejoinLocked(r, role)
	r.mu.Unlock()
	log.Printf("media.leg_failed call=%s role=%s cause=%s window_ms=%d", r.id, role, cause, s.rejoinWindow.Milliseconds())
	// Unlocked, like /offer's old.Close(): the peer entry is already gone, so the
	// Closed event this fires sees current()==false and cannot recurse.
	pc.Close()
}

// legConnected cancels the role's window when its new leg reaches Connected.
func (s *bridge) legConnected(r *room, role string) {
	r.mu.Lock()
	st := r.rejoin[role]
	if r.closed || st == nil || !st.pending {
		r.mu.Unlock()
		return
	}
	st.timer.Stop()
	st.gen++
	st.pending = false
	r.rejoins++
	after := time.Since(st.since).Milliseconds()
	r.mu.Unlock()
	log.Printf("media.leg_rejoined call=%s role=%s after_ms=%d", r.id, role, after)
}

func (s *bridge) rejoinExpired(r *room, role string, gen uint64) {
	defer s.recoverCallback(r.id, r.mediaEpoch, role, "rejoin_timer")
	r.mu.Lock()
	st := r.rejoin[role]
	live := !r.closed && st != nil && st.pending && st.gen == gen
	r.mu.Unlock()
	if !live {
		return
	}
	// ponytail: a leg reaching Connected between this unlock and the close still
	// loses the room; that is indistinguishable from connecting 1 ms after the window.
	log.Printf("media.rejoin_window_closed call=%s role=%s reason=timeout", r.id, role)
	s.closeRoomAtEpoch(r.id, r.mediaEpoch, "rejoin_timeout")
}
