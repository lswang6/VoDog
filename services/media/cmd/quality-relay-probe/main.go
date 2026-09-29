package main

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"math"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/pion/ice/v4"
	"github.com/pion/sdp/v3"
	"github.com/pion/webrtc/v4"
)

const (
	measurement = "relay_data_channel_echo_v1"
	probePath   = "/webrtc-probe/offer"
	probeLabel  = "media-quality-v1"
	frameBytes  = 32
	maxInput    = 256 * 1024
)

var (
	nodeIDPattern     = regexp.MustCompile(`^[a-z][a-z0-9_-]{0,31}$`)
	generationPattern = regexp.MustCompile(`^[A-Za-z0-9._:-]{1,96}$`)
	turnUDPPattern    = regexp.MustCompile(`^turn:([A-Za-z0-9.-]+):([0-9]+)\?transport=udp$`)
	probeEpoch        = time.Now()
)

type options struct {
	NetworkGeneration string `json:"networkGeneration"`
	Measurement       string `json:"measurement"`
	LifetimeMS        int    `json:"lifetimeMs"`
	SampleDurationMS  int    `json:"sampleDurationMs"`
	PacketIntervalMS  int    `json:"packetIntervalMs"`
	MaxPackets        int    `json:"maxPackets"`
	MaxPacketBytes    int    `json:"maxPacketBytes"`
	ICETransport      string `json:"iceTransportPolicy"`
	Nodes             []node `json:"nodes"`
}

type node struct {
	NodeID     string      `json:"nodeId"`
	ProbeURL   string      `json:"probeUrl"`
	ExpiresAt  string      `json:"expiresAt"`
	Grant      string      `json:"grant"`
	ICEServers []iceServer `json:"iceServers"`
}

type iceServer struct {
	URLs       []string `json:"urls"`
	Username   string   `json:"username"`
	Credential string   `json:"credential"`
}

type report struct {
	Measurement       string       `json:"measurement"`
	NetworkGeneration string       `json:"networkGeneration"`
	GeneratedAt       string       `json:"generatedAt"`
	Nodes             []nodeReport `json:"nodes"`
}

type nodeReport struct {
	NodeID           string     `json:"nodeId"`
	Outcome          string     `json:"outcome"`
	Sent             int        `json:"sent"`
	Received         int        `json:"received"`
	SampleDurationMS float64    `json:"sampleDurationMs"`
	ConnectionMS     *float64   `json:"connectionMs,omitempty"`
	RTTMedianMS      *float64   `json:"rttMedianMs,omitempty"`
	RTTP95MS         *float64   `json:"rttP95Ms,omitempty"`
	JitterMS         *float64   `json:"jitterMs,omitempty"`
	SelectedPair     *pairProof `json:"selectedPair,omitempty"`
	CleanupCompleted bool       `json:"cleanupCompleted"`
	ErrorCode        string     `json:"errorCode,omitempty"`
}

type pairProof struct {
	LocalType      string `json:"localCandidateType"`
	RemoteType     string `json:"remoteCandidateType"`
	LocalProtocol  string `json:"localProtocol"`
	RemoteProtocol string `json:"remoteProtocol"`
	UDPRelayOnly   bool   `json:"udpRelayOnly"`
}

type description struct {
	Type string `json:"type"`
	SDP  string `json:"sdp"`
}

func main() {
	inputPath := flag.String("input", "-", "private options JSON path, or - for stdin")
	outputPath := flag.String("output", "-", "sanitized report JSON path, or - for stdout")
	flag.Parse()
	if flag.NArg() != 0 {
		exitError("invalid_arguments")
	}
	raw, err := readPrivateInput(*inputPath)
	if err != nil {
		exitError(errorCode(err))
	}
	var opts options
	if strictJSON(raw, &opts) != nil || validateOptions(opts, time.Now()) != nil {
		exitError("invalid_options")
	}

	results := make([]nodeReport, len(opts.Nodes))
	var wait sync.WaitGroup
	for index := range opts.Nodes {
		wait.Add(1)
		go func(index int) {
			defer wait.Done()
			results[index] = measure(opts, opts.Nodes[index])
		}(index)
	}
	wait.Wait()
	payload, err := json.MarshalIndent(report{
		Measurement: measurement, NetworkGeneration: opts.NetworkGeneration,
		GeneratedAt: time.Now().UTC().Format(time.RFC3339Nano), Nodes: results,
	}, "", "  ")
	if err != nil || writePrivateOutput(*outputPath, append(payload, '\n')) != nil {
		exitError("output_failed")
	}
}

