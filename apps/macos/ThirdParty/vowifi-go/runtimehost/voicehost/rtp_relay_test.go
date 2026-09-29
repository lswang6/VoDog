package voicehost

import (
	"bytes"
	"context"
	"errors"
	"net"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/pion/rtcp"
)

func TestRTPRelaySessionForwardsBidirectionalPackets(t *testing.T) {
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
	}, SDPInfo{ConnectionIP: "127.0.0.1", MediaPort: clientAddr.Port, RTCPPort: clientRTCPAddr.Port})
	if err != nil {
		t.Fatalf("NewRTPRelaySession() error = %v", err)
	}
	defer relay.Close()
	if err := relay.SetIMSRemote(SDPInfo{ConnectionIP: "127.0.0.1", MediaPort: imsAddr.Port, RTCPPort: imsRTCPAddr.Port}); err != nil {
		t.Fatalf("SetIMSRemote() error = %v", err)
	}

	clientEndpoint := udpAddrFromSDP(t, relay.ClientEndpoint())
	clientRTCPEndpoint := udpRTCPAddrFromSDP(t, relay.ClientEndpoint())
	imsEndpoint := udpAddrFromSDP(t, relay.IMSEndpoint())
	imsRTCPEndpoint := udpRTCPAddrFromSDP(t, relay.IMSEndpoint())

	if _, err := clientPeer.WriteToUDP([]byte{0x11, 0x22, 0x33}, clientEndpoint); err != nil {
		t.Fatalf("client WriteToUDP() error = %v", err)
	}
	got, from := readTestUDP(t, imsPeer)
	if string(got) != string([]byte{0x11, 0x22, 0x33}) {
		t.Fatalf("IMS got=%x", got)
	}
	if from.Port != imsEndpoint.Port {
		t.Fatalf("IMS packet source port=%d, want relay IMS port %d", from.Port, imsEndpoint.Port)
	}

	if _, err := imsPeer.WriteToUDP([]byte{0x44, 0x55}, imsEndpoint); err != nil {
		t.Fatalf("ims WriteToUDP() error = %v", err)
	}
	got, from = readTestUDP(t, clientPeer)
	if string(got) != string([]byte{0x44, 0x55}) {
		t.Fatalf("client got=%x", got)
	}
	if from.Port != clientEndpoint.Port {
		t.Fatalf("client packet source port=%d, want relay client port %d", from.Port, clientEndpoint.Port)
	}

	if _, err := clientRTCPPeer.WriteToUDP([]byte{0x81, 0xc9}, clientRTCPEndpoint); err != nil {
		t.Fatalf("client RTCP WriteToUDP() error = %v", err)
	}
	got, from = readTestUDP(t, imsRTCPPeer)
	if string(got) != string([]byte{0x81, 0xc9}) {
		t.Fatalf("IMS RTCP got=%x", got)
	}
	if from.Port != imsRTCPEndpoint.Port {
		t.Fatalf("IMS RTCP packet source port=%d, want relay IMS RTCP port %d", from.Port, imsRTCPEndpoint.Port)
	}

	if _, err := imsRTCPPeer.WriteToUDP([]byte{0x82, 0xca, 0x00}, imsRTCPEndpoint); err != nil {
		t.Fatalf("IMS RTCP WriteToUDP() error = %v", err)
	}
	got, from = readTestUDP(t, clientRTCPPeer)
	if string(got) != string([]byte{0x82, 0xca, 0x00}) {
		t.Fatalf("client RTCP got=%x", got)
	}
	if from.Port != clientRTCPEndpoint.Port {
		t.Fatalf("client RTCP packet source port=%d, want relay client RTCP port %d", from.Port, clientRTCPEndpoint.Port)
	}

	stats := relay.Stats()
	if stats.ClientToIMSRTPPackets != 1 || stats.IMSToClientRTPPackets != 1 || stats.ClientToIMSRTCPPackets != 1 || stats.IMSToClientRTCPPackets != 1 {
		t.Fatalf("stats packets=%+v", stats)
	}
	if stats.ClientToIMSRTPBytes != 3 || stats.IMSToClientRTPBytes != 2 || stats.ClientToIMSRTCPBytes != 2 || stats.IMSToClientRTCPBytes != 3 {
		t.Fatalf("stats=%+v", stats)
	}
}

func TestRTPRelaySessionAppliesSDPMediaDirection(t *testing.T) {
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
	}, SDPInfo{ConnectionIP: "127.0.0.1", MediaPort: clientAddr.Port, RTCPPort: clientRTCPAddr.Port, Direction: "sendrecv"})
	if err != nil {
		t.Fatalf("NewRTPRelaySession() error = %v", err)
	}
	defer relay.Close()
	if err := relay.SetIMSRemote(SDPInfo{ConnectionIP: "127.0.0.1", MediaPort: imsAddr.Port, RTCPPort: imsRTCPAddr.Port, Direction: "sendrecv"}); err != nil {
		t.Fatalf("SetIMSRemote() error = %v", err)
	}
	clientEndpoint := udpAddrFromSDP(t, relay.ClientEndpoint())
	clientRTCPEndpoint := udpRTCPAddrFromSDP(t, relay.ClientEndpoint())
	imsEndpoint := udpAddrFromSDP(t, relay.IMSEndpoint())
	imsRTCPEndpoint := udpRTCPAddrFromSDP(t, relay.IMSEndpoint())

	if _, err := clientPeer.WriteToUDP([]byte{0x10}, clientEndpoint); err != nil {
		t.Fatalf("client initial WriteToUDP() error = %v", err)
	}
	if got, _ := readTestUDP(t, imsPeer); !bytes.Equal(got, []byte{0x10}) {
		t.Fatalf("IMS initial got=%x", got)
	}

	if err := relay.SetClientRemote(SDPInfo{ConnectionIP: "127.0.0.1", MediaPort: clientAddr.Port, RTCPPort: clientRTCPAddr.Port, Direction: "recvonly"}); err != nil {
		t.Fatalf("SetClientRemote(recvonly) error = %v", err)
	}
	if _, err := clientPeer.WriteToUDP([]byte{0x11}, clientEndpoint); err != nil {
		t.Fatalf("client recvonly WriteToUDP() error = %v", err)
	}
	expectNoTestUDP(t, imsPeer)

	if _, err := imsPeer.WriteToUDP([]byte{0x22}, imsEndpoint); err != nil {
		t.Fatalf("ims WriteToUDP() error = %v", err)
	}
	if got, _ := readTestUDP(t, clientPeer); !bytes.Equal(got, []byte{0x22}) {
		t.Fatalf("client recvonly got=%x", got)
	}

	clientRTCP := testRTCPPacket(0x11111111)
	if _, err := clientRTCPPeer.WriteToUDP(clientRTCP, clientRTCPEndpoint); err != nil {
		t.Fatalf("client RTCP during recvonly WriteToUDP() error = %v", err)
	}
	if got, _ := readTestUDP(t, imsRTCPPeer); !bytes.Equal(got, clientRTCP) {
		t.Fatalf("IMS RTCP during recvonly got=%x, want %x", got, clientRTCP)
	}
	imsRTCP := testRTCPPacket(0x22222222)
	if _, err := imsRTCPPeer.WriteToUDP(imsRTCP, imsRTCPEndpoint); err != nil {
		t.Fatalf("ims RTCP during recvonly WriteToUDP() error = %v", err)
	}
	if got, _ := readTestUDP(t, clientRTCPPeer); !bytes.Equal(got, imsRTCP) {
		t.Fatalf("client RTCP during recvonly got=%x, want %x", got, imsRTCP)
	}

	if err := relay.SetIMSRemote(SDPInfo{ConnectionIP: "0.0.0.0", MediaPort: imsAddr.Port}); err != nil {
		t.Fatalf("SetIMSRemote(0.0.0.0) error = %v", err)
	}
	if _, err := clientPeer.WriteToUDP([]byte{0x12}, clientEndpoint); err != nil {
		t.Fatalf("client zero-target WriteToUDP() error = %v", err)
	}
	expectNoTestUDP(t, imsPeer)
	if err := relay.SetIMSRemote(SDPInfo{ConnectionIP: "127.0.0.1", MediaPort: 0, Direction: "inactive"}); err != nil {
		t.Fatalf("SetIMSRemote(port 0) error = %v", err)
	}
	if _, err := clientPeer.WriteToUDP([]byte{0x13}, clientEndpoint); err != nil {
		t.Fatalf("client disabled-port WriteToUDP() error = %v", err)
	}
	expectNoTestUDP(t, imsPeer)

	stats := waitRelayStats(t, relay, func(stats RTPRelayStats) bool {
		return stats.ClientToIMSRTPPackets == 1 && stats.ClientToIMSRTPDrops >= 1 &&
			stats.IMSToClientRTPPackets == 1 && stats.ClientToIMSRTCPPackets == 1 &&
			stats.IMSToClientRTCPPackets == 1
	})
	if stats.ClientToIMSRTPPackets != 1 || stats.ClientToIMSRTPDrops < 1 || stats.IMSToClientRTPPackets != 1 ||
		stats.ClientToIMSRTCPPackets != 1 || stats.IMSToClientRTCPPackets != 1 {
		t.Fatalf("direction stats=%+v", stats)
	}
}

func TestRTPRelaySessionRewritesSDP(t *testing.T) {
	clientPeer := listenTestUDP(t)
	defer clientPeer.Close()
	clientAddr := clientPeer.LocalAddr().(*net.UDPAddr)
	relay, err := NewRTPRelaySession(context.Background(), RTPRelayConfig{
		ClientListenIP:    "127.0.0.1",
		ClientAdvertiseIP: "198.51.100.10",
		IMSListenIP:       "127.0.0.1",
		IMSAdvertiseIP:    "203.0.113.10",
	}, SDPInfo{ConnectionIP: "127.0.0.1", MediaPort: clientAddr.Port, RTCPPort: clientAddr.Port + 1, Payloads: []int{0, 101}, Direction: "sendrecv"})
	if err != nil {
		t.Fatalf("NewRTPRelaySession() error = %v", err)
	}
	defer relay.Close()

	offer, err := ParseSDP(relay.IMSOfferSDP(SDPInfo{ConnectionIP: "127.0.0.1", MediaPort: clientAddr.Port, Payloads: []int{0, 101}}))
	if err != nil {
		t.Fatalf("ParseSDP(offer) error = %v", err)
	}
	if offer.ConnectionIP != "203.0.113.10" || offer.MediaPort != relay.IMSEndpoint().MediaPort ||
		offer.RTCPIP != "203.0.113.10" || offer.RTCPPort != relay.IMSEndpoint().RTCPPort {
		t.Fatalf("offer=%+v relayIMS=%+v", offer, relay.IMSEndpoint())
	}
	answer, err := ParseSDP(relay.ClientAnswerSDP(SDPInfo{ConnectionIP: "192.0.2.20", MediaPort: 49170, RTCPPort: 49171, Payloads: []int{0}}))
	if err != nil {
		t.Fatalf("ParseSDP(answer) error = %v", err)
	}
	if answer.ConnectionIP != "198.51.100.10" || answer.MediaPort != relay.ClientEndpoint().MediaPort ||
		answer.RTCPIP != "198.51.100.10" || answer.RTCPPort != relay.ClientEndpoint().RTCPPort {
		t.Fatalf("answer=%+v relayClient=%+v", answer, relay.ClientEndpoint())
	}
}

