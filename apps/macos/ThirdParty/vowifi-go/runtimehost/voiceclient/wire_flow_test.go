package voiceclient

import (
	"bufio"
	"context"
	"errors"
	"net"
	"strconv"
	"strings"
	"testing"
	"time"
)

func TestWireSIPFlowReusesUDPFlowForRegisterAndDialog(t *testing.T) {
	pc, err := net.ListenPacket("udp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("ListenPacket() error = %v", err)
	}
	defer pc.Close()

	type seenRequest struct {
		addr string
		wire string
	}
	seen := make(chan []seenRequest, 1)
	go func() {
		var requests []seenRequest
		buf := make([]byte, 65535)
		for i := 0; i < 2; i++ {
			_ = pc.SetReadDeadline(time.Now().Add(time.Second))
			n, addr, err := pc.ReadFrom(buf)
			if err != nil {
				seen <- append(requests, seenRequest{wire: "read error: " + err.Error()})
				return
			}
			requests = append(requests, seenRequest{
				addr: addr.String(),
				wire: string(append([]byte(nil), buf[:n]...)),
			})
			_, _ = pc.WriteTo([]byte("SIP/2.0 200 OK\r\nContent-Length: 0\r\n\r\n"), addr)
		}
		seen <- requests
	}()

	flow := &WireSIPFlow{Network: "udp", ServerAddr: pc.LocalAddr().String(), Timeout: time.Second}
	defer flow.Close()
	resp, err := flow.RoundTripRegister(context.Background(), RegisterMessage{
		URI: "sip:ims.example",
		Headers: map[string]string{
			"To":           "<sip:user@example>",
			"From":         "<sip:user@example>;tag=t",
			"Contact":      "<sip:user@192.0.2.10:5060>",
			"Call-ID":      "flow-register",
			"CSeq":         "1 REGISTER",
			"Max-Forwards": "70",
		},
	})
	if err != nil || resp.StatusCode != 200 {
		t.Fatalf("RoundTripRegister() response=%+v err=%v", resp, err)
	}
	resp, err = flow.RoundTripRequest(context.Background(), SIPRequestMessage{
		Method: "MESSAGE",
		URI:    "sip:+18005551212@example",
		Headers: map[string]string{
			"To":           "<sip:+18005551212@example>",
			"From":         "<sip:user@example>;tag=sms",
			"Contact":      "<sip:user@192.0.2.10:5060>",
			"Call-ID":      "flow-message",
			"CSeq":         "1 MESSAGE",
			"Max-Forwards": "70",
		},
		Body: []byte("hello"),
	})
	if err != nil || resp.StatusCode != 200 {
		t.Fatalf("RoundTripRequest() response=%+v err=%v", resp, err)
	}
	requests := <-seen
	if len(requests) != 2 {
		t.Fatalf("requests=%d %+v", len(requests), requests)
	}
	if requests[0].addr == "" || requests[0].addr != requests[1].addr {
		t.Fatalf("flow used different local addresses: %+v", requests)
	}
	if !strings.Contains(requests[0].wire, "REGISTER sip:ims.example SIP/2.0") || !strings.Contains(requests[1].wire, "MESSAGE sip:+18005551212@example SIP/2.0") {
		t.Fatalf("unexpected wires: %+v", requests)
	}
}

func TestWireSIPFlowSendsCRLFKeepaliveOnEstablishedUDPFlow(t *testing.T) {
	pc, err := net.ListenPacket("udp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("ListenPacket() error = %v", err)
	}
	defer pc.Close()

	seen := make(chan []string, 1)
	go func() {
		var requests []string
		buf := make([]byte, 65535)
		_ = pc.SetReadDeadline(time.Now().Add(time.Second))
		n, addr, err := pc.ReadFrom(buf)
		if err != nil {
			seen <- []string{"read register error: " + err.Error()}
			return
		}
		requests = append(requests, string(append([]byte(nil), buf[:n]...)), addr.String())
		_, _ = pc.WriteTo([]byte("SIP/2.0 200 OK\r\nContent-Length: 0\r\n\r\n"), addr)
		_ = pc.SetReadDeadline(time.Now().Add(time.Second))
		n, keepaliveAddr, err := pc.ReadFrom(buf)
		if err != nil {
			seen <- append(requests, "read keepalive error: "+err.Error())
			return
		}
		requests = append(requests, string(append([]byte(nil), buf[:n]...)), keepaliveAddr.String())
		seen <- requests
	}()

	flow := &WireSIPFlow{Network: "udp", ServerAddr: pc.LocalAddr().String(), Timeout: time.Second}
	defer flow.Close()
	resp, err := flow.RoundTripRegister(context.Background(), RegisterMessage{
		URI: "sip:ims.example",
		Headers: map[string]string{
			"To":           "<sip:user@example>",
			"From":         "<sip:user@example>;tag=t",
			"Contact":      "<sip:user@192.0.2.10:5060>",
			"Call-ID":      "flow-keepalive",
			"CSeq":         "1 REGISTER",
			"Max-Forwards": "70",
		},
	})
	if err != nil || resp.StatusCode != 200 {
		t.Fatalf("RoundTripRegister() response=%+v err=%v", resp, err)
	}
	if err := flow.SendCRLFKeepalive(context.Background()); err != nil {
		t.Fatalf("SendCRLFKeepalive() error = %v", err)
	}
	requests := <-seen
	if len(requests) != 4 {
		t.Fatalf("requests=%d %+v", len(requests), requests)
	}
	if requests[2] != "\r\n\r\n" || requests[1] != requests[3] {
		t.Fatalf("keepalive=%q addrs=%q/%q", requests[2], requests[1], requests[3])
	}
}

func TestWireSIPFlowUsesResolverForRegisterTarget(t *testing.T) {
	pc, err := net.ListenPacket("udp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("ListenPacket() error = %v", err)
	}
	defer pc.Close()

	seen := make(chan string, 1)
	go func() {
		buf := make([]byte, 65535)
		_ = pc.SetReadDeadline(time.Now().Add(time.Second))
		n, addr, err := pc.ReadFrom(buf)
		if err != nil {
			seen <- "read error: " + err.Error()
			return
		}
		seen <- string(append([]byte(nil), buf[:n]...))
		_, _ = pc.WriteTo([]byte("SIP/2.0 200 OK\r\nContent-Length: 0\r\n\r\n"), addr)
	}()

	var resolvedNetwork, resolvedURI string
	flow := &WireSIPFlow{
		Network: "udp",
		Resolver: SIPServerResolverFunc(func(ctx context.Context, network, uri string) (string, error) {
			resolvedNetwork = network
			resolvedURI = uri
			return pc.LocalAddr().String(), nil
		}),
		Timeout: time.Second,
	}
	defer flow.Close()
	resp, err := flow.RoundTripRegister(context.Background(), RegisterMessage{
		URI: "sip:ims.example",
		Headers: map[string]string{
			"To":           "<sip:user@example>",
			"From":         "<sip:user@example>;tag=t",
			"Contact":      "<sip:user@192.0.2.10:5060>",
			"Call-ID":      "flow-resolver",
			"CSeq":         "1 REGISTER",
			"Max-Forwards": "70",
		},
	})
	if err != nil || resp.StatusCode != 200 {
		t.Fatalf("RoundTripRegister() response=%+v err=%v", resp, err)
	}
	if resolvedNetwork != "udp" || resolvedURI != "sip:ims.example" {
		t.Fatalf("resolver saw network=%q uri=%q", resolvedNetwork, resolvedURI)
	}
	if wire := <-seen; !strings.Contains(wire, "REGISTER sip:ims.example SIP/2.0") {
		t.Fatalf("wire=%q", wire)
	}
}

