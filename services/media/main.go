// VoDog media bridge. The HTTP listener is internal and never proxies arbitrary URLs.
package main

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha1"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/pion/rtp"
	"github.com/pion/webrtc/v4"
	"github.com/pion/webrtc/v4/pkg/media/oggwriter"
	"io"
	"log"
	"math"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

type room struct {
	mu                     sync.Mutex
	id                     string
	peers                  map[string]*webrtc.PeerConnection
	dc                     *webrtc.DataChannel
	track                  *webrtc.TrackLocalStaticRTP
	recorder               *roomRecorder
	lastSeq                uint32
	downWindow             lateWindow
	seen                   bool
	closed                 bool
	created                time.Time
	lastActivity           atomic.Int64 // unix nanos of the last forwarded packet or peer state change
	dir                    string
	recordingFailed        bool
	nodeID                 string
	mediaEpoch             int64
	upTimingSeen           bool
	upFirstSourceUS        uint64
	upFirstArrivalUS       int64
	downPackets, upPackets uint64
	transport              mediaTransportStats
	upSeq                  uint32 // S73 D4: room-level so a rejoined client leg keeps numbering towards the gateway
	upLegs                 int    // S73 D4: client legs that forwarded audio; a later leg is offset so timestamps never go back
	upLastUS               uint64
	upLastArrivalUS        int64
	rejoin                 map[string]*rejoinState
	rejoins                int
}
type bridge struct {
	mu                      sync.Mutex
	rooms                   map[string]*room
	verifier                GrantVerifier
	secret                  string
	recordDir               string
	turnSecret              string
	turnUDPURL              string
	nodeID                  string
	recordingAuth           recordingRequestAuth
	dataChannelLifetimeMS   uint16
	dataChannelRetransmits  uint16
	dataChannelCopies       uint8
	dataChannelCopyInterval time.Duration
	sctpTuning              sctpTuning
	rrLossFloorPct          uint8
	testDropEveryN          uint64
	rejoinWindow            time.Duration
}

// D1: the Opus maximum average bitrate is its own constant so it can be rolled
// back independently of the DTX decision (the local line never carried usedtx).
const opusMaxAverageBitrate = 32000

var localOpusFmtpLine = fmt.Sprintf("minptime=10;useinbandfec=1;stereo=0;sprop-stereo=0;maxaveragebitrate=%d", opusMaxAverageBitrate)

// D9: an off-by-default SCTP congestion tuning switch. "off" keeps the bare
// pion constructor so production behaviour is byte-for-byte unchanged.
type sctpTuning struct {
	name    string
	minCwnd uint32
	rtoMax  time.Duration
}

const sctpTuningV1MinCwnd = 8 * 1200

const sctpTuningV1RTOMax = 2 * time.Second

func configuredSCTPTuning(raw string) (sctpTuning, error) {
	switch raw {
	case "", "off":
		return sctpTuning{}, nil
	case "v1":
		return sctpTuning{name: "v1", minCwnd: sctpTuningV1MinCwnd, rtoMax: sctpTuningV1RTOMax}, nil
	}
	return sctpTuning{}, errors.New("CC_MEDIA_SCTP_TUNING must be unset, off or v1")
}

// label is what lands in transport-stats.json; the zero value reports "off".
func (t sctpTuning) label() string {
	if t.name == "" {
		return "off"
	}
	return t.name
}

// newPeerConnection mirrors webrtc.NewPeerConnection exactly when tuning is off.
// webrtc.NewPeerConnection is itself NewAPI().NewPeerConnection, and NewAPI
// registers the default codecs and the default interceptor registry whenever a
// MediaEngine or an interceptor.Registry was not supplied, so passing only a
// SettingEngine keeps NACK/RR/TWCC registration identical.
func (t sctpTuning) newPeerConnection(configuration webrtc.Configuration) (*webrtc.PeerConnection, error) {
	if t.name == "" {
		return webrtc.NewPeerConnection(configuration)
	}
	return webrtc.NewAPI(webrtc.WithSettingEngine(t.settingEngine())).NewPeerConnection(configuration)
}

func (t sctpTuning) settingEngine() webrtc.SettingEngine {
	engine := webrtc.SettingEngine{}
	if t.name != "" {
		engine.SetSCTPMinCwnd(t.minCwnd)
		engine.SetSCTPRTOMax(t.rtoMax)
	}
	return engine
}

type dataChannelReliability struct {
	maxRetransmits   uint16
	packetLifetimeMS uint16
	copies           uint8
	copyIntervalMS   uint16
}

const defaultDataChannelCopyIntervalMS = 5

func (c dataChannelReliability) copyInterval() time.Duration {
	return time.Duration(c.copyIntervalMS) * time.Millisecond
}

func configuredDataChannelReliability(listen, rawLifetime, rawRetransmits, rawCopies, rawCopyInterval string) (dataChannelReliability, error) {
	config := dataChannelReliability{copies: 1, copyIntervalMS: defaultDataChannelCopyIntervalMS}
	modes := 0
	for _, raw := range []string{rawLifetime, rawRetransmits, rawCopies} {
		if raw != "" {
			modes++
		}
	}
	if modes > 1 {
		return config, errors.New("experimental packet lifetime, max retransmits, and copies are mutually exclusive")
	}
	if modes == 0 && rawCopyInterval == "" {
		return config, nil
	}
	if listen != "127.0.0.1:16882" {
		return config, errors.New("experimental data channel reliability requires MEDIA_LISTEN_ADDR=127.0.0.1:16882")
	}
	// The copy interval is a modifier of copies, not a mode of its own, so it
	// never participates in the mutual exclusion check above.
	if rawCopyInterval != "" {
		value, err := strconv.Atoi(rawCopyInterval)
		if err != nil || (value != 0 && value != 5) {
			return config, errors.New("experimental copy interval must be 0 or 5 milliseconds")
		}
		config.copyIntervalMS = uint16(value)
	}
	if rawLifetime != "" {
		value, err := strconv.Atoi(rawLifetime)
		if err != nil || (value != 120 && value != 200) {
			return config, errors.New("invalid experimental packet lifetime")
		}
		config.packetLifetimeMS = uint16(value)
		return config, nil
	}
	if rawRetransmits != "" {
		if rawRetransmits != "2" {
			return config, errors.New("experimental max retransmits must be exactly 2")
		}
		config.maxRetransmits = 2
		return config, nil
	}
	if rawCopies != "" {
		value, err := strconv.Atoi(rawCopies)
		if err != nil || value < 1 || value > 3 {
			return config, errors.New("experimental copies must be 1, 2 or 3")
		}
		config.copies = uint8(value)
	}
	return config, nil
}

