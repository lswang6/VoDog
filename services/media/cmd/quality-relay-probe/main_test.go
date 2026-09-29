package main

import (
	"encoding/binary"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func validOptions(now time.Time) options {
	return options{
		NetworkGeneration: "synthetic:1", Measurement: measurement, LifetimeMS: 5000,
		SampleDurationMS: 2000, PacketIntervalMS: 20, MaxPackets: 250, MaxPacketBytes: 512,
		ICETransport: "relay", Nodes: []node{{
			NodeID: "relay-primary", ProbeURL: "https://probe.example/webrtc-probe/offer",
			ExpiresAt: now.Add(30 * time.Second).UTC().Format(time.RFC3339Nano), Grant: "grant-at-least-thirty-two-bytes-long",
			ICEServers: []iceServer{{URLs: []string{"turn:relay.example:3478?transport=udp"}, Username: "u", Credential: "c"}},
		}},
	}
}

func TestReportCannotSerializeSecretsOrAddresses(t *testing.T) {
	payload, err := json.Marshal(report{
		Measurement: measurement, NetworkGeneration: "synthetic:1", Nodes: []nodeReport{{
			NodeID: "relay-primary", Outcome: "ok", Sent: 100, Received: 99, CleanupCompleted: true,
			SelectedPair: &pairProof{LocalType: "relay", RemoteType: "relay", LocalProtocol: "udp", RemoteProtocol: "udp", UDPRelayOnly: true},
		}},
	})
	if err != nil {
		t.Fatal(err)
	}
	for _, forbidden := range []string{"grant", "credential", "sdp", "probeUrl", "address"} {
		if strings.Contains(string(payload), forbidden) {
			t.Fatalf("sanitized report contains %q: %s", forbidden, payload)
		}
	}
}

func TestTimeoutPreservesObservedCountsAndDurationWithoutRTTClaims(t *testing.T) {
	collector := newEchoCollector()
	collector.rtts = []float64{10, 12, 11}
	median, p95, jitter := 11.0, 12.0, 1.0
	result := nodeReport{
		NodeID: "relay-primary", Outcome: "ok", Sent: 47, Received: 0,
		RTTMedianMS: &median, RTTP95MS: &p95, JitterMS: &jitter,
	}
	preserveFailedSample(&result, collector, time.Now().Add(-950*time.Millisecond), "timeout", "lifetime_timeout")
	if result.Outcome != "timeout" || result.ErrorCode != "lifetime_timeout" || result.Sent != 47 || result.Received != 3 || result.SampleDurationMS < 900 {
		t.Fatalf("partial timeout evidence was lost: %+v", result)
	}
	if result.RTTMedianMS != nil || result.RTTP95MS != nil || result.JitterMS != nil {
		t.Fatalf("timeout claimed success RTT fields: %+v", result)
	}
}

func TestFrameContractAndSummary(t *testing.T) {
	frame := makeFrame(17, 0xfedcba9876543210)
	sequence, sent, ok := parseFrame(frame)
	if !ok || sequence != 17 || sent != 0xfedcba9876543210 || len(frame) != 32 || string(frame[:4]) != "CCQ1" {
		t.Fatalf("sequence=%d sent=%x ok=%v", sequence, sent, ok)
	}
	for _, mutate := range []func([]byte){
		func(value []byte) { value[0] = 'X' },
		func(value []byte) { binary.BigEndian.PutUint32(value[4:8], 250) },
		func(value []byte) { value[16] = 1 },
	} {
		candidate := append([]byte(nil), frame...)
		mutate(candidate)
		if _, _, valid := parseFrame(candidate); valid {
			t.Fatal("invalid frame accepted")
		}
	}
	median, p95, jitter := summarize([]float64{10, 12, 11, 30})
	if median != 11 || p95 != 30 || jitter != 2 {
		t.Fatalf("median=%v p95=%v jitter=%v", median, p95, jitter)
	}
}

func TestValidateOptionsStrictRelayShape(t *testing.T) {
	now := time.Now()
	valid := validOptions(now)
	if err := validateOptions(valid, now); err != nil {
		t.Fatal(err)
	}
	cases := []func(*options){
		func(value *options) { value.Measurement = "other" },
		func(value *options) { value.Nodes[0].ProbeURL = "http://probe.example/webrtc-probe/offer" },
		func(value *options) { value.Nodes[0].ProbeURL = "https://probe.example/other" },
		func(value *options) { value.Nodes[0].ICEServers[0].URLs[0] = "turns:relay.example:5349?transport=tcp" },
		func(value *options) { value.Nodes[0].ExpiresAt = now.Format(time.RFC3339Nano) },
		func(value *options) { value.Nodes = append(value.Nodes, value.Nodes[0]) },
	}
	for index, mutate := range cases {
		candidate := validOptions(now)
		mutate(&candidate)
		if validateOptions(candidate, now) == nil {
			t.Fatalf("invalid option case %d accepted", index)
		}
	}
}

func TestPrivateInputAndOutput(t *testing.T) {
	directory := t.TempDir()
	input := filepath.Join(directory, "options.json")
	if err := os.WriteFile(input, []byte("{}"), 0600); err != nil {
		t.Fatal(err)
	}
	if raw, err := readPrivateInput(input); err != nil || string(raw) != "{}" {
		t.Fatalf("raw=%q err=%v", raw, err)
	}
	if err := os.Chmod(input, 0644); err != nil {
		t.Fatal(err)
	}
	if _, err := readPrivateInput(input); err == nil {
		t.Fatal("world-readable options were accepted")
	}
	link := filepath.Join(directory, "link.json")
	if err := os.Symlink(input, link); err != nil {
		t.Fatal(err)
	}
	if _, err := readPrivateInput(link); err == nil {
		t.Fatal("symlink options were accepted")
	}
	output := filepath.Join(directory, "report.json")
	if err := writePrivateOutput(output, []byte("sanitized")); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(output)
	if err != nil || info.Mode().Perm() != 0600 {
		t.Fatalf("mode=%v err=%v", info.Mode().Perm(), err)
	}
}

func TestCompleteUDPRelaySDP(t *testing.T) {
	base := "v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\nc=IN IP4 0.0.0.0\r\n"
	relay := "a=candidate:1 1 udp 16777215 203.0.113.10 50000 typ relay raddr 0.0.0.0 rport 0\r\n"
	if !completeUDPRelaySDP(base + relay + "a=end-of-candidates\r\n") {
		t.Fatal("valid relay SDP rejected")
	}
	for _, suffix := range []string{
		relay,
		"a=candidate:1 1 udp 2130706431 192.0.2.10 50000 typ host\r\na=end-of-candidates\r\n",
		"a=candidate:bad\r\na=end-of-candidates\r\n",
	} {
		if completeUDPRelaySDP(base + suffix) {
			t.Fatal("invalid relay SDP accepted")
		}
	}
}