func TestWireSIPFlowFailsOverAndReusesResolvedTarget(t *testing.T) {
	dead, err := net.ListenPacket("udp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("ListenPacket(dead) error = %v", err)
	}
	defer dead.Close()
	live, err := net.ListenPacket("udp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("ListenPacket(live) error = %v", err)
	}
	defer live.Close()

	deadSeen := make(chan string, 1)
	go func() {
		buf := make([]byte, 65535)
		_ = dead.SetReadDeadline(time.Now().Add(time.Second))
		n, _, err := dead.ReadFrom(buf)
		if err != nil {
			deadSeen <- "read error: " + err.Error()
			return
		}
		deadSeen <- string(append([]byte(nil), buf[:n]...))
	}()
	type seenRequest struct {
		addr string
		wire string
	}
	liveSeen := make(chan []seenRequest, 1)
	go func() {
		var requests []seenRequest
		buf := make([]byte, 65535)
		for i := 0; i < 2; i++ {
			_ = live.SetReadDeadline(time.Now().Add(time.Second))
			n, addr, err := live.ReadFrom(buf)
			if err != nil {
				liveSeen <- append(requests, seenRequest{wire: "read error: " + err.Error()})
				return
			}
			requests = append(requests, seenRequest{
				addr: addr.String(),
				wire: string(append([]byte(nil), buf[:n]...)),
			})
			_, _ = live.WriteTo([]byte("SIP/2.0 200 OK\r\nContent-Length: 0\r\n\r\n"), addr)
		}
		liveSeen <- requests
	}()

	resolverCalls := 0
	flow := &WireSIPFlow{
		Network: "udp",
		Resolver: SIPServerCandidateResolverFunc(func(ctx context.Context, network, uri string) ([]string, error) {
			resolverCalls++
			if network != "udp" || uri != "sip:ims.example" {
				t.Fatalf("resolver network=%q uri=%q", network, uri)
			}
			return []string{dead.LocalAddr().String(), live.LocalAddr().String()}, nil
		}),
		Timeout:               80 * time.Millisecond,
		RetransmitInterval:    20 * time.Millisecond,
		MaxRetransmitInterval: 20 * time.Millisecond,
		MaxRetransmits:        1,
	}
	defer flow.Close()
	resp, err := flow.RoundTripRegister(context.Background(), RegisterMessage{
		URI: "sip:ims.example",
		Headers: map[string]string{
			"To":           "<sip:user@example>",
			"From":         "<sip:user@example>;tag=t",
			"Contact":      "<sip:user@192.0.2.10:5060>",
			"Call-ID":      "flow-failover-register",
			"CSeq":         "1 REGISTER",
			"Max-Forwards": "70",
		},
	})
	if err != nil || resp.StatusCode != 200 {
		t.Fatalf("RoundTripRegister() response=%+v err=%v", resp, err)
	}
	resp, err = flow.RoundTripRequest(context.Background(), SIPRequestMessage{
		Method: "MESSAGE",
		URI:    "sip:+18005551212@example",
		Headers: map[string]string{
			"To":           "<sip:+18005551212@example>",
			"From":         "<sip:user@example>;tag=sms",
			"Contact":      "<sip:user@192.0.2.10:5060>",
			"Call-ID":      "flow-failover-message",
			"CSeq":         "1 MESSAGE",
			"Max-Forwards": "70",
		},
		Body: []byte("hello"),
	})
	if err != nil || resp.StatusCode != 200 {
		t.Fatalf("RoundTripRequest() response=%+v err=%v", resp, err)
	}
	if wire := <-deadSeen; !strings.Contains(wire, "REGISTER sip:ims.example") {
		t.Fatalf("dead target wire=%q", wire)
	}
	requests := <-liveSeen
	if len(requests) != 2 {
		t.Fatalf("live requests=%d %+v", len(requests), requests)
	}
	if requests[0].addr == "" || requests[0].addr != requests[1].addr {
		t.Fatalf("flow did not reuse live target/local address: %+v", requests)
	}
	if !strings.Contains(requests[0].wire, "REGISTER sip:ims.example") ||
		!strings.Contains(requests[1].wire, "MESSAGE sip:+18005551212@example") {
		t.Fatalf("live wires=%+v", requests)
	}
	if resolverCalls != 1 {
		t.Fatalf("resolver calls=%d, want 1", resolverCalls)
	}
}

func TestWireSIPFlowRegisterFailsOverRecoverableResponse(t *testing.T) {
	first, err := net.ListenPacket("udp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("ListenPacket(first) error = %v", err)
	}
	defer first.Close()
	second, err := net.ListenPacket("udp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("ListenPacket(second) error = %v", err)
	}
	defer second.Close()

	firstSeen := make(chan string, 1)
	go func() {
		buf := make([]byte, 65535)
		_ = first.SetReadDeadline(time.Now().Add(time.Second))
		n, addr, err := first.ReadFrom(buf)
		if err != nil {
			firstSeen <- "read error: " + err.Error()
			return
		}
		firstSeen <- string(append([]byte(nil), buf[:n]...))
		_, _ = first.WriteTo([]byte("SIP/2.0 503 Service Unavailable\r\nRetry-After: 30\r\nContent-Length: 0\r\n\r\n"), addr)
	}()
	secondSeen := make(chan string, 1)
	go func() {
		buf := make([]byte, 65535)
		_ = second.SetReadDeadline(time.Now().Add(time.Second))
		n, addr, err := second.ReadFrom(buf)
		if err != nil {
			secondSeen <- "read error: " + err.Error()
			return
		}
		secondSeen <- string(append([]byte(nil), buf[:n]...))
		_, _ = second.WriteTo([]byte("SIP/2.0 200 OK\r\nContent-Length: 0\r\n\r\n"), addr)
	}()

	resolverCalls := 0
	flow := &WireSIPFlow{
		Network: "udp",
		Resolver: SIPServerCandidateResolverFunc(func(ctx context.Context, network, uri string) ([]string, error) {
			resolverCalls++
			return []string{first.LocalAddr().String(), second.LocalAddr().String()}, nil
		}),
		Timeout: time.Second,
	}
	defer flow.Close()
	resp, err := flow.RoundTripRegister(context.Background(), RegisterMessage{
		URI: "sip:ims.example",
		Headers: map[string]string{
			"To":           "<sip:user@example>",
			"From":         "<sip:user@example>;tag=t",
			"Contact":      "<sip:user@192.0.2.10:5060>",
			"Call-ID":      "flow-failover-response",
			"CSeq":         "1 REGISTER",
			"Max-Forwards": "70",
		},
	})
	if err != nil || resp.StatusCode != 200 {
		t.Fatalf("RoundTripRegister() response=%+v err=%v", resp, err)
	}
	if wire := <-firstSeen; !strings.Contains(wire, "REGISTER sip:ims.example") {
		t.Fatalf("first target wire=%q", wire)
	}
	if wire := <-secondSeen; !strings.Contains(wire, "REGISTER sip:ims.example") {
		t.Fatalf("second target wire=%q", wire)
	}
	if resolverCalls != 1 {
		t.Fatalf("resolver calls=%d, want 1", resolverCalls)
	}
}

