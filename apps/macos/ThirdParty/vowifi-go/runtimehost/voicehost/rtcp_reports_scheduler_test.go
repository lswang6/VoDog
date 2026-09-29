package voicehost

import (
	"context"
	"net"
	"testing"
	"time"

	"github.com/pion/rtcp"
)

func TestRTPRelaySessionSchedulesReceiverReportsUntilStopped(t *testing.T) {
	clientPeer := listenTestUDP(t)
	defer clientPeer.Close()
	clientRTCPPeer := listenTestUDP(t)
	defer clientRTCPPeer.Close()
	imsPeer := listenTestUDP(t)
	defer imsPeer.Close()
	imsRTCPPeer := listenTestUDP(t)
	defer imsRTCPPeer.Close()

	clientAddr := clientPeer.LocalAddr().(*net.UDPAddr)
	clientRTCPAddr := clientRTCPPeer.LocalAddr().(*net.UDPAddr)
	imsAddr := imsPeer.LocalAddr().(*net.UDPAddr)
	imsRTCPAddr := imsRTCPPeer.LocalAddr().(*net.UDPAddr)
	relay, err := NewRTPRelaySession(context.Background(), RTPRelayConfig{
		ClientListenIP:    "127.0.0.1",
		ClientAdvertiseIP: "127.0.0.1",
		IMSListenIP:       "127.0.0.1",
		IMSAdvertiseIP:    "127.0.0.1",
		IMSRTPClockRate:   8000,
		RTCPReportSchedule: RTPRelayRTCPReportScheduleConfig{
			Enabled:         true,
			Interval:        60 * time.Millisecond,
			ClientToIMS:     true,
			Kind:            RTCPReportKindReceiver,
			ClientToIMSSSRC: 0x33333333,
		},
	}, SDPInfo{ConnectionIP: "127.0.0.1", MediaPort: clientAddr.Port, RTCPPort: clientRTCPAddr.Port})
	if err != nil {
		t.Fatalf("NewRTPRelaySession() error = %v", err)
	}
	defer relay.Close()
	if err := relay.SetIMSRemote(SDPInfo{ConnectionIP: "127.0.0.1", MediaPort: imsAddr.Port, RTCPPort: imsRTCPAddr.Port}); err != nil {
		t.Fatalf("SetIMSRemote() error = %v", err)
	}

	imsEndpoint := udpAddrFromSDP(t, relay.IMSEndpoint())
	for _, seq := range []uint16{10, 12} {
		packet := testRTPPacket(seq, 0x22222222, []byte{byte(seq)})
		if _, err := imsPeer.WriteToUDP(packet, imsEndpoint); err != nil {
			t.Fatalf("ims WriteToUDP(%d) error = %v", seq, err)
		}
		if got, _ := readTestUDP(t, clientPeer); len(got) == 0 {
			t.Fatalf("client got empty RTP packet for seq=%d", seq)
		}
	}
	_ = waitRelayStats(t, relay, func(stats RTPRelayStats) bool {
		return len(stats.IMSToClientRTPStreams) == 1 && stats.IMSToClientRTPStreams[0].LostPackets == 1
	})

	packets := readRTCPPacketsUntil(t, imsRTCPPeer, func(packets []rtcp.Packet) bool {
		rr := firstReceiverReport(packets)
		return rr != nil && rr.SSRC == 0x33333333 && len(rr.Reports) == 1
	})
	rr := firstReceiverReport(packets)
	report := rr.Reports[0]
	if report.SSRC != 0x22222222 || report.TotalLost != 1 || report.LastSequenceNumber != 12 {
		t.Fatalf("scheduled receiver report=%+v block=%+v", rr, report)
	}

	relay.StopRTCPReportSchedule()
	drainTestUDP(t, imsRTCPPeer)
	expectNoTestUDP(t, imsRTCPPeer)
}

