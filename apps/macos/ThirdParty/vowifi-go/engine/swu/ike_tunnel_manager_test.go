package swu

import (
	"bytes"
	"context"
	"errors"
	"net"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/boa-z/vowifi-go/engine/sim"
	"github.com/boa-z/vowifi-go/engine/swu/eapaka"
	"github.com/boa-z/vowifi-go/engine/swu/ikev2"
)

func TestIKEPacketTunnelManagerEstablishesPacketSession(t *testing.T) {
	ikeTransport := ikeTunnelNoopTransport{}
	espTransport := &captureESPPacketTransport{}
	var gotInit ikev2.InitConfig
	var gotAuth ikev2.FullAuthConfig
	var gotIKETransport IKETransportConfig
	var gotESPTransport ESPTransportConfig
	var gotPacketConfig PacketSessionConfig

	manager := NewIKEPacketTunnelManager(IKEPacketTunnelManagerConfig{
		SIM:      ikeTunnelAKAProvider{},
		Random:   bytes.NewReader(append([]byte{0xca, 0xfe, 0xba, 0xbe}, bytes.Repeat([]byte{0x55}, 64)...)),
		RemoteIP: net.IPv4(198, 51, 100, 7),
		IKETransportFactory: func(cfg TunnelConfig, transport IKETransportConfig) (ikev2.InitTransport, error) {
			gotIKETransport = transport
			return ikeTransport, nil
		},
		ESPTransportFactory: func(cfg TunnelConfig, transport ESPTransportConfig) (ESPPacketTransport, error) {
			gotESPTransport = transport
			return espTransport, nil
		},
		InitRunner: func(ctx context.Context, cfg ikev2.InitConfig) (ikev2.InitResult, error) {
			gotInit = cfg
			return ikev2.InitResult{MOBIKESupported: true, NATDetected: true}, nil
		},
		AuthRunner: func(ctx context.Context, cfg ikev2.FullAuthConfig) (ikev2.FullAuthResult, error) {
			gotAuth = cfg
			child := packetChildSA(true)
			child.LocalSPI = append([]byte(nil), cfg.ChildSPI...)
			child.Configuration = &ikev2.Configuration{
				Type: ikev2.CFGReply,
				Attributes: []ikev2.ConfigurationAttribute{
					{Type: ikev2.ConfigInternalIPv4Address, Value: []byte{10, 0, 0, 2}},
					{Type: ikev2.ConfigInternalIPv4DNS, Value: []byte{10, 0, 0, 1}},
					{Type: ikev2.ConfigInternalIPv6DNS, Value: net.ParseIP("2001:db8::53").To16()},
				},
			}
			return ikev2.FullAuthResult{ChildSA: &child, NextMessageID: 3}, nil
		},
		PacketSessionFactory: func(cfg PacketSessionConfig) (TunnelSession, error) {
			gotPacketConfig = cfg
			return NewPacketSession(cfg)
		},
	})

	session, err := manager.EstablishTunnel(context.Background(), TunnelConfig{
		DeviceID:     "dev-1",
		Mode:         DataplaneModeUserspace,
		EPDGAddress:  "epdg.example",
		OuterLocalIP: "192.0.2.10",
		IMSI:         "310280000000001",
		MCC:          "310",
		MNC:          "280",
		APN:          "ims",
		Identity:     IMSIdentity{IMPI: "310280000000001@private.att.net"},
	})
	if err != nil {
		t.Fatalf("EstablishTunnel() error = %v", err)
	}
	result := session.Result()
	if !result.IsReady() || result.EPDGAddress != "epdg.example" || result.LocalInnerIP != "10.0.0.2" {
		t.Fatalf("result=%+v", result)
	}
	if len(result.DNSServers) != 2 || result.DNSServers[0] != "10.0.0.1" || result.DNSServers[1] != "2001:db8::53" {
		t.Fatalf("result DNS=%+v", result.DNSServers)
	}
	result.DNSServers[0] = "198.51.100.53"
	if got := session.Result().DNSServers[0]; got != "10.0.0.1" {
		t.Fatalf("Result() leaked DNS slice, got %q", got)
	}
	if !result.MOBIKESupported || result.ChildSAIdentifier != "cafebabe/22222222" {
		t.Fatalf("result MOBIKE/child id = %+v", result)
	}
	if gotIKETransport.RemoteAddr != "epdg.example:4500" || gotIKETransport.LocalAddr != "192.0.2.10:0" || !gotIKETransport.UseNonESPMarker {
		t.Fatalf("IKE transport=%+v", gotIKETransport)
	}
	if gotESPTransport.RemoteAddr != "epdg.example:4500" || gotESPTransport.LocalAddr != "192.0.2.10:0" {
		t.Fatalf("ESP transport=%+v", gotESPTransport)
	}
	if gotInit.Transport != ikeTransport || gotInit.RemotePort != 4500 {
		t.Fatalf("init config=%+v", gotInit)
	}
	if gotAuth.Transport != ikeTransport || gotAuth.SIM == nil {
		t.Fatalf("auth config transport/SIM not wired: %+v", gotAuth)
	}
	if gotAuth.EAPIdentity != "0310280000000001@nai.epc.mnc280.mcc310.3gppnetwork.org" {
		t.Fatalf("EAP identity=%q", gotAuth.EAPIdentity)
	}
	if gotAuth.InitiatorID.Type != ikev2.IDRFC822Addr || string(gotAuth.InitiatorID.Data) != gotAuth.EAPIdentity {
		t.Fatalf("initiator id=%+v", gotAuth.InitiatorID)
	}
	if gotAuth.ResponderID.Type != ikev2.IDFQDN || string(gotAuth.ResponderID.Data) != "ims" {
		t.Fatalf("responder id=%+v", gotAuth.ResponderID)
	}
	if !bytes.Equal(gotAuth.ChildSPI, []byte{0xca, 0xfe, 0xba, 0xbe}) {
		t.Fatalf("child SPI=%x", gotAuth.ChildSPI)
	}
	if gotPacketConfig.MOBIKENAT == nil {
		t.Fatal("packet session config missing MOBIKE NAT state")
	}
	natEndpoint, _ := gotPacketConfig.MOBIKENAT.Snapshot()
	if !natEndpoint.LocalIP.Equal(net.IPv4(192, 0, 2, 10)) ||
		!natEndpoint.RemoteIP.Equal(net.IPv4(198, 51, 100, 7)) ||
		natEndpoint.LocalPort != 4500 ||
		natEndpoint.RemotePort != 4500 ||
		!natEndpoint.NATDetected {
		t.Fatalf("MOBIKE NAT endpoint=%+v", natEndpoint)
	}

	packetSession, ok := session.(PacketTunnelSession)
	if !ok {
		t.Fatalf("session type %T does not implement PacketTunnelSession", session)
	}
	if err := packetSession.SendInnerPacket(context.Background(), []byte{0x45, 0x00, 0x00, 0x14}); err != nil {
		t.Fatalf("SendInnerPacket() error = %v", err)
	}
	if len(espTransport.packets) != 1 {
		t.Fatalf("ESP packets=%d, want 1", len(espTransport.packets))
	}
	if err := session.Close(context.Background()); err != nil {
		t.Fatalf("Close() error = %v", err)
	}
	if !espTransport.closed {
		t.Fatalf("ESP transport was not closed")
	}
}