func TestWireSIPFlowDialogFailsOverRecoverableResponse(t *testing.T) {
	first, err := net.ListenPacket("udp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("ListenPacket(first) error = %v", err)
	}
	defer first.Close()
	second, err := net.ListenPacket("udp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("ListenPacket(second) error = %v", err)
	}
	defer second.Close()

	firstSeen := make(chan string, 1)
	go func() {
		buf := make([]byte, 65535)
		_ = first.SetReadDeadline(time.Now().Add(time.Second))
		n, addr, err := first.ReadFrom(buf)
		if err != nil {
			firstSeen <- "read error: " + err.Error()
			return
		}
		firstSeen <- string(append([]byte(nil), buf[:n]...))
		_, _ = first.WriteTo([]byte("SIP/2.0 503 Service Unavailable\r\nRetry-After: 20\r\nContent-Length: 0\r\n\r\n"), addr)
	}()
	secondSeen := make(chan string, 1)
	go func() {
		buf := make([]byte, 65535)
		_ = second.SetReadDeadline(time.Now().Add(time.Second))
		n, addr, err := second.ReadFrom(buf)
		if err != nil {
			secondSeen <- "read error: " + err.Error()
			return
		}
		secondSeen <- string(append([]byte(nil), buf[:n]...))
		_, _ = second.WriteTo([]byte("SIP/2.0 202 Accepted\r\nContent-Length: 0\r\n\r\n"), addr)
	}()

	resolverCalls := 0
	flow := &WireSIPFlow{
		Network: "udp",
		Resolver: SIPServerCandidateResolverFunc(func(ctx context.Context, network, uri string) ([]string, error) {
			resolverCalls++
			return []string{first.LocalAddr().String(), second.LocalAddr().String()}, nil
		}),
		Timeout: time.Second,
	}
	defer flow.Close()
	resp, err := flow.RoundTripRequest(context.Background(), SIPRequestMessage{
		Method: "MESSAGE",
		URI:    "sip:+18005551212@example",
		Headers: map[string]string{
			"To":           "<sip:+18005551212@example>",
			"From":         "<sip:user@example>;tag=sms",
			"Contact":      "<sip:user@192.0.2.10:5060>",
			"Call-ID":      "flow-dialog-failover",
			"CSeq":         "1 MESSAGE",
			"Max-Forwards": "70",
		},
		Body: []byte("hello"),
	})
	if err != nil || resp.StatusCode != 202 {
		t.Fatalf("RoundTripRequest() response=%+v err=%v", resp, err)
	}
	if wire := <-firstSeen; !strings.Contains(wire, "MESSAGE sip:+18005551212@example") {
		t.Fatalf("first target wire=%q", wire)
	}
	if wire := <-secondSeen; !strings.Contains(wire, "MESSAGE sip:+18005551212@example") {
		t.Fatalf("second target wire=%q", wire)
	}
	if resolverCalls != 1 {
		t.Fatalf("resolver calls=%d, want 1", resolverCalls)
	}
}

func TestWireSIPFlowFailsOverTCPResetAndReusesResolvedTarget(t *testing.T) {
	first, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("Listen(first) error = %v", err)
	}
	defer first.Close()
	second, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("Listen(second) error = %v", err)
	}
	defer second.Close()

	firstSeen := make(chan string, 1)
	go func() {
		conn, err := first.Accept()
		if err != nil {
			firstSeen <- "accept error: " + err.Error()
			return
		}
		raw, err := readSIPStreamMessage(bufio.NewReader(conn))
		if err != nil {
			firstSeen <- "read error: " + err.Error()
			_ = conn.Close()
			return
		}
		firstSeen <- string(raw)
		if tcp, ok := conn.(*net.TCPConn); ok {
			_ = tcp.SetLinger(0)
		}
		_ = conn.Close()
	}()
	secondSeen := make(chan []string, 1)
	go func() {
		conn, err := second.Accept()
		if err != nil {
			secondSeen <- []string{"accept error: " + err.Error()}
			return
		}
		defer conn.Close()
		reader := bufio.NewReader(conn)
		var requests []string
		for i := 0; i < 2; i++ {
			raw, err := readSIPStreamMessage(reader)
			if err != nil {
				secondSeen <- append(requests, "read error: "+err.Error())
				return
			}
			requests = append(requests, string(raw))
			status := "SIP/2.0 200 OK\r\nContent-Length: 0\r\n\r\n"
			if i == 1 {
				status = "SIP/2.0 202 Accepted\r\nContent-Length: 0\r\n\r\n"
			}
			_, _ = conn.Write([]byte(status))
		}
		secondSeen <- requests
	}()

	resolverCalls := 0
	flow := &WireSIPFlow{
		Network: "tcp",
		Resolver: SIPServerCandidateResolverFunc(func(ctx context.Context, network, uri string) ([]string, error) {
			resolverCalls++
			return []string{first.Addr().String(), second.Addr().String()}, nil
		}),
		Timeout: time.Second,
	}
	defer flow.Close()
	resp, err := flow.RoundTripRegister(context.Background(), RegisterMessage{
		URI: "sip:ims.example",
		Headers: map[string]string{
			"To":           "<sip:user@example>",
			"From":         "<sip:user@example>;tag=t",
			"Contact":      "<sip:user@192.0.2.10:5060>",
			"Call-ID":      "flow-tcp-reset-register",
			"CSeq":         "1 REGISTER",
			"Max-Forwards": "70",
		},
	})
	if err != nil || resp.StatusCode != 200 {
		t.Fatalf("RoundTripRegister() response=%+v err=%v", resp, err)
	}
	resp, err = flow.RoundTripRequest(context.Background(), SIPRequestMessage{
		Method: "MESSAGE",
		URI:    "sip:+18005551212@example",
		Headers: map[string]string{
			"To":           "<sip:+18005551212@example>",
			"From":         "<sip:user@example>;tag=sms",
			"Contact":      "<sip:user@192.0.2.10:5060>",
			"Call-ID":      "flow-tcp-reset-message",
			"CSeq":         "1 MESSAGE",
			"Max-Forwards": "70",
		},
		Body: []byte("hello"),
	})
	if err != nil || resp.StatusCode != 202 {
		t.Fatalf("RoundTripRequest() response=%+v err=%v", resp, err)
	}
	if wire := <-firstSeen; !strings.Contains(wire, "REGISTER sip:ims.example") {
		t.Fatalf("first target wire=%q", wire)
	}
	requests := <-secondSeen
	if len(requests) != 2 ||
		!strings.Contains(requests[0], "REGISTER sip:ims.example") ||
		!strings.Contains(requests[1], "MESSAGE sip:+18005551212@example") {
		t.Fatalf("second target requests=%+v", requests)
	}
	if resolverCalls != 1 {
		t.Fatalf("resolver calls=%d, want 1", resolverCalls)
	}
}