func TestRTPRelaySessionPreservesHeldSDPWhenAdvertising(t *testing.T) {
	clientPeer := listenTestUDP(t)
	defer clientPeer.Close()
	clientAddr := clientPeer.LocalAddr().(*net.UDPAddr)
	relay, err := NewRTPRelaySession(context.Background(), RTPRelayConfig{
		ClientListenIP:    "127.0.0.1",
		ClientAdvertiseIP: "198.51.100.10",
		IMSListenIP:       "127.0.0.1",
		IMSAdvertiseIP:    "203.0.113.10",
	}, SDPInfo{ConnectionIP: "127.0.0.1", MediaPort: clientAddr.Port, RTCPPort: clientAddr.Port + 1, Payloads: []int{0}, Direction: "sendrecv"})
	if err != nil {
		t.Fatalf("NewRTPRelaySession() error = %v", err)
	}
	defer relay.Close()

	heldPort := 4002
	for heldPort == relay.IMSEndpoint().MediaPort || heldPort+1 == relay.IMSEndpoint().RTCPPort {
		heldPort += 2
	}
	heldOfferRaw := string(relay.IMSOfferSDP(SDPInfo{
		ConnectionIP: "0.0.0.0",
		MediaPort:    heldPort,
		RTCPPort:     heldPort + 1,
		Payloads:     []int{0},
		Direction:    "inactive",
	}))
	heldOffer, err := ParseSDP([]byte(heldOfferRaw))
	if err != nil {
		t.Fatalf("ParseSDP(held offer) error = %v", err)
	}
	if heldOffer.ConnectionIP != "0.0.0.0" || heldOffer.MediaPort != heldPort || heldOffer.Direction != "inactive" {
		t.Fatalf("held offer=%+v", heldOffer)
	}
	if strings.Contains(heldOfferRaw, "203.0.113.10") ||
		strings.Contains(heldOfferRaw, "m=audio "+strconv.Itoa(relay.IMSEndpoint().MediaPort)+" ") ||
		strings.Contains(heldOfferRaw, "a=rtcp:"+strconv.Itoa(relay.IMSEndpoint().RTCPPort)) {
		t.Fatalf("held offer leaked relay IMS endpoint:\n%s", heldOfferRaw)
	}

	disabledAnswerRaw := string(relay.ClientAnswerSDP(SDPInfo{
		ConnectionIP: "192.0.2.20",
		MediaPort:    0,
		Payloads:     []int{0},
	}))
	disabledAnswer, err := ParseSDP([]byte(disabledAnswerRaw))
	if err != nil {
		t.Fatalf("ParseSDP(disabled answer) error = %v", err)
	}
	if disabledAnswer.ConnectionIP != "192.0.2.20" || disabledAnswer.MediaPort != 0 || disabledAnswer.Direction != "inactive" {
		t.Fatalf("disabled answer=%+v", disabledAnswer)
	}
	if disabledAnswer.RTCPPort != 0 ||
		strings.Contains(disabledAnswerRaw, "198.51.100.10") ||
		strings.Contains(disabledAnswerRaw, "m=audio "+strconv.Itoa(relay.ClientEndpoint().MediaPort)+" ") ||
		strings.Contains(disabledAnswerRaw, "a=rtcp:"+strconv.Itoa(relay.ClientEndpoint().RTCPPort)) {
		t.Fatalf("disabled answer leaked relay client endpoint:\n%s", disabledAnswerRaw)
	}

	inactivePort := 49170
	for inactivePort == relay.ClientEndpoint().MediaPort || inactivePort+1 == relay.ClientEndpoint().RTCPPort {
		inactivePort += 2
	}
	inactiveAnswerRaw := string(relay.ClientAnswerSDP(SDPInfo{
		ConnectionIP: "192.0.2.30",
		MediaPort:    inactivePort,
		RTCPPort:     inactivePort + 1,
		Payloads:     []int{0},
		Direction:    "inactive",
	}))
	inactiveAnswer, err := ParseSDP([]byte(inactiveAnswerRaw))
	if err != nil {
		t.Fatalf("ParseSDP(inactive answer) error = %v", err)
	}
	if inactiveAnswer.ConnectionIP != "192.0.2.30" || inactiveAnswer.MediaPort != inactivePort ||
		inactiveAnswer.RTCPPort != inactivePort+1 || inactiveAnswer.Direction != "inactive" {
		t.Fatalf("inactive answer=%+v", inactiveAnswer)
	}
	if strings.Contains(inactiveAnswerRaw, "198.51.100.10") ||
		strings.Contains(inactiveAnswerRaw, "m=audio "+strconv.Itoa(relay.ClientEndpoint().MediaPort)+" ") ||
		strings.Contains(inactiveAnswerRaw, "a=rtcp:"+strconv.Itoa(relay.ClientEndpoint().RTCPPort)) {
		t.Fatalf("inactive answer leaked relay client endpoint:\n%s", inactiveAnswerRaw)
	}
}

func TestRTPRelaySessionAppliesSRTPTransforms(t *testing.T) {
	clientPeer := listenTestUDP(t)
	defer clientPeer.Close()
	clientRTCPPeer := listenTestUDP(t)
	defer clientRTCPPeer.Close()
	imsPeer := listenTestUDP(t)
	defer imsPeer.Close()
	imsRTCPPeer := listenTestUDP(t)
	defer imsRTCPPeer.Close()
	media, err := NewSRTPMediaSession(testSRTPMediaConfig())
	if err != nil {
		t.Fatalf("NewSRTPMediaSession() error = %v", err)
	}
	clientAddr := clientPeer.LocalAddr().(*net.UDPAddr)
	clientRTCPAddr := clientRTCPPeer.LocalAddr().(*net.UDPAddr)
	imsAddr := imsPeer.LocalAddr().(*net.UDPAddr)
	imsRTCPAddr := imsRTCPPeer.LocalAddr().(*net.UDPAddr)
	relay, err := NewRTPRelaySession(context.Background(), RTPRelayConfig{
		ClientListenIP:    "127.0.0.1",
		ClientAdvertiseIP: "127.0.0.1",
		IMSListenIP:       "127.0.0.1",
		IMSAdvertiseIP:    "127.0.0.1",
		Transforms:        media.RelayTransforms(),
	}, SDPInfo{ConnectionIP: "127.0.0.1", MediaPort: clientAddr.Port, RTCPPort: clientRTCPAddr.Port})
	if err != nil {
		t.Fatalf("NewRTPRelaySession() error = %v", err)
	}
	defer relay.Close()
	if err := relay.SetIMSRemote(SDPInfo{ConnectionIP: "127.0.0.1", MediaPort: imsAddr.Port, RTCPPort: imsRTCPAddr.Port}); err != nil {
		t.Fatalf("SetIMSRemote() error = %v", err)
	}
	clientEndpoint := udpAddrFromSDP(t, relay.ClientEndpoint())
	imsEndpoint := udpAddrFromSDP(t, relay.IMSEndpoint())

	clientPlain := testRTPPacket(31, 0x11111111, []byte{0x01, 0x02, 0x03})
	clientProtected, err := media.ProtectClientRTP(clientPlain)
	if err != nil {
		t.Fatalf("ProtectClientRTP() error = %v", err)
	}
	if _, err := clientPeer.WriteToUDP(clientProtected, clientEndpoint); err != nil {
		t.Fatalf("client WriteToUDP() error = %v", err)
	}
	got, _ := readTestUDP(t, imsPeer)
	if bytes.Equal(got, clientPlain) || bytes.Equal(got, clientProtected) {
		t.Fatalf("IMS got untransformed packet=%x", got)
	}
	gotPlain, err := media.UnprotectIMSRTP(got)
	if err != nil {
		t.Fatalf("UnprotectIMSRTP() error = %v", err)
	}
	if !bytes.Equal(gotPlain, clientPlain) {
		t.Fatalf("IMS plain=%x, want %x", gotPlain, clientPlain)
	}

	imsPlain := testRTPPacket(32, 0x22222222, []byte{0x04, 0x05})
	imsProtected, err := media.ProtectIMSRTP(imsPlain)
	if err != nil {
		t.Fatalf("ProtectIMSRTP() error = %v", err)
	}
	if _, err := imsPeer.WriteToUDP(imsProtected, imsEndpoint); err != nil {
		t.Fatalf("ims WriteToUDP() error = %v", err)
	}
	got, _ = readTestUDP(t, clientPeer)
	if bytes.Equal(got, imsPlain) || bytes.Equal(got, imsProtected) {
		t.Fatalf("client got untransformed packet=%x", got)
	}
	gotPlain, err = media.UnprotectClientRTP(got)
	if err != nil {
		t.Fatalf("UnprotectClientRTP() error = %v", err)
	}
	if !bytes.Equal(gotPlain, imsPlain) {
		t.Fatalf("client plain=%x, want %x", gotPlain, imsPlain)
	}
	stats := waitRelayStats(t, relay, func(stats RTPRelayStats) bool {
		return stats.ClientToIMSRTPPackets == 1 && stats.IMSToClientRTPPackets == 1
	})
	if stats.ClientToIMSRTPDrops != 0 || stats.IMSToClientRTPDrops != 0 || stats.ClientToIMSRTPPackets != 1 || stats.IMSToClientRTPPackets != 1 {
		t.Fatalf("stats=%+v", stats)
	}
}