func TestIKEPacketTunnelManagerEstablishesKernelSession(t *testing.T) {
	init := ikeControlInit(t)
	child := xfrmChildSA(ikev2.INTEG_HMAC_SHA2_256_128)
	child.LocalSPI = []byte{0xca, 0xfe, 0xba, 0xbe}
	control := &ikeCloseTransport{
		t:         t,
		init:      init,
		keys:      init.Keys,
		child:     child,
		messageID: 8,
	}
	xfrmManager := &fakeKernelXFRMManager{
		applyState: KernelXFRMState{undo: []ipCommand{{args: []string{"xfrm", "state", "delete"}}}},
	}
	manager := NewIKEPacketTunnelManager(IKEPacketTunnelManagerConfig{
		SIM:               ikeTunnelAKAProvider{},
		Random:            bytes.NewReader(bytes.Repeat([]byte{0x55}, 64)),
		ChildSPI:          child.LocalSPI,
		Transport:         control,
		KernelXFRMManager: xfrmManager,
		ESPTransportFactory: func(cfg TunnelConfig, transport ESPTransportConfig) (ESPPacketTransport, error) {
			t.Fatal("ESP transport factory must not be used for kernel dataplane")
			return nil, nil
		},
		InitRunner: func(ctx context.Context, cfg ikev2.InitConfig) (ikev2.InitResult, error) {
			return init, nil
		},
		AuthRunner: func(ctx context.Context, cfg ikev2.FullAuthConfig) (ikev2.FullAuthResult, error) {
			if !bytes.Equal(cfg.ChildSPI, child.LocalSPI) {
				t.Fatalf("auth child SPI=%x, want %x", cfg.ChildSPI, child.LocalSPI)
			}
			return ikev2.FullAuthResult{ChildSA: &child, NextMessageID: 8}, nil
		},
	})

	session, err := manager.EstablishTunnel(context.Background(), TunnelConfig{
		DeviceID:      "dev-1",
		Mode:          DataplaneModeKernel,
		EPDGAddress:   "198.51.100.7",
		OuterLocalIP:  "192.0.2.10",
		InnerLocalIP:  "10.10.0.2",
		RemoteInnerIP: "0.0.0.0/0",
		IMSI:          "310280000000001",
		MCC:           "310",
		MNC:           "280",
	})
	if err != nil {
		t.Fatalf("EstablishTunnel() error = %v", err)
	}
	if _, ok := session.(PacketTunnelSession); ok {
		t.Fatalf("kernel session type %T unexpectedly implements PacketTunnelSession", session)
	}
	result := session.Result()
	if !result.IsReady() || result.Mode != DataplaneModeKernel || result.LocalInnerIP != "10.10.0.2" ||
		result.ChildSAIdentifier != "cafebabe/deadbeef" {
		t.Fatalf("result=%+v", result)
	}
	if len(xfrmManager.applyConfigs) != 1 {
		t.Fatalf("xfrm apply count=%d, want 1", len(xfrmManager.applyConfigs))
	}
	xfrmCfg := xfrmManager.applyConfigs[0]
	if xfrmCfg.OuterLocalIP != "192.0.2.10" || xfrmCfg.OuterRemoteIP != "198.51.100.7" ||
		xfrmCfg.InnerLocalPrefix != "10.10.0.2/32" || xfrmCfg.InnerRemotePrefix != "0.0.0.0/0" ||
		!bytes.Equal(xfrmCfg.ChildSA.LocalSPI, child.LocalSPI) {
		t.Fatalf("xfrm config=%+v", xfrmCfg)
	}
	if err := session.Close(context.Background()); err != nil {
		t.Fatalf("Close() error = %v", err)
	}
	if control.requests != 1 || !control.sawChildDelete || !control.sawIKEDelete {
		t.Fatalf("control requests=%d child=%t ike=%t", control.requests, control.sawChildDelete, control.sawIKEDelete)
	}
	if len(xfrmManager.cleanupStates) != 1 {
		t.Fatalf("xfrm cleanup count=%d, want 1", len(xfrmManager.cleanupStates))
	}
	if err := session.Close(context.Background()); err != nil {
		t.Fatalf("Close(second) error = %v", err)
	}
	if control.requests != 1 || len(xfrmManager.cleanupStates) != 1 {
		t.Fatalf("second close repeated work: control=%d cleanup=%d", control.requests, len(xfrmManager.cleanupStates))
	}
}