func TestWireSIPFlowReusesTLSFlowForRegisterAndDialog(t *testing.T) {
	ln := listenTestSIPTLS(t)
	defer ln.Close()

	seen := make(chan []string, 1)
	go func() {
		conn, err := ln.Accept()
		if err != nil {
			seen <- []string{"accept error: " + err.Error()}
			return
		}
		defer conn.Close()
		reader := bufio.NewReader(conn)
		var requests []string
		for i := 0; i < 2; i++ {
			raw, err := readSIPStreamMessage(reader)
			if err != nil {
				seen <- append(requests, "read error: "+err.Error())
				return
			}
			requests = append(requests, string(raw))
			status := "SIP/2.0 200 OK\r\nContent-Length: 0\r\n\r\n"
			if i == 1 {
				status = "SIP/2.0 202 Accepted\r\nContent-Length: 0\r\n\r\n"
			}
			_, _ = conn.Write([]byte(status))
		}
		seen <- requests
	}()

	resolverCalls := 0
	flow := &WireSIPFlow{
		Resolver: SIPServerCandidateResolverFunc(func(ctx context.Context, network, uri string) ([]string, error) {
			resolverCalls++
			if network != "tls" {
				t.Errorf("resolver network=%q, want tls", network)
			}
			return []string{ln.Addr().String()}, nil
		}),
		Timeout:   time.Second,
		TLSConfig: testSIPClientTLSConfig(),
	}
	defer flow.Close()

	resp, err := flow.RoundTripRegister(context.Background(), RegisterMessage{
		URI: "sips:ims.example",
		Headers: map[string]string{
			"To":           "<sips:user@example>",
			"From":         "<sips:user@example>;tag=t",
			"Contact":      "<sips:user@192.0.2.10:5061>",
			"Call-ID":      "flow-tls-register",
			"CSeq":         "1 REGISTER",
			"Max-Forwards": "70",
		},
	})
	if err != nil || resp.StatusCode != 200 {
		t.Fatalf("RoundTripRegister(tls) response=%+v err=%v", resp, err)
	}
	resp, err = flow.RoundTripRequest(context.Background(), SIPRequestMessage{
		Method: "MESSAGE",
		URI:    "sip:+18005551212@example",
		Headers: map[string]string{
			"To":           "<sip:+18005551212@example>",
			"From":         "<sip:user@example>;tag=sms",
			"Contact":      "<sip:user@192.0.2.10:5060>",
			"Call-ID":      "flow-tls-message",
			"CSeq":         "1 MESSAGE",
			"Max-Forwards": "70",
		},
		Body: []byte("hello"),
	})
	if err != nil || resp.StatusCode != 202 {
		t.Fatalf("RoundTripRequest(tls) response=%+v err=%v", resp, err)
	}
	requests := <-seen
	if len(requests) != 2 ||
		!strings.Contains(requests[0], "REGISTER sips:ims.example SIP/2.0") ||
		!strings.Contains(requests[0], "Via: SIP/2.0/TLS") ||
		!strings.Contains(requests[1], "MESSAGE sip:+18005551212@example SIP/2.0") ||
		!strings.Contains(requests[1], "Via: SIP/2.0/TLS") {
		t.Fatalf("TLS flow requests=%+v", requests)
	}
	if resolverCalls != 1 {
		t.Fatalf("resolver calls=%d, want 1", resolverCalls)
	}
}

func TestWireSIPFlowRegisterFollowsRedirectContactTarget(t *testing.T) {
	first, err := net.ListenPacket("udp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("ListenPacket(first) error = %v", err)
	}
	defer first.Close()
	second, err := net.ListenPacket("udp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("ListenPacket(second) error = %v", err)
	}
	defer second.Close()

	firstSeen := make(chan string, 1)
	go func() {
		buf := make([]byte, 65535)
		_ = first.SetReadDeadline(time.Now().Add(time.Second))
		n, addr, err := first.ReadFrom(buf)
		if err != nil {
			firstSeen <- "read error: " + err.Error()
			return
		}
		firstSeen <- string(append([]byte(nil), buf[:n]...))
		_, _ = first.WriteTo([]byte("SIP/2.0 302 Moved Temporarily\r\nContact: <sip:pcscf@"+second.LocalAddr().String()+">\r\nContent-Length: 0\r\n\r\n"), addr)
	}()
	secondSeen := make(chan string, 1)
	go func() {
		buf := make([]byte, 65535)
		_ = second.SetReadDeadline(time.Now().Add(time.Second))
		n, addr, err := second.ReadFrom(buf)
		if err != nil {
			secondSeen <- "read error: " + err.Error()
			return
		}
		secondSeen <- string(append([]byte(nil), buf[:n]...))
		_, _ = second.WriteTo([]byte("SIP/2.0 200 OK\r\nContent-Length: 0\r\n\r\n"), addr)
	}()

	flow := &WireSIPFlow{Network: "udp", ServerAddr: first.LocalAddr().String(), Timeout: time.Second}
	defer flow.Close()
	resp, err := flow.RoundTripRegister(context.Background(), RegisterMessage{
		URI: "sip:ims.example",
		Headers: map[string]string{
			"To":           "<sip:user@example>",
			"From":         "<sip:user@example>;tag=t",
			"Contact":      "<sip:user@192.0.2.10:5060>",
			"Call-ID":      "flow-register-redirect",
			"CSeq":         "1 REGISTER",
			"Max-Forwards": "70",
		},
	})
	if err != nil || resp.StatusCode != 200 {
		t.Fatalf("RoundTripRegister() response=%+v err=%v", resp, err)
	}
	if wire := <-firstSeen; !strings.Contains(wire, "REGISTER sip:ims.example") {
		t.Fatalf("first target wire=%q", wire)
	}
	if wire := <-secondSeen; !strings.Contains(wire, "REGISTER sip:ims.example") {
		t.Fatalf("redirect target wire=%q", wire)
	}
	if flow.target != second.LocalAddr().String() {
		t.Fatalf("flow target=%q, want redirect target %q", flow.target, second.LocalAddr().String())
	}
}