func TestRTPRelaySessionSchedulesSenderReportsWithSourceDescription(t *testing.T) {
	clientPeer := listenTestUDP(t)
	defer clientPeer.Close()
	clientRTCPPeer := listenTestUDP(t)
	defer clientRTCPPeer.Close()
	imsPeer := listenTestUDP(t)
	defer imsPeer.Close()
	imsRTCPPeer := listenTestUDP(t)
	defer imsRTCPPeer.Close()

	clientAddr := clientPeer.LocalAddr().(*net.UDPAddr)
	clientRTCPAddr := clientRTCPPeer.LocalAddr().(*net.UDPAddr)
	imsAddr := imsPeer.LocalAddr().(*net.UDPAddr)
	imsRTCPAddr := imsRTCPPeer.LocalAddr().(*net.UDPAddr)
	relay, err := NewRTPRelaySession(context.Background(), RTPRelayConfig{
		ClientListenIP:     "127.0.0.1",
		ClientAdvertiseIP:  "127.0.0.1",
		IMSListenIP:        "127.0.0.1",
		IMSAdvertiseIP:     "127.0.0.1",
		ClientRTPClockRate: 8000,
		RTCPReportSchedule: RTPRelayRTCPReportScheduleConfig{
			Enabled:            true,
			Interval:           60 * time.Millisecond,
			ClientToIMS:        true,
			Kind:               RTCPReportKindSender,
			ClientToIMSSSRC:    0x61626364,
			ClientToIMSCNAME:   "session-61626364",
			ClientToIMSRTPTime: 0x10203040,
		},
	}, SDPInfo{ConnectionIP: "127.0.0.1", MediaPort: clientAddr.Port, RTCPPort: clientRTCPAddr.Port})
	if err != nil {
		t.Fatalf("NewRTPRelaySession() error = %v", err)
	}
	defer relay.Close()
	if err := relay.SetIMSRemote(SDPInfo{ConnectionIP: "127.0.0.1", MediaPort: imsAddr.Port, RTCPPort: imsRTCPAddr.Port}); err != nil {
		t.Fatalf("SetIMSRemote() error = %v", err)
	}

	clientEndpoint := udpAddrFromSDP(t, relay.ClientEndpoint())
	var sentBytes int
	for _, seq := range []uint16{20, 21} {
		packet := testRTPPacket(seq, 0x11111111, []byte{byte(seq)})
		sentBytes += len(packet)
		if _, err := clientPeer.WriteToUDP(packet, clientEndpoint); err != nil {
			t.Fatalf("client WriteToUDP(%d) error = %v", seq, err)
		}
		if got, _ := readTestUDP(t, imsPeer); len(got) == 0 {
			t.Fatalf("IMS got empty RTP packet for seq=%d", seq)
		}
	}
	_ = waitRelayStats(t, relay, func(stats RTPRelayStats) bool {
		return stats.ClientToIMSRTPPackets == 2
	})

	packets := readRTCPPacketsUntil(t, imsRTCPPeer, func(packets []rtcp.Packet) bool {
		sr := firstSenderReport(packets)
		return sr != nil && sr.SSRC == 0x61626364
	})
	sr := firstSenderReport(packets)
	if sr.PacketCount != 2 || sr.OctetCount != uint32(sentBytes) || sr.RTPTime == 0 {
		t.Fatalf("scheduled sender report=%+v sentBytes=%d", sr, sentBytes)
	}
	sdes := firstSourceDescription(packets)
	if sdes == nil || len(sdes.Chunks) != 1 || len(sdes.Chunks[0].Items) != 1 ||
		sdes.Chunks[0].Source != 0x61626364 || sdes.Chunks[0].Items[0].Type != rtcp.SDESCNAME ||
		sdes.Chunks[0].Items[0].Text != "session-61626364" {
		t.Fatalf("scheduled source description=%+v", sdes)
	}
}

func readRTCPPacketsUntil(t *testing.T, conn *net.UDPConn, pred func([]rtcp.Packet) bool) []rtcp.Packet {
	t.Helper()
	deadline := time.Now().Add(time.Second)
	buf := make([]byte, 256)
	for time.Now().Before(deadline) {
		if err := conn.SetReadDeadline(time.Now().Add(50 * time.Millisecond)); err != nil {
			t.Fatalf("SetReadDeadline() error = %v", err)
		}
		n, _, err := conn.ReadFromUDP(buf)
		if err != nil {
			if netErr, ok := err.(net.Error); ok && netErr.Timeout() {
				continue
			}
			t.Fatalf("ReadFromUDP() error = %v", err)
		}
		packets, err := rtcp.Unmarshal(buf[:n])
		if err != nil {
			t.Fatalf("rtcp.Unmarshal() error = %v packet=%x", err, buf[:n])
		}
		if pred(packets) {
			return packets
		}
	}
	t.Fatal("timed out waiting for matching RTCP packets")
	return nil
}

func drainTestUDP(t *testing.T, conn *net.UDPConn) {
	t.Helper()
	buf := make([]byte, 256)
	for {
		if err := conn.SetReadDeadline(time.Now().Add(10 * time.Millisecond)); err != nil {
			t.Fatalf("SetReadDeadline() error = %v", err)
		}
		if _, _, err := conn.ReadFromUDP(buf); err != nil {
			if netErr, ok := err.(net.Error); ok && netErr.Timeout() {
				return
			}
			t.Fatalf("ReadFromUDP() error = %v", err)
		}
	}
}

func firstReceiverReport(packets []rtcp.Packet) *rtcp.ReceiverReport {
	for _, packet := range packets {
		if rr, ok := packet.(*rtcp.ReceiverReport); ok {
			return rr
		}
	}
	return nil
}

func firstSenderReport(packets []rtcp.Packet) *rtcp.SenderReport {
	for _, packet := range packets {
		if sr, ok := packet.(*rtcp.SenderReport); ok {
			return sr
		}
	}
	return nil
}

func firstSourceDescription(packets []rtcp.Packet) *rtcp.SourceDescription {
	for _, packet := range packets {
		if sdes, ok := packet.(*rtcp.SourceDescription); ok {
			return sdes
		}
	}
	return nil
}