func TestIKEPacketTunnelManagerKernelXFRMApplyFailureClosesIKE(t *testing.T) {
	init := ikeControlInit(t)
	child := xfrmChildSA(ikev2.INTEG_HMAC_SHA2_256_128)
	child.LocalSPI = []byte{0xca, 0xfe, 0xba, 0xbe}
	control := &ikeCloseTransport{
		t:         t,
		init:      init,
		keys:      init.Keys,
		child:     child,
		messageID: 9,
	}
	wantErr := errors.New("xfrm apply failed")
	xfrmManager := &fakeKernelXFRMManager{applyErr: wantErr}
	manager := NewIKEPacketTunnelManager(IKEPacketTunnelManagerConfig{
		SIM:               ikeTunnelAKAProvider{},
		Random:            bytes.NewReader(bytes.Repeat([]byte{0x66}, 64)),
		ChildSPI:          child.LocalSPI,
		Transport:         control,
		KernelXFRMManager: xfrmManager,
		InitRunner: func(ctx context.Context, cfg ikev2.InitConfig) (ikev2.InitResult, error) {
			return init, nil
		},
		AuthRunner: func(ctx context.Context, cfg ikev2.FullAuthConfig) (ikev2.FullAuthResult, error) {
			return ikev2.FullAuthResult{ChildSA: &child, NextMessageID: 9}, nil
		},
	})

	_, err := manager.EstablishTunnel(context.Background(), TunnelConfig{
		DeviceID:      "dev-1",
		Mode:          DataplaneModeKernel,
		EPDGAddress:   "198.51.100.7",
		OuterLocalIP:  "192.0.2.10",
		InnerLocalIP:  "10.10.0.2",
		RemoteInnerIP: "0.0.0.0/0",
		IMSI:          "310280000000001",
		MCC:           "310",
		MNC:           "280",
	})
	if !errors.Is(err, wantErr) {
		t.Fatalf("EstablishTunnel() err=%v, want xfrm apply failure", err)
	}
	if control.requests != 1 || !control.sawChildDelete || !control.sawIKEDelete {
		t.Fatalf("control requests=%d child=%t ike=%t", control.requests, control.sawChildDelete, control.sawIKEDelete)
	}
	if len(xfrmManager.cleanupStates) != 0 {
		t.Fatalf("xfrm cleanup count=%d, want 0", len(xfrmManager.cleanupStates))
	}
}

func TestIKEPacketTunnelManagerWiresLivenessDPDHandler(t *testing.T) {
	init := ikeControlInit(t)
	init.MOBIKESupported = true
	control := &ikeMOBIKETransport{
		t:         t,
		init:      init,
		keys:      init.Keys,
		messageID: 5,
	}
	var gotPacketConfig PacketSessionConfig
	manager := NewIKEPacketTunnelManager(IKEPacketTunnelManagerConfig{
		SIM:          ikeTunnelAKAProvider{},
		ChildSPI:     []byte{0x11, 0x22, 0x33, 0x44},
		Transport:    control,
		ESPTransport: &captureESPPacketTransport{},
		Liveness: IKELivenessConfig{
			DisableKeepalive: true,
			DPDInterval:      30 * time.Second,
			DPDTimeout:       10 * time.Second,
		},
		InitRunner: func(ctx context.Context, cfg ikev2.InitConfig) (ikev2.InitResult, error) {
			return init, nil
		},
		AuthRunner: func(ctx context.Context, cfg ikev2.FullAuthConfig) (ikev2.FullAuthResult, error) {
			child := packetChildSA(true)
			child.LocalSPI = append([]byte(nil), cfg.ChildSPI...)
			return ikev2.FullAuthResult{ChildSA: &child, NextMessageID: 5}, nil
		},
		PacketSessionFactory: func(cfg PacketSessionConfig) (TunnelSession, error) {
			gotPacketConfig = cfg
			return ikeTunnelStaticSession{result: cfg.Result}, nil
		},
	})

	session, err := manager.EstablishTunnel(context.Background(), TunnelConfig{
		DeviceID:     "dev-1",
		Mode:         DataplaneModeUserspace,
		EPDGAddress:  "198.51.100.7",
		OuterLocalIP: "192.0.2.10",
		IMSI:         "310280000000001",
		MCC:          "310",
		MNC:          "280",
	})
	if err != nil {
		t.Fatalf("EstablishTunnel() error = %v", err)
	}
	if !session.Result().MOBIKESupported {
		t.Fatalf("session result=%+v", session.Result())
	}
	if gotPacketConfig.Liveness == nil || !gotPacketConfig.Liveness.Snapshot().DPDEnabled ||
		gotPacketConfig.DPDHandler == nil {
		t.Fatalf("packet session liveness=%+v dpd=%v", gotPacketConfig.Liveness, gotPacketConfig.DPDHandler != nil)
	}
	if gotPacketConfig.RekeyHandler == nil {
		t.Fatal("packet session config missing rekey handler")
	}
	if err := gotPacketConfig.DPDHandler(context.Background()); err != nil {
		t.Fatalf("DPDHandler() error = %v", err)
	}
	if control.requests != 1 {
		t.Fatalf("control requests=%d, want 1", control.requests)
	}
}