func TestWireSIPFlowUsesSecurityAssociationPortsForAuthenticatedRegister(t *testing.T) {
	initial, err := net.ListenPacket("udp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("ListenPacket(initial) error = %v", err)
	}
	defer initial.Close()
	protected, err := net.ListenPacket("udp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("ListenPacket(protected) error = %v", err)
	}
	defer protected.Close()
	protectedLocalPort := reserveTestUDPPort(t)
	protectedRemotePort := protected.LocalAddr().(*net.UDPAddr).Port

	firstSeen := make(chan string, 1)
	firstErr := make(chan string, 1)
	go func() {
		buf := make([]byte, 65535)
		_ = initial.SetReadDeadline(time.Now().Add(time.Second))
		n, addr, err := initial.ReadFrom(buf)
		if err != nil {
			firstErr <- "read error: " + err.Error()
			return
		}
		wire := string(append([]byte(nil), buf[:n]...))
		firstSeen <- wire
		req, err := ParseSIPRequest(buf[:n])
		if err != nil {
			firstErr <- "parse request error: " + err.Error()
			return
		}
		challenge, err := BuildSIPResponseWire(req, 401, "Unauthorized", map[string]string{
			"WWW-Authenticate": `Digest realm="ims.example", nonce="nonce", algorithm=MD5, qop="auth"`,
			"Security-Server": "ipsec-3gpp;alg=hmac-sha-1-96;ealg=null;spi-c=111;spi-s=222;port-c=" +
				strconv.Itoa(protectedLocalPort) + ";port-s=" + strconv.Itoa(protectedRemotePort),
		}, nil)
		if err != nil {
			firstErr <- "build challenge error: " + err.Error()
			return
		}
		if _, err := initial.WriteTo(challenge, addr); err != nil {
			firstErr <- "write challenge error: " + err.Error()
			return
		}
		firstErr <- ""
	}()

	type protectedSeenRequest struct {
		wire       string
		sourcePort int
	}
	protectedSeen := make(chan protectedSeenRequest, 1)
	protectedErr := make(chan string, 1)
	go func() {
		buf := make([]byte, 65535)
		_ = protected.SetReadDeadline(time.Now().Add(time.Second))
		n, addr, err := protected.ReadFrom(buf)
		if err != nil {
			protectedErr <- "read error: " + err.Error()
			return
		}
		sourcePort := 0
		if udpAddr, ok := addr.(*net.UDPAddr); ok {
			sourcePort = udpAddr.Port
		}
		protectedSeen <- protectedSeenRequest{
			wire:       string(append([]byte(nil), buf[:n]...)),
			sourcePort: sourcePort,
		}
		req, err := ParseSIPRequest(buf[:n])
		if err != nil {
			protectedErr <- "parse request error: " + err.Error()
			return
		}
		ok, err := BuildSIPResponseWire(req, 200, "OK", nil, nil)
		if err != nil {
			protectedErr <- "build ok error: " + err.Error()
			return
		}
		if _, err := protected.WriteTo(ok, addr); err != nil {
			protectedErr <- "write ok error: " + err.Error()
			return
		}
		protectedErr <- ""
	}()

	flow := &WireSIPFlow{Network: "udp", ServerAddr: initial.LocalAddr().String(), Timeout: time.Second}
	defer flow.Close()
	result, err := RegisterSession{
		Transport:             flow,
		Profile:               IMSProfile{IMPI: "impi@example", IMPU: "sip:user@example", Domain: "example"},
		RegistrarURI:          "sip:ims.example",
		ContactURI:            "sip:user@127.0.0.1:5060",
		CallID:                "flow-security-register",
		CNonce:                "cnonce",
		SecurityPlanInstaller: &fakeSecurityPlanInstaller{},
		SecurityLocalAddr:     "127.0.0.1",
		SecurityRemoteAddr:    initial.LocalAddr().String(),
	}.Register(context.Background())
	if err != nil {
		t.Fatalf("Register() error = %v", err)
	}
	if !result.Registered || result.Attempts != 2 {
		t.Fatalf("result=%+v", result)
	}
	if msg := <-firstErr; msg != "" {
		t.Fatal(msg)
	}
	if msg := <-protectedErr; msg != "" {
		t.Fatal(msg)
	}
	if wire := <-firstSeen; !strings.Contains(wire, "CSeq: 1 REGISTER") || strings.Contains(wire, "Authorization:") {
		t.Fatalf("first REGISTER wire=%q", wire)
	}
	protectedReq := <-protectedSeen
	if protectedReq.sourcePort != protectedLocalPort ||
		!strings.Contains(protectedReq.wire, "CSeq: 2 REGISTER") ||
		!strings.Contains(protectedReq.wire, "Authorization: Digest") ||
		!strings.Contains(protectedReq.wire, "Security-Verify: ipsec-3gpp") {
		t.Fatalf("protected REGISTER sourcePort=%d wire=%q", protectedReq.sourcePort, protectedReq.wire)
	}
}

func TestWireSIPFlowDialogFollowsRedirectContactTarget(t *testing.T) {
	first, err := net.ListenPacket("udp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("ListenPacket(first) error = %v", err)
	}
	defer first.Close()
	second, err := net.ListenPacket("udp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("ListenPacket(second) error = %v", err)
	}
	defer second.Close()

	firstSeen := make(chan string, 1)
	go func() {
		buf := make([]byte, 65535)
		_ = first.SetReadDeadline(time.Now().Add(time.Second))
		n, addr, err := first.ReadFrom(buf)
		if err != nil {
			firstSeen <- "read error: " + err.Error()
			return
		}
		firstSeen <- string(append([]byte(nil), buf[:n]...))
		_, _ = first.WriteTo([]byte("SIP/2.0 302 Moved Temporarily\r\nContact: <sip:pcscf@"+second.LocalAddr().String()+";transport=udp>\r\nContent-Length: 0\r\n\r\n"), addr)
	}()
	secondSeen := make(chan string, 1)
	go func() {
		buf := make([]byte, 65535)
		_ = second.SetReadDeadline(time.Now().Add(time.Second))
		n, addr, err := second.ReadFrom(buf)
		if err != nil {
			secondSeen <- "read error: " + err.Error()
			return
		}
		secondSeen <- string(append([]byte(nil), buf[:n]...))
		_, _ = second.WriteTo([]byte("SIP/2.0 202 Accepted\r\nContent-Length: 0\r\n\r\n"), addr)
	}()

	flow := &WireSIPFlow{Network: "udp", ServerAddr: first.LocalAddr().String(), Timeout: time.Second}
	defer flow.Close()
	resp, err := flow.RoundTripRequest(context.Background(), SIPRequestMessage{
		Method: "MESSAGE",
		URI:    "sip:+18005551212@example",
		Headers: map[string]string{
			"To":           "<sip:+18005551212@example>",
			"From":         "<sip:user@example>;tag=sms",
			"Contact":      "<sip:user@192.0.2.10:5060>",
			"Call-ID":      "flow-dialog-redirect",
			"CSeq":         "1 MESSAGE",
			"Max-Forwards": "70",
		},
		Body: []byte("hello"),
	})
	if err != nil || resp.StatusCode != 202 {
		t.Fatalf("RoundTripRequest() response=%+v err=%v", resp, err)
	}
	if wire := <-firstSeen; !strings.Contains(wire, "MESSAGE sip:+18005551212@example") {
		t.Fatalf("first target wire=%q", wire)
	}
	if wire := <-secondSeen; !strings.Contains(wire, "MESSAGE sip:+18005551212@example") {
		t.Fatalf("redirect target wire=%q", wire)
	}
}