func TestRTPRelaySessionUpdatesTransformsAtRuntime(t *testing.T) {
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
	}, SDPInfo{
		ConnectionIP:           "127.0.0.1",
		MediaPort:              clientAddr.Port,
		RTCPPort:               clientRTCPAddr.Port,
		TelephoneEventPayloads: map[uint8]int{101: 8000},
	})
	if err != nil {
		t.Fatalf("NewRTPRelaySession() error = %v", err)
	}
	defer relay.Close()
	if err := relay.SetIMSRemote(SDPInfo{
		ConnectionIP:           "127.0.0.1",
		MediaPort:              imsAddr.Port,
		RTCPPort:               imsRTCPAddr.Port,
		TelephoneEventPayloads: map[uint8]int{101: 8000},
	}); err != nil {
		t.Fatalf("SetIMSRemote() error = %v", err)
	}
	clientEndpoint := udpAddrFromSDP(t, relay.ClientEndpoint())
	imsEndpoint := udpAddrFromSDP(t, relay.IMSEndpoint())

	initialPlain := testRTPPacket(41, 0x11111111, []byte{0x41})
	if _, err := clientPeer.WriteToUDP(initialPlain, clientEndpoint); err != nil {
		t.Fatalf("client initial WriteToUDP() error = %v", err)
	}
	if got, _ := readTestUDP(t, imsPeer); !bytes.Equal(got, initialPlain) {
		t.Fatalf("IMS initial RTP=%x, want %x", got, initialPlain)
	}

	media, err := NewSRTPMediaSession(testSRTPMediaConfig())
	if err != nil {
		t.Fatalf("NewSRTPMediaSession() error = %v", err)
	}
	if err := relay.SetTransforms(media.RelayTransforms()); err != nil {
		t.Fatalf("SetTransforms() error = %v", err)
	}
	if relay.Transforms().ClientToIMSRTP == nil || relay.Transforms().GeneratedToClientRTCP == nil {
		t.Fatalf("Transforms() did not expose installed transforms")
	}

	clientPlain := testRTPPacket(42, 0x11111111, []byte{0x42})
	clientProtected, err := media.ProtectClientRTP(clientPlain)
	if err != nil {
		t.Fatalf("ProtectClientRTP() error = %v", err)
	}
	if _, err := clientPeer.WriteToUDP(clientProtected, clientEndpoint); err != nil {
		t.Fatalf("client protected WriteToUDP() error = %v", err)
	}
	got, _ := readTestUDP(t, imsPeer)
	if bytes.Equal(got, clientPlain) || bytes.Equal(got, clientProtected) {
		t.Fatalf("IMS got untransformed RTP=%x", got)
	}
	gotPlain, err := media.UnprotectIMSRTP(got)
	if err != nil {
		t.Fatalf("UnprotectIMSRTP() error = %v", err)
	}
	if !bytes.Equal(gotPlain, clientPlain) {
		t.Fatalf("IMS RTP plain=%x, want %x", gotPlain, clientPlain)
	}

	dtmf, err := relay.SendRTPDTMFToIMS(context.Background(), RTPRelayDTMFRequest{
		Signal:         "9",
		DurationMS:     10,
		StepMS:         10,
		EndPacketCount: 1,
		PayloadType:    101,
		ClockRate:      8000,
		SequenceNumber: 90,
		Timestamp:      0x09090909,
		SSRC:           0x09090909,
	})
	if err != nil {
		t.Fatalf("SendRTPDTMFToIMS() error = %v", err)
	}
	if dtmf.Packets != 2 {
		t.Fatalf("DTMF result=%+v", dtmf)
	}
	for i := 0; i < dtmf.Packets; i++ {
		got, _ := readTestUDP(t, imsPeer)
		plain, err := media.UnprotectIMSRTP(got)
		if err != nil {
			t.Fatalf("UnprotectIMSRTP(DTMF %d) error = %v", i, err)
		}
		event, ok, err := ParseRTPDTMFEvent(RTPDTMFClientToIMS, plain, map[uint8]int{101: 8000})
		if err != nil || !ok || event.Signal != "9" {
			t.Fatalf("DTMF event[%d]=%+v ok=%v err=%v", i, event, ok, err)
		}
	}

	rtcpResult, err := relay.SendRTCPToClient(context.Background(), &rtcp.ReceiverReport{SSRC: 0x51525354})
	if err != nil {
		t.Fatalf("SendRTCPToClient() error = %v", err)
	}
	if rtcpResult.Datagrams != 1 {
		t.Fatalf("RTCP result=%+v", rtcpResult)
	}
	got, _ = readTestUDP(t, clientRTCPPeer)
	plainRTCP, err := media.UnprotectClientRTCP(got)
	if err != nil {
		t.Fatalf("UnprotectClientRTCP() error = %v", err)
	}
	packets, err := rtcp.Unmarshal(plainRTCP)
	if err != nil {
		t.Fatalf("rtcp.Unmarshal() error = %v", err)
	}
	if rr, ok := packets[0].(*rtcp.ReceiverReport); !ok || rr.SSRC != 0x51525354 {
		t.Fatalf("RTCP packets=%+v", packets)
	}

	if err := relay.SetTransforms(RTPRelayTransforms{}); err != nil {
		t.Fatalf("SetTransforms(clear) error = %v", err)
	}
	if relay.Transforms().ClientToIMSRTP != nil {
		t.Fatalf("Transforms() still has ClientToIMSRTP after clear")
	}
	finalPlain := testRTPPacket(43, 0x22222222, []byte{0x43})
	if _, err := imsPeer.WriteToUDP(finalPlain, imsEndpoint); err != nil {
		t.Fatalf("IMS final WriteToUDP() error = %v", err)
	}
	if got, _ := readTestUDP(t, clientPeer); !bytes.Equal(got, finalPlain) {
		t.Fatalf("client final RTP=%x, want %x", got, finalPlain)
	}

	if err := relay.Close(); err != nil {
		t.Fatalf("Close() error = %v", err)
	}
	if err := relay.SetTransforms(media.RelayTransforms()); !errors.Is(err, ErrRTPRelayConfig) {
		t.Fatalf("SetTransforms(closed) err=%v, want ErrRTPRelayConfig", err)
	}
}

func TestRTPRelaySessionTracksSRTPPlaintextStreams(t *testing.T) {
	clientPeer := listenTestUDP(t)
	defer clientPeer.Close()
	clientRTCPPeer := listenTestUDP(t)
	defer clientRTCPPeer.Close()
	imsPeer := listenTestUDP(t)
	defer imsPeer.Close()
	imsRTCPPeer := listenTestUDP(t)
	defer imsRTCPPeer.Close()
	media, err := NewSRTPMediaSession(testSRTPMediaConfig())
	if err != nil {
		t.Fatalf("NewSRTPMediaSession() error = %v", err)
	}
	clientAddr := clientPeer.LocalAddr().(*net.UDPAddr)
	clientRTCPAddr := clientRTCPPeer.LocalAddr().(*net.UDPAddr)
	imsAddr := imsPeer.LocalAddr().(*net.UDPAddr)
	imsRTCPAddr := imsRTCPPeer.LocalAddr().(*net.UDPAddr)
	var relay *RTPRelaySession
	transforms := media.RelayTransformsWithMediaObservers(nil, nil, func(event RTPPlaintextEvent) {
		if relay != nil {
			relay.ObserveRTPPlaintext(event)
		}
	}, nil, nil)
	relay, err = NewRTPRelaySession(context.Background(), RTPRelayConfig{
		ClientListenIP:     "127.0.0.1",
		ClientAdvertiseIP:  "127.0.0.1",
		IMSListenIP:        "127.0.0.1",
		IMSAdvertiseIP:     "127.0.0.1",
		ClientRTPClockRate: 16000,
		IMSRTPClockRate:    8000,
		Transforms:         transforms,
	}, SDPInfo{ConnectionIP: "127.0.0.1", MediaPort: clientAddr.Port, RTCPPort: clientRTCPAddr.Port})
	if err != nil {
		t.Fatalf("NewRTPRelaySession() error = %v", err)
	}
	defer relay.Close()
	if err := relay.SetIMSRemote(SDPInfo{ConnectionIP: "127.0.0.1", MediaPort: imsAddr.Port, RTCPPort: imsRTCPAddr.Port}); err != nil {
		t.Fatalf("SetIMSRemote() error = %v", err)
	}
	clientEndpoint := udpAddrFromSDP(t, relay.ClientEndpoint())
	imsEndpoint := udpAddrFromSDP(t, relay.IMSEndpoint())

	for _, seq := range []uint16{100, 102} {
		packet := testRTPPacket(seq, 0x11111111, []byte{byte(seq)})
		protected, err := media.ProtectClientRTP(packet)
		if err != nil {
			t.Fatalf("ProtectClientRTP(%d) error = %v", seq, err)
		}
		if _, err := clientPeer.WriteToUDP(protected, clientEndpoint); err != nil {
			t.Fatalf("client WriteToUDP(%d) error = %v", seq, err)
		}
		got, _ := readTestUDP(t, imsPeer)
		plain, err := media.UnprotectIMSRTP(got)
		if err != nil {
			t.Fatalf("UnprotectIMSRTP(%d) error = %v", seq, err)
		}
		if !bytes.Equal(plain, packet) {
			t.Fatalf("IMS plain seq=%d got=%x want=%x", seq, plain, packet)
		}
	}
	for _, seq := range []uint16{200, 202} {
		packet := testRTPPacket(seq, 0x22222222, []byte{byte(seq)})
		protected, err := media.ProtectIMSRTP(packet)
		if err != nil {
			t.Fatalf("ProtectIMSRTP(%d) error = %v", seq, err)
		}
		if _, err := imsPeer.WriteToUDP(protected, imsEndpoint); err != nil {
			t.Fatalf("ims WriteToUDP(%d) error = %v", seq, err)
		}
		got, _ := readTestUDP(t, clientPeer)
		plain, err := media.UnprotectClientRTP(got)
		if err != nil {
			t.Fatalf("UnprotectClientRTP(%d) error = %v", seq, err)
		}
		if !bytes.Equal(plain, packet) {
			t.Fatalf("client plain seq=%d got=%x want=%x", seq, plain, packet)
		}
	}

	stats := waitRelayStats(t, relay, func(stats RTPRelayStats) bool {
		return len(stats.ClientToIMSRTPStreams) == 1 && len(stats.IMSToClientRTPStreams) == 1 &&
			stats.ClientToIMSRTPStreams[0].LostPackets == 1 && stats.IMSToClientRTPStreams[0].LostPackets == 1
	})
	if len(stats.ClientToIMSRTPStreams) != 1 || len(stats.IMSToClientRTPStreams) != 1 {
		t.Fatalf("stream stats=%+v", stats)
	}
	if stream := stats.ClientToIMSRTPStreams[0]; stream.SSRC != 0x11111111 || stream.Packets != 2 || stream.ExpectedPackets != 3 || stream.LostPackets != 1 {
		t.Fatalf("client-to-IMS stream=%+v", stream)
	}
	if stream := stats.IMSToClientRTPStreams[0]; stream.SSRC != 0x22222222 || stream.Packets != 2 || stream.ExpectedPackets != 3 || stream.LostPackets != 1 {
		t.Fatalf("IMS-to-client stream=%+v", stream)
	}
}

