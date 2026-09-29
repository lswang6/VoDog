package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"
	"time"

	"github.com/pion/rtp"
	"github.com/pion/webrtc/v4"
)

type fecTransparencyPacketEvidence struct {
	FixtureIndex int    `json:"fixtureIndex"`
	LogicalSeq   uint32 `json:"logicalSequence"`
	RTPSeq       uint16 `json:"rtpSequence"`
	TimestampUS  uint64 `json:"timestampUs"`
	RTPTimestamp uint32 `json:"rtpTimestamp"`
	PayloadSHA   string `json:"payloadSha256"`
}

type fecTransparencyEvidence struct {
	FixturePath   string                          `json:"fixturePath"`
	FixtureSHA256 string                          `json:"fixtureSha256"`
	PacketCount   int                             `json:"packetCount"`
	GapCount      int                             `json:"logicalGapCount"`
	Wrapped       bool                            `json:"rtpSequenceWrapped"`
	Packets       []fecTransparencyPacketEvidence `json:"packets"`
}

func TestFECNativePayloadRTPTransparency(t *testing.T) {
	fixture := os.Getenv("CC_MEDIA_FEC_TRANSPARENCY_FIXTURE")
	if fixture == "" {
		t.Skip("set CC_MEDIA_FEC_TRANSPARENCY_FIXTURE to an explicit native Opus fixture")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()

	opusPackets, err := loadBrowserProbePackets(fixture)
	if err != nil {
		t.Fatal(err)
	}
	fixtureRaw, err := os.ReadFile(fixture)
	if err != nil {
		t.Fatal(err)
	}
	fixtureHash := sha256.Sum256(fixtureRaw)

	secret := bytes.Repeat([]byte("f"), 32)
	bridge := &bridge{
		rooms:     map[string]*room{},
		verifier:  GrantVerifier{Secret: secret},
		recordDir: t.TempDir(),
	}
	server := httptest.NewServer(http.HandlerFunc(bridge.offer))
	defer server.Close()
	callID := "fec00000-0000-4000-8000-000000000001"
	defer bridge.closeRoom(callID, "test")

	gateway, err := webrtc.NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		t.Fatal(err)
	}
	defer gateway.Close()
	ordered := false
	retransmits := uint16(0)
	dc, err := gateway.CreateDataChannel("cellular-opus-v1", &webrtc.DataChannelInit{
		Ordered: &ordered, MaxRetransmits: &retransmits,
	})
	if err != nil {
		t.Fatal(err)
	}
	dcOpen := make(chan struct{})
	dc.OnOpen(func() { close(dcOpen) })

	client, err := webrtc.NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	if _, err := client.AddTransceiverFromKind(webrtc.RTPCodecTypeAudio, webrtc.RTPTransceiverInit{
		Direction: webrtc.RTPTransceiverDirectionRecvonly,
	}); err != nil {
		t.Fatal(err)
	}
	received := make(chan *rtp.Packet, 1)
	client.OnTrack(func(track *webrtc.TrackRemote, _ *webrtc.RTPReceiver) {
		for {
			packet, _, err := track.ReadRTP()
			if err != nil {
				return
			}
			select {
			case received <- packet:
			case <-ctx.Done():
				return
			}
		}
	})

	connectTransparencyPeer(t, ctx, gateway, server.URL, callID, "gateway", secret)
	connectTransparencyPeer(t, ctx, client, server.URL, callID, "client", secret)
	select {
	case <-dcOpen:
	case <-ctx.Done():
		t.Fatal("gateway DataChannel open timeout")
	}
	for (gateway.ConnectionState() != webrtc.PeerConnectionStateConnected ||
		client.ConnectionState() != webrtc.PeerConnectionStateConnected) && ctx.Err() == nil {
		time.Sleep(5 * time.Millisecond)
	}
	if ctx.Err() != nil {
		t.Fatalf("peer connection timeout: gateway=%s client=%s", gateway.ConnectionState(), client.ConnectionState())
	}

	const sourcePackets = 48
	skippedOffsets := map[int]bool{5: true, 17: true, 36: true}
	evidence := fecTransparencyEvidence{
		FixturePath:   fixture,
		FixtureSHA256: hex.EncodeToString(fixtureHash[:]),
		GapCount:      len(skippedOffsets),
		Packets:       make([]fecTransparencyPacketEvidence, 0, sourcePackets-len(skippedOffsets)),
	}
	var previousRTP uint16
	havePrevious := false
	for offset := 0; offset < sourcePackets; offset++ {
		if skippedOffsets[offset] {
			continue
		}
		logicalSeq := uint32(65520 + offset)
		timestampUS := uint64(5_000_000 + offset*20_000)
		payload := opusPackets[offset]
		message := encodePacket(Packet{
			Direction: 0, DurationMS: 20, Sequence: logicalSeq,
			TimestampUS: timestampUS, Opus: payload,
		})
		if err := dc.Send(message); err != nil {
			t.Fatalf("send logical sequence %d: %v", logicalSeq, err)
		}
		var got *rtp.Packet
		select {
		case got = <-received:
		case <-ctx.Done():
			t.Fatalf("RTP timeout after logical sequence %d", logicalSeq)
		}
		expectedSeq := uint16(logicalSeq)
		expectedTimestamp := uint32(timestampUS * 48 / 1000)
		wantHash := sha256.Sum256(payload)
		gotHash := sha256.Sum256(got.Payload)
		if got.SequenceNumber != expectedSeq || got.Timestamp != expectedTimestamp ||
			!bytes.Equal(got.Payload, payload) || gotHash != wantHash {
			t.Fatalf("RTP changed logical=%d: seq=%d want=%d timestamp=%d want=%d payloadSHA=%x want=%x",
				logicalSeq, got.SequenceNumber, expectedSeq, got.Timestamp, expectedTimestamp, gotHash, wantHash)
		}
		if havePrevious && previousRTP == ^uint16(0) && got.SequenceNumber == 0 {
			evidence.Wrapped = true
		}
		previousRTP = got.SequenceNumber
		havePrevious = true
		evidence.Packets = append(evidence.Packets, fecTransparencyPacketEvidence{
			FixtureIndex: offset,
			LogicalSeq:   logicalSeq,
			RTPSeq:       got.SequenceNumber,
			TimestampUS:  timestampUS,
			RTPTimestamp: got.Timestamp,
			PayloadSHA:   hex.EncodeToString(gotHash[:]),
		})
	}
	evidence.PacketCount = len(evidence.Packets)
	if !evidence.Wrapped {
		t.Fatal("RTP sequence did not demonstrate 65535 to 0 wrap")
	}
	if evidence.PacketCount != sourcePackets-len(skippedOffsets) {
		t.Fatalf("received %d verified packets", evidence.PacketCount)
	}
	if path := os.Getenv("CC_MEDIA_FEC_TRANSPARENCY_EVIDENCE_JSON"); path != "" {
		encoded, err := json.MarshalIndent(evidence, "", "  ")
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, append(encoded, '\n'), 0600); err != nil {
			t.Fatal(err)
		}
		t.Logf("RTP transparency evidence JSON: %s", path)
	}
	t.Logf("verified native Opus RTP transparency: packets=%d logicalGaps=%d wrapped=%v fixtureSHA256=%s",
		evidence.PacketCount, evidence.GapCount, evidence.Wrapped, evidence.FixtureSHA256)
}