func TestWireSIPFlowRetransmitsNonInviteAfterProvisional(t *testing.T) {
	pc, err := net.ListenPacket("udp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("ListenPacket() error = %v", err)
	}
	defer pc.Close()

	seen := make(chan []string, 1)
	go func() {
		var requests []string
		buf := make([]byte, 65535)
		_ = pc.SetReadDeadline(time.Now().Add(time.Second))
		n, addr, err := pc.ReadFrom(buf)
		if err != nil {
			seen <- []string{"read initial error: " + err.Error()}
			return
		}
		requests = append(requests, string(append([]byte(nil), buf[:n]...)))
		req, err := ParseSIPRequest(buf[:n])
		if err != nil {
			seen <- append(requests, "parse request error: "+err.Error())
			return
		}
		trying, err := BuildSIPResponseWire(req, 100, "Trying", nil, nil)
		if err != nil {
			seen <- append(requests, "build trying error: "+err.Error())
			return
		}
		if _, err := pc.WriteTo(trying, addr); err != nil {
			seen <- append(requests, "write trying error: "+err.Error())
			return
		}
		_ = pc.SetReadDeadline(time.Now().Add(250 * time.Millisecond))
		n, _, err = pc.ReadFrom(buf)
		if err != nil {
			seen <- append(requests, "read retransmit error: "+err.Error())
			return
		}
		requests = append(requests, string(append([]byte(nil), buf[:n]...)))
		accepted, err := BuildSIPResponseWire(req, 202, "Accepted", nil, nil)
		if err != nil {
			seen <- append(requests, "build accepted error: "+err.Error())
			return
		}
		if _, err := pc.WriteTo(accepted, addr); err != nil {
			seen <- append(requests, "write accepted error: "+err.Error())
			return
		}
		seen <- requests
	}()

	flow := &WireSIPFlow{
		Network:               "udp",
		ServerAddr:            pc.LocalAddr().String(),
		Timeout:               time.Second,
		RetransmitInterval:    20 * time.Millisecond,
		MaxRetransmitInterval: 20 * time.Millisecond,
		MaxRetransmits:        1,
	}
	defer flow.Close()
	resp, err := flow.RoundTripRequest(context.Background(), SIPRequestMessage{
		Method: "MESSAGE",
		URI:    "sip:+18005551212@example",
		Headers: map[string]string{
			"To":           "<sip:+18005551212@example>",
			"From":         "<sip:user@example>;tag=sms",
			"Contact":      "<sip:user@192.0.2.10:5060>",
			"Call-ID":      "flow-provisional-message",
			"CSeq":         "1 MESSAGE",
			"Max-Forwards": "70",
		},
		Body: []byte("hello"),
	})
	if err != nil || resp.StatusCode != 202 {
		t.Fatalf("RoundTripRequest() response=%+v err=%v", resp, err)
	}
	requests := <-seen
	if len(requests) != 2 ||
		!strings.Contains(requests[0], "MESSAGE sip:+18005551212@example") ||
		requests[0] != requests[1] {
		t.Fatalf("requests=%d %+v", len(requests), requests)
	}
}

func TestWireSIPFlowStopsInviteRetransmitAfterProvisional(t *testing.T) {
	pc, err := net.ListenPacket("udp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("ListenPacket() error = %v", err)
	}
	defer pc.Close()

	seen := make(chan []string, 1)
	go func() {
		buf := make([]byte, 65535)
		_ = pc.SetReadDeadline(time.Now().Add(time.Second))
		n, addr, err := pc.ReadFrom(buf)
		if err != nil {
			seen <- []string{"read initial error: " + err.Error()}
			return
		}
		first := string(append([]byte(nil), buf[:n]...))
		req, err := ParseSIPRequest(buf[:n])
		if err != nil {
			seen <- []string{first, "parse request error: " + err.Error()}
			return
		}
		ringing, err := BuildSIPResponseWire(req, 180, "Ringing", nil, nil)
		if err != nil {
			seen <- []string{first, "build ringing error: " + err.Error()}
			return
		}
		if _, err := pc.WriteTo(ringing, addr); err != nil {
			seen <- []string{first, "write ringing error: " + err.Error()}
			return
		}
		_ = pc.SetReadDeadline(time.Now().Add(90 * time.Millisecond))
		n, _, err = pc.ReadFrom(buf)
		if err == nil {
			seen <- []string{first, "unexpected retransmit: " + string(append([]byte(nil), buf[:n]...))}
			return
		}
		ok, err := BuildSIPResponseWire(req, 200, "OK", nil, nil)
		if err != nil {
			seen <- []string{first, "build ok error: " + err.Error()}
			return
		}
		if _, err := pc.WriteTo(ok, addr); err != nil {
			seen <- []string{first, "write ok error: " + err.Error()}
			return
		}
		seen <- []string{first}
	}()

	flow := &WireSIPFlow{
		Network:               "udp",
		ServerAddr:            pc.LocalAddr().String(),
		Timeout:               time.Second,
		RetransmitInterval:    20 * time.Millisecond,
		MaxRetransmitInterval: 20 * time.Millisecond,
		MaxRetransmits:        1,
	}
	defer flow.Close()
	resp, err := flow.RoundTripInvite(context.Background(), SIPRequestMessage{
		Method: "INVITE",
		URI:    "sip:+18005551212@example",
		Headers: map[string]string{
			"To":           "<sip:+18005551212@example>",
			"From":         "<sip:user@example>;tag=call",
			"Contact":      "<sip:user@192.0.2.10:5060>",
			"Call-ID":      "flow-provisional-invite",
			"CSeq":         "1 INVITE",
			"Max-Forwards": "70",
		},
	}, nil)
	if err != nil || resp.StatusCode != 200 {
		t.Fatalf("RoundTripInvite() response=%+v err=%v", resp, err)
	}
	requests := <-seen
	if len(requests) != 1 || !strings.Contains(requests[0], "INVITE sip:+18005551212@example") {
		t.Fatalf("requests=%d %+v", len(requests), requests)
	}
}

func TestWireSIPFlowFinalResponseTimeoutAfterProvisionalDoesNotFailOver(t *testing.T) {
	first, err := net.ListenPacket("udp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("ListenPacket(first) error = %v", err)
	}
	defer first.Close()
	second, err := net.ListenPacket("udp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("ListenPacket(second) error = %v", err)
	}
	defer second.Close()

	firstSeen := make(chan string, 1)
	go func() {
		buf := make([]byte, 65535)
		_ = first.SetReadDeadline(time.Now().Add(time.Second))
		n, addr, err := first.ReadFrom(buf)
		if err != nil {
			firstSeen <- "read error: " + err.Error()
			return
		}
		requestWire := string(append([]byte(nil), buf[:n]...))
		req, err := ParseSIPRequest(buf[:n])
		if err != nil {
			firstSeen <- "parse request error: " + err.Error()
			return
		}
		trying, err := BuildSIPResponseWire(req, 100, "Trying", nil, nil)
		if err != nil {
			firstSeen <- "build trying error: " + err.Error()
			return
		}
		if _, err := first.WriteTo(trying, addr); err != nil {
			firstSeen <- "write trying error: " + err.Error()
			return
		}
		_ = first.SetReadDeadline(time.Now().Add(80 * time.Millisecond))
		n, _, err = first.ReadFrom(buf)
		if err == nil {
			firstSeen <- "unexpected retransmit after 100 Trying: " + string(append([]byte(nil), buf[:n]...))
			return
		}
		firstSeen <- requestWire
	}()

	secondSeen := make(chan string, 1)
	go func() {
		buf := make([]byte, 65535)
		_ = second.SetReadDeadline(time.Now().Add(380 * time.Millisecond))
		n, _, err := second.ReadFrom(buf)
		if err != nil {
			secondSeen <- ""
			return
		}
		secondSeen <- string(append([]byte(nil), buf[:n]...))
	}()

	resolverCalls := 0
	flow := &WireSIPFlow{
		Network: "udp",
		Resolver: SIPServerCandidateResolverFunc(func(ctx context.Context, network, uri string) ([]string, error) {
			resolverCalls++
			return []string{first.LocalAddr().String(), second.LocalAddr().String()}, nil
		}),
		Timeout:               250 * time.Millisecond,
		RetransmitInterval:    20 * time.Millisecond,
		MaxRetransmitInterval: 20 * time.Millisecond,
		MaxRetransmits:        1,
	}
	defer flow.Close()
	resp, err := flow.RoundTripRequest(context.Background(), SIPRequestMessage{
		Method: "MESSAGE",
		URI:    "sip:+18005551212@example",
		Headers: map[string]string{
			"To":           "<sip:+18005551212@example>",
			"From":         "<sip:user@example>;tag=sms",
			"Contact":      "<sip:user@192.0.2.10:5060>",
			"Call-ID":      "flow-final-timeout-message",
			"CSeq":         "1 MESSAGE",
			"Max-Forwards": "70",
		},
		Body: []byte("hello"),
	})
	firstWire := <-firstSeen
	if err == nil || !errors.Is(err, ErrSIPFinalResponseTimeout) {
		t.Fatalf("RoundTripRequest() response=%+v err=%v, first=%q, want final response timeout", resp, err, firstWire)
	}
	if !strings.Contains(firstWire, "MESSAGE sip:+18005551212@example") {
		t.Fatalf("first target wire=%q", firstWire)
	}
	if wire := <-secondSeen; wire != "" {
		t.Fatalf("unexpected failover request to second target: %q", wire)
	}
	if resolverCalls != 1 {
		t.Fatalf("resolver calls=%d, want 1", resolverCalls)
	}
}