func TestRTPRelaySessionReportsRTCPFeedback(t *testing.T) {
	clientPeer := listenTestUDP(t)
	defer clientPeer.Close()
	clientRTCPPeer := listenTestUDP(t)
	defer clientRTCPPeer.Close()
	imsPeer := listenTestUDP(t)
	defer imsPeer.Close()
	imsRTCPPeer := listenTestUDP(t)
	defer imsRTCPPeer.Close()

	events := make(chan RTCPFeedbackEvent, 4)
	clientAddr := clientPeer.LocalAddr().(*net.UDPAddr)
	clientRTCPAddr := clientRTCPPeer.LocalAddr().(*net.UDPAddr)
	imsAddr := imsPeer.LocalAddr().(*net.UDPAddr)
	imsRTCPAddr := imsRTCPPeer.LocalAddr().(*net.UDPAddr)
	relay, err := NewRTPRelaySession(context.Background(), RTPRelayConfig{
		ClientListenIP:    "127.0.0.1",
		ClientAdvertiseIP: "127.0.0.1",
		IMSListenIP:       "127.0.0.1",
		IMSAdvertiseIP:    "127.0.0.1",
		RTCPFeedbackHandler: func(event RTCPFeedbackEvent) {
			events <- event
		},
	}, SDPInfo{ConnectionIP: "127.0.0.1", MediaPort: clientAddr.Port, RTCPPort: clientRTCPAddr.Port})
	if err != nil {
		t.Fatalf("NewRTPRelaySession() error = %v", err)
	}
	defer relay.Close()
	if err := relay.SetIMSRemote(SDPInfo{ConnectionIP: "127.0.0.1", MediaPort: imsAddr.Port, RTCPPort: imsRTCPAddr.Port}); err != nil {
		t.Fatalf("SetIMSRemote() error = %v", err)
	}

	packet, err := rtcp.Marshal([]rtcp.Packet{
		&rtcp.PictureLossIndication{SenderSSRC: 0x11111111, MediaSSRC: 0x22222222},
		&rtcp.TransportLayerNack{
			SenderSSRC: 0x11111111,
			MediaSSRC:  0x22222222,
			Nacks:      rtcp.NackPairsFromSequenceNumbers([]uint16{7, 8, 12}),
		},
	})
	if err != nil {
		t.Fatalf("rtcp.Marshal() error = %v", err)
	}
	clientRTCPEndpoint := udpRTCPAddrFromSDP(t, relay.ClientEndpoint())
	if _, err := clientRTCPPeer.WriteToUDP(packet, clientRTCPEndpoint); err != nil {
		t.Fatalf("client RTCP WriteToUDP() error = %v", err)
	}
	got, _ := readTestUDP(t, imsRTCPPeer)
	if !bytes.Equal(got, packet) {
		t.Fatalf("IMS RTCP got=%x, want %x", got, packet)
	}

	first := readRTCPFeedbackEvent(t, events)
	second := readRTCPFeedbackEvent(t, events)
	seen := map[RTCPFeedbackKind]RTCPFeedbackEvent{
		first.Kind:  first,
		second.Kind: second,
	}
	if event, ok := seen[RTCPFeedbackPictureLossIndication]; !ok || event.Direction != RTCPFeedbackClientToIMS || event.MediaSSRC != 0x22222222 {
		t.Fatalf("PLI event=%+v seen=%v", event, ok)
	}
	if event, ok := seen[RTCPFeedbackTransportLayerNack]; !ok || event.NACKCount != 3 {
		t.Fatalf("NACK event=%+v seen=%v", event, ok)
	}
	stats := waitRelayStats(t, relay, func(stats RTPRelayStats) bool {
		return stats.RTCPFeedbackPackets == 2
	})
	if stats.RTCPPictureLossIndications != 1 || stats.RTCPTransportLayerNacks != 1 || stats.RTCPFeedbackParseErrors != 0 {
		t.Fatalf("stats=%+v", stats)
	}
}

func TestRTPRelaySessionSendsGeneratedRTCPToIMS(t *testing.T) {
	clientPeer := listenTestUDP(t)
	defer clientPeer.Close()
	clientRTCPPeer := listenTestUDP(t)
	defer clientRTCPPeer.Close()
	imsPeer := listenTestUDP(t)
	defer imsPeer.Close()
	imsRTCPPeer := listenTestUDP(t)
	defer imsRTCPPeer.Close()

	events := make(chan RTCPFeedbackEvent, 4)
	clientAddr := clientPeer.LocalAddr().(*net.UDPAddr)
	clientRTCPAddr := clientRTCPPeer.LocalAddr().(*net.UDPAddr)
	imsAddr := imsPeer.LocalAddr().(*net.UDPAddr)
	imsRTCPAddr := imsRTCPPeer.LocalAddr().(*net.UDPAddr)
	relay, err := NewRTPRelaySession(context.Background(), RTPRelayConfig{
		ClientListenIP:    "127.0.0.1",
		ClientAdvertiseIP: "127.0.0.1",
		IMSListenIP:       "127.0.0.1",
		IMSAdvertiseIP:    "127.0.0.1",
		RTCPFeedbackHandler: func(event RTCPFeedbackEvent) {
			events <- event
		},
	}, SDPInfo{ConnectionIP: "127.0.0.1", MediaPort: clientAddr.Port, RTCPPort: clientRTCPAddr.Port})
	if err != nil {
		t.Fatalf("NewRTPRelaySession() error = %v", err)
	}
	defer relay.Close()
	if err := relay.SetIMSRemote(SDPInfo{ConnectionIP: "127.0.0.1", MediaPort: imsAddr.Port, RTCPPort: imsRTCPAddr.Port}); err != nil {
		t.Fatalf("SetIMSRemote() error = %v", err)
	}

	result, err := relay.SendRTCPToIMS(context.Background(),
		&rtcp.ReceiverReport{
			SSRC: 0x11111111,
			Reports: []rtcp.ReceptionReport{{
				SSRC:               0x22222222,
				LastSequenceNumber: 77,
				Jitter:             9,
			}},
		},
		&rtcp.PictureLossIndication{SenderSSRC: 0x11111111, MediaSSRC: 0x22222222},
	)
	if err != nil {
		t.Fatalf("SendRTCPToIMS() error = %v", err)
	}
	if result.Datagrams != 1 || result.Feedback.Packets != 2 || result.Feedback.ReceiverReports != 1 || result.Feedback.PictureLossIndications != 1 {
		t.Fatalf("result=%+v", result)
	}
	got, from := readTestUDP(t, imsRTCPPeer)
	if from.Port != relay.IMSEndpoint().RTCPPort {
		t.Fatalf("IMS RTCP packet source port=%d, want relay IMS RTCP port %d", from.Port, relay.IMSEndpoint().RTCPPort)
	}
	packets, err := rtcp.Unmarshal(got)
	if err != nil {
		t.Fatalf("rtcp.Unmarshal() error = %v", err)
	}
	if len(packets) != 2 {
		t.Fatalf("packets=%d, want 2", len(packets))
	}
	first := readRTCPFeedbackEvent(t, events)
	second := readRTCPFeedbackEvent(t, events)
	seen := map[RTCPFeedbackKind]bool{first.Kind: true, second.Kind: true}
	if !seen[RTCPFeedbackReceiverReport] || !seen[RTCPFeedbackPictureLossIndication] {
		t.Fatalf("events=%+v %+v", first, second)
	}
	stats := relay.Stats()
	if stats.ClientToIMSRTCPPackets != 1 || stats.RTCPFeedbackPackets != 2 || stats.RTCPReceiverReports != 1 || stats.RTCPPictureLossIndications != 1 {
		t.Fatalf("stats=%+v", stats)
	}
}

func TestRTPRelaySessionTracksRTPStreamsAndSendsReceiverReport(t *testing.T) {
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
		if got, _ := readTestUDP(t, clientPeer); !bytes.Equal(got, packet) {
			t.Fatalf("client got seq=%d packet=%x, want %x", seq, got, packet)
		}
	}

	stats := waitRelayStats(t, relay, func(stats RTPRelayStats) bool {
		return len(stats.IMSToClientRTPStreams) == 1 && stats.IMSToClientRTPStreams[0].LostPackets == 1
	})
	if len(stats.IMSToClientRTPStreams) != 1 {
		t.Fatalf("stream stats=%+v", stats)
	}
	stream := stats.IMSToClientRTPStreams[0]
	if stream.SSRC != 0x22222222 || stream.Packets != 2 || stream.ExpectedPackets != 3 || stream.LostPackets != 1 || stream.LastSequenceNumber != 12 {
		t.Fatalf("stream=%+v", stream)
	}

	result, err := relay.SendReceiverReportToIMS(context.Background(), 0x33333333)
	if err != nil {
		t.Fatalf("SendReceiverReportToIMS() error = %v", err)
	}
	if result.Feedback.ReceiverReports != 1 || result.Datagrams != 1 {
		t.Fatalf("result=%+v", result)
	}
	got, from := readTestUDP(t, imsRTCPPeer)
	if from.Port != relay.IMSEndpoint().RTCPPort {
		t.Fatalf("IMS RTCP source port=%d, want relay IMS RTCP port %d", from.Port, relay.IMSEndpoint().RTCPPort)
	}
	packets, err := rtcp.Unmarshal(got)
	if err != nil {
		t.Fatalf("rtcp.Unmarshal() error = %v packet=%x", err, got)
	}
	if len(packets) != 1 {
		t.Fatalf("packets=%d, want 1", len(packets))
	}
	rr, ok := packets[0].(*rtcp.ReceiverReport)
	if !ok {
		t.Fatalf("packet type=%T, want ReceiverReport", packets[0])
	}
	if rr.SSRC != 0x33333333 || len(rr.Reports) != 1 {
		t.Fatalf("receiver report=%+v", rr)
	}
	report := rr.Reports[0]
	if report.SSRC != 0x22222222 || report.TotalLost != 1 || report.LastSequenceNumber != 12 {
		t.Fatalf("reception report=%+v", report)
	}
}

