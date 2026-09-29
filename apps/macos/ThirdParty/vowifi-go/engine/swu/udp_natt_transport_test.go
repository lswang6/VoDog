package swu

import (
	"bytes"
	"context"
	"net"
	"testing"
	"time"
)

func TestUDPNATTTransportReusesPortAndDemultiplexesIKEAndESP(t *testing.T) {
	server, err := net.ListenUDP("udp4", &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1), Port: 0})
	if err != nil {
		t.Fatal(err)
	}
	defer server.Close()

	ports := make(chan int, 2)
	serverErr := make(chan error, 1)
	go func() {
		buf := make([]byte, 2048)
		var client *net.UDPAddr
		for i := 0; i < 2; i++ {
			n, addr, err := server.ReadFromUDP(buf)
			if err != nil {
				serverErr <- err
				return
			}
			client = addr
			ports <- addr.Port
			response := append([]byte{0, 0, 0, 0}, buf[4:n]...)
			if _, err := server.WriteToUDP(response, addr); err != nil {
				serverErr <- err
				return
			}
		}
		esp := []byte{0xde, 0xad, 0xbe, 0xef, 0, 0, 0, 1, 0xaa}
		_, err := server.WriteToUDP(esp, client)
		serverErr <- err
	}()

	transport := NewUDPNATTTransport(server.LocalAddr().String(), "127.0.0.1:0", time.Second, true)
	defer transport.Close(context.Background())
	for _, request := range [][]byte{{1, 2, 3, 4, 5, 6, 7, 8}, {9, 10, 11, 12, 13, 14, 15, 16}} {
		response, err := transport.ExchangeIKE(context.Background(), request)
		if err != nil {
			t.Fatal(err)
		}
		if !bytes.Equal(response, request) {
			t.Fatalf("response=%x, want %x", response, request)
		}
	}
	first, second := <-ports, <-ports
	if first != second {
		t.Fatalf("source ports changed: %d -> %d", first, second)
	}
	esp, err := transport.ReadESPPacket(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(esp, []byte{0xde, 0xad, 0xbe, 0xef, 0, 0, 0, 1, 0xaa}) {
		t.Fatalf("ESP=%x", esp)
	}
	if err := <-serverErr; err != nil {
		t.Fatal(err)
	}
}