// maxConcurrentRooms caps live calls per media node.  A call has two relay legs
// (caller<->bridge and bridge<->gateway) and every end of a leg is relay-only, so a
// call costs four TURN allocations on this node's own coturn: the ceiling is that
// coturn's total-quota=24 divided by four.  Headroom absorbs the quality probes.
// Raising this requires raising total-quota and the min-port/max-port relay range
// together (infra/turnserver.conf.example and infra/deploy-turn-relay-primary.py).
const maxConcurrentRooms = 6

func (s *bridge) getRoom(id string, epochs ...int64) (*room, error) {
	epoch := int64(1)
	if len(epochs) > 0 {
		epoch = epochs[0]
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if r := s.rooms[id]; r != nil {
		if r.mediaEpoch != epoch {
			return nil, errors.New("media epoch mismatch")
		}
		return r, nil
	}
	if len(s.rooms) >= maxConcurrentRooms {
		return nil, errors.New("media capacity reached")
	}
	dir := filepath.Join(s.recordDir, id)
	if err := os.MkdirAll(s.recordDir, 0700); err != nil {
		return nil, err
	}
	// A completed call directory is also a durable tombstone: never overwrite recordings.
	if err := os.Mkdir(dir, 0700); err != nil {
		return nil, err
	}
	down, e := oggwriter.New(filepath.Join(dir, "remote_original.ogg"), 48000, 1)
	if e != nil {
		return nil, e
	}
	up, e := oggwriter.New(filepath.Join(dir, "caller_original.ogg"), 48000, 1)
	if e != nil {
		down.Close()
		return nil, e
	}
	track, e := webrtc.NewTrackLocalStaticRTP(webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeOpus, ClockRate: 48000, Channels: 2, SDPFmtpLine: localOpusFmtpLine}, "cellular", "vodog")
	if e != nil {
		down.Close()
		up.Close()
		return nil, e
	}
	timeline, e := os.OpenFile(filepath.Join(dir, "timeline.jsonl"), os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if e != nil {
		down.Close()
		up.Close()
		return nil, e
	}
	r := &room{recorder: startRoomRecorder(down, up, timeline, recordingQueueSize), dir: dir, id: id, nodeID: s.nodeID, mediaEpoch: epoch, peers: map[string]*webrtc.PeerConnection{}, track: track, created: time.Now(), transport: mediaTransportStats{SCTPTuning: s.sctpTuning.label()}}
	r.touch()
	s.rooms[id] = r
	log.Printf("media.room_created call=%s node=%s", id, s.nodeID)
	return r, nil
}

// testDrop is the S70 acceptance knob CC_MEDIA_TEST_DROP_EVERY_N: every Nth up packet.
func (s *bridge) testDrop(upReceived uint64) bool {
	return s.testDropEveryN > 0 && upReceived%s.testDropEveryN == 0
}

func (r *room) touch() { r.lastActivity.Store(time.Now().UnixNano()) }

// record queues one recording entry; the caller holds r.mu. A late packet goes to
// the timeline only, so the Ogg granule stays monotonic.
func (r *room) record(ogg *oggwriter.OggWriter, packet *rtp.Packet, direction string, sequence uint32, timestampUS uint64, durationMS uint16, late bool) {
	if late {
		ogg = nil
	}
	now := time.Now()
	if !r.recorder.enqueue(recordingJob{ogg: ogg, packet: packet, direction: direction, sequence: sequence, timestampUS: timestampUS, durationMS: durationMS, elapsedUS: now.Sub(r.created).Microseconds(), receivedAt: now, late: late}) {
		r.transport.RecordingDrops++
	}
}

// acceptDownSequence classifies a gateway packet (caller holds r.mu). A late
// packet inside the window is forwarded and un-counts the gap it fills, so
// DownSequenceMissing ends as the gaps that never arrived.
func (r *room) acceptDownSequence(sequence uint32) (late, forward bool) {
	if !r.seen {
		r.seen = true
		r.lastSeq = sequence
		r.downWindow = startLateWindow
		return false, true
	}
	distance := int64(int32(sequence - r.lastSeq))
	switch {
	case distance > 0:
		r.transport.DownSequenceMissing += uint64(distance - 1)
		r.downWindow.advance(uint64(distance))
		r.lastSeq = sequence
		return false, true
	case -distance > lateForwardWindow:
		r.transport.DownLate++
		r.transport.DownOutOfOrderDrop++
		return false, false
	case distance == 0 || !r.downWindow.fill(uint64(-distance)):
		r.transport.DownDuplicate++
		r.transport.DownOutOfOrderDrop++
		return false, false
	}
	r.transport.DownLate++
	r.transport.DownLateForwarded++
	if r.transport.DownSequenceMissing > 0 {
		r.transport.DownSequenceMissing--
	}
	return true, true
}

// roomIdleLimit closes a room only after this long without a forwarded packet or
// a peer state change; a healthy long call is never torn down by age alone.
const roomIdleLimit = 2 * time.Hour

func (s *bridge) closeIdleRooms() {
	s.mu.Lock()
	ids := []string{}
	for id, r := range s.rooms {
		if time.Since(time.Unix(0, r.lastActivity.Load())) > roomIdleLimit {
			ids = append(ids, id)
		}
	}
	s.mu.Unlock()
	for _, id := range ids {
		s.closeRoom(id, "stale_room")
	}
}

// recoverCallback is deferred at the top of every pion callback and goroutine:
// a panic there would otherwise kill the whole bridge and every live call.
// The epoch scope keeps an old leg's panic from closing a newer room.
func (s *bridge) recoverCallback(id string, epoch int64, role, where string) {
	if p := recover(); p != nil {
		log.Printf("media.panic call=%s role=%s where=%s err=%v", id, role, where, p)
		s.closeRoomAtEpoch(id, epoch, "panic")
	}
}

// discardableCloseReasons are failures before any media flowed; such a room's
// directory is removed so a retry of the same callId can rebuild it.
var discardableCloseReasons = map[string]bool{"offer_failed": true, "pc_failed": true, "codec_rejected": true, "panic": true, "rejoin_timeout": true}

func (s *bridge) closeRoom(id string, reason string) {
	s.closeRoomAtEpoch(id, 0, reason)
}

func (s *bridge) closeRoomAtEpoch(id string, mediaEpoch int64, reason string) bool {
	s.mu.Lock()
	r := s.rooms[id]
	if r != nil && mediaEpoch > 0 && r.mediaEpoch != mediaEpoch {
		s.mu.Unlock()
		return false
	}
	delete(s.rooms, id)
	s.mu.Unlock()
	if r == nil {
		return true
	}
	r.mu.Lock()
	if r.closed {
		r.mu.Unlock()
		return true
	}
	r.closed = true
	for _, st := range r.rejoin {
		if st.timer != nil {
			st.timer.Stop()
		}
	}
	peers := r.peers
	r.peers = map[string]*webrtc.PeerConnection{}
	// S70: the writer drains and closes the files before anything is hashed; closed
	// is already set under r.mu, so nothing can be queued after this.
	r.recorder.close()
	if r.recorder.failed {
		r.recordingFailed = true
	}
	r.downPackets += r.recorder.downPackets.Load()
	r.upPackets += r.recorder.upPackets.Load()
	discarded := false
	recording := "failed"
	// S31 never overwrites recordings: only a failed room that never wrote or
	// forwarded a single packet gives its directory back.
	if info, err := os.Stat(filepath.Join(r.dir, "timeline.jsonl")); discardableCloseReasons[reason] && err == nil && info.Size() == 0 && r.downPackets == 0 && r.upPackets == 0 && r.transport.DownForwarded == 0 && r.transport.UpSent == 0 {
		if err := os.RemoveAll(r.dir); err == nil {
			log.Printf("media.room_dir_discarded call=%s reason=%s", r.id, reason)
			discarded = true
			recording = "discarded"
		}
	}
	if !discarded {
		// A manifest with complete=false is served as unavailable by the backup path, so only a
		// complete, finalized recording counts as ok.
		complete := !r.recordingFailed && r.downPackets > 0 && r.upPackets > 0
		if err := finalizeRecording(r.dir, r.id, complete, r.nodeID, r.mediaEpoch); err != nil {
			log.Printf("media.recording_finalize_failed call=%s err=%q", r.id, err.Error())
		} else if complete {
			recording = "ok"
		}
		if data, err := json.Marshal(r.transport); err == nil {
			if err = os.WriteFile(filepath.Join(r.dir, "transport-stats.json"), data, 0600); err != nil {
				log.Printf("media.stats_write_failed call=%s err=%q", r.id, err.Error())
			}
		}
	}
	// S69: one line per call, written after the recording is finalized so it reports the outcome.
	log.Printf("media.room_closed call=%s reason=%s peers=%d elapsed_ms=%d recording=%s %s", r.id, reason, len(peers), time.Since(r.created).Milliseconds(), recording, roomCounters(r.downPackets, r.upPackets, r.transport, r.rejoins))
	r.mu.Unlock()
	for role, p := range peers {
		log.Printf("media.leg_closed call=%s role=%s reason=%s", id, role, reason)
		p.Close()
	}
	return true
}

// roomCounters is the counter tail shared by media.room_closed and media.room_stats (S75).
func roomCounters(down, up uint64, t mediaTransportStats, rejoins int) string {
	return fmt.Sprintf("down_pkts=%d up_pkts=%d down_forwarded=%d down_seq_missing=%d down_late=%d down_send_err=%d up_sent=%d up_backpressure_drop=%d up_channel_unavailable=%d up_oversized_drop=%d up_duration_drop=%d up_clock_drop=%d up_send_err=%d up_max_src_lag_ms=%d recording_drops=%d down_late_forwarded=%d up_late=%d up_test_drops=%d up_padding_ignored=%d up_invalid_sample=%q rejoins=%d",
		down, up, t.DownForwarded, t.DownSequenceMissing, t.DownLate, t.DownSendErrors,
		t.UpSent, t.UpBackpressureDrops, t.UpChannelUnavailable, t.UpOversizedDrop, t.UpDurationInvalidDrop, t.UpClockRejectDrop, t.UpSendErrors, t.UpMaxSourceLagMillis, t.RecordingDrops, t.DownLateForwarded, t.UpLate, t.UpTestDrops, t.UpPaddingIgnored, t.UpInvalidSample, rejoins)
}

// roomStatsInterval spaces the S75 in-call media.room_stats lines.
const roomStatsInterval = 30 * time.Second

// logRoomStats writes one cumulative media.room_stats line per room that has a leg.
func (s *bridge) logRoomStats() {
	s.mu.Lock()
	rooms := make([]*room, 0, len(s.rooms))
	for _, r := range s.rooms {
		rooms = append(rooms, r)
	}
	s.mu.Unlock()
	for _, r := range rooms {
		r.mu.Lock()
		if r.closed || len(r.peers) == 0 {
			r.mu.Unlock()
			continue
		}
		// Recorder counters are folded into r.downPackets only at close.
		down, up, t, rejoins := r.downPackets+r.recorder.downPackets.Load(), r.upPackets+r.recorder.upPackets.Load(), r.transport, r.rejoins
		r.mu.Unlock()
		log.Printf("media.room_stats call=%s elapsed_ms=%d %s", r.id, time.Since(r.created).Milliseconds(), roomCounters(down, up, t, rejoins))
	}
}

// selectedPairTypes names the ICE candidate types of the connected pair ("?" when unknown).
func selectedPairTypes(pc *webrtc.PeerConnection) (string, string) {
	sctp := pc.SCTP()
	if sctp == nil || sctp.Transport() == nil || sctp.Transport().ICETransport() == nil {
		return "?", "?"
	}
	pair, err := sctp.Transport().ICETransport().GetSelectedCandidatePair()
	if err != nil || pair == nil || pair.Local == nil || pair.Remote == nil {
		return "?", "?"
	}
	return pair.Local.Typ.String(), pair.Remote.Typ.String()
}
func (s *bridge) config() webrtc.Configuration {
	c := webrtc.Configuration{}
	if s.turnSecret != "" {
		u := fmt.Sprintf("%d:media-%s", time.Now().Add(time.Hour).Unix(), rand.Text())
		m := hmac.New(sha1.New, []byte(s.turnSecret))
		m.Write([]byte(u))
		c.ICEServers = []webrtc.ICEServer{{URLs: []string{s.turnUDPURL}, Username: u, Credential: base64.StdEncoding.EncodeToString(m.Sum(nil))}}
		c.ICETransportPolicy = webrtc.ICETransportPolicyRelay
	}
	return c
}

const secondaryTurnUDPURL = "turn:relay-secondary.example.com:16801?transport=udp"

func configuredMediaTurnUDPURL(nodeID, raw string) (string, error) {
	if raw == "" {
		if nodeID == "relay-secondary" {
			return secondaryTurnUDPURL, nil
		}
		return "", errors.New("MEDIA_TURN_UDP_URL is required for this media node")
	}
	if !strings.HasPrefix(raw, "turn:") {
		return "", errors.New("MEDIA_TURN_UDP_URL must be an explicit turn URL with transport=udp")
	}
	parsed, err := url.Parse("//" + strings.TrimPrefix(raw, "turn:"))
	if err != nil || parsed.Hostname() == "" || parsed.Port() == "" || parsed.User != nil || parsed.Path != "" || parsed.Fragment != "" || parsed.RawQuery != "transport=udp" {
		return "", errors.New("MEDIA_TURN_UDP_URL must be an explicit turn URL with transport=udp")
	}
	return raw, nil
}
func (s *bridge) offer(w http.ResponseWriter, req *http.Request) {
	if req.Method != "POST" {
		http.Error(w, "method", 405)
		return
	}
	start := time.Now()
	token := strings.TrimPrefix(req.Header.Get("Authorization"), "Bearer ")
	g, e := s.verifier.Consume(token)
	if e != nil {
		// No callId is known yet; the grant error text is a fixed string and carries no key material.
		log.Printf("media.offer_rejected call=- role=- code=401 reason=%q", e.Error())
		http.Error(w, "invalid media grant", 401)
		return
	}
	// transport is this bridge's own ICE policy, not the peer's TURN transport: the
	// peer's udp/tls choice is not observable from its offer.
	transport := "all"
	if s.turnSecret != "" {
		transport = "relay"
	}
	log.Printf("media.offer_received call=%s role=%s transport=%s", g.CallID, g.Role, transport)
	var offer webrtc.SessionDescription
	req.Body = http.MaxBytesReader(w, req.Body, 128*1024)
	if json.NewDecoder(req.Body).Decode(&offer) != nil || offer.Type != webrtc.SDPTypeOffer {
		log.Printf("media.offer_rejected call=%s role=%s code=400 reason=invalid_offer", g.CallID, g.Role)
		http.Error(w, "invalid offer", 400)
		return
	}
	r, e := s.getRoom(g.CallID, g.MediaEpoch)
	if e != nil {
		// 503 covers epoch mismatch, capacity and the recording tombstone; keep them apart.
		log.Printf("media.offer_rejected call=%s role=%s code=503 reason=%q", g.CallID, g.Role, e.Error())
		http.Error(w, "capacity", 503)
		return
	}
	pc, e := newMediaPeerConnection(s.sctpTuning, s.rrLossFloorPct, s.config())
	if e != nil {
		log.Printf("media.offer_rejected call=%s role=%s code=500 reason=peer_creation err=%q", g.CallID, g.Role, e.Error())
		http.Error(w, "peer creation", 500)
		return
	}
	r.mu.Lock()
	old := r.peers[g.Role]
	// Read once: a stale leg can flip Connected<->Disconnected between two reads (S75c).
	var oldState webrtc.PeerConnectionState
	if old != nil {
		oldState = old.ConnectionState()
	}
	forced := g.Replace && oldState == webrtc.PeerConnectionStateConnected
	if r.closed || oldState == webrtc.PeerConnectionStateConnected && !forced {
		r.mu.Unlock()
		pc.Close()
		log.Printf("media.offer_rejected call=%s role=%s code=409 reason=role_already_connected", g.CallID, g.Role)
		http.Error(w, "role already connected", 409)
		return
	}
	// A same-role retry (e.g. UDP->TLS fallback) replaces a leg that never reached
	// Connected; only that leg is closed, the room and the other leg stay up.
	if old != nil {
		r.clearLegLocked(g.Role)
		// S73: pion only reaches Disconnected from Connected, so this is a lost leg
		// being rejoined (the common path: the end re-offers at 5 s, before Failed).
		// S75c: the owner re-offering over a leg the bridge still sees Connected is the
		// same rejoin (the end already abandoned that leg). New/Connecting replacements
		// (S52 UDP->TLS fallback) are not counted.
		if s.rejoinWindow > 0 && (oldState == webrtc.PeerConnectionStateDisconnected || forced) {
			s.startRejoinLocked(r, g.Role)
			cause := "replaced_disconnected"
			if forced {
				cause = "replaced_connected"
			}
			log.Printf("media.leg_failed call=%s role=%s cause=%s window_ms=%d", g.CallID, g.Role, cause, s.rejoinWindow.Milliseconds())
		}
	}
	r.peers[g.Role] = pc
	r.mu.Unlock()
	if old != nil {
		log.Printf("media.offer_replaced call=%s role=%s old_state=%s forced=%t", g.CallID, g.Role, oldState, forced)
		old.Close()
	}
	// current reports whether pc is still this role's leg; a replaced leg's
	// callbacks and failed offer must not tear down the room.
	current := func() bool {
		r.mu.Lock()
		defer r.mu.Unlock()
		return r.peers[g.Role] == pc
	}
	ok := false
	// A failed offer drops only its own leg; the room closes only when no other leg is left.
	defer func() {
		if ok {
			return
		}
		r.mu.Lock()
		mine := r.peers[g.Role] == pc
		if mine {
			delete(r.peers, g.Role)
			if g.Role == "gateway" {
				r.dc = nil
			}
		}
		others := len(r.peers)
		// S73: inside a rejoin window the timer, not a bad retry offer, decides.
		pending := r.rejoinPendingLocked()
		r.mu.Unlock()
		pc.Close()
		log.Printf("media.leg_closed call=%s role=%s reason=offer_failed", g.CallID, g.Role)
		if mine && others == 0 && !pending {
			s.closeRoom(g.CallID, "offer_failed")
		}
	}()
	// Pion fires state callbacks from its own goroutines, possibly before the answer
	// is written, so the answer instant is published atomically and reads as -1 until then.
	var answered atomic.Int64
	var pairLogged atomic.Bool
	// Candidate counts by type, for gather_timeout and answer_sent (the relay-only policy
	// means a zero relay count is the whole story of a failed gather).
	var candHost, candSrflx, candRelay atomic.Int64
	pc.OnICECandidate(func(c *webrtc.ICECandidate) {
		if c == nil {
			return
		}
		switch c.Typ {
		case webrtc.ICECandidateTypeHost:
			candHost.Add(1)
		case webrtc.ICECandidateTypeSrflx, webrtc.ICECandidateTypePrflx:
			candSrflx.Add(1)
		case webrtc.ICECandidateTypeRelay:
			candRelay.Add(1)
		}
	})
	sinceAnswerMS := func() int64 {
		if at := answered.Load(); at > 0 {
			return time.Since(time.Unix(0, at)).Milliseconds()
		}
		return -1
	}
	pc.OnICEConnectionStateChange(func(state webrtc.ICEConnectionState) {
		defer s.recoverCallback(g.CallID, g.MediaEpoch, g.Role, "ice_state")
		// S69: only the transitions that explain a call; new/completed/closed repeat pc_state.
		switch state {
		case webrtc.ICEConnectionStateChecking, webrtc.ICEConnectionStateConnected, webrtc.ICEConnectionStateDisconnected, webrtc.ICEConnectionStateFailed:
			log.Printf("media.ice_state call=%s role=%s state=%s since_answer_ms=%d", g.CallID, g.Role, state, sinceAnswerMS())
		}
	})
	pc.OnConnectionStateChange(func(state webrtc.PeerConnectionState) {
		defer s.recoverCallback(g.CallID, g.MediaEpoch, g.Role, "pc_state")
		log.Printf("media.pc_state call=%s role=%s state=%s", g.CallID, g.Role, state)
		if !current() {
			return
		}
		r.touch()
		if state == webrtc.PeerConnectionStateConnected && !pairLogged.Swap(true) {
			local, remote := selectedPairTypes(pc)
			log.Printf("media.pair call=%s role=%s local=%s remote=%s", g.CallID, g.Role, local, remote)
		}
		switch state {
		case webrtc.PeerConnectionStateConnected:
			s.legConnected(r, g.Role)
		case webrtc.PeerConnectionStateFailed:
			s.legFailed(r, g.Role, pc, "failed")
		case webrtc.PeerConnectionStateClosed:
			// Only reached for a close we did not ask for: every bridge-side close
			// removes the peer entry first, so current() is already false.
			if s.rejoinWindow > 0 {
				s.legFailed(r, g.Role, pc, "closed")
			}
		}
	})
	if g.Role == "gateway" {
		pc.OnDataChannel(func(dc *webrtc.DataChannel) {
			defer s.recoverCallback(g.CallID, g.MediaEpoch, g.Role, "data_channel")
			validReliability := dc.MaxRetransmits() != nil && *dc.MaxRetransmits() == s.dataChannelRetransmits && dc.MaxPacketLifeTime() == nil
			if s.dataChannelLifetimeMS > 0 {
				validReliability = dc.MaxPacketLifeTime() != nil && *dc.MaxPacketLifeTime() == s.dataChannelLifetimeMS && dc.MaxRetransmits() == nil
			}
			if dc.Label() != "cellular-opus-v1" || dc.Ordered() || !validReliability {
				reason := "reliability"
				if dc.Label() != "cellular-opus-v1" {
					reason = "label"
				} else if dc.Ordered() {
					reason = "ordered"
				}
				log.Printf("media.dc_rejected call=%s role=%s label=%q reason=%s", g.CallID, g.Role, dc.Label(), reason)
				dc.Close()
				return
			}
			r.mu.Lock()
			if r.dc != nil || r.peers[g.Role] != pc {
				reason := "duplicate"
				if r.peers[g.Role] != pc {
					reason = "leg_replaced"
				}
				r.mu.Unlock()
				log.Printf("media.dc_rejected call=%s role=%s label=%q reason=%s", g.CallID, g.Role, dc.Label(), reason)
				dc.Close()
				return
			}
			r.dc = dc
			r.mu.Unlock()
			dc.OnOpen(func() {
				defer s.recoverCallback(g.CallID, g.MediaEpoch, g.Role, "dc_open")
				log.Printf("media.leg_open call=%s role=gateway", g.CallID)
			})
			dc.OnMessage(func(message webrtc.DataChannelMessage) {
				defer s.recoverCallback(g.CallID, g.MediaEpoch, g.Role, "dc_message")
				r.mu.Lock()
				r.transport.DownMessagesReceived++
				r.mu.Unlock()
				if message.IsString {
					r.mu.Lock()
					r.transport.DownStringRejected++
					r.mu.Unlock()
					return
				}
				p, e := decodePacket(message.Data)
				if e != nil {
					r.mu.Lock()
					r.transport.DownInvalidRejected++
					r.mu.Unlock()
					return
				}
				if p.Direction != 0 {
					r.mu.Lock()
					r.transport.DownDirectionRejected++
					r.mu.Unlock()
					return
				}
				r.mu.Lock()
				defer r.mu.Unlock()
				if r.closed {
					return
				}
				late, forward := r.acceptDownSequence(p.Sequence)
				if !forward {
					return
				}
				r.transport.DownUniqueReceived++
				packet := &rtp.Packet{Header: rtp.Header{Version: 2, PayloadType: 111, SequenceNumber: uint16(p.Sequence), Timestamp: uint32(p.TimestampUS * 48 / 1000), SSRC: 1}, Payload: p.Opus}
				r.record(r.recorder.down, packet, "remote_original", p.Sequence, p.TimestampUS, p.DurationMS, late)
				if err := r.track.WriteRTP(packet); err != nil {
					r.transport.DownSendErrors++
				} else {
					r.transport.DownForwarded++
					r.touch()
				}
			})
		})
	} else {
		sender, e := pc.AddTrack(r.track)
		if e != nil {
			log.Printf("media.offer_rejected call=%s role=%s code=500 reason=track_creation err=%q", g.CallID, g.Role, e.Error())
			http.Error(w, "track creation", 500)
			return
		}
		go func() {
			defer s.recoverCallback(g.CallID, g.MediaEpoch, g.Role, "rtcp_read")
			buf := make([]byte, 1500)
			for {
				if _, _, e := sender.Read(buf); e != nil {
					return
				}
			}
		}()
		pc.OnTrack(func(track *webrtc.TrackRemote, _ *webrtc.RTPReceiver) {
			defer s.recoverCallback(g.CallID, g.MediaEpoch, g.Role, "track")
			log.Printf("media.leg_open call=%s role=client kind=%s", g.CallID, track.Kind())
			if !strings.EqualFold(track.Codec().MimeType, webrtc.MimeTypeOpus) {
				log.Printf("media.codec_rejected call=%s role=%s mime=%s", g.CallID, g.Role, track.Codec().MimeType)
				if current() {
					s.closeRoom(g.CallID, "codec_rejected")
				}
				return
			}
			var clock rtpClock
			// S73 D4: each client leg's RTP clock starts at 0; a rejoined leg continues from the
			// previous leg's last timestamp plus the wall-clock gap, so gateways see monotonic time.
			var legBase uint64
			legStarted := false
			drop := func(counter *uint64) {
				r.mu.Lock()
				*counter++
				r.mu.Unlock()
			}
			for {
				packet, _, e := track.ReadRTP()
				if e != nil {
					return
				}
				if len(packet.Payload) == 0 {
					// Padding-only RTP (libwebrtc BWE probes on the audio SSRC once TWCC is
					// negotiated): pion strips the padding and leaves no payload. Not audio.
					drop(&r.transport.UpPaddingIgnored)
					continue
				}
				if len(packet.Payload) > 1024 {
					drop(&r.transport.UpOversizedDrop)
					continue
				}
				duration, durationError := opusDurationMS(packet.Payload)
				if durationError != nil {
					r.mu.Lock()
					r.transport.UpDurationInvalidDrop++
					if r.transport.UpDurationInvalidDrop <= 3 {
						// Bounded diag: which Opus TOCs we still reject (len:toc hex).
						if r.transport.UpInvalidSample != "" {
							r.transport.UpInvalidSample += ","
						}
						r.transport.UpInvalidSample += fmt.Sprintf("%d:%02x", len(packet.Payload), packet.Payload[0])
					}
					r.mu.Unlock()
					continue
				}
				timestampUS, late, accepted := clock.accept(packet.SequenceNumber, packet.Timestamp)
				if !accepted {
					drop(&r.transport.UpClockRejectDrop)
					continue
				}
				// The lock is released by defer so a recovered panic never leaves r.mu held.
				if func() (stop bool) {
					r.mu.Lock()
					defer r.mu.Unlock()
					if r.closed {
						return true
					}
					arrivalUS := time.Since(r.created).Microseconds()
					if !legStarted {
						legStarted = true
						if r.upLegs > 0 {
							legBase = r.upLastUS + uint64(max(arrivalUS-r.upLastArrivalUS, 0))
						}
						r.upLegs++
					}
					timestampUS += legBase
					if !late {
						r.upLastUS, r.upLastArrivalUS = timestampUS, arrivalUS
					}
					r.record(r.recorder.up, packet, "caller_original", uint32(packet.SequenceNumber), timestampUS, duration, late)
					dc := r.dc
					if late {
						// Recorded in the timeline only, not forwarded: the up leg carries a
						// bridge sequence and CellDock plays in sequence order, so a late packet
						// would play in the wrong slot. Up-leg reordering is rare (S70).
						r.transport.UpLate++
						return false
					} else if !r.upTimingSeen {
						r.upTimingSeen = true
						r.upFirstSourceUS = timestampUS
						r.upFirstArrivalUS = arrivalUS
					} else {
						relativeArrival := arrivalUS - r.upFirstArrivalUS
						relativeSource := int64(timestampUS - r.upFirstSourceUS)
						if lag := relativeArrival - relativeSource; lag > 0 && uint64(lag/1000) > r.transport.UpMaxSourceLagMillis {
							r.transport.UpMaxSourceLagMillis = uint64(lag / 1000)
						}
					}
					r.upSeq++
					packetBytes := uint64(headerSize + len(packet.Payload))
					// Pion BufferedAmount includes unacknowledged in-flight bytes (released
					// by SACK), not only unsent audio. Allow one bounded RTT and delayed
					// ACK interval, plus 60ms headroom; otherwise healthy remote paths
					// are starved by treating every in-flight packet as stale speech.
					srtt := 0.0
					cwnd := uint32(0)
					if gateway := r.peers["gateway"]; gateway != nil && gateway.SCTP() != nil {
						stats := gateway.SCTP().Stats()
						srtt = stats.SmoothedRoundTripTime
						cwnd = stats.CongestionWindow
					}
					budget := mediaFlightBudget(packetBytes, duration, srtt)
					buffered := uint64(0)
					if dc != nil {
						buffered = dc.BufferedAmount()
					}
					r.transport.UpReceived++
					r.transport.observe(uint64(time.Since(r.created)/time.Second), buffered, budget, srtt, cwnd)
					if dc == nil || dc.ReadyState() != webrtc.DataChannelStateOpen {
						r.transport.UpChannelUnavailable++
					} else if buffered+packetBytes > budget {
						r.transport.UpBackpressureDrops++
					} else if s.testDrop(r.transport.UpReceived) {
						// S70 acceptance knob: after recording, before the DataChannel; the
						// skipped bridge sequence is the loss the gateway's FEC sees.
						r.transport.UpTestDrops++
					} else {
						encoded := encodePacket(Packet{Direction: 1, DurationMS: duration, Sequence: r.upSeq, TimestampUS: timestampUS, Opus: packet.Payload})
						r.transport.UpLogicalSent++
						copies := int(s.dataChannelCopies)
						if copies < 1 {
							copies = 1
						}
						for copyIndex := 0; copyIndex < copies; copyIndex++ {
							if copyIndex > 0 {
								r.mu.Unlock()
								time.Sleep(s.dataChannelCopyInterval)
								r.mu.Lock()
								if r.closed || dc.ReadyState() != webrtc.DataChannelStateOpen {
									break
								}
							}
							r.transport.UpPhysicalCopies++
							if err := dc.Send(encoded); err != nil {
								r.transport.UpSendErrors++
							} else {
								r.transport.UpSent++
								r.touch()
							}
						}
					}
					return false
				}() {
					return
				}
			}
		})
	}
	if e = pc.SetRemoteDescription(offer); e != nil {
		log.Printf("media.offer_rejected call=%s role=%s code=400 reason=invalid_sdp err=%q", g.CallID, g.Role, e.Error())
		http.Error(w, "invalid SDP", 400)
		return
	}
	answer, e := pc.CreateAnswer(nil)
	if e != nil {
		log.Printf("media.offer_rejected call=%s role=%s code=500 reason=answer_failed err=%q", g.CallID, g.Role, e.Error())
		http.Error(w, "answer failed", 500)
		return
	}
	gather := webrtc.GatheringCompletePromise(pc)
	if e = pc.SetLocalDescription(answer); e != nil {
		log.Printf("media.offer_rejected call=%s role=%s code=500 reason=local_sdp_failed err=%q", g.CallID, g.Role, e.Error())
		http.Error(w, "local SDP failed", 500)
		return
	}
	select {
	case <-gather:
	case <-req.Context().Done():
		log.Printf("media.offer_rejected call=%s role=%s code=- reason=client_gone", g.CallID, g.Role)
		return
	case <-time.After(12 * time.Second):
		log.Printf("media.offer_rejected call=%s role=%s code=504 reason=gather_timeout cand_host=%d cand_srflx=%d cand_relay=%d", g.CallID, g.Role, candHost.Load(), candSrflx.Load(), candRelay.Load())
		http.Error(w, "ICE gathering timed out", 504)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	answered.Store(time.Now().UnixNano())
	if e = json.NewEncoder(w).Encode(pc.LocalDescription()); e != nil {
		log.Printf("media.offer_rejected call=%s role=%s code=- reason=answer_write_failed err=%q", g.CallID, g.Role, e.Error())
		return
	}
	log.Printf("media.answer_sent call=%s role=%s elapsed_ms=%d cand_host=%d cand_srflx=%d cand_relay=%d", g.CallID, g.Role, time.Since(start).Milliseconds(), candHost.Load(), candSrflx.Load(), candRelay.Load())
	ok = true
}
func main() {
	secret := os.Getenv("MEDIA_SECRET")
	if len(secret) < 32 {
		log.Fatal("MEDIA_SECRET must contain at least 32 bytes")
	}
	dir := os.Getenv("MEDIA_RECORD_DIR")
	if dir == "" {
		dir = "./data/recordings"
	}
	nodeID := os.Getenv("MEDIA_NODE_ID")
	if nodeID == "" {
		nodeID = "relay-primary"
	}
	rawTurnUDPURL := os.Getenv("MEDIA_TURN_UDP_URL")
	turnUDPURL, err := configuredMediaTurnUDPURL(nodeID, rawTurnUDPURL)
	if err != nil {
		log.Fatal(err)
	}
	if rawTurnUDPURL == "" {
		log.Printf("media.config_warning key=MEDIA_TURN_UDP_URL reason=unset fallback=relay-secondary_legacy_url")
	}
	listen := os.Getenv("MEDIA_LISTEN_ADDR")
	if listen == "" {
		listen = "127.0.0.1:16881"
	}
	reliability, err := configuredDataChannelReliability(listen, os.Getenv("CC_MEDIA_EXPERIMENT_MAX_PACKET_LIFETIME_MS"), os.Getenv("CC_MEDIA_EXPERIMENT_MAX_RETRANSMITS"), os.Getenv("CC_MEDIA_EXPERIMENT_COPIES"), os.Getenv("CC_MEDIA_EXPERIMENT_COPY_INTERVAL_MS"))
	if err != nil {
		log.Fatal(err)
	}
	tuning, err := configuredSCTPTuning(os.Getenv("CC_MEDIA_SCTP_TUNING"))
	if err != nil {
		log.Fatal(err)
	}
	lossFloor, err := configuredRRLossFloorPct(os.Getenv("CC_MEDIA_RR_LOSS_FLOOR_PCT"))
	if err != nil {
		log.Fatal(err)
	}
	testDropEveryN, err := configuredTestDropEveryN(os.Getenv("CC_MEDIA_TEST_DROP_EVERY_N"))
	if err != nil {
		log.Fatal(err)
	}
	rejoinWindow, err := configuredRejoinWindow(os.Getenv("CC_MEDIA_REJOIN_WINDOW_S"))
	if err != nil {
		log.Fatal(err)
	}
	s := &bridge{rejoinWindow: rejoinWindow, rooms: map[string]*room{}, verifier: GrantVerifier{Secret: []byte(secret)}, secret: secret, recordDir: dir, turnSecret: os.Getenv("TURN_SECRET"), turnUDPURL: turnUDPURL, nodeID: nodeID, dataChannelLifetimeMS: reliability.packetLifetimeMS, dataChannelRetransmits: reliability.maxRetransmits, dataChannelCopies: reliability.copies, dataChannelCopyInterval: reliability.copyInterval(), sctpTuning: tuning, rrLossFloorPct: lossFloor, testDropEveryN: testDropEveryN}
	mux := http.NewServeMux()
	probe, err := NewMediaProbeHandler(MediaProbeHandlerOptions{Secret: []byte(secret), NodeID: nodeID, AllowedOrigins: splitConfiguredOrigins(os.Getenv("MEDIA_PROBE_ALLOWED_ORIGINS"))})
	if err != nil {
		log.Fatal(err)
	}
	mux.Handle("/probe", probe)
	qualityProbe, err := NewWebRTCProbeHandler(WebRTCProbeHandlerOptions{
		Secret: []byte(secret), NodeID: nodeID, AllowedOrigins: splitConfiguredOrigins(os.Getenv("MEDIA_PROBE_ALLOWED_ORIGINS")),
		TurnSecret: os.Getenv("TURN_SECRET"), TurnUDPURL: turnUDPURL, SCTPTuning: tuning,
	})
	if err != nil {
		log.Fatal(err)
	}
	mux.Handle(webRTCProbePath, qualityProbe)
	mux.HandleFunc("/offer", s.offer)
	mux.HandleFunc("/close/", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "POST" || !hmac.Equal([]byte(r.Header.Get("Authorization")), []byte("Bearer "+s.secret)) {
			http.Error(w, "unauthorized", 401)
			return
		}
		epoch, err := strconv.ParseInt(r.Header.Get("X-Media-Epoch"), 10, 64)
		if err != nil || epoch < 1 {
			http.Error(w, "invalid media epoch", 400)
			return
		}
		if !s.closeRoomAtEpoch(strings.TrimPrefix(r.URL.Path, "/close/"), epoch, "control_close") {
			http.Error(w, "media epoch mismatch", 409)
			return
		}
		w.WriteHeader(204)
	})
	// Serves the signed GET reads and the S29 §2.4 `DELETE /internal/recordings/{callId}`.
	mux.Handle("/internal/recordings/", s.recordingHandler())
	mux.Handle("GET /internal/recordings/{callId}/finalized/{mediaEpoch}/{manifestSHA}/timeline", s.recordingBackupTimelineHandler())
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) { io.WriteString(w, "{\"ok\":true}") })
	go func() {
		for range time.Tick(time.Minute) {
			s.closeIdleRooms()
		}
	}()
	go func() {
		for range time.Tick(roomStatsInterval) {
			s.logRoomStats()
		}
	}()
	host, _, err := net.SplitHostPort(listen)
	if err != nil || host != "127.0.0.1" {
		log.Fatal("MEDIA_LISTEN_ADDR must be loopback IPv4")
	}
	server := &http.Server{Addr: listen, Handler: mux, ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 15 * time.Second, WriteTimeout: 20 * time.Second}
	log.Fatal(server.ListenAndServe())
}