func TestRTPRelaySessionReportsQualitySnapshot(t *testing.T) {
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
		IMSRTPClockRate:    8000,
	}, SDPInfo{ConnectionIP: "127.0.0.1", MediaPort: clientAddr.Port, RTCPPort: clientRTCPAddr.Port})
	if err != nil {
		t.Fatalf("NewRTPRelaySession() error = %v", err)
	}
	defer relay.Close()
	if err := relay.SetIMSRemote(SDPInfo{ConnectionIP: "127.0.0.1", MediaPort: imsAddr.Port, RTCPPort: imsRTCPAddr.Port}); err != nil {
		t.Fatalf("SetIMSRemote() error = %v", err)
	}

	clientEndpoint := udpAddrFromSDP(t, relay.ClientEndpoint())
	clientRTCPEndpoint := udpRTCPAddrFromSDP(t, relay.ClientEndpoint())
	imsEndpoint := udpAddrFromSDP(t, relay.IMSEndpoint())
	imsRTCPEndpoint := udpRTCPAddrFromSDP(t, relay.IMSEndpoint())

	for _, input := range []struct {
		sequence  uint16
		timestamp uint32
	}{
		{sequence: 10, timestamp: 1000},
		{sequence: 12, timestamp: 1320},
	} {
		packet := buildRTPStatsPacket(0x11111111, input.sequence, input.timestamp)
		if _, err := clientPeer.WriteToUDP(packet, clientEndpoint); err != nil {
			t.Fatalf("client WriteToUDP(%d) error = %v", input.sequence, err)
		}
		if got, _ := readTestUDP(t, imsPeer); !bytes.Equal(got, packet) {
			t.Fatalf("IMS got seq=%d packet=%x, want %x", input.sequence, got, packet)
		}
	}
	for _, input := range []struct {
		sequence  uint16
		timestamp uint32
	}{
		{sequence: 20, timestamp: 2000},
		{sequence: 21, timestamp: 2160},
	} {
		packet := buildRTPStatsPacket(0x22222222, input.sequence, input.timestamp)
		if _, err := imsPeer.WriteToUDP(packet, imsEndpoint); err != nil {
			t.Fatalf("ims WriteToUDP(%d) error = %v", input.sequence, err)
		}
		if got, _ := readTestUDP(t, clientPeer); !bytes.Equal(got, packet) {
			t.Fatalf("client got seq=%d packet=%x, want %x", input.sequence, got, packet)
		}
	}

	imsReport, err := rtcp.Marshal([]rtcp.Packet{
		&rtcp.ReceiverReport{
			SSRC: 0x51515151,
			Reports: []rtcp.ReceptionReport{{
				SSRC:               0x11111111,
				FractionLost:       64,
				TotalLost:          3,
				LastSequenceNumber: 12,
				Jitter:             44,
				LastSenderReport:   0x12345678,
				Delay:              0x00001000,
			}},
		},
	})
	if err != nil {
		t.Fatalf("rtcp.Marshal(ims report) error = %v", err)
	}
	if _, err := imsRTCPPeer.WriteToUDP(imsReport, imsRTCPEndpoint); err != nil {
		t.Fatalf("IMS RTCP WriteToUDP() error = %v", err)
	}
	if got, _ := readTestUDP(t, clientRTCPPeer); !bytes.Equal(got, imsReport) {
		t.Fatalf("client RTCP got=%x, want %x", got, imsReport)
	}

	clientReport, err := rtcp.Marshal([]rtcp.Packet{
		&rtcp.SenderReport{
			SSRC: 0x61616161,
			Reports: []rtcp.ReceptionReport{{
				SSRC:               0x22222222,
				FractionLost:       8,
				TotalLost:          1,
				LastSequenceNumber: 21,
				Jitter:             7,
			}},
		},
	})
	if err != nil {
		t.Fatalf("rtcp.Marshal(client report) error = %v", err)
	}
	if _, err := clientRTCPPeer.WriteToUDP(clientReport, clientRTCPEndpoint); err != nil {
		t.Fatalf("client RTCP WriteToUDP() error = %v", err)
	}
	if got, _ := readTestUDP(t, imsRTCPPeer); !bytes.Equal(got, clientReport) {
		t.Fatalf("IMS RTCP got=%x, want %x", got, clientReport)
	}

	quality := waitRelayQuality(t, relay, func(quality RTPRelayQualityStats) bool {
		return quality.ClientToIMS.RTPPackets == 2 &&
			quality.IMSToClient.RTPPackets == 2 &&
			len(quality.ClientToIMS.RTCPReports) == 1 &&
			len(quality.IMSToClient.RTCPReports) == 1
	})
	if quality.ClientToIMS.RTPReceivedPackets != 2 || quality.ClientToIMS.RTPExpectedPackets != 3 ||
		quality.ClientToIMS.RTPLostPackets != 1 || quality.ClientToIMS.RTPFractionLost != 85 {
		t.Fatalf("client-to-IMS quality=%+v", quality.ClientToIMS)
	}
	if quality.IMSToClient.RTPReceivedPackets != 2 || quality.IMSToClient.RTPExpectedPackets != 2 ||
		quality.IMSToClient.RTPLostPackets != 0 || quality.IMSToClient.RTPFractionLost != 0 {
		t.Fatalf("IMS-to-client quality=%+v", quality.IMSToClient)
	}
	if quality.ClientToIMS.RTCPPackets != 1 || quality.IMSToClient.RTCPPackets != 1 ||
		quality.RTCPFeedback.Packets != 2 || quality.RTCPFeedback.ReceiverReports != 1 ||
		quality.RTCPFeedback.SenderReports != 1 || quality.RTCPFeedbackParseErrors != 0 {
		t.Fatalf("RTCP quality=%+v", quality)
	}
	if report := quality.IMSToClient.RTCPReports[0]; report.Direction != RTCPFeedbackIMSToClient ||
		report.ReporterSSRC != 0x51515151 || report.MediaSSRC != 0x11111111 ||
		report.FractionLost != 64 || report.TotalLost != 3 || report.Jitter != 44 ||
		report.LastSenderReport != 0x12345678 || report.Delay != 0x00001000 {
		t.Fatalf("IMS report quality=%+v", report)
	}
	if report := quality.ClientToIMS.RTCPReports[0]; report.Direction != RTCPFeedbackClientToIMS ||
		report.ReporterSSRC != 0x61616161 || report.MediaSSRC != 0x22222222 ||
		report.FractionLost != 8 || report.TotalLost != 1 || report.Jitter != 7 {
		t.Fatalf("client report quality=%+v", report)
	}
}

func TestRTPRelayRTCPReportDiagnosisActions(t *testing.T) {
	cfg := RTPStreamDiagnosisConfig{
		ClockRate:            8000,
		LossWarningFraction:  32,
		LossCriticalFraction: 128,
		JitterWarning:        40 * time.Millisecond,
		JitterCritical:       100 * time.Millisecond,
		RoundTripWarning:     300 * time.Millisecond,
		RoundTripCritical:    800 * time.Millisecond,
	}
	base := RTPRelayRTCPReportQuality{
		Direction:    RTCPFeedbackClientToIMS,
		ReporterSSRC: 0x61616161,
		MediaSSRC:    0x11111111,
		TotalLost:    7,
	}
	tests := []struct {
		name        string
		report      RTPRelayRTCPReportQuality
		wantStatus  RTPStreamDiagnosisStatus
		wantReasons []RTPStreamDiagnosisReason
		wantAction  RTPRelayQualityAction
	}{
		{
			name:       "ok",
			report:     base,
			wantStatus: RTPStreamDiagnosisStatusOK,
			wantAction: RTPRelayQualityActionNone,
		},
		{
			name:        "jitter warning",
			report:      reportWithRTCPQuality(base, 0, 400, 0),
			wantStatus:  RTPStreamDiagnosisStatusWarning,
			wantReasons: []RTPStreamDiagnosisReason{RTPStreamDiagnosisReasonJitter},
			wantAction:  RTPRelayQualityActionIncreaseJitterBuffer,
		},
		{
			name:        "loss warning",
			report:      reportWithRTCPQuality(base, 40, 0, 0),
			wantStatus:  RTPStreamDiagnosisStatusWarning,
			wantReasons: []RTPStreamDiagnosisReason{RTPStreamDiagnosisReasonPacketLoss},
			wantAction:  RTPRelayQualityActionReduceBitrate,
		},
		{
			name:        "RTT warning",
			report:      reportWithRTCPQuality(base, 0, 0, 350*time.Millisecond),
			wantStatus:  RTPStreamDiagnosisStatusWarning,
			wantReasons: []RTPStreamDiagnosisReason{RTPStreamDiagnosisReasonRoundTripTime},
			wantAction:  RTPRelayQualityActionMonitor,
		},
		{
			name:        "critical media path",
			report:      reportWithRTCPQuality(base, 160, 960, 900*time.Millisecond),
			wantStatus:  RTPStreamDiagnosisStatusCritical,
			wantReasons: []RTPStreamDiagnosisReason{RTPStreamDiagnosisReasonPacketLoss, RTPStreamDiagnosisReasonJitter, RTPStreamDiagnosisReasonRoundTripTime},
			wantAction:  RTPRelayQualityActionRecoverMediaPath,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			diagnosis := tt.report.Diagnose(cfg)
			if diagnosis.Direction != base.Direction || diagnosis.ReporterSSRC != base.ReporterSSRC || diagnosis.MediaSSRC != base.MediaSSRC {
				t.Fatalf("diagnosis identity=%+v", diagnosis)
			}
			if diagnosis.Status != tt.wantStatus || diagnosis.Action != tt.wantAction {
				t.Fatalf("diagnosis status/action=%q/%q, want %q/%q: %+v", diagnosis.Status, diagnosis.Action, tt.wantStatus, tt.wantAction, diagnosis)
			}
			if !rtpDiagnosisReasonsEqual(diagnosis.Reasons, tt.wantReasons) {
				t.Fatalf("diagnosis reasons=%+v, want %+v", diagnosis.Reasons, tt.wantReasons)
			}
		})
	}

	diagnoses := RTPRelayDirectionQuality{RTCPReports: []RTPRelayRTCPReportQuality{tests[len(tests)-1].report}}.DiagnoseRTCPReports(cfg)
	if len(diagnoses) != 1 || diagnoses[0].Action != RTPRelayQualityActionRecoverMediaPath ||
		diagnoses[0].Loss.TotalLost != 7 || diagnoses[0].Jitter.Duration != 120*time.Millisecond ||
		diagnoses[0].RoundTripTime.RoundTripTime != 900*time.Millisecond {
		t.Fatalf("quality diagnoses=%+v", diagnoses)
	}
}

func TestRTPRelayRTCPReportQualitySummaryIncludesRoundTripTime(t *testing.T) {
	status, reasons := summarizeRTPRelayRTCPReportQuality([]RTPRelayRTCPReportQuality{{
		Direction:     RTCPFeedbackClientToIMS,
		ReporterSSRC:  0x61616161,
		MediaSSRC:     0x11111111,
		RoundTripTime: 900 * time.Millisecond,
	}}, RTPStreamDiagnosisConfig{
		RoundTripWarning:  300 * time.Millisecond,
		RoundTripCritical: 800 * time.Millisecond,
	}, RTPStreamDiagnosisStatusUnknown, nil)

	if status != RTPStreamDiagnosisStatusCritical {
		t.Fatalf("summary status=%q, want critical", status)
	}
	if !rtpDiagnosisReasonsEqual(reasons, []RTPStreamDiagnosisReason{RTPStreamDiagnosisReasonRoundTripTime}) {
		t.Fatalf("summary reasons=%+v, want round-trip time", reasons)
	}
}

func TestRTPRelaySessionEmitsQualityEventsOnStatusChange(t *testing.T) {
	base := time.Date(2026, 7, 7, 10, 30, 0, 0, time.UTC)
	var events []RTPRelayQualityEvent
	relay := &RTPRelaySession{
		clientRTPClockRate: 8000,
		rtpQualityConfig: RTPRelayQualityConfig{
			EmitInitial: true,
			ClientToIMS: RTPStreamDiagnosisConfig{
				ClockRate:            8000,
				MinExpectedPackets:   2,
				LossWarningFraction:  1,
				LossCriticalFraction: 200,
			},
		},
		rtpQualityHandler: func(event RTPRelayQualityEvent) {
			events = append(events, event)
		},
	}

	relay.observeRTPStream(RTPDTMFClientToIMS, buildRTPStatsPacket(0x11111111, 10, 1000), base, 8000)
	if len(events) != 0 {
		t.Fatalf("startup quality events=%+v, want none before diagnosis is known", events)
	}

	relay.observeRTPStream(RTPDTMFClientToIMS, buildRTPStatsPacket(0x11111111, 11, 1160), base.Add(20*time.Millisecond), 8000)
	if len(events) != 1 ||
		events[0].Direction != RTCPFeedbackClientToIMS ||
		events[0].Status != RTPStreamDiagnosisStatusOK ||
		events[0].PreviousStatus != RTPStreamDiagnosisStatusUnknown ||
		len(events[0].Reasons) != 0 ||
		len(events[0].Diagnoses) != 1 {
		t.Fatalf("initial quality event=%+v", events)
	}

	relay.observeRTPStream(RTPDTMFClientToIMS, buildRTPStatsPacket(0x11111111, 12, 1320), base.Add(40*time.Millisecond), 8000)
	if len(events) != 1 {
		t.Fatalf("duplicate OK quality events=%+v", events)
	}

	relay.observeRTPStream(RTPDTMFClientToIMS, buildRTPStatsPacket(0x11111111, 14, 1640), base.Add(80*time.Millisecond), 8000)
	if len(events) != 2 {
		t.Fatalf("quality events after loss=%+v, want status change event", events)
	}
	event := events[1]
	if event.Status != RTPStreamDiagnosisStatusWarning ||
		event.PreviousStatus != RTPStreamDiagnosisStatusOK ||
		len(event.Reasons) != 1 ||
		event.Reasons[0] != RTPStreamDiagnosisReasonPacketLoss ||
		event.Quality.RTPLostPackets != 1 ||
		event.Quality.RTPExpectedPackets != 5 {
		t.Fatalf("loss quality event=%+v", event)
	}
}