func TestIKEPacketTunnelManagerWiresChildSARekeyHandler(t *testing.T) {
	init := ikeControlInit(t)
	oldChild := packetChildSA(true)
	oldChild.LocalSPI = []byte{0x11, 0x22, 0x33, 0x44}
	oldChild.SelectedSA = ikev2.DefaultESPProposal(oldChild.RemoteSPI)
	oldChild.TSi = ikev2.IPv4AnyTrafficSelectors()
	oldChild.TSr = ikev2.IPv4AnyTrafficSelectors()
	firstLocalSPI := []byte{0xaa, 0xbb, 0xcc, 0xdd}
	secondLocalSPI := []byte{0xee, 0xff, 0x00, 0x11}
	random := append([]byte{}, firstLocalSPI...)
	random = append(random, bytes.Repeat([]byte{0x31}, 32)...)
	random = append(random, bytes.Repeat([]byte{0x32}, init.Keys.Profile.EncryptionBlockSize)...)
	random = append(random, secondLocalSPI...)
	random = append(random, bytes.Repeat([]byte{0x41}, 32)...)
	random = append(random, bytes.Repeat([]byte{0x42}, init.Keys.Profile.EncryptionBlockSize)...)
	transport := &ikeRekeyTransport{
		t:          t,
		init:       init,
		keys:       init.Keys,
		messageIDs: []uint32{7, 8},
		localSPIs:  [][]byte{firstLocalSPI, secondLocalSPI},
		remoteSPIs: [][]byte{
			{0xca, 0xfe, 0xba, 0xbe},
			{0xba, 0xad, 0xf0, 0x0d},
		},
		rekeySPIs: [][]byte{oldChild.LocalSPI, firstLocalSPI},
	}
	var gotPacketConfig PacketSessionConfig
	manager := NewIKEPacketTunnelManager(IKEPacketTunnelManagerConfig{
		SIM:          ikeTunnelAKAProvider{},
		Random:       bytes.NewReader(random),
		ChildSPI:     oldChild.LocalSPI,
		Transport:    transport,
		ESPTransport: &captureESPPacketTransport{},
		ChildSARekey: ChildSARekeyPolicy{
			Lifetime: time.Hour,
			LeadTime: 5 * time.Minute,
		},
		InitRunner: func(ctx context.Context, cfg ikev2.InitConfig) (ikev2.InitResult, error) {
			return init, nil
		},
		AuthRunner: func(ctx context.Context, cfg ikev2.FullAuthConfig) (ikev2.FullAuthResult, error) {
			if !bytes.Equal(cfg.ChildSPI, oldChild.LocalSPI) {
				t.Fatalf("auth child SPI=%x, want %x", cfg.ChildSPI, oldChild.LocalSPI)
			}
			return ikev2.FullAuthResult{ChildSA: &oldChild, NextMessageID: 7}, nil
		},
		PacketSessionFactory: func(cfg PacketSessionConfig) (TunnelSession, error) {
			gotPacketConfig = cfg
			return ikeTunnelStaticSession{result: cfg.Result}, nil
		},
	})

	session, err := manager.EstablishTunnel(context.Background(), TunnelConfig{
		DeviceID:    "dev-1",
		Mode:        DataplaneModeUserspace,
		EPDGAddress: "198.51.100.7",
		IMSI:        "310280000000001",
		MCC:         "310",
		MNC:         "280",
	})
	if err != nil {
		t.Fatalf("EstablishTunnel() error = %v", err)
	}
	defer session.Close(context.Background())
	if gotPacketConfig.RekeyHandler == nil {
		t.Fatal("packet session config missing rekey handler")
	}
	if gotPacketConfig.RekeyPolicy.Lifetime != time.Hour || gotPacketConfig.RekeyPolicy.LeadTime != 5*time.Minute {
		t.Fatalf("packet session rekey policy=%+v", gotPacketConfig.RekeyPolicy)
	}
	firstChild, err := gotPacketConfig.RekeyHandler(context.Background())
	if err != nil {
		t.Fatalf("RekeyHandler(first) error = %v", err)
	}
	secondChild, err := gotPacketConfig.RekeyHandler(context.Background())
	if err != nil {
		t.Fatalf("RekeyHandler(second) error = %v", err)
	}
	if transport.requests != 2 || transport.sawRekey != 2 {
		t.Fatalf("transport requests=%d sawRekey=%d", transport.requests, transport.sawRekey)
	}
	if !bytes.Equal(firstChild.LocalSPI, firstLocalSPI) || !bytes.Equal(firstChild.RemoteSPI, transport.remoteSPIs[0]) ||
		firstChild.NextMessageID != 8 {
		t.Fatalf("first child=%+v", firstChild)
	}
	if !bytes.Equal(secondChild.LocalSPI, secondLocalSPI) || !bytes.Equal(secondChild.RemoteSPI, transport.remoteSPIs[1]) ||
		secondChild.NextMessageID != 9 {
		t.Fatalf("second child=%+v", secondChild)
	}
}

func TestIKEPacketTunnelManagerDerivesEPDGAndAKAIdentity(t *testing.T) {
	var gotAuth ikev2.FullAuthConfig
	var gotIKETransport IKETransportConfig
	manager := NewIKEPacketTunnelManager(IKEPacketTunnelManagerConfig{
		SIM:      ikeTunnelAKAProvider{},
		ChildSPI: []byte{0x11, 0x22, 0x33, 0x44},
		IKETransportFactory: func(cfg TunnelConfig, transport IKETransportConfig) (ikev2.InitTransport, error) {
			gotIKETransport = transport
			return ikeTunnelNoopTransport{}, nil
		},
		ESPTransport: &captureESPPacketTransport{},
		InitRunner: func(ctx context.Context, cfg ikev2.InitConfig) (ikev2.InitResult, error) {
			return ikev2.InitResult{}, nil
		},
		AuthRunner: func(ctx context.Context, cfg ikev2.FullAuthConfig) (ikev2.FullAuthResult, error) {
			gotAuth = cfg
			child := packetChildSA(true)
			child.LocalSPI = append([]byte(nil), cfg.ChildSPI...)
			return ikev2.FullAuthResult{ChildSA: &child, NextMessageID: 2}, nil
		},
	})

	session, err := manager.EstablishTunnel(context.Background(), TunnelConfig{
		DeviceID: "dev-1",
		Mode:     DataplaneModeUserspace,
		IMSI:     "310280000000001",
		MCC:      "310",
		MNC:      "28",
	})
	if err != nil {
		t.Fatalf("EstablishTunnel() error = %v", err)
	}
	defer session.Close(context.Background())

	wantEPDG := "epdg.epc.mnc028.mcc310.pub.3gppnetwork.org"
	wantIdentity := "0310280000000001@nai.epc.mnc028.mcc310.3gppnetwork.org"
	if gotIKETransport.EPDGAddress != wantEPDG || gotIKETransport.RemoteAddr != wantEPDG+":4500" {
		t.Fatalf("IKE transport=%+v", gotIKETransport)
	}
	if gotAuth.EAPIdentity != wantIdentity || string(gotAuth.InitiatorID.Data) != wantIdentity {
		t.Fatalf("auth identity=%q initiator=%q", gotAuth.EAPIdentity, gotAuth.InitiatorID.Data)
	}
	if session.Result().EPDGAddress != wantEPDG {
		t.Fatalf("result EPDG=%q", session.Result().EPDGAddress)
	}
}