func connectTransparencyPeer(t *testing.T, ctx context.Context, pc *webrtc.PeerConnection, endpoint, callID, role string, secret []byte) {
	t.Helper()
	offer, err := pc.CreateOffer(nil)
	if err != nil {
		t.Fatal(err)
	}
	gather := webrtc.GatheringCompletePromise(pc)
	if err := pc.SetLocalDescription(offer); err != nil {
		t.Fatal(err)
	}
	select {
	case <-gather:
	case <-ctx.Done():
		t.Fatalf("%s ICE gathering timeout", role)
	}
	body, err := json.Marshal(pc.LocalDescription())
	if err != nil {
		t.Fatal(err)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Authorization", "Bearer "+sign(Grant{
		CallID: callID, Role: role, MediaEpoch: 1, Expires: time.Now().Unix() + 30,
		Nonce: fmt.Sprintf("fec-transparency-%s-%d", role, time.Now().UnixNano()),
	}, secret))
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("%s offer: %v", role, err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		t.Fatalf("%s offer status=%d", role, res.StatusCode)
	}
	var answer webrtc.SessionDescription
	if err := json.NewDecoder(res.Body).Decode(&answer); err != nil {
		t.Fatal(err)
	}
	if err := pc.SetRemoteDescription(answer); err != nil {
		t.Fatal(err)
	}
}
