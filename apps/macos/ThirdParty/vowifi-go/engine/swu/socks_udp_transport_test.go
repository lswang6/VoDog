package swu

import (
	"context"
	"encoding/binary"
	"io"
	"net"
	"testing"
	"time"
)

func TestSOCKSUDPFrameRoundTrip(t *testing.T) {
	payload := []byte{1, 2, 3, 4}
	frame, err := encodeSOCKSUDP(socksAddress{host: "epdg.example", port: 4500}, payload)
	if err != nil {
		t.Fatal(err)
	}
	got, err := decodeSOCKSUDP(frame)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != string(payload) {
		t.Fatalf("payload = %x, want %x", got, payload)
	}
	frame[2] = 1
	if _, err := decodeSOCKSUDP(frame); err == nil {
		t.Fatal("fragmented SOCKS UDP frame was accepted")
	}
}

func TestSOCKSNATTTransportSharesUDPAssociation(t *testing.T) {
	proxyAddr, stop := startSOCKSUDPEchoProxy(t)
	defer stop()

	transport, err := NewSOCKSNATTTransport(ProxyConfig{
		Enabled: true,
		Address: proxyAddr,
	}, "198.51.100.10:4500", time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer transport.Close(context.Background())

	ikeRequest := []byte{0x21, 0x22, 0x23}
	ikeResponse, err := transport.ExchangeIKE(context.Background(), ikeRequest)
	if err != nil {
		t.Fatal(err)
	}
	if string(ikeResponse) != string(ikeRequest) {
		t.Fatalf("IKE response = %x, want %x", ikeResponse, ikeRequest)
	}

	espRequest := []byte{1, 2, 3, 4, 5, 6, 7, 8}
	if err := transport.SendESPPacket(context.Background(), espRequest); err != nil {
		t.Fatal(err)
	}
	espResponse, err := transport.ReadESPPacket(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if string(espResponse) != string(espRequest) {
		t.Fatalf("ESP response = %x, want %x", espResponse, espRequest)
	}
}

func startSOCKSUDPEchoProxy(t *testing.T) (string, func()) {
	t.Helper()
	udp, err := net.ListenUDP("udp4", &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1)})
	if err != nil {
		t.Fatal(err)
	}
	tcp, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		udp.Close()
		t.Fatal(err)
	}
	done := make(chan struct{})
	go func() {
		buf := make([]byte, 64*1024)
		for {
			n, peer, err := udp.ReadFromUDP(buf)
			if err != nil {
				return
			}
			_, _ = udp.WriteToUDP(buf[:n], peer)
		}
	}()
	go func() {
		defer close(done)
		conn, err := tcp.Accept()
		if err != nil {
			return
		}
		defer conn.Close()
		header := make([]byte, 2)
		if _, err := io.ReadFull(conn, header); err != nil {
			return
		}
		methods := make([]byte, int(header[1]))
		if _, err := io.ReadFull(conn, methods); err != nil {
			return
		}
		if _, err := conn.Write([]byte{5, 0}); err != nil {
			return
		}
		request := make([]byte, 10)
		if _, err := io.ReadFull(conn, request); err != nil || request[1] != 3 {
			return
		}
		port := uint16(udp.LocalAddr().(*net.UDPAddr).Port)
		reply := []byte{5, 0, 0, 1, 127, 0, 0, 1, 0, 0}
		binary.BigEndian.PutUint16(reply[8:], port)
		if _, err := conn.Write(reply); err != nil {
			return
		}
		_, _ = io.Copy(io.Discard, conn)
	}()
	return tcp.Addr().String(), func() {
		_ = tcp.Close()
		_ = udp.Close()
		select {
		case <-done:
		case <-time.After(time.Second):
		}
	}
}