func TestIKEPacketTunnelManagerUsesAKAPrimePermanentIdentityInsteadOfIMPI(t *testing.T) {
	var gotAuth ikev2.FullAuthConfig
	manager := NewIKEPacketTunnelManager(IKEPacketTunnelManagerConfig{
		SIM:      ikeTunnelAKAProvider{},
		ChildSPI: []byte{0x11, 0x22, 0x33, 0x44},
		IKETransportFactory: func(TunnelConfig, IKETransportConfig) (ikev2.InitTransport, error) {
			return ikeTunnelNoopTransport{}, nil
		},
		ESPTransport: &captureESPPacketTransport{},
		InitRunner: func(context.Context, ikev2.InitConfig) (ikev2.InitResult, error) {
			return ikev2.InitResult{}, nil
		},
		AuthRunner: func(_ context.Context, cfg ikev2.FullAuthConfig) (ikev2.FullAuthResult, error) {
			gotAuth = cfg
			child := packetChildSA(true)
			child.LocalSPI = append([]byte(nil), cfg.ChildSPI...)
			return ikev2.FullAuthResult{ChildSA: &child, NextMessageID: 2}, nil
		},
	})

	session, err := manager.EstablishTunnel(context.Background(), TunnelConfig{
		DeviceID:    "dev-ultra",
		Mode:        DataplaneModeUserspace,
		IMSI:        "310240123456789",
		MCC:         "310",
		MNC:         "240",
		EAPMethod:   EAPMethodAKAPrime,
		Identity:    IMSIdentity{IMPI: "310240123456789@ims.mnc240.mcc310.3gppnetwork.org"},
		EPDGAddress: "epdg.example",
	})
	if err != nil {
		t.Fatalf("EstablishTunnel() error = %v", err)
	}
	defer session.Close(context.Background())

	want := "6310240123456789@wlan.mnc240.mcc310.3gppnetwork.org"
	if gotAuth.EAPIdentity != want || string(gotAuth.InitiatorID.Data) != want {
		t.Fatalf("EAP identity=%q IDi=%q, want AKA' permanent NAI", gotAuth.EAPIdentity, gotAuth.InitiatorID.Data)
	}
}

func TestIKEPacketTunnelManagerUsesAndroidIWLANAKAPermanentIdentity(t *testing.T) {
	var gotAuth ikev2.FullAuthConfig
	manager := NewIKEPacketTunnelManager(IKEPacketTunnelManagerConfig{
		SIM:      ikeTunnelAKAProvider{},
		ChildSPI: []byte{0x11, 0x22, 0x33, 0x44},
		IKETransportFactory: func(TunnelConfig, IKETransportConfig) (ikev2.InitTransport, error) {
			return ikeTunnelNoopTransport{}, nil
		},
		ESPTransport: &captureESPPacketTransport{},
		InitRunner: func(context.Context, ikev2.InitConfig) (ikev2.InitResult, error) {
			return ikev2.InitResult{}, nil
		},
		AuthRunner: func(_ context.Context, cfg ikev2.FullAuthConfig) (ikev2.FullAuthResult, error) {
			gotAuth = cfg
			child := packetChildSA(true)
			child.LocalSPI = append([]byte(nil), cfg.ChildSPI...)
			return ikev2.FullAuthResult{ChildSA: &child, NextMessageID: 2}, nil
		},
	})

	session, err := manager.EstablishTunnel(context.Background(), TunnelConfig{
		DeviceID:    "dev-ultra",
		Mode:        DataplaneModeUserspace,
		IMSI:        "310240123456789",
		MCC:         "310",
		MNC:         "240",
		EAPMethod:   EAPMethodAKA,
		EPDGAddress: "epdg.example",
	})
	if err != nil {
		t.Fatalf("EstablishTunnel() error = %v", err)
	}
	defer session.Close(context.Background())

	want := "0310240123456789@nai.epc.mnc240.mcc310.3gppnetwork.org"
	if gotAuth.EAPIdentity != want || string(gotAuth.InitiatorID.Data) != want {
		t.Fatalf("EAP identity=%q IDi=%q, want Android IWLAN EAP-AKA permanent NAI", gotAuth.EAPIdentity, gotAuth.InitiatorID.Data)
	}
}

func TestIKEPacketTunnelManagerFailureIncludesRedactedInitialAuthDiagnostic(t *testing.T) {
	manager := NewIKEPacketTunnelManager(IKEPacketTunnelManagerConfig{
		SIM: ikeTunnelAKAProvider{},
		IKETransportFactory: func(TunnelConfig, IKETransportConfig) (ikev2.InitTransport, error) {
			return ikeTunnelNoopTransport{}, nil
		},
		InitRunner: func(context.Context, ikev2.InitConfig) (ikev2.InitResult, error) {
			return ikev2.InitResult{}, nil
		},
		AuthRunner: func(context.Context, ikev2.FullAuthConfig) (ikev2.FullAuthResult, error) {
			return ikev2.FullAuthResult{}, errors.New("ikev2 notify error: INVALID_SYNTAX")
		},
	})

	_, err := manager.EstablishTunnel(context.Background(), TunnelConfig{
		DeviceID:    "dev-ultra",
		Mode:        DataplaneModeUserspace,
		IMSI:        "310240123456789",
		MCC:         "310",
		MNC:         "240",
		EAPMethod:   EAPMethodAKAPrime,
		EPDGAddress: "epdg.example",
	})
	if err == nil {
		t.Fatal("EstablishTunnel() error=nil")
	}
	text := err.Error()
	for _, want := range []string{"payloads=[IDi,IDr,SA,TSi,TSr,CP", "auth=omitted", "method=aka-prime", "prefix=6", "digits=15", "realm=wlan.mnc240.mcc310.3gppnetwork.org", "INVALID_SYNTAX"} {
		if !strings.Contains(text, want) {
			t.Fatalf("diagnostic %q missing %q", text, want)
		}
	}
	if strings.Contains(text, "310240123456789") {
		t.Fatalf("diagnostic leaked IMSI: %q", text)
	}
}

func TestTunnelResultUsesRFC7651PCSCFAddresses(t *testing.T) {
	child := ikev2.ChildSAResult{Configuration: &ikev2.Configuration{Type: ikev2.CFGReply, Attributes: []ikev2.ConfigurationAttribute{
		{Type: ikev2.ConfigInternalIPv4Address, Value: []byte{10, 0, 0, 2}},
		{Type: ikev2.ConfigPCSCFIPv4Address, Value: []byte{10, 0, 0, 10, 10, 0, 0, 11}},
		{Type: ikev2.ConfigPCSCFIPv6Address, Value: net.ParseIP("2001:db8::10").To16()},
	}}}
	result := tunnelResultFromIKE(TunnelConfig{}, "epdg.example", ikev2.InitResult{}, child, DataplaneModeUserspace)
	want := []string{"10.0.0.10", "10.0.0.11", "2001:db8::10"}
	if !reflect.DeepEqual(result.PCSCFServers, want) {
		t.Fatalf("P-CSCF servers=%v, want %v", result.PCSCFServers, want)
	}
}