func TestRTPRelaySessionEmitsQualityEventsFromRTCPReceiverReports(t *testing.T) {
	base := time.Date(2026, 7, 7, 10, 32, 0, 0, time.UTC)
	var events []RTPRelayQualityEvent
	relay := &RTPRelaySession{
		clientRTPClockRate: 8000,
		rtpQualityConfig: RTPRelayQualityConfig{
			ClientToIMS: RTPStreamDiagnosisConfig{
				ClockRate:            8000,
				LossWarningFraction:  10,
				LossCriticalFraction: 128,
				JitterWarning:        40 * time.Millisecond,
				JitterCritical:       80 * time.Millisecond,
			},
		},
		rtpQualityHandler: func(event RTPRelayQualityEvent) {
			events = append(events, event)
		},
	}

	relay.recordRTCPReportQuality(RTCPFeedbackEvent{
		Direction: RTCPFeedbackClientToIMS,
		SSRC:      0x61616161,
		Reports: []RTCPReceptionReport{{
			SSRC:               0x11111111,
			FractionLost:       32,
			TotalLost:          2,
			LastSequenceNumber: 0x00010010,
			Jitter:             160,
		}},
	}, base)
	if len(events) != 1 {
		t.Fatalf("quality events=%+v, want RTCP report warning", events)
	}
	event := events[0]
	if event.Direction != RTCPFeedbackClientToIMS ||
		event.Status != RTPStreamDiagnosisStatusWarning ||
		event.PreviousStatus != RTPStreamDiagnosisStatusUnknown ||
		len(event.Reasons) != 1 ||
		event.Reasons[0] != RTPStreamDiagnosisReasonPacketLoss ||
		len(event.Diagnoses) != 0 ||
		!event.ObservedAt.Equal(base) {
		t.Fatalf("RTCP warning quality event=%+v", event)
	}
	if len(event.Quality.RTCPReports) != 1 ||
		event.Quality.RTCPReports[0].ReporterSSRC != 0x61616161 ||
		event.Quality.RTCPReports[0].MediaSSRC != 0x11111111 ||
		event.Quality.RTCPReports[0].FractionLost != 32 {
		t.Fatalf("RTCP report quality=%+v", event.Quality.RTCPReports)
	}

	relay.recordRTCPReportQuality(RTCPFeedbackEvent{
		Direction: RTCPFeedbackClientToIMS,
		SSRC:      0x61616161,
		Reports: []RTCPReceptionReport{{
			SSRC:               0x11111111,
			FractionLost:       40,
			TotalLost:          3,
			LastSequenceNumber: 0x00010020,
			Jitter:             240,
		}},
	}, base.Add(20*time.Millisecond))
	if len(events) != 1 {
		t.Fatalf("duplicate RTCP warning events=%+v", events)
	}

	relay.recordRTCPReportQuality(RTCPFeedbackEvent{
		Direction: RTCPFeedbackClientToIMS,
		SSRC:      0x61616161,
		Reports: []RTCPReceptionReport{{
			SSRC:               0x11111111,
			FractionLost:       160,
			TotalLost:          8,
			LastSequenceNumber: 0x00010030,
			Jitter:             800,
		}},
	}, base.Add(40*time.Millisecond))
	if len(events) != 2 {
		t.Fatalf("quality events after critical RTCP report=%+v, want status change", events)
	}
	event = events[1]
	if event.Status != RTPStreamDiagnosisStatusCritical ||
		event.PreviousStatus != RTPStreamDiagnosisStatusWarning ||
		len(event.Reasons) != 2 ||
		event.Reasons[0] != RTPStreamDiagnosisReasonPacketLoss ||
		event.Reasons[1] != RTPStreamDiagnosisReasonJitter ||
		len(event.Quality.RTCPReports) != 1 ||
		event.Quality.RTCPReports[0].FractionLost != 160 ||
		event.Quality.RTCPReports[0].Jitter != 800 {
		t.Fatalf("critical RTCP quality event=%+v", event)
	}
}

func reportWithRTCPQuality(report RTPRelayRTCPReportQuality, fractionLost uint8, jitter uint32, roundTripTime time.Duration) RTPRelayRTCPReportQuality {
	report.FractionLost = fractionLost
	report.Jitter = jitter
	report.RoundTripTime = roundTripTime
	return report
}

func rtpDiagnosisReasonsEqual(got, want []RTPStreamDiagnosisReason) bool {
	if len(got) != len(want) {
		return false
	}
	for i := range got {
		if got[i] != want[i] {
			return false
		}
	}
	return true
}

func TestRTPRelaySessionRTCPQualityEventDoesNotDeadlock(t *testing.T) {
	base := time.Date(2026, 7, 7, 10, 31, 0, 0, time.UTC)
	relay := &RTPRelaySession{
		clientRTPClockRate: 8000,
		rtpQualityHandler:  func(RTPRelayQualityEvent) {},
		rtpQualityConfig: RTPRelayQualityConfig{
			ClientToIMS: RTPStreamDiagnosisConfig{
				ClockRate:          8000,
				MinExpectedPackets: 1,
			},
		},
	}
	relay.observeRTPStream(RTPDTMFClientToIMS, buildRTPStatsPacket(0x11111111, 10, 1000), base, 8000)

	done := make(chan struct{})
	go func() {
		relay.recordRTCPReportQuality(RTCPFeedbackEvent{
			Direction: RTCPFeedbackClientToIMS,
			SSRC:      0x61616161,
			Reports: []RTCPReceptionReport{{
				SSRC:               0x11111111,
				FractionLost:       32,
				TotalLost:          1,
				LastSequenceNumber: 10,
				Jitter:             4,
			}},
		}, base.Add(20*time.Millisecond))
		close(done)
	}()

	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("recordRTCPReportQuality deadlocked while emitting RTP quality event")
	}
}

func TestRTPRelaySessionEstimatesRTTFromSenderAndReceiverReports(t *testing.T) {
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
	}, SDPInfo{ConnectionIP: "127.0.0.1", MediaPort: clientAddr.Port, RTCPPort: clientRTCPAddr.Port})
	if err != nil {
		t.Fatalf("NewRTPRelaySession() error = %v", err)
	}
	defer relay.Close()
	if err := relay.SetIMSRemote(SDPInfo{ConnectionIP: "127.0.0.1", MediaPort: imsAddr.Port, RTCPPort: imsRTCPAddr.Port}); err != nil {
		t.Fatalf("SetIMSRemote() error = %v", err)
	}

	clientRTCPEndpoint := udpRTCPAddrFromSDP(t, relay.ClientEndpoint())
	imsRTCPEndpoint := udpRTCPAddrFromSDP(t, relay.IMSEndpoint())
	mediaSSRC := uint32(0x70717273)
	ntpTime := rtcpNTPTime(time.Unix(123, 456*time.Millisecond.Nanoseconds()))
	imsSenderReport, err := rtcp.Marshal([]rtcp.Packet{&rtcp.SenderReport{SSRC: mediaSSRC, NTPTime: ntpTime}})
	if err != nil {
		t.Fatalf("rtcp.Marshal(sender report) error = %v", err)
	}
	if _, err := imsRTCPPeer.WriteToUDP(imsSenderReport, imsRTCPEndpoint); err != nil {
		t.Fatalf("IMS RTCP WriteToUDP() error = %v", err)
	}
	if got, _ := readTestUDP(t, clientRTCPPeer); !bytes.Equal(got, imsSenderReport) {
		t.Fatalf("client RTCP got=%x, want %x", got, imsSenderReport)
	}

	time.Sleep(30 * time.Millisecond)
	clientReceiverReport, err := rtcp.Marshal([]rtcp.Packet{&rtcp.ReceiverReport{
		SSRC: 0x81828384,
		Reports: []rtcp.ReceptionReport{{
			SSRC:             mediaSSRC,
			LastSenderReport: rtcpLastSenderReport(ntpTime),
			Delay:            rtcpCompactDelay(5 * time.Millisecond),
		}},
	}})
	if err != nil {
		t.Fatalf("rtcp.Marshal(receiver report) error = %v", err)
	}
	if _, err := clientRTCPPeer.WriteToUDP(clientReceiverReport, clientRTCPEndpoint); err != nil {
		t.Fatalf("client RTCP WriteToUDP() error = %v", err)
	}
	if got, _ := readTestUDP(t, imsRTCPPeer); !bytes.Equal(got, clientReceiverReport) {
		t.Fatalf("IMS RTCP got=%x, want %x", got, clientReceiverReport)
	}

	quality := waitRelayQuality(t, relay, func(quality RTPRelayQualityStats) bool {
		return len(quality.ClientToIMS.RTCPReports) == 1 && quality.ClientToIMS.RTCPReports[0].RoundTripTime > 0
	})
	if len(quality.ClientToIMS.RTCPReports) != 1 {
		t.Fatalf("quality=%+v", quality)
	}
	report := quality.ClientToIMS.RTCPReports[0]
	if report.LastSenderReport != rtcpLastSenderReport(ntpTime) || report.Delay != rtcpCompactDelay(5*time.Millisecond) {
		t.Fatalf("report quality=%+v", report)
	}
	if report.RoundTripTime <= 0 || report.RoundTripTime > time.Second {
		t.Fatalf("RoundTripTime=%v", report.RoundTripTime)
	}
	if quality.ClientToIMS.RTCPMaxRoundTripTime != report.RoundTripTime {
		t.Fatalf("max RTT=%v report RTT=%v", quality.ClientToIMS.RTCPMaxRoundTripTime, report.RoundTripTime)
	}
	if quality.IMSToClient.RTCPMaxRoundTripTime != 0 {
		t.Fatalf("IMS-to-client max RTT=%v", quality.IMSToClient.RTCPMaxRoundTripTime)
	}
}