func measure(opts options, target node) (result nodeReport) {
	result = nodeReport{NodeID: target.NodeID, Outcome: "network_error"}
	ctx, cancel := context.WithTimeout(context.Background(), time.Duration(opts.LifetimeMS)*time.Millisecond)
	defer cancel()
	configuration := webrtc.Configuration{ICETransportPolicy: webrtc.ICETransportPolicyRelay}
	for _, server := range target.ICEServers {
		configuration.ICEServers = append(configuration.ICEServers, webrtc.ICEServer{URLs: server.URLs, Username: server.Username, Credential: server.Credential})
	}
	peer, err := webrtc.NewPeerConnection(configuration)
	if err != nil {
		result.ErrorCode = "peer_create_failed"
		return
	}
	defer func() {
		_ = peer.Close()
		result.CleanupCompleted = true
	}()
	ordered, retransmits := false, uint16(0)
	channel, err := peer.CreateDataChannel(probeLabel, &webrtc.DataChannelInit{Ordered: &ordered, MaxRetransmits: &retransmits})
	if err != nil {
		result.ErrorCode = "channel_create_failed"
		return
	}
	defer channel.Close()

	opened := make(chan struct{})
	var openOnce sync.Once
	channel.OnOpen(func() { openOnce.Do(func() { close(opened) }) })
	collector := newEchoCollector()
	channel.OnMessage(func(message webrtc.DataChannelMessage) { collector.receive(message) })
	channel.OnError(func(error) { collector.fail("channel_failed") })

	started := time.Now()
	offer, err := peer.CreateOffer(nil)
	if err != nil {
		result.ErrorCode = "offer_failed"
		return
	}
	gathered := webrtc.GatheringCompletePromise(peer)
	if peer.SetLocalDescription(offer) != nil {
		result.ErrorCode = "local_description_failed"
		return
	}
	gatherTimer := time.NewTimer(2 * time.Second)
	select {
	case <-gathered:
		gatherTimer.Stop()
	case <-gatherTimer.C:
		result.Outcome, result.ErrorCode = "timeout", "ice_gather_timeout"
		return
	case <-ctx.Done():
		gatherTimer.Stop()
		result.Outcome, result.ErrorCode = "timeout", "lifetime_timeout"
		return
	}
	local := peer.LocalDescription()
	if local == nil || !completeUDPRelaySDP(local.SDP) {
		result.ErrorCode = "relay_candidate_unavailable"
		return
	}
	answer, code := exchange(ctx, target, local.SDP)
	if code != "" {
		result.ErrorCode = code
		return
	}
	if !completeUDPRelaySDP(answer) || peer.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeAnswer, SDP: answer}) != nil {
		result.ErrorCode = "remote_description_failed"
		return
	}
	select {
	case <-opened:
	case <-ctx.Done():
		result.Outcome, result.ErrorCode = "timeout", "connection_timeout"
		return
	}
	connection := durationMS(time.Since(started))
	result.ConnectionMS = &connection
	pair, err := peer.SCTP().Transport().ICETransport().GetSelectedCandidatePair()
	if err != nil || pair == nil || pair.Local == nil || pair.Remote == nil {
		result.ErrorCode = "selected_pair_unavailable"
		return
	}
	proof := pairProof{
		LocalType: pair.Local.Typ.String(), RemoteType: pair.Remote.Typ.String(),
		LocalProtocol: pair.Local.Protocol.String(), RemoteProtocol: pair.Remote.Protocol.String(),
	}
	proof.UDPRelayOnly = pair.Local.Typ == webrtc.ICECandidateTypeRelay && pair.Remote.Typ == webrtc.ICECandidateTypeRelay &&
		pair.Local.Protocol == webrtc.ICEProtocolUDP && pair.Remote.Protocol == webrtc.ICEProtocolUDP
	result.SelectedPair = &proof
	if !proof.UDPRelayOnly {
		result.ErrorCode = "selected_pair_not_udp_relay"
		return
	}

	sampleStart := time.Now()
	interval := time.Duration(opts.PacketIntervalMS) * time.Millisecond
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for sequence := 0; sequence < opts.MaxPackets; sequence++ {
		sentAt := monotonicMicroseconds()
		frame := makeFrame(uint32(sequence), sentAt)
		collector.record(uint32(sequence), sentAt)
		if channel.Send(frame) != nil {
			collector.fail("send_failed")
			break
		}
		result.Sent++
		if time.Since(sampleStart) >= time.Duration(opts.SampleDurationMS)*time.Millisecond {
			break
		}
		select {
		case <-ticker.C:
		case <-ctx.Done():
			preserveFailedSample(&result, collector, sampleStart, "timeout", "lifetime_timeout")
			return
		}
	}
	result.SampleDurationMS = durationMS(time.Since(sampleStart))
	select {
	case <-time.After(interval):
	case <-ctx.Done():
	}
	rtts, collectCode := collector.snapshot()
	result.Received = len(rtts)
	if collectCode != "" {
		result.ErrorCode = collectCode
		return
	}
	if result.Sent < 20 || result.Received == 0 || result.SampleDurationMS < float64(opts.SampleDurationMS) {
		result.ErrorCode = "insufficient_echoes"
		return
	}
	median, p95, jitter := summarize(rtts)
	result.RTTMedianMS, result.RTTP95MS, result.JitterMS = &median, &p95, &jitter
	result.Outcome = "ok"
	return
}