func TestIKEPacketTunnelManagerCarriesReauthenticationState(t *testing.T) {
	initialKeys := eapaka.Keys{
		MK:    bytes.Repeat([]byte{0x01}, 20),
		KEncr: bytes.Repeat([]byte{0x02}, eapaka.KeyLengthKEncr),
		KAut:  bytes.Repeat([]byte{0x03}, eapaka.KeyLengthKAut),
		MSK:   bytes.Repeat([]byte{0x04}, eapaka.KeyLengthMSK),
		EMSK:  bytes.Repeat([]byte{0x05}, eapaka.KeyLengthEMSK),
	}
	nextKeys := initialKeys
	nextKeys.MSK = bytes.Repeat([]byte{0x06}, eapaka.KeyLengthMSK)
	nextKeys.EMSK = bytes.Repeat([]byte{0x07}, eapaka.KeyLengthEMSK)
	var gotAuth ikev2.FullAuthConfig
	var gotState EAPReauthenticationState
	manager := NewIKEPacketTunnelManager(IKEPacketTunnelManagerConfig{
		SIM:          ikeTunnelAKAProvider{},
		ChildSPI:     []byte{0x11, 0x22, 0x33, 0x44},
		Transport:    ikeTunnelNoopTransport{},
		ESPTransport: &captureESPPacketTransport{},
		Reauthentication: EAPReauthenticationState{
			Identity:      "reauth-2",
			NextPseudonym: "pseudo-2",
			Counter:       2,
			CounterOK:     true,
			Keys:          initialKeys,
		},
		OnReauthenticationState: func(state EAPReauthenticationState) {
			gotState = state
		},
		InitRunner: func(ctx context.Context, cfg ikev2.InitConfig) (ikev2.InitResult, error) {
			return ikev2.InitResult{}, nil
		},
		AuthRunner: func(ctx context.Context, cfg ikev2.FullAuthConfig) (ikev2.FullAuthResult, error) {
			gotAuth = cfg
			child := packetChildSA(true)
			child.LocalSPI = append([]byte(nil), cfg.ChildSPI...)
			return ikev2.FullAuthResult{
				ChildSA:            &child,
				EAPKeys:            nextKeys,
				EAPNextReauthID:    "reauth-3",
				EAPNextPseudonym:   "pseudo-3",
				EAPReauthenticated: true,
				EAPReauthCounter:   3,
				NextMessageID:      2,
			}, nil
		},
	})

	session, err := manager.EstablishTunnel(context.Background(), TunnelConfig{
		DeviceID:    "dev-1",
		Mode:        DataplaneModeUserspace,
		EPDGAddress: "epdg.example",
		IMSI:        "310280000000001",
		MCC:         "310",
		MNC:         "280",
	})
	if err != nil {
		t.Fatalf("EstablishTunnel() error = %v", err)
	}
	defer session.Close(context.Background())

	if gotAuth.EAPReauthIdentity != "reauth-2" || gotAuth.EAPPseudonym != "pseudo-2" || gotAuth.EAPReauthCounter != 2 || !gotAuth.EAPReauthCounterOK {
		t.Fatalf("auth reauth config identity=%q pseudonym=%q counter=%d ok=%t", gotAuth.EAPReauthIdentity, gotAuth.EAPPseudonym, gotAuth.EAPReauthCounter, gotAuth.EAPReauthCounterOK)
	}
	if !bytes.Equal(gotAuth.EAPKeys.MSK, initialKeys.MSK) {
		t.Fatalf("auth EAP keys were not carried")
	}
	if gotState.Identity != "reauth-3" || gotState.NextPseudonym != "pseudo-3" || gotState.Counter != 3 || !gotState.CounterOK || !gotState.Reauthenticated {
		t.Fatalf("callback state=%+v", gotState)
	}
	if !bytes.Equal(gotState.Keys.MSK, nextKeys.MSK) || !bytes.Equal(manager.Config.Reauthentication.Keys.EMSK, nextKeys.EMSK) {
		t.Fatalf("updated keys callback=%+v manager=%+v", gotState.Keys, manager.Config.Reauthentication.Keys)
	}
	gotState.Keys.MSK[0] = 0xff
	if manager.Config.Reauthentication.Keys.MSK[0] == 0xff {
		t.Fatal("callback state leaked key slice into manager state")
	}
}

func TestIKEPacketTunnelManagerIgnoresIncompleteReauthenticationState(t *testing.T) {
	initialKeys := eapaka.Keys{
		MK:    bytes.Repeat([]byte{0x01}, 20),
		KEncr: bytes.Repeat([]byte{0x02}, eapaka.KeyLengthKEncr),
		KAut:  bytes.Repeat([]byte{0x03}, eapaka.KeyLengthKAut),
		MSK:   bytes.Repeat([]byte{0x04}, eapaka.KeyLengthMSK),
		EMSK:  bytes.Repeat([]byte{0x05}, eapaka.KeyLengthEMSK),
	}
	var gotAuth ikev2.FullAuthConfig
	manager := NewIKEPacketTunnelManager(IKEPacketTunnelManagerConfig{
		SIM:          ikeTunnelAKAProvider{},
		ChildSPI:     []byte{0x11, 0x22, 0x33, 0x44},
		Transport:    ikeTunnelNoopTransport{},
		ESPTransport: &captureESPPacketTransport{},
		Reauthentication: EAPReauthenticationState{
			Counter:   9,
			CounterOK: true,
			Keys:      initialKeys,
		},
		InitRunner: func(ctx context.Context, cfg ikev2.InitConfig) (ikev2.InitResult, error) {
			return ikev2.InitResult{}, nil
		},
		AuthRunner: func(ctx context.Context, cfg ikev2.FullAuthConfig) (ikev2.FullAuthResult, error) {
			gotAuth = cfg
			child := packetChildSA(true)
			child.LocalSPI = append([]byte(nil), cfg.ChildSPI...)
			return ikev2.FullAuthResult{
				ChildSA:         &child,
				EAPKeys:         initialKeys,
				EAPNextReauthID: "reauth-1",
				NextMessageID:   2,
			}, nil
		},
	})

	session, err := manager.EstablishTunnel(context.Background(), TunnelConfig{
		DeviceID:    "dev-1",
		Mode:        DataplaneModeUserspace,
		EPDGAddress: "epdg.example",
		IMSI:        "310280000000001",
		MCC:         "310",
		MNC:         "280",
	})
	if err != nil {
		t.Fatalf("EstablishTunnel() error = %v", err)
	}
	defer session.Close(context.Background())

	if gotAuth.EAPReauthIdentity != "" || gotAuth.EAPReauthCounter != 0 || gotAuth.EAPReauthCounterOK {
		t.Fatalf("auth reauth config identity=%q counter=%d ok=%t", gotAuth.EAPReauthIdentity, gotAuth.EAPReauthCounter, gotAuth.EAPReauthCounterOK)
	}
	if len(gotAuth.EAPKeys.KAut) != 0 || len(gotAuth.EAPKeys.KEncr) != 0 {
		t.Fatalf("incomplete EAP keys were carried: %+v", gotAuth.EAPKeys)
	}
	if manager.Config.Reauthentication.Identity != "reauth-1" || manager.Config.Reauthentication.Counter != 0 || !manager.Config.Reauthentication.CounterOK {
		t.Fatalf("updated state=%+v", manager.Config.Reauthentication)
	}
}