func TestRTPRelaySessionSendsSenderReportWithSourceDescription(t *testing.T) {
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
	}, SDPInfo{ConnectionIP: "127.0.0.1", MediaPort: clientAddr.Port, RTCPPort: clientRTCPAddr.Port})
	if err != nil {
		t.Fatalf("NewRTPRelaySession() error = %v", err)
	}
	defer relay.Close()
	if err := relay.SetIMSRemote(SDPInfo{ConnectionIP: "127.0.0.1", MediaPort: imsAddr.Port, RTCPPort: imsRTCPAddr.Port}); err != nil {
		t.Fatalf("SetIMSRemote() error = %v", err)
	}

	imsEndpoint := udpAddrFromSDP(t, relay.IMSEndpoint())
	for _, seq := range []uint16{30, 32} {
		packet := testRTPPacket(seq, 0x51525354, []byte{byte(seq)})
		if _, err := imsPeer.WriteToUDP(packet, imsEndpoint); err != nil {
			t.Fatalf("ims WriteToUDP(%d) error = %v", seq, err)
		}
		if got, _ := readTestUDP(t, clientPeer); !bytes.Equal(got, packet) {
			t.Fatalf("client got seq=%d packet=%x, want %x", seq, got, packet)
		}
	}
	_ = waitRelayStats(t, relay, func(stats RTPRelayStats) bool {
		return len(stats.IMSToClientRTPStreams) == 1 && stats.IMSToClientRTPStreams[0].LostPackets == 1
	})

	result, err := relay.SendSenderReportToIMS(context.Background(), RTPRelaySenderReportRequest{
		SSRC:        0x61626364,
		CNAME:       "session-61626364",
		WallClock:   time.Unix(10, 0),
		RTPTime:     0x10203040,
		PacketCount: 4,
		OctetCount:  640,
	})
	if err != nil {
		t.Fatalf("SendSenderReportToIMS() error = %v", err)
	}
	if result.Datagrams != 1 || result.Feedback.SenderReports != 1 || result.Feedback.SourceDescriptions != 1 {
		t.Fatalf("result=%+v", result)
	}
	got, from := readTestUDP(t, imsRTCPPeer)
	if from.Port != relay.IMSEndpoint().RTCPPort {
		t.Fatalf("IMS RTCP source port=%d, want relay IMS RTCP port %d", from.Port, relay.IMSEndpoint().RTCPPort)
	}
	packets, err := rtcp.Unmarshal(got)
	if err != nil {
		t.Fatalf("rtcp.Unmarshal() error = %v packet=%x", err, got)
	}
	if len(packets) != 2 {
		t.Fatalf("packets=%d, want 2", len(packets))
	}
	sr, ok := packets[0].(*rtcp.SenderReport)
	if !ok || sr.SSRC != 0x61626364 || sr.RTPTime != 0x10203040 || sr.PacketCount != 4 || sr.OctetCount != 640 || len(sr.Reports) != 1 {
		t.Fatalf("sender report=%+v ok=%v", packets[0], ok)
	}
	if report := sr.Reports[0]; report.SSRC != 0x51525354 || report.TotalLost != 1 || report.LastSequenceNumber != 32 {
		t.Fatalf("sender report reception block=%+v", report)
	}
	sdes, ok := packets[1].(*rtcp.SourceDescription)
	if !ok || len(sdes.Chunks) != 1 || sdes.Chunks[0].Source != 0x61626364 ||
		len(sdes.Chunks[0].Items) != 1 || sdes.Chunks[0].Items[0].Type != rtcp.SDESCNAME ||
		sdes.Chunks[0].Items[0].Text != "session-61626364" {
		t.Fatalf("source description=%+v ok=%v", packets[1], ok)
	}
	stats := relay.Stats()
	if stats.ClientToIMSRTCPPackets != 1 || stats.RTCPSenderReports != 1 || stats.RTCPSourceDescriptions != 1 {
		t.Fatalf("stats=%+v", stats)
	}
}

func TestRTPRelaySessionReportsRTPDTMFEvents(t *testing.T) {
	clientPeer := listenTestUDP(t)
	defer clientPeer.Close()
	clientRTCPPeer := listenTestUDP(t)
	defer clientRTCPPeer.Close()
	imsPeer := listenTestUDP(t)
	defer imsPeer.Close()
	imsRTCPPeer := listenTestUDP(t)
	defer imsRTCPPeer.Close()

	events := make(chan RTPDTMFEvent, 4)
	clientAddr := clientPeer.LocalAddr().(*net.UDPAddr)
	clientRTCPAddr := clientRTCPPeer.LocalAddr().(*net.UDPAddr)
	imsAddr := imsPeer.LocalAddr().(*net.UDPAddr)
	imsRTCPAddr := imsRTCPPeer.LocalAddr().(*net.UDPAddr)
	relay, err := NewRTPRelaySession(context.Background(), RTPRelayConfig{
		ClientListenIP:    "127.0.0.1",
		ClientAdvertiseIP: "127.0.0.1",
		IMSListenIP:       "127.0.0.1",
		IMSAdvertiseIP:    "127.0.0.1",
		RTPDTMFHandler: func(event RTPDTMFEvent) {
			events <- event
		},
	}, SDPInfo{
		ConnectionIP:           "127.0.0.1",
		MediaPort:              clientAddr.Port,
		RTCPPort:               clientRTCPAddr.Port,
		Payloads:               []int{0, 110},
		TelephoneEventPayloads: map[uint8]int{110: 16000},
	})
	if err != nil {
		t.Fatalf("NewRTPRelaySession() error = %v", err)
	}
	defer relay.Close()
	if err := relay.SetIMSRemote(SDPInfo{
		ConnectionIP:           "127.0.0.1",
		MediaPort:              imsAddr.Port,
		RTCPPort:               imsRTCPAddr.Port,
		Payloads:               []int{0, 101},
		TelephoneEventPayloads: map[uint8]int{101: 8000},
	}); err != nil {
		t.Fatalf("SetIMSRemote() error = %v", err)
	}

	clientEndpoint := udpAddrFromSDP(t, relay.ClientEndpoint())
	imsEndpoint := udpAddrFromSDP(t, relay.IMSEndpoint())
	clientPacket, err := BuildRTPDTMFPacket(RTPDTMFPacket{PayloadType: 110, Marker: true, SequenceNumber: 10, Timestamp: 160, SSRC: 0x11111111, Signal: "5", DurationSamples: 1600, ClockRate: 16000})
	if err != nil {
		t.Fatalf("BuildRTPDTMFPacket(client) error = %v", err)
	}
	if _, err := clientPeer.WriteToUDP(clientPacket, clientEndpoint); err != nil {
		t.Fatalf("client WriteToUDP() error = %v", err)
	}
	wantClientToIMS, remapped, err := RewriteRTPDTMFPayloadType(clientPacket, map[uint8]int{110: 16000}, map[uint8]int{101: 8000})
	if err != nil || !remapped {
		t.Fatalf("RewriteRTPDTMFPayloadType(client) remapped=%v err=%v", remapped, err)
	}
	if got, _ := readTestUDP(t, imsPeer); !bytes.Equal(got, wantClientToIMS) {
		t.Fatalf("IMS got=%x, want %x", got, wantClientToIMS)
	}
	clientEvent := readRTPDTMFEvent(t, events)
	if clientEvent.Direction != RTPDTMFClientToIMS || clientEvent.PayloadType != 110 || clientEvent.Signal != "5" || clientEvent.DurationMS != 100 {
		t.Fatalf("client event=%+v", clientEvent)
	}

	imsPacket, err := BuildRTPDTMFPacket(RTPDTMFPacket{PayloadType: 101, SequenceNumber: 11, Timestamp: 320, SSRC: 0x22222222, Signal: "#", End: true, DurationSamples: 800, ClockRate: 8000})
	if err != nil {
		t.Fatalf("BuildRTPDTMFPacket(ims) error = %v", err)
	}
	if _, err := imsPeer.WriteToUDP(imsPacket, imsEndpoint); err != nil {
		t.Fatalf("ims WriteToUDP() error = %v", err)
	}
	wantIMSToClient, remapped, err := RewriteRTPDTMFPayloadType(imsPacket, map[uint8]int{101: 8000}, map[uint8]int{110: 16000})
	if err != nil || !remapped {
		t.Fatalf("RewriteRTPDTMFPayloadType(ims) remapped=%v err=%v", remapped, err)
	}
	if got, _ := readTestUDP(t, clientPeer); !bytes.Equal(got, wantIMSToClient) {
		t.Fatalf("client got=%x, want %x", got, wantIMSToClient)
	}
	imsEvent := readRTPDTMFEvent(t, events)
	if imsEvent.Direction != RTPDTMFIMSToClient || imsEvent.PayloadType != 101 || imsEvent.Signal != "#" || !imsEvent.End || imsEvent.DurationMS != 100 {
		t.Fatalf("IMS event=%+v", imsEvent)
	}

	stats := waitRelayStats(t, relay, func(stats RTPRelayStats) bool {
		return stats.RTPDTMFEvents == 2
	})
	if stats.RTPDTMFEvents != 2 || stats.RTPDTMFEndEvents != 1 || stats.RTPDTMFClientToIMSEvents != 1 || stats.RTPDTMFIMSToClientEvents != 1 ||
		stats.RTPDTMFRemappedEvents != 2 || stats.RTPDTMFClientToIMSRemappedEvents != 1 || stats.RTPDTMFIMSToClientRemappedEvents != 1 || stats.RTPDTMFParseErrors != 0 {
		t.Fatalf("stats=%+v", stats)
	}
}

func TestRTPRelaySessionSendsGeneratedRTPDTMFToIMS(t *testing.T) {
	clientPeer := listenTestUDP(t)
	defer clientPeer.Close()
	clientRTCPPeer := listenTestUDP(t)
	defer clientRTCPPeer.Close()
	imsPeer := listenTestUDP(t)
	defer imsPeer.Close()
	imsRTCPPeer := listenTestUDP(t)
	defer imsRTCPPeer.Close()

	events := make(chan RTPDTMFEvent, 8)
	clientAddr := clientPeer.LocalAddr().(*net.UDPAddr)
	clientRTCPAddr := clientRTCPPeer.LocalAddr().(*net.UDPAddr)
	imsAddr := imsPeer.LocalAddr().(*net.UDPAddr)
	imsRTCPAddr := imsRTCPPeer.LocalAddr().(*net.UDPAddr)
	relay, err := NewRTPRelaySession(context.Background(), RTPRelayConfig{
		ClientListenIP:    "127.0.0.1",
		ClientAdvertiseIP: "127.0.0.1",
		IMSListenIP:       "127.0.0.1",
		IMSAdvertiseIP:    "127.0.0.1",
		RTPDTMFHandler: func(event RTPDTMFEvent) {
			events <- event
		},
	}, SDPInfo{
		ConnectionIP:           "127.0.0.1",
		MediaPort:              clientAddr.Port,
		RTCPPort:               clientRTCPAddr.Port,
		TelephoneEventPayloads: map[uint8]int{101: 8000},
	})
	if err != nil {
		t.Fatalf("NewRTPRelaySession() error = %v", err)
	}
	defer relay.Close()
	if err := relay.SetIMSRemote(SDPInfo{
		ConnectionIP:           "127.0.0.1",
		MediaPort:              imsAddr.Port,
		RTCPPort:               imsRTCPAddr.Port,
		TelephoneEventPayloads: map[uint8]int{110: 16000},
	}); err != nil {
		t.Fatalf("SetIMSRemote() error = %v", err)
	}

	result, err := relay.SendRTPDTMFToIMS(context.Background(), RTPRelayDTMFRequest{
		Signal:         "6",
		DurationMS:     20,
		StepMS:         5,
		EndPacketCount: 2,
		Volume:         8,
		SequenceNumber: 700,
		Timestamp:      0x01020304,
		SSRC:           0x11223344,
	})
	if err != nil {
		t.Fatalf("SendRTPDTMFToIMS() error = %v", err)
	}
	if result.PayloadType != 110 || result.ClockRate != 16000 || result.Packets != 5 || result.Signal != "6" {
		t.Fatalf("result=%+v", result)
	}
	for i := 0; i < result.Packets; i++ {
		got, from := readTestUDP(t, imsPeer)
		if from.Port != relay.IMSEndpoint().MediaPort {
			t.Fatalf("IMS packet source port=%d, want relay IMS port %d", from.Port, relay.IMSEndpoint().MediaPort)
		}
		event, ok, err := ParseRTPDTMFEvent(RTPDTMFClientToIMS, got, map[uint8]int{110: 16000})
		if err != nil || !ok {
			t.Fatalf("ParseRTPDTMFEvent(%d) ok=%v err=%v packet=%x", i, ok, err, got)
		}
		if event.Signal != "6" || event.PayloadType != 110 || event.Volume != 8 || event.SequenceNumber != uint16(700+i) || event.Timestamp != 0x01020304 || event.SSRC != 0x11223344 {
			t.Fatalf("event[%d]=%+v", i, event)
		}
		if event.End != (i >= result.Packets-2) {
			t.Fatalf("event[%d] end=%v", i, event.End)
		}
	}
	for i := 0; i < result.Packets; i++ {
		event := readRTPDTMFEvent(t, events)
		if event.Direction != RTPDTMFClientToIMS || event.PayloadType != 110 || event.Signal != "6" {
			t.Fatalf("callback[%d]=%+v", i, event)
		}
	}
	stats := relay.Stats()
	if stats.ClientToIMSRTPPackets != uint64(result.Packets) || stats.RTPDTMFEvents != uint64(result.Packets) || stats.RTPDTMFEndEvents != 2 {
		t.Fatalf("stats=%+v result=%+v", stats, result)
	}
}