func TestWireSIPFlowTCPFinalResponseTimeoutAfterProvisional(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("Listen() error = %v", err)
	}
	defer ln.Close()

	serverErr := make(chan string, 1)
	go func() {
		conn, err := ln.Accept()
		if err != nil {
			serverErr <- "accept error: " + err.Error()
			return
		}
		defer conn.Close()
		raw, err := readSIPStreamMessage(bufio.NewReader(conn))
		if err != nil {
			serverErr <- "read error: " + err.Error()
			return
		}
		req, err := ParseSIPRequest(raw)
		if err != nil {
			serverErr <- "parse request error: " + err.Error()
			return
		}
		ringing, err := BuildSIPResponseWire(req, 180, "Ringing", nil, nil)
		if err != nil {
			serverErr <- "build ringing error: " + err.Error()
			return
		}
		if _, err := conn.Write(ringing); err != nil {
			serverErr <- "write ringing error: " + err.Error()
			return
		}
		time.Sleep(320 * time.Millisecond)
		serverErr <- ""
	}()

	flow := &WireSIPFlow{
		Network:    "tcp",
		ServerAddr: ln.Addr().String(),
		Timeout:    200 * time.Millisecond,
	}
	defer flow.Close()
	resp, err := flow.RoundTripInvite(context.Background(), SIPRequestMessage{
		Method: "INVITE",
		URI:    "sip:+18005551212@example",
		Headers: map[string]string{
			"To":           "<sip:+18005551212@example>",
			"From":         "<sip:user@example>;tag=call",
			"Contact":      "<sip:user@192.0.2.10:5060>",
			"Call-ID":      "flow-tcp-final-timeout-invite",
			"CSeq":         "1 INVITE",
			"Max-Forwards": "70",
		},
	}, nil)
	if err == nil || !errors.Is(err, ErrSIPFinalResponseTimeout) {
		t.Fatalf("RoundTripInvite() response=%+v err=%v, want final response timeout", resp, err)
	}
	if msg := <-serverErr; msg != "" {
		t.Fatal(msg)
	}
}

func TestWireSIPFlowIgnoresStaleMatchedHeadersOnReusedUDPFlow(t *testing.T) {
	pc, err := net.ListenPacket("udp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("ListenPacket() error = %v", err)
	}
	defer pc.Close()

	go func() {
		buf := make([]byte, 65535)
		_ = pc.SetReadDeadline(time.Now().Add(time.Second))
		n, addr, err := pc.ReadFrom(buf)
		if err != nil {
			return
		}
		firstReq, err := ParseSIPRequest(buf[:n])
		if err != nil {
			return
		}
		firstOK := strings.Join([]string{
			"SIP/2.0 200 OK",
			"Via: " + firstHeader(firstReq.Headers, "Via"),
			"Call-ID: " + firstHeader(firstReq.Headers, "Call-ID"),
			"CSeq: " + firstHeader(firstReq.Headers, "CSeq"),
			"Content-Length: 0",
			"",
			"",
		}, "\r\n")
		_, _ = pc.WriteTo([]byte(firstOK), addr)

		_ = pc.SetReadDeadline(time.Now().Add(time.Second))
		n, addr, err = pc.ReadFrom(buf)
		if err != nil {
			return
		}
		secondReq, err := ParseSIPRequest(buf[:n])
		if err != nil {
			return
		}
		stale := strings.Join([]string{
			"SIP/2.0 486 Busy Here",
			"Via: " + firstHeader(firstReq.Headers, "Via"),
			"Call-ID: " + firstHeader(firstReq.Headers, "Call-ID"),
			"CSeq: " + firstHeader(firstReq.Headers, "CSeq"),
			"Content-Length: 0",
			"",
			"",
		}, "\r\n")
		matched := strings.Join([]string{
			"SIP/2.0 202 Accepted",
			"Via: " + firstHeader(secondReq.Headers, "Via"),
			"Call-ID: " + firstHeader(secondReq.Headers, "Call-ID"),
			"CSeq: " + firstHeader(secondReq.Headers, "CSeq"),
			"Content-Length: 0",
			"",
			"",
		}, "\r\n")
		_, _ = pc.WriteTo([]byte(stale), addr)
		_, _ = pc.WriteTo([]byte(matched), addr)
	}()

	flow := &WireSIPFlow{Network: "udp", ServerAddr: pc.LocalAddr().String(), Timeout: time.Second}
	defer flow.Close()
	resp, err := flow.RoundTripRegister(context.Background(), RegisterMessage{
		URI: "sip:ims.example",
		Headers: map[string]string{
			"To":           "<sip:user@example>",
			"From":         "<sip:user@example>;tag=t",
			"Contact":      "<sip:user@192.0.2.10:5060>",
			"Call-ID":      "flow-stale-register",
			"CSeq":         "1 REGISTER",
			"Max-Forwards": "70",
		},
	})
	if err != nil || resp.StatusCode != 200 {
		t.Fatalf("RoundTripRegister() response=%+v err=%v", resp, err)
	}
	resp, err = flow.RoundTripRequest(context.Background(), SIPRequestMessage{
		Method: "MESSAGE",
		URI:    "sip:+18005551212@example",
		Headers: map[string]string{
			"To":           "<sip:+18005551212@example>",
			"From":         "<sip:user@example>;tag=sms",
			"Contact":      "<sip:user@192.0.2.10:5060>",
			"Call-ID":      "flow-stale-message",
			"CSeq":         "1 MESSAGE",
			"Max-Forwards": "70",
		},
		Body: []byte("hello"),
	})
	if err != nil || resp.StatusCode != 202 {
		t.Fatalf("RoundTripRequest() response=%+v err=%v", resp, err)
	}
}