func TestIKEPacketTunnelManagerResetsReauthenticationCounterAfterFullAuth(t *testing.T) {
	previousKeys := eapaka.Keys{
		MK:    bytes.Repeat([]byte{0x01}, 20),
		KEncr: bytes.Repeat([]byte{0x02}, eapaka.KeyLengthKEncr),
		KAut:  bytes.Repeat([]byte{0x03}, eapaka.KeyLengthKAut),
		MSK:   bytes.Repeat([]byte{0x04}, eapaka.KeyLengthMSK),
		EMSK:  bytes.Repeat([]byte{0x05}, eapaka.KeyLengthEMSK),
	}
	nextKeys := eapaka.Keys{
		MK:    bytes.Repeat([]byte{0x11}, 20),
		KEncr: bytes.Repeat([]byte{0x12}, eapaka.KeyLengthKEncr),
		KAut:  bytes.Repeat([]byte{0x13}, eapaka.KeyLengthKAut),
		MSK:   bytes.Repeat([]byte{0x14}, eapaka.KeyLengthMSK),
		EMSK:  bytes.Repeat([]byte{0x15}, eapaka.KeyLengthEMSK),
	}
	manager := NewIKEPacketTunnelManager(IKEPacketTunnelManagerConfig{
		SIM:          ikeTunnelAKAProvider{},
		ChildSPI:     []byte{0x11, 0x22, 0x33, 0x44},
		Transport:    ikeTunnelNoopTransport{},
		ESPTransport: &captureESPPacketTransport{},
		Reauthentication: EAPReauthenticationState{
			Identity:            "old-reauth",
			Counter:             9,
			CounterOK:           true,
			Keys:                previousKeys,
			LastAcceptedCounter: 9,
			LastRejectedCounter: 4,
		},
		InitRunner: func(ctx context.Context, cfg ikev2.InitConfig) (ikev2.InitResult, error) {
			return ikev2.InitResult{}, nil
		},
		AuthRunner: func(ctx context.Context, cfg ikev2.FullAuthConfig) (ikev2.FullAuthResult, error) {
			if cfg.EAPReauthIdentity != "old-reauth" || cfg.EAPReauthCounter != 9 || !cfg.EAPReauthCounterOK {
				t.Fatalf("auth reauth config identity=%q counter=%d ok=%t", cfg.EAPReauthIdentity, cfg.EAPReauthCounter, cfg.EAPReauthCounterOK)
			}
			child := packetChildSA(true)
			child.LocalSPI = append([]byte(nil), cfg.ChildSPI...)
			return ikev2.FullAuthResult{
				ChildSA:         &child,
				EAPKeys:         nextKeys,
				EAPNextReauthID: "new-reauth",
				NextMessageID:   2,
			}, nil
		},
	})

	session, err := manager.EstablishTunnel(context.Background(), TunnelConfig{
		DeviceID:    "dev-1",
		Mode:        DataplaneModeUserspace,
		EPDGAddress: "epdg.example",
		IMSI:        "310280000000001",
		MCC:         "310",
		MNC:         "280",
	})
	if err != nil {
		t.Fatalf("EstablishTunnel() error = %v", err)
	}
	defer session.Close(context.Background())

	state := manager.Config.Reauthentication
	if state.Identity != "new-reauth" || state.Counter != 0 || !state.CounterOK || state.LastAcceptedCounter != 0 || state.LastRejectedCounter != 0 {
		t.Fatalf("updated state=%+v", state)
	}
	if !bytes.Equal(state.Keys.MSK, nextKeys.MSK) {
		t.Fatalf("updated keys=%+v", state.Keys)
	}
}

func TestIKEPacketTunnelManagerRejectsMissingSIM(t *testing.T) {
	manager := NewIKEPacketTunnelManager(IKEPacketTunnelManagerConfig{})
	_, err := manager.EstablishTunnel(context.Background(), TunnelConfig{
		DeviceID:    "dev-1",
		Mode:        DataplaneModeUserspace,
		EPDGAddress: "epdg.example",
		IMSI:        "310280000000001",
	})
	if !errors.Is(err, ErrInvalidIKETunnelManager) {
		t.Fatalf("EstablishTunnel() err=%v, want ErrInvalidIKETunnelManager", err)
	}
}

func TestIKEPacketTunnelManagerRejectsMissingChildSA(t *testing.T) {
	manager := NewIKEPacketTunnelManager(IKEPacketTunnelManagerConfig{
		SIM:          ikeTunnelAKAProvider{},
		ChildSPI:     []byte{0x11, 0x22, 0x33, 0x44},
		Transport:    ikeTunnelNoopTransport{},
		ESPTransport: &captureESPPacketTransport{},
		InitRunner: func(ctx context.Context, cfg ikev2.InitConfig) (ikev2.InitResult, error) {
			return ikev2.InitResult{}, nil
		},
		AuthRunner: func(ctx context.Context, cfg ikev2.FullAuthConfig) (ikev2.FullAuthResult, error) {
			return ikev2.FullAuthResult{NextMessageID: 2}, nil
		},
	})
	_, err := manager.EstablishTunnel(context.Background(), TunnelConfig{
		DeviceID:    "dev-1",
		Mode:        DataplaneModeUserspace,
		EPDGAddress: "epdg.example",
		IMSI:        "310280000000001",
	})
	if !errors.Is(err, ErrTunnelNotReady) {
		t.Fatalf("EstablishTunnel() err=%v, want ErrTunnelNotReady", err)
	}
}