func TestRTPRelaySessionSendsGeneratedRTPDTMFThroughSRTPTransform(t *testing.T) {
	clientPeer := listenTestUDP(t)
	defer clientPeer.Close()
	clientRTCPPeer := listenTestUDP(t)
	defer clientRTCPPeer.Close()
	imsPeer := listenTestUDP(t)
	defer imsPeer.Close()
	imsRTCPPeer := listenTestUDP(t)
	defer imsRTCPPeer.Close()

	media, err := NewSRTPMediaSession(testSRTPMediaConfig())
	if err != nil {
		t.Fatalf("NewSRTPMediaSession() error = %v", err)
	}
	clientAddr := clientPeer.LocalAddr().(*net.UDPAddr)
	clientRTCPAddr := clientRTCPPeer.LocalAddr().(*net.UDPAddr)
	imsAddr := imsPeer.LocalAddr().(*net.UDPAddr)
	imsRTCPAddr := imsRTCPPeer.LocalAddr().(*net.UDPAddr)
	relay, err := NewRTPRelaySession(context.Background(), RTPRelayConfig{
		ClientListenIP:    "127.0.0.1",
		ClientAdvertiseIP: "127.0.0.1",
		IMSListenIP:       "127.0.0.1",
		IMSAdvertiseIP:    "127.0.0.1",
		Transforms:        media.RelayTransforms(),
	}, SDPInfo{
		ConnectionIP:           "127.0.0.1",
		MediaPort:              clientAddr.Port,
		RTCPPort:               clientRTCPAddr.Port,
		TelephoneEventPayloads: map[uint8]int{101: 8000},
	})
	if err != nil {
		t.Fatalf("NewRTPRelaySession() error = %v", err)
	}
	defer relay.Close()
	if err := relay.SetIMSRemote(SDPInfo{
		ConnectionIP:           "127.0.0.1",
		MediaPort:              imsAddr.Port,
		RTCPPort:               imsRTCPAddr.Port,
		TelephoneEventPayloads: map[uint8]int{101: 8000},
	}); err != nil {
		t.Fatalf("SetIMSRemote() error = %v", err)
	}
	result, err := relay.SendRTPDTMFToIMS(context.Background(), RTPRelayDTMFRequest{
		Signal:         "#",
		DurationMS:     10,
		StepMS:         5,
		EndPacketCount: 1,
		SequenceNumber: 9,
		Timestamp:      0x10,
		SSRC:           0x22334455,
	})
	if err != nil {
		t.Fatalf("SendRTPDTMFToIMS() error = %v", err)
	}
	if result.Packets != 2 {
		t.Fatalf("result=%+v", result)
	}
	for i := 0; i < result.Packets; i++ {
		got, _ := readTestUDP(t, imsPeer)
		if len(got) <= 16 {
			t.Fatalf("IMS got unprotected RTP packet=%x", got)
		}
		plain, err := media.UnprotectIMSRTP(got)
		if err != nil {
			t.Fatalf("UnprotectIMSRTP(%d) error = %v", i, err)
		}
		event, ok, err := ParseRTPDTMFEvent(RTPDTMFClientToIMS, plain, map[uint8]int{101: 8000})
		if err != nil || !ok {
			t.Fatalf("ParseRTPDTMFEvent(%d) ok=%v err=%v plain=%x", i, ok, err, plain)
		}
		if event.Signal != "#" || event.SequenceNumber != uint16(9+i) || event.End != (i == result.Packets-1) {
			t.Fatalf("event[%d]=%+v", i, event)
		}
	}
}

func TestRTPRelaySessionSendsGeneratedRTCPThroughSRTPTransform(t *testing.T) {
	clientPeer := listenTestUDP(t)
	defer clientPeer.Close()
	clientRTCPPeer := listenTestUDP(t)
	defer clientRTCPPeer.Close()
	imsPeer := listenTestUDP(t)
	defer imsPeer.Close()
	imsRTCPPeer := listenTestUDP(t)
	defer imsRTCPPeer.Close()

	media, err := NewSRTPMediaSession(testSRTPMediaConfig())
	if err != nil {
		t.Fatalf("NewSRTPMediaSession() error = %v", err)
	}
	clientAddr := clientPeer.LocalAddr().(*net.UDPAddr)
	clientRTCPAddr := clientRTCPPeer.LocalAddr().(*net.UDPAddr)
	imsAddr := imsPeer.LocalAddr().(*net.UDPAddr)
	imsRTCPAddr := imsRTCPPeer.LocalAddr().(*net.UDPAddr)
	relay, err := NewRTPRelaySession(context.Background(), RTPRelayConfig{
		ClientListenIP:    "127.0.0.1",
		ClientAdvertiseIP: "127.0.0.1",
		IMSListenIP:       "127.0.0.1",
		IMSAdvertiseIP:    "127.0.0.1",
		Transforms:        media.RelayTransforms(),
	}, SDPInfo{ConnectionIP: "127.0.0.1", MediaPort: clientAddr.Port, RTCPPort: clientRTCPAddr.Port})
	if err != nil {
		t.Fatalf("NewRTPRelaySession() error = %v", err)
	}
	defer relay.Close()
	if err := relay.SetIMSRemote(SDPInfo{ConnectionIP: "127.0.0.1", MediaPort: imsAddr.Port, RTCPPort: imsRTCPAddr.Port}); err != nil {
		t.Fatalf("SetIMSRemote() error = %v", err)
	}
	result, err := relay.SendRTCPToClient(context.Background(), &rtcp.ReceiverReport{
		SSRC: 0x33333333,
		Reports: []rtcp.ReceptionReport{{
			SSRC:               0x44444444,
			LastSequenceNumber: 91,
			Jitter:             12,
		}},
	})
	if err != nil {
		t.Fatalf("SendRTCPToClient() error = %v", err)
	}
	if result.Datagrams != 1 || result.Feedback.ReceiverReports != 1 {
		t.Fatalf("result=%+v", result)
	}
	got, _ := readTestUDP(t, clientRTCPPeer)
	plain, err := media.UnprotectClientRTCP(got)
	if err != nil {
		t.Fatalf("UnprotectClientRTCP() error = %v", err)
	}
	if bytes.Equal(got, plain) || len(got) <= len(plain) {
		t.Fatalf("client got unprotected RTCP packet=%x plain=%x", got, plain)
	}
	packets, err := rtcp.Unmarshal(plain)
	if err != nil {
		t.Fatalf("rtcp.Unmarshal() error = %v", err)
	}
	if len(packets) != 1 {
		t.Fatalf("packets=%d, want 1", len(packets))
	}
	if rr, ok := packets[0].(*rtcp.ReceiverReport); !ok || rr.SSRC != 0x33333333 || len(rr.Reports) != 1 || rr.Reports[0].SSRC != 0x44444444 {
		t.Fatalf("receiver report=%+v ok=%v", packets[0], ok)
	}
}

func listenTestUDP(t *testing.T) *net.UDPConn {
	t.Helper()
	conn, err := net.ListenUDP("udp", &net.UDPAddr{IP: net.ParseIP("127.0.0.1")})
	if err != nil {
		t.Fatalf("ListenUDP() error = %v", err)
	}
	return conn
}

func readTestUDP(t *testing.T, conn *net.UDPConn) ([]byte, *net.UDPAddr) {
	t.Helper()
	if err := conn.SetReadDeadline(time.Now().Add(time.Second)); err != nil {
		t.Fatalf("SetReadDeadline() error = %v", err)
	}
	buf := make([]byte, 128)
	n, addr, err := conn.ReadFromUDP(buf)
	if err != nil {
		t.Fatalf("ReadFromUDP() error = %v", err)
	}
	return append([]byte(nil), buf[:n]...), addr
}

func expectNoTestUDP(t *testing.T, conn *net.UDPConn) {
	t.Helper()
	if err := conn.SetReadDeadline(time.Now().Add(150 * time.Millisecond)); err != nil {
		t.Fatalf("SetReadDeadline() error = %v", err)
	}
	buf := make([]byte, 128)
	n, addr, err := conn.ReadFromUDP(buf)
	if err == nil {
		t.Fatalf("unexpected UDP packet from %v: %x", addr, buf[:n])
	}
	if netErr, ok := err.(net.Error); !ok || !netErr.Timeout() {
		t.Fatalf("ReadFromUDP() error = %v, want timeout", err)
	}
}

func readRTCPFeedbackEvent(t *testing.T, events <-chan RTCPFeedbackEvent) RTCPFeedbackEvent {
	t.Helper()
	select {
	case event := <-events:
		return event
	case <-time.After(time.Second):
		t.Fatalf("timed out waiting for RTCP feedback event")
		return RTCPFeedbackEvent{}
	}
}

func readRTPDTMFEvent(t *testing.T, events <-chan RTPDTMFEvent) RTPDTMFEvent {
	t.Helper()
	select {
	case event := <-events:
		return event
	case <-time.After(time.Second):
		t.Fatalf("timed out waiting for RTP DTMF event")
		return RTPDTMFEvent{}
	}
}

func waitRelayStats(t *testing.T, relay *RTPRelaySession, pred func(RTPRelayStats) bool) RTPRelayStats {
	t.Helper()
	deadline := time.Now().Add(time.Second)
	for {
		stats := relay.Stats()
		if pred(stats) {
			return stats
		}
		if time.Now().After(deadline) {
			return stats
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func waitRelayQuality(t *testing.T, relay *RTPRelaySession, pred func(RTPRelayQualityStats) bool) RTPRelayQualityStats {
	t.Helper()
	deadline := time.Now().Add(time.Second)
	for {
		quality := relay.Quality()
		if pred(quality) {
			return quality
		}
		if time.Now().After(deadline) {
			return quality
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func udpAddrFromSDP(t *testing.T, info SDPInfo) *net.UDPAddr {
	t.Helper()
	addr, err := net.ResolveUDPAddr("udp", net.JoinHostPort(info.ConnectionIP, strconv.Itoa(info.MediaPort)))
	if err != nil {
		t.Fatalf("ResolveUDPAddr(%+v) error = %v", info, err)
	}
	return addr
}

func udpRTCPAddrFromSDP(t *testing.T, info SDPInfo) *net.UDPAddr {
	t.Helper()
	addr, err := net.ResolveUDPAddr("udp", net.JoinHostPort(info.ConnectionIP, strconv.Itoa(info.RTCPPort)))
	if err != nil {
		t.Fatalf("ResolveUDPAddr(%+v RTCP) error = %v", info, err)
	}
	return addr
}