func splitConfiguredOrigins(raw string) []string {
	if strings.TrimSpace(raw) == "" {
		return nil
	}
	parts := strings.Split(raw, ",")
	result := make([]string, 0, len(parts))
	for _, part := range parts {
		if value := strings.TrimSpace(part); value != "" {
			result = append(result, value)
		}
	}
	return result
}

// Per-room numeric diagnostics; never contains SDP, credentials, phone numbers or audio.
type mediaTransportStats struct {
	UpReceived            uint64                 `json:"upReceived"`
	UpLogicalSent         uint64                 `json:"upLogicalSent"`
	UpPhysicalCopies      uint64                 `json:"upPhysicalCopies"`
	UpSent                uint64                 `json:"upSent"`
	UpBackpressureDrops   uint64                 `json:"upBackpressureDrops"`
	UpChannelUnavailable  uint64                 `json:"upChannelUnavailable"`
	UpSendErrors          uint64                 `json:"upSendErrors"`
	UpOversizedDrop       uint64                 `json:"upOversizedDrop"`
	UpDurationInvalidDrop uint64                 `json:"upDurationInvalidDrop"`
	UpClockRejectDrop     uint64                 `json:"upClockRejectDrop"`
	UpPaddingIgnored      uint64                 `json:"upPaddingIgnored"`
	UpInvalidSample       string                 `json:"upInvalidSample,omitempty"`
	DownSendErrors        uint64                 `json:"downSendErrors"`
	DownMessagesReceived  uint64                 `json:"downMessagesReceived"`
	DownStringRejected    uint64                 `json:"downStringRejected"`
	DownInvalidRejected   uint64                 `json:"downInvalidRejected"`
	DownDirectionRejected uint64                 `json:"downDirectionRejected"`
	DownOutOfOrderDrop    uint64                 `json:"downOutOfOrderDrop"`
	DownUniqueReceived    uint64                 `json:"downUniqueReceived"`
	DownDuplicate         uint64                 `json:"downDuplicate"`
	DownLate              uint64                 `json:"downLate"`
	DownSequenceMissing   uint64                 `json:"downSequenceMissing"`
	DownForwarded         uint64                 `json:"downForwarded"`
	DownLateForwarded     uint64                 `json:"downLateForwarded"`
	UpLate                uint64                 `json:"upLate"`
	UpTestDrops           uint64                 `json:"upTestDrops"`
	RecordingDrops        uint64                 `json:"recordingDrops"`
	UpMaxBufferedAmount   uint64                 `json:"upMaxBufferedAmount"`
	UpMaxFlightBudget     uint64                 `json:"upMaxFlightBudget"`
	UpMinFlightBudget     uint64                 `json:"upMinFlightBudget"`
	UpMaxSRTTMillis       uint64                 `json:"upMaxSrttMillis"`
	UpSamplesAtZero       uint64                 `json:"upSamplesAtZero"`
	UpSamplesWithinBudget uint64                 `json:"upSamplesWithinBudget"`
	UpMaxSourceLagMillis  uint64                 `json:"upMaxSourceLagMillis"`
	SCTPTuning            string                 `json:"sctpTuning"`
	Samples               []mediaTransportSample `json:"samples,omitempty"`
}