type ikeTunnelNoopTransport struct{}

func (ikeTunnelNoopTransport) ExchangeIKE(context.Context, []byte) ([]byte, error) {
	return nil, errors.New("unexpected IKE exchange")
}

type ikeTunnelStaticSession struct {
	result TunnelResult
}

func (s ikeTunnelStaticSession) Result() TunnelResult {
	return s.result
}

func (s ikeTunnelStaticSession) MOBIKE(context.Context, MOBIKERequest) (MOBIKEResult, error) {
	return MOBIKEResult{}, nil
}

func (s ikeTunnelStaticSession) Close(context.Context) error {
	return nil
}

type ikeRekeyTransport struct {
	t          *testing.T
	init       ikev2.InitResult
	keys       ikev2.IKEKeys
	messageIDs []uint32
	localSPIs  [][]byte
	remoteSPIs [][]byte
	rekeySPIs  [][]byte
	requests   int
	sawRekey   int
}

func (tr *ikeRekeyTransport) ExchangeIKE(ctx context.Context, request []byte) ([]byte, error) {
	tr.t.Helper()
	requestIndex := tr.requests
	if requestIndex >= len(tr.messageIDs) || requestIndex >= len(tr.localSPIs) ||
		requestIndex >= len(tr.remoteSPIs) || requestIndex >= len(tr.rekeySPIs) {
		tr.t.Fatalf("unexpected rekey request index %d", requestIndex)
	}
	messageID := tr.messageIDs[requestIndex]
	localSPI := tr.localSPIs[requestIndex]
	rekeySPI := tr.rekeySPIs[requestIndex]
	msg, inner, err := ikev2.UnprotectMessage(request, tr.keys, true)
	if err != nil {
		tr.t.Fatalf("UnprotectMessage(rekey request) error = %v", err)
	}
	if msg.Header.ExchangeType != ikev2.ExchangeCREATE_CHILD_SA || msg.Header.MessageID != messageID ||
		msg.Header.Flags&ikev2.FlagInitiator == 0 {
		tr.t.Fatalf("rekey request header=%+v", msg.Header)
	}
	tr.requests++
	var sawSA bool
	for _, payload := range inner {
		switch payload.Type {
		case ikev2.PayloadNotify:
			notify, err := ikev2.ParseNotify(payload.Body)
			if err != nil {
				tr.t.Fatalf("ParseNotify(rekey) error = %v", err)
			}
			if notify.NotifyType == ikev2.NotifyRekeySA {
				if notify.ProtocolID != ikev2.ProtocolESP || !bytes.Equal(notify.SPI, rekeySPI) {
					tr.t.Fatalf("rekey notify=%+v want SPI %x", notify, rekeySPI)
				}
				tr.sawRekey++
			}
		case ikev2.PayloadSA:
			sa, err := ikev2.ParseSecurityAssociation(payload.Body)
			if err != nil {
				tr.t.Fatalf("ParseSecurityAssociation(rekey) error = %v", err)
			}
			if len(sa.Proposals) != 1 || !bytes.Equal(sa.Proposals[0].SPI, localSPI) {
				tr.t.Fatalf("request SA=%+v want local SPI %x", sa, localSPI)
			}
			sawSA = true
		}
	}
	if !sawSA {
		tr.t.Fatal("rekey request missing SA")
	}
	saPayload, err := ikev2.SecurityAssociationPayload(ikev2.DefaultESPProposal(tr.remoteSPIs[requestIndex]))
	if err != nil {
		tr.t.Fatalf("SecurityAssociationPayload(response) error = %v", err)
	}
	tsiPayload, err := ikev2.TrafficSelectorsPayload(ikev2.PayloadTSi, ikev2.IPv4AnyTrafficSelectors())
	if err != nil {
		tr.t.Fatalf("TrafficSelectorsPayload(TSi) error = %v", err)
	}
	tsrPayload, err := ikev2.TrafficSelectorsPayload(ikev2.PayloadTSr, ikev2.IPv4AnyTrafficSelectors())
	if err != nil {
		tr.t.Fatalf("TrafficSelectorsPayload(TSr) error = %v", err)
	}
	_, raw, err := ikev2.ProtectMessage(
		ikev2.Header{
			InitiatorSPI: tr.init.InitiatorSPI,
			ResponderSPI: tr.init.ResponderSPI,
			ExchangeType: ikev2.ExchangeCREATE_CHILD_SA,
			Flags:        ikev2.FlagResponse,
			MessageID:    messageID,
		},
		tr.keys,
		false,
		[]ikev2.Payload{
			saPayload,
			ikev2.NoncePayload(bytes.Repeat([]byte{byte(0x90 + requestIndex)}, 32)),
			tsiPayload,
			tsrPayload,
		},
		bytes.Repeat([]byte{byte(0xa0 + requestIndex)}, tr.keys.Profile.EncryptionBlockSize),
	)
	if err != nil {
		tr.t.Fatalf("ProtectMessage(rekey response) error = %v", err)
	}
	return raw, nil
}

type ikeTunnelAKAProvider struct{}

func (ikeTunnelAKAProvider) CalculateAKA(rand16, autn16 []byte) (sim.AKAResult, error) {
	return sim.AKAResult{
		RES: []byte{0x01, 0x02, 0x03, 0x04},
		CK:  bytes.Repeat([]byte{0x10}, 16),
		IK:  bytes.Repeat([]byte{0x20}, 16),
	}, nil
}

type fakeKernelXFRMManager struct {
	applyConfigs  []KernelXFRMConfig
	applyState    KernelXFRMState
	applyErr      error
	cleanupStates []KernelXFRMState
	cleanupErr    error
}

func (m *fakeKernelXFRMManager) Apply(ctx context.Context, cfg KernelXFRMConfig) (KernelXFRMState, error) {
	m.applyConfigs = append(m.applyConfigs, cfg)
	return m.applyState, m.applyErr
}

func (m *fakeKernelXFRMManager) Cleanup(ctx context.Context, state KernelXFRMState) error {
	m.cleanupStates = append(m.cleanupStates, state)
	return m.cleanupErr
}