func preserveFailedSample(result *nodeReport, collector *echoCollector, sampleStart time.Time, outcome, code string) {
	rtts, collectCode := collector.snapshot()
	result.Outcome = outcome
	result.ErrorCode = code
	if collectCode != "" {
		result.ErrorCode = collectCode
	}
	result.Received = len(rtts)
	result.SampleDurationMS = durationMS(time.Since(sampleStart))
	// Failed reports deliberately omit RTT summaries; partial observations are not success evidence.
	result.RTTMedianMS = nil
	result.RTTP95MS = nil
	result.JitterMS = nil
}

func exchange(ctx context.Context, target node, offer string) (string, string) {
	body, _ := json.Marshal(description{Type: "offer", SDP: offer})
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, target.ProbeURL, bytes.NewReader(body))
	if err != nil {
		return "", "signaling_request_failed"
	}
	request.Header.Set("Authorization", "Bearer "+target.Grant)
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Accept", "application/json")
	client := &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	response, err := client.Do(request)
	if err != nil {
		return "", "signaling_network_failed"
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return "", "signaling_rejected"
	}
	raw, err := io.ReadAll(io.LimitReader(response.Body, 128*1024+1))
	var answer description
	if err != nil || len(raw) > 128*1024 || strictJSON(raw, &answer) != nil || answer.Type != "answer" || answer.SDP == "" {
		return "", "invalid_answer"
	}
	return answer.SDP, ""
}

type echoCollector struct {
	mu       sync.Mutex
	sent     map[uint32]uint64
	received map[uint32]struct{}
	rtts     []float64
	error    string
}

func newEchoCollector() *echoCollector {
	return &echoCollector{sent: map[uint32]uint64{}, received: map[uint32]struct{}{}}
}

func (c *echoCollector) record(sequence uint32, sentUS uint64) {
	c.mu.Lock()
	c.sent[sequence] = sentUS
	c.mu.Unlock()
}

func (c *echoCollector) receive(message webrtc.DataChannelMessage) {
	c.mu.Lock()
	defer c.mu.Unlock()
	sequence, sentUS, ok := parseFrame(message.Data)
	expected, exists := c.sent[sequence]
	_, duplicate := c.received[sequence]
	now := monotonicMicroseconds()
	if message.IsString || !ok || !exists || duplicate || expected != sentUS || now < sentUS {
		c.error = "invalid_echo"
		return
	}
	c.received[sequence] = struct{}{}
	c.rtts = append(c.rtts, float64(now-sentUS)/1000)
}

func (c *echoCollector) fail(code string) {
	c.mu.Lock()
	if c.error == "" {
		c.error = code
	}
	c.mu.Unlock()
}

func (c *echoCollector) snapshot() ([]float64, string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	return append([]float64(nil), c.rtts...), c.error
}

func makeFrame(sequence uint32, sentUS uint64) []byte {
	frame := make([]byte, frameBytes)
	copy(frame, "CCQ1")
	binary.BigEndian.PutUint32(frame[4:8], sequence)
	binary.BigEndian.PutUint64(frame[8:16], sentUS)
	return frame
}

func parseFrame(frame []byte) (uint32, uint64, bool) {
	if len(frame) != frameBytes || string(frame[:4]) != "CCQ1" {
		return 0, 0, false
	}
	sequence := binary.BigEndian.Uint32(frame[4:8])
	if sequence > 249 {
		return 0, 0, false
	}
	for _, value := range frame[16:] {
		if value != 0 {
			return 0, 0, false
		}
	}
	return sequence, binary.BigEndian.Uint64(frame[8:16]), true
}

func completeUDPRelaySDP(raw string) bool {
	var parsed sdp.SessionDescription
	if parsed.UnmarshalString(raw) != nil || len(parsed.MediaDescriptions) != 1 {
		return false
	}
	count, complete := 0, false
	for _, attribute := range parsed.MediaDescriptions[0].Attributes {
		switch attribute.Key {
		case "candidate":
			candidate, err := ice.UnmarshalCandidate(attribute.Value)
			if err != nil || candidate.Type() != ice.CandidateTypeRelay || !candidate.NetworkType().IsUDP() {
				return false
			}
			count++
		case "end-of-candidates":
			complete = attribute.Value == ""
		}
	}
	return count > 0 && complete
}