type mediaTransportSample struct {
	ElapsedSeconds    uint64 `json:"elapsedSeconds"`
	MaxBufferedAmount uint64 `json:"maxBufferedAmount"`
	MinFlightBudget   uint64 `json:"minFlightBudget"`
	MaxSRTTMillis     uint64 `json:"maxSrttMillis"`
	CongestionWindow  uint32 `json:"congestionWindow"`
}

func (s *mediaTransportStats) observe(elapsed, buffered, budget uint64, srtt float64, cwnd uint32) {
	if buffered > s.UpMaxBufferedAmount {
		s.UpMaxBufferedAmount = buffered
	}
	if budget > s.UpMaxFlightBudget {
		s.UpMaxFlightBudget = budget
	}
	if s.UpMinFlightBudget == 0 || budget < s.UpMinFlightBudget {
		s.UpMinFlightBudget = budget
	}
	ms := uint64(math.Round(math.Max(0, srtt) * 1000))
	if ms > s.UpMaxSRTTMillis {
		s.UpMaxSRTTMillis = ms
	}
	if buffered == 0 {
		s.UpSamplesAtZero++
	} else if buffered <= budget {
		s.UpSamplesWithinBudget++
	}
	if len(s.Samples) == 0 || s.Samples[len(s.Samples)-1].ElapsedSeconds != elapsed {
		s.Samples = append(s.Samples, mediaTransportSample{ElapsedSeconds: elapsed, MaxBufferedAmount: buffered, MinFlightBudget: budget, MaxSRTTMillis: ms, CongestionWindow: cwnd})
	} else {
		sample := &s.Samples[len(s.Samples)-1]
		if buffered > sample.MaxBufferedAmount {
			sample.MaxBufferedAmount = buffered
		}
		if budget < sample.MinFlightBudget {
			sample.MinFlightBudget = budget
		}
		if ms > sample.MaxSRTTMillis {
			sample.MaxSRTTMillis = ms
		}
		sample.CongestionWindow = cwnd
	}
}

func mediaFlightBudget(packetBytes uint64, durationMS uint16, srttSeconds float64) uint64 {
	if durationMS == 0 {
		return 0
	}
	rttMS := srttSeconds * 1000
	if math.IsNaN(rttMS) || rttMS <= 0 {
		rttMS = 500
	}
	rttMS = math.Min(1000, math.Max(100, rttMS))
	packets := uint64(math.Ceil((rttMS + 200 + 60) / float64(durationMS)))
	// S70d: BufferedAmount still holds earlier speech-sized packets when speech stops, so
	// sizing by the current (24 B silence) packet collapsed the budget 3-4x and dropped.
	// ponytail: floor at a p99 Opus speech packet (100 B payload); in pure silence this admits
	// ~2 s of tiny frames, which the gateway's forced catch-up at T+1 s absorbs.
	return max(packetBytes, headerSize+100) * packets
}