func TestWireSIPFlowBranchesCallerViaAndIgnoresLateTCPFinal(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("Listen() error = %v", err)
	}
	defer ln.Close()

	seen := make(chan []string, 1)
	go func() {
		conn, err := ln.Accept()
		if err != nil {
			seen <- []string{"accept error: " + err.Error()}
			return
		}
		defer conn.Close()

		reader := bufio.NewReader(conn)
		firstRaw, err := readSIPStreamMessage(reader)
		if err != nil {
			seen <- []string{"read first error: " + err.Error()}
			return
		}
		firstReq, err := ParseSIPRequest(firstRaw)
		if err != nil {
			seen <- []string{"parse first error: " + err.Error()}
			return
		}
		firstOK, err := BuildSIPResponseWire(firstReq, 200, "OK", nil, nil)
		if err != nil {
			seen <- []string{"build first ok error: " + err.Error()}
			return
		}
		if _, err := conn.Write(firstOK); err != nil {
			seen <- []string{"write first ok error: " + err.Error()}
			return
		}

		secondRaw, err := readSIPStreamMessage(reader)
		if err != nil {
			seen <- []string{string(firstRaw), "read second error: " + err.Error()}
			return
		}
		secondReq, err := ParseSIPRequest(secondRaw)
		if err != nil {
			seen <- []string{string(firstRaw), "parse second error: " + err.Error()}
			return
		}
		stale, err := BuildSIPResponseWire(firstReq, 486, "Busy Here", nil, nil)
		if err != nil {
			seen <- []string{string(firstRaw), string(secondRaw), "build stale error: " + err.Error()}
			return
		}
		secondOK, err := BuildSIPResponseWire(secondReq, 200, "OK", nil, nil)
		if err != nil {
			seen <- []string{string(firstRaw), string(secondRaw), "build second ok error: " + err.Error()}
			return
		}
		_, _ = conn.Write(stale)
		_, _ = conn.Write(secondOK)
		seen <- []string{string(firstRaw), string(secondRaw)}
	}()

	headers := map[string]string{
		"Via":          "SIP/2.0/TCP 192.0.2.10:5060",
		"To":           "<sip:user@example>",
		"From":         "<sip:user@example>;tag=t",
		"Contact":      "<sip:user@192.0.2.10:5060>",
		"Call-ID":      "flow-late-tcp-branch",
		"CSeq":         "1 REGISTER",
		"Max-Forwards": "70",
	}
	flow := &WireSIPFlow{Network: "tcp", ServerAddr: ln.Addr().String(), Timeout: time.Second}
	defer flow.Close()
	resp, err := flow.RoundTripRegister(context.Background(), RegisterMessage{
		URI:     "sip:ims.example",
		Headers: headers,
	})
	if err != nil || resp.StatusCode != 200 {
		t.Fatalf("first RoundTripRegister() response=%+v err=%v", resp, err)
	}
	resp, err = flow.RoundTripRegister(context.Background(), RegisterMessage{
		URI:     "sip:ims.example",
		Headers: headers,
	})
	if err != nil || resp.StatusCode != 200 {
		t.Fatalf("second RoundTripRegister() response=%+v err=%v, want stale final ignored", resp, err)
	}

	requests := <-seen
	if len(requests) != 2 {
		t.Fatalf("requests=%d %+v", len(requests), requests)
	}
	firstReq, err := ParseSIPRequest([]byte(requests[0]))
	if err != nil {
		t.Fatalf("ParseSIPRequest(first) error = %v", err)
	}
	secondReq, err := ParseSIPRequest([]byte(requests[1]))
	if err != nil {
		t.Fatalf("ParseSIPRequest(second) error = %v", err)
	}
	firstVia := firstHeader(firstReq.Headers, "Via")
	secondVia := firstHeader(secondReq.Headers, "Via")
	if sipViaBranch(firstVia) == "" || sipViaBranch(secondVia) == "" || sipViaBranch(firstVia) == sipViaBranch(secondVia) {
		t.Fatalf("Via branches first=%q second=%q", firstVia, secondVia)
	}
}

func TestWireSIPFlowResetToNextTargetPreservesCandidates(t *testing.T) {
	first, err := net.ListenPacket("udp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("ListenPacket(first) error = %v", err)
	}
	defer first.Close()
	second, err := net.ListenPacket("udp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("ListenPacket(second) error = %v", err)
	}
	defer second.Close()

	firstSeen := make(chan string, 1)
	go func() {
		buf := make([]byte, 65535)
		_ = first.SetReadDeadline(time.Now().Add(time.Second))
		n, addr, err := first.ReadFrom(buf)
		if err != nil {
			firstSeen <- "read error: " + err.Error()
			return
		}
		firstSeen <- string(append([]byte(nil), buf[:n]...))
		_, _ = first.WriteTo([]byte("SIP/2.0 200 OK\r\nContent-Length: 0\r\n\r\n"), addr)
	}()
	secondSeen := make(chan string, 1)
	go func() {
		buf := make([]byte, 65535)
		_ = second.SetReadDeadline(time.Now().Add(time.Second))
		n, addr, err := second.ReadFrom(buf)
		if err != nil {
			secondSeen <- "read error: " + err.Error()
			return
		}
		secondSeen <- string(append([]byte(nil), buf[:n]...))
		_, _ = second.WriteTo([]byte("SIP/2.0 200 OK\r\nContent-Length: 0\r\n\r\n"), addr)
	}()

	resolverCalls := 0
	flow := &WireSIPFlow{
		Network: "udp",
		Resolver: SIPServerCandidateResolverFunc(func(ctx context.Context, network, uri string) ([]string, error) {
			resolverCalls++
			return []string{first.LocalAddr().String(), second.LocalAddr().String()}, nil
		}),
		Timeout: time.Second,
	}
	defer flow.Close()
	if resp, err := flow.RoundTripRegister(context.Background(), RegisterMessage{
		URI: "sip:ims.example",
		Headers: map[string]string{
			"To":           "<sip:user@example>",
			"From":         "<sip:user@example>;tag=t",
			"Contact":      "<sip:user@192.0.2.10:5060>",
			"Call-ID":      "flow-reset-target",
			"CSeq":         "1 REGISTER",
			"Max-Forwards": "70",
		},
	}); err != nil || resp.StatusCode != 200 {
		t.Fatalf("first RoundTripRegister() response=%+v err=%v", resp, err)
	}
	switched, err := flow.ResetToNextTarget()
	if err != nil || !switched {
		t.Fatalf("ResetToNextTarget() switched=%t err=%v, want switched", switched, err)
	}
	if resp, err := flow.RoundTripRegister(context.Background(), RegisterMessage{
		URI: "sip:ims.example",
		Headers: map[string]string{
			"To":           "<sip:user@example>",
			"From":         "<sip:user@example>;tag=t",
			"Contact":      "<sip:user@192.0.2.10:5060>",
			"Call-ID":      "flow-reset-target",
			"CSeq":         "2 REGISTER",
			"Max-Forwards": "70",
		},
	}); err != nil || resp.StatusCode != 200 {
		t.Fatalf("second RoundTripRegister() response=%+v err=%v", resp, err)
	}
	if wire := <-firstSeen; !strings.Contains(wire, "CSeq: 1 REGISTER") {
		t.Fatalf("first target wire=%q", wire)
	}
	if wire := <-secondSeen; !strings.Contains(wire, "CSeq: 2 REGISTER") {
		t.Fatalf("second target wire=%q", wire)
	}
	if resolverCalls != 1 {
		t.Fatalf("resolver calls=%d, want 1", resolverCalls)
	}
}

func reserveTestUDPPort(t *testing.T) int {
	t.Helper()
	conn, err := net.ListenPacket("udp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("ListenPacket(reserve) error = %v", err)
	}
	port := conn.LocalAddr().(*net.UDPAddr).Port
	if err := conn.Close(); err != nil {
		t.Fatalf("Close(reserve) error = %v", err)
	}
	return port
}