func summarize(values []float64) (float64, float64, float64) {
	sorted := append([]float64(nil), values...)
	sort.Float64s(sorted)
	differences := make([]float64, 0, len(values)-1)
	for index := 1; index < len(values); index++ {
		differences = append(differences, math.Abs(values[index]-values[index-1]))
	}
	sort.Float64s(differences)
	return percentile(sorted, .5), percentile(sorted, .95), percentileOrZero(differences, .5)
}

func percentile(sorted []float64, fraction float64) float64 {
	index := int(math.Ceil(float64(len(sorted))*fraction)) - 1
	if index < 0 {
		index = 0
	}
	return sorted[index]
}

func percentileOrZero(sorted []float64, fraction float64) float64 {
	if len(sorted) == 0 {
		return 0
	}
	return percentile(sorted, fraction)
}

func validateOptions(value options, now time.Time) error {
	if value.Measurement != measurement || value.LifetimeMS != 5000 || value.SampleDurationMS != 2000 ||
		value.PacketIntervalMS != 20 || value.MaxPackets != 250 || value.MaxPacketBytes != 512 ||
		value.ICETransport != "relay" || !generationPattern.MatchString(value.NetworkGeneration) ||
		len(value.Nodes) < 1 || len(value.Nodes) > 16 {
		return errors.New("invalid options")
	}
	seen := map[string]struct{}{}
	for _, target := range value.Nodes {
		if !nodeIDPattern.MatchString(target.NodeID) || len(target.Grant) < 32 || len(target.Grant) > 4096 {
			return errors.New("invalid node")
		}
		if _, exists := seen[target.NodeID]; exists {
			return errors.New("duplicate node")
		}
		seen[target.NodeID] = struct{}{}
		expires, err := time.Parse(time.RFC3339Nano, target.ExpiresAt)
		parsed, parseErr := url.Parse(target.ProbeURL)
		if err != nil || !expires.After(now) || parseErr != nil || parsed.Scheme != "https" || parsed.Host == "" || parsed.Path != probePath || parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" || len(target.ICEServers) != 1 {
			return errors.New("invalid node endpoint")
		}
		server := target.ICEServers[0]
		if len(server.URLs) != 1 || server.Username == "" || len(server.Username) > 1024 || server.Credential == "" || len(server.Credential) > 4096 || !validTurnUDPURL(server.URLs[0]) {
			return errors.New("invalid relay")
		}
	}
	return nil
}

func validTurnUDPURL(raw string) bool {
	match := turnUDPPattern.FindStringSubmatch(raw)
	if match == nil || strings.HasPrefix(match[1], ".") || strings.HasSuffix(match[1], ".") || strings.Contains(match[1], "..") {
		return false
	}
	port, err := strconv.Atoi(match[2])
	return err == nil && port > 0 && port <= 65535
}

func strictJSON(raw []byte, target any) error {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return err
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return errors.New("trailing JSON")
	}
	return nil
}

func readPrivateInput(path string) ([]byte, error) {
	if path == "-" {
		raw, err := io.ReadAll(io.LimitReader(os.Stdin, maxInput+1))
		if err != nil || len(raw) > maxInput {
			return nil, errors.New("input too large")
		}
		return raw, nil
	}
	info, err := os.Lstat(path)
	if err != nil || !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 || info.Mode().Perm()&0077 != 0 || info.Size() > maxInput {
		return nil, errors.New("unsafe input")
	}
	return os.ReadFile(path)
}

func writePrivateOutput(path string, raw []byte) error {
	if path == "-" {
		_, err := os.Stdout.Write(raw)
		return err
	}
	directory := filepath.Dir(path)
	temporary, err := os.CreateTemp(directory, ".quality-relay-probe-*")
	if err != nil {
		return err
	}
	temporaryPath := temporary.Name()
	defer os.Remove(temporaryPath)
	if err = temporary.Chmod(0600); err == nil {
		_, err = temporary.Write(raw)
	}
	if closeErr := temporary.Close(); err == nil {
		err = closeErr
	}
	if err == nil {
		err = os.Rename(temporaryPath, path)
	}
	return err
}

func durationMS(value time.Duration) float64 { return float64(value.Microseconds()) / 1000 }

func monotonicMicroseconds() uint64 { return uint64(time.Since(probeEpoch).Microseconds()) }

func errorCode(err error) string {
	if err == nil {
		return "unknown_error"
	}
	return "input_failed"
}

func exitError(code string) {
	_, _ = fmt.Fprintln(os.Stderr, code)
	os.Exit(2)
}
