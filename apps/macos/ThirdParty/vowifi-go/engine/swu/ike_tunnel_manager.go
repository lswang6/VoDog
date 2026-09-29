package swu

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/boa-z/vowifi-go/engine/sim"
	"github.com/boa-z/vowifi-go/engine/swu/eapaka"
	"github.com/boa-z/vowifi-go/engine/swu/ikev2"
)

var ErrInvalidIKETunnelManager = errors.New("invalid swu ike tunnel manager")

type IKEInitRunner func(context.Context, ikev2.InitConfig) (ikev2.InitResult, error)

type IKEAuthRunner func(context.Context, ikev2.FullAuthConfig) (ikev2.FullAuthResult, error)

type IKEPacketSessionFactory func(PacketSessionConfig) (TunnelSession, error)

type IKETransportFactory func(TunnelConfig, IKETransportConfig) (ikev2.InitTransport, error)

type IKEESPTransportFactory func(TunnelConfig, ESPTransportConfig) (ESPPacketTransport, error)

type IKETransportConfig struct {
	EPDGAddress     string
	RemoteAddr      string
	LocalAddr       string
	LocalIP         net.IP
	RemoteIP        net.IP
	LocalPort       uint16
	RemotePort      uint16
	Timeout         time.Duration
	UseNonESPMarker bool
}

type ESPTransportConfig struct {
	EPDGAddress string
	RemoteAddr  string
	LocalAddr   string
	Timeout     time.Duration
}

type IKEPacketTunnelManagerConfig struct {
	Transport                ikev2.InitTransport
	ESPTransport             ESPPacketTransport
	SIM                      sim.AKAProvider
	Random                   io.Reader
	Timeout                  time.Duration
	LocalIP                  net.IP
	RemoteIP                 net.IP
	LocalPort                uint16
	RemotePort               uint16
	UseNonESPMarker          bool
	EAPIdentity              string
	Reauthentication         EAPReauthenticationState
	OnReauthenticationState  func(EAPReauthenticationState)
	ReauthenticationLifetime time.Duration
	InitiatorID              ikev2.Identity
	ResponderID              ikev2.Identity
	IKETransportFactory      IKETransportFactory
	ESPTransportFactory      IKEESPTransportFactory
	InitRunner               IKEInitRunner
	AuthRunner               IKEAuthRunner
	PacketSessionFactory     IKEPacketSessionFactory
	KernelXFRMManager        KernelXFRMManager
	KernelXFRMConfig         KernelXFRMConfig
	SA                       ikev2.SecurityAssociation
	ChildSA                  ikev2.SecurityAssociation
	ChildSPI                 []byte
	TSi                      ikev2.TrafficSelectors
	TSr                      ikev2.TrafficSelectors
	Configuration            ikev2.Configuration
	AdditionalAddresses      []net.IP
	NoAdditionalAddresses    bool
	Liveness                 IKELivenessConfig
	ChildSARekey             ChildSARekeyPolicy
	DisableControlPlaneHooks bool
}

type IKEPacketTunnelManager struct {
	Config IKEPacketTunnelManagerConfig
}

type IKETunnelManagerConfig = IKEPacketTunnelManagerConfig

type IKETunnelManager = IKEPacketTunnelManager

var _ TunnelManager = (*IKEPacketTunnelManager)(nil)

func NewIKEPacketTunnelManager(cfg IKEPacketTunnelManagerConfig) *IKEPacketTunnelManager {
	return &IKEPacketTunnelManager{Config: cfg}
}

func NewIKETunnelManager(cfg IKETunnelManagerConfig) *IKETunnelManager {
	return NewIKEPacketTunnelManager(cfg)
}

func (m *IKEPacketTunnelManager) EstablishTunnel(ctx context.Context, cfg TunnelConfig) (TunnelSession, error) {
	if m == nil {
		return nil, fmt.Errorf("%w: manager is nil", ErrInvalidIKETunnelManager)
	}
	if ctx == nil {
		ctx = context.Background()
	}
	if err := cfg.Validate(); err != nil {
		return nil, err
	}
	mode := cfg.NormalizedMode()
	if mode == DataplaneModeDisabled {
		return nil, fmt.Errorf("%w: dataplane mode is disabled", ErrInvalidTunnelConfig)
	}
	if mode != DataplaneModeUserspace && mode != DataplaneModeKernel {
		return nil, fmt.Errorf("%w: unsupported dataplane mode %q", ErrInvalidTunnelConfig, mode)
	}
	provider := m.Config.SIM
	if provider == nil {
		return nil, fmt.Errorf("%w: SIM AKA provider is nil", ErrInvalidIKETunnelManager)
	}
	epdg := epdgAddressForTunnel(cfg)
	if epdg == "" {
		return nil, fmt.Errorf("%w: ePDG address is empty", ErrInvalidTunnelConfig)
	}
	identity, err := eapIdentityForTunnel(cfg, m.Config.EAPIdentity)
	if err != nil {
		return nil, err
	}
	operatorRealm := eapOperatorRealm(identity)
	initiatorID := m.Config.InitiatorID
	if initiatorID.Type == 0 {
		initiatorID = ikev2.Identity{Type: ikev2.IDRFC822Addr, Data: []byte(identity)}
	}
	responderID := m.Config.ResponderID
	if responderID.Type == 0 {
		apn := strings.TrimSpace(cfg.APN)
		if apn == "" {
			apn = "ims"
		}
		responderID = ikev2.Identity{Type: ikev2.IDFQDN, Data: []byte(apn)}
	}
	random := m.Config.Random
	if random == nil {
		random = rand.Reader
	}
	transportCfg, espCfg := m.transportConfigs(cfg, epdg)
	var proxyTransport *SOCKSNATTTransport
	var transport ikev2.InitTransport
	if cfg.Proxy != nil && cfg.Proxy.Enabled {
		if mode != DataplaneModeUserspace {
			return nil, fmt.Errorf("%w: SOCKS5 UDP proxy requires userspace dataplane", ErrInvalidTunnelConfig)
		}
		proxyTransport, err = NewSOCKSNATTTransport(*cfg.Proxy, transportCfg.RemoteAddr, transportCfg.Timeout)
		if err != nil {
			return nil, err
		}
		transport = proxyTransport
	} else {
		transport, err = m.ikeTransport(cfg, transportCfg)
		if err != nil {
			return nil, err
		}
	}
	transportOwnedBySession := false
	ownedTransport, ownsTransport := transport.(ESPPacketTransportCloser)
	if m.Config.Transport != nil || m.Config.IKETransportFactory != nil {
		ownsTransport = false
	}
	defer func() {
		if ownsTransport && !transportOwnedBySession {
			_ = ownedTransport.Close(context.Background())
		}
	}()
	childSPI, err := m.childSPI(random)
	if err != nil {
		return nil, err
	}
	initRunner := m.Config.InitRunner
	if initRunner == nil {
		initRunner = ikev2.RunIKE_SA_INIT
	}
	init, err := initRunner(ctx, ikev2.InitConfig{
		Transport:  transport,
		Random:     random,
		SA:         m.Config.SA,
		LocalIP:    transportCfg.LocalIP,
		LocalPort:  transportCfg.LocalPort,
		RemoteIP:   transportCfg.RemoteIP,
		RemotePort: transportCfg.RemotePort,
	})
	if err != nil {
		return nil, err
	}
	authRunner := m.Config.AuthRunner
	if authRunner == nil {
		authRunner = ikev2.RunIKE_AUTH_Full
	}
	reauth := m.Config.Reauthentication.authStateAt(reauthenticationNow(cfg.StartedAt), operatorRealm)
	authCfg := ikev2.FullAuthConfig{
		Transport:          transport,
		Init:               init,
		Keys:               init.Keys,
		SIM:                provider,
		EAPKeys:            reauth.Keys,
		InitiatorID:        initiatorID,
		ResponderID:        responderID,
		EAPIdentity:        identity,
		EAPPseudonym:       reauth.NextPseudonym,
		EAPReauthIdentity:  reauth.Identity,
		EAPReauthCounter:   reauth.Counter,
		EAPReauthCounterOK: reauth.CounterOK,
		ChildSA:            m.Config.ChildSA,
		ChildSPI:           childSPI,
		TSi:                m.Config.TSi,
		TSr:                m.Config.TSr,
		Configuration:      m.Config.Configuration,
		Random:             random,
	}
	auth, err := authRunner(ctx, authCfg)
	if err != nil {
		return nil, fmt.Errorf("%s: %w", initialIKEAuthDiagnostic(cfg, authCfg), err)
	}
	if auth.ChildSA == nil {
		return nil, fmt.Errorf("%w: IKE_AUTH completed without CHILD_SA", ErrTunnelNotReady)
	}
	child := *auth.ChildSA
	m.updateReauthenticationState(auth, operatorRealm)
	result := tunnelResultFromIKE(cfg, epdg, init, child, mode)
	closeHandler, mobikeHandler, rekeyHandler, dpdHandler := m.controlHandlers(transport, init, auth, child, result, transportCfg)
	if mode == DataplaneModeKernel {
		return m.establishKernelSession(ctx, cfg, transportCfg, init, child, result, closeHandler)
	}
	var espTransport ESPPacketTransport
	if shared, ok := transport.(ESPPacketTransport); ok {
		espTransport = shared
	} else {
		espTransport, err = m.espTransport(cfg, espCfg)
		if err != nil {
			return nil, err
		}
	}
	livenessCfg := m.Config.Liveness
	if dpdHandler == nil {
		livenessCfg.DisableDPD = true
	}
	liveness, err := NewIKELivenessState(livenessCfg, result.EstablishedAt)
	if err != nil {
		if closer, ok := espTransport.(ESPPacketTransportCloser); ok {
			_ = closer.Close(ctx)
		}
		return nil, err
	}
	sessionFactory := m.Config.PacketSessionFactory
	if sessionFactory == nil {
		sessionFactory = func(pc PacketSessionConfig) (TunnelSession, error) {
			return NewPacketSession(pc)
		}
	}
	session, err := sessionFactory(PacketSessionConfig{
		Result:        result,
		ChildSA:       child,
		Transport:     espTransport,
		Random:        random,
		MOBIKEHandler: mobikeHandler,
		RekeyHandler:  rekeyHandler,
		RekeyPolicy:   m.Config.ChildSARekey,
		MOBIKENAT: NewMOBIKENATState(MOBIKENATStateConfig{
			MOBIKESupported: result.MOBIKESupported,
			LocalIP:         transportCfg.LocalIP,
			RemoteIP:        transportCfg.RemoteIP,
			LocalPort:       transportCfg.LocalPort,
			RemotePort:      transportCfg.RemotePort,
			NATDetected:     init.NATDetected,
			UpdatedAt:       result.EstablishedAt,
		}),
		Liveness:     liveness,
		DPDHandler:   dpdHandler,
		CloseHandler: closeHandler,
	})
	if err != nil {
		if closer, ok := espTransport.(ESPPacketTransportCloser); ok {
			_ = closer.Close(ctx)
		}
		return nil, err
	}
	if session == nil {
		if closer, ok := espTransport.(ESPPacketTransportCloser); ok {
			_ = closer.Close(ctx)
		}
		return nil, fmt.Errorf("%w: packet session factory returned nil", ErrInvalidIKETunnelManager)
	}
	transportOwnedBySession = ownsTransport
	return session, nil
}

func (m *IKEPacketTunnelManager) establishKernelSession(ctx context.Context, cfg TunnelConfig, transportCfg IKETransportConfig, init ikev2.InitResult, child ikev2.ChildSAResult, result TunnelResult, closeHandler func(context.Context) error) (TunnelSession, error) {
	xfrmTemplate := m.Config.KernelXFRMConfig
	xfrmCfg, err := KernelXFRMConfigFromIKE(KernelXFRMConfigFromIKEConfig{
		Tunnel:               cfg,
		Transport:            transportCfg,
		Init:                 init,
		ChildSA:              child,
		InnerLocalPrefix:     xfrmTemplate.InnerLocalPrefix,
		InnerRemotePrefix:    xfrmTemplate.InnerRemotePrefix,
		ReqID:                xfrmTemplate.ReqID,
		Mark:                 xfrmTemplate.Mark,
		InterfaceID:          xfrmTemplate.InterfaceID,
		IncludeForwardPolicy: xfrmTemplate.IncludeForwardPolicy,
		XFRMInterface:        xfrmTemplate.XFRMInterface,
		NATTraversal:         xfrmTemplate.NATTraversal,
	})
	if err != nil {
		return nil, errors.Join(err, closeIKEBestEffort(ctx, closeHandler))
	}
	xfrmManager := m.Config.KernelXFRMManager
	if xfrmManager == nil {
		xfrmManager = LinuxXFRMManager{}
	}
	xfrmState, err := xfrmManager.Apply(ctx, xfrmCfg)
	if err != nil {
		return nil, errors.Join(err, closeIKEBestEffort(ctx, closeHandler))
	}
	session, err := newKernelTunnelSession(result, xfrmManager, xfrmState, closeHandler)
	if err != nil {
		return nil, errors.Join(err, xfrmManager.Cleanup(ctx, xfrmState), closeIKEBestEffort(ctx, closeHandler))
	}
	return session, nil
}

func closeIKEBestEffort(ctx context.Context, closeHandler func(context.Context) error) error {
	if closeHandler == nil {
		return nil
	}
	return closeHandler(ctx)
}

func (m *IKEPacketTunnelManager) updateReauthenticationState(auth ikev2.FullAuthResult, operatorRealm string) {
	if m == nil || len(auth.EAPKeys.KAut) == 0 || len(auth.EAPKeys.KEncr) == 0 {
		return
	}
	next, ok := m.Config.Reauthentication.ApplyUpdate(EAPReauthenticationUpdate{
		NextReauthID:    auth.EAPNextReauthID,
		NextPseudonym:   auth.EAPNextPseudonym,
		Keys:            auth.EAPKeys,
		Reauthenticated: auth.EAPReauthenticated,
		CounterTooSmall: auth.EAPReauthCounterTooSmall,
		Counter:         auth.EAPReauthCounter,
		ExpiresAt:       m.reauthenticationExpiresAt(),
		OperatorRealm:   operatorRealm,
	})
	if !ok {
		return
	}
	m.Config.Reauthentication = next
	if m.Config.OnReauthenticationState != nil {
		m.Config.OnReauthenticationState(next.clone())
	}
}

func (m *IKEPacketTunnelManager) reauthenticationExpiresAt() time.Time {
	if m == nil || m.Config.ReauthenticationLifetime <= 0 {
		return time.Time{}
	}
	return time.Now().Add(m.Config.ReauthenticationLifetime)
}

func (m *IKEPacketTunnelManager) transportConfigs(cfg TunnelConfig, epdg string) (IKETransportConfig, ESPTransportConfig) {
	remotePort := m.Config.RemotePort
	if remotePort == 0 {
		remotePort = 4500
	}
	localPort := m.Config.LocalPort
	localIP := normalizedMOBIKEIP(m.Config.LocalIP, cfg.OuterLocalIP)
	remoteIP := normalizedMOBIKEIP(m.Config.RemoteIP, tunnelAddressHost(epdg))
	remoteAddr := tunnelUDPAddr(epdg, remotePort)
	localAddr := ""
	if local := firstPacketNonEmpty(cfg.OuterLocalIP); local != "" {
		localAddr = tunnelUDPAddr(local, localPort)
	}
	timeout := m.Config.Timeout
	if timeout == 0 {
		timeout = 8 * time.Second
	}
	useMarker := m.Config.UseNonESPMarker
	if !useMarker {
		useMarker = remotePort == 4500
	}
	ikeCfg := IKETransportConfig{
		EPDGAddress:     epdg,
		RemoteAddr:      remoteAddr,
		LocalAddr:       localAddr,
		LocalIP:         localIP,
		RemoteIP:        remoteIP,
		LocalPort:       localPort,
		RemotePort:      remotePort,
		Timeout:         timeout,
		UseNonESPMarker: useMarker,
	}
	espCfg := ESPTransportConfig{
		EPDGAddress: epdg,
		RemoteAddr:  remoteAddr,
		LocalAddr:   localAddr,
		Timeout:     timeout,
	}
	return ikeCfg, espCfg
}

func (m *IKEPacketTunnelManager) ikeTransport(cfg TunnelConfig, transportCfg IKETransportConfig) (ikev2.InitTransport, error) {
	if m.Config.Transport != nil {
		return m.Config.Transport, nil
	}
	if m.Config.IKETransportFactory != nil {
		return m.Config.IKETransportFactory(cfg, transportCfg)
	}
	return NewUDPNATTTransport(
		transportCfg.RemoteAddr,
		transportCfg.LocalAddr,
		transportCfg.Timeout,
		transportCfg.UseNonESPMarker,
	), nil
}

func (m *IKEPacketTunnelManager) espTransport(cfg TunnelConfig, transportCfg ESPTransportConfig) (ESPPacketTransport, error) {
	if m.Config.ESPTransport != nil {
		return m.Config.ESPTransport, nil
	}
	if m.Config.ESPTransportFactory != nil {
		return m.Config.ESPTransportFactory(cfg, transportCfg)
	}
	return &UDPESPPacketTransport{
		RemoteAddr: transportCfg.RemoteAddr,
		LocalAddr:  transportCfg.LocalAddr,
		Timeout:    transportCfg.Timeout,
	}, nil
}

func (m *IKEPacketTunnelManager) childSPI(random io.Reader) ([]byte, error) {
	if len(m.Config.ChildSPI) > 0 {
		if len(m.Config.ChildSPI) != 4 {
			return nil, fmt.Errorf("%w: child SPI length %d", ErrInvalidIKETunnelManager, len(m.Config.ChildSPI))
		}
		return append([]byte(nil), m.Config.ChildSPI...), nil
	}
	spi := make([]byte, 4)
	if _, err := io.ReadFull(random, spi); err != nil {
		return nil, err
	}
	if spi[0] == 0 && spi[1] == 0 && spi[2] == 0 && spi[3] == 0 {
		spi[3] = 1
	}
	return spi, nil
}

func (m *IKEPacketTunnelManager) controlHandlers(transport ikev2.InitTransport, init ikev2.InitResult, auth ikev2.FullAuthResult, child ikev2.ChildSAResult, result TunnelResult, transportCfg IKETransportConfig) (func(context.Context) error, func(context.Context, MOBIKERequest) (MOBIKEResult, error), ChildSARekeyHandler, func(context.Context) error) {
	if m.Config.DisableControlPlaneHooks || auth.NextMessageID == 0 || !ikeKeysUsable(init.Keys) {
		return nil, nil, nil, nil
	}
	control := &ikePacketTunnelControl{
		transport:             transport,
		init:                  init,
		keys:                  init.Keys,
		child:                 child,
		nextMessageID:         auth.NextMessageID,
		result:                result,
		localIP:               transportCfg.LocalIP,
		remoteIP:              transportCfg.RemoteIP,
		localPort:             transportCfg.LocalPort,
		remotePort:            transportCfg.RemotePort,
		additionalAddresses:   cloneIPs(m.Config.AdditionalAddresses),
		noAdditionalAddresses: m.Config.NoAdditionalAddresses,
		random:                m.Config.Random,
	}
	closeHandler := control.close
	var mobikeHandler func(context.Context, MOBIKERequest) (MOBIKEResult, error)
	if init.MOBIKESupported {
		mobikeHandler = control.mobike
	}
	return closeHandler, mobikeHandler, control.rekeyChildSA, control.dpd
}

type ikePacketTunnelControl struct {
	mu                    sync.Mutex
	transport             ikev2.InitTransport
	init                  ikev2.InitResult
	keys                  ikev2.IKEKeys
	child                 ikev2.ChildSAResult
	nextMessageID         uint32
	result                TunnelResult
	localIP               net.IP
	remoteIP              net.IP
	localPort             uint16
	remotePort            uint16
	additionalAddresses   []net.IP
	noAdditionalAddresses bool
	random                io.Reader
}

func (c *ikePacketTunnelControl) close(ctx context.Context) error {
	if c == nil {
		return nil
	}
	c.mu.Lock()
	messageID := c.nextMessageID
	c.nextMessageID++
	c.mu.Unlock()
	payloads, err := ikev2.TeardownDeletePayloads(c.child, true)
	if err != nil {
		return err
	}
	_, err = ikev2.RunInformationalExchange(ctx, ikev2.InformationalConfig{
		Transport: c.transport,
		Init:      c.init,
		Keys:      c.keys,
		MessageID: messageID,
		Payloads:  payloads,
		Random:    c.random,
	})
	return err
}

func (c *ikePacketTunnelControl) rekeyChildSA(ctx context.Context) (ikev2.ChildSAResult, error) {
	if c == nil {
		return ikev2.ChildSAResult{}, ErrInvalidIKEControl
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.nextMessageID == 0 {
		return ikev2.ChildSAResult{}, fmt.Errorf("%w: next message_id is zero", ErrInvalidIKEControl)
	}
	messageID := c.nextMessageID
	c.nextMessageID++
	res, err := ikev2.RunCREATE_CHILD_SARekey(ctx, ikev2.ChildSARekeyConfig{
		Transport:  c.transport,
		Init:       c.init,
		Keys:       c.keys,
		MessageID:  messageID,
		OldChildSA: c.child,
		Random:     c.random,
	})
	if err != nil {
		return ikev2.ChildSAResult{}, err
	}
	if res.NextMessageID != 0 {
		c.nextMessageID = res.NextMessageID
	}
	c.child = res.ChildSA
	c.result.ChildSAIdentifier = childSAIdentifier(res.ChildSA)
	c.result.IKEEstablished = true
	c.result.IPsecEstablished = true
	c.result.Ready = true
	c.result.Reason = "child sa rekeyed"
	return res.ChildSA, nil
}

func (c *ikePacketTunnelControl) dpd(ctx context.Context) error {
	if c == nil {
		return ErrInvalidIKEControl
	}
	c.mu.Lock()
	messageID := c.nextMessageID
	c.nextMessageID++
	c.mu.Unlock()
	_, err := ikev2.RunLivenessCheck(ctx, ikev2.InformationalConfig{
		Transport: c.transport,
		Init:      c.init,
		Keys:      c.keys,
		MessageID: messageID,
		Random:    c.random,
	})
	return err
}

func (c *ikePacketTunnelControl) mobike(ctx context.Context, req MOBIKERequest) (MOBIKEResult, error) {
	if c == nil {
		return MOBIKEResult{}, ErrInvalidIKEControl
	}
	c.mu.Lock()
	messageID := c.nextMessageID
	c.nextMessageID++
	c.mu.Unlock()
	payloads, err := mobikeUpdatePayloads(IKEMOBIKEConfig{
		Init:                  c.init,
		Result:                c.result,
		LocalIP:               c.localIP,
		RemoteIP:              c.remoteIP,
		LocalPort:             c.localPort,
		RemotePort:            c.remotePort,
		AdditionalAddresses:   c.additionalAddresses,
		NoAdditionalAddresses: c.noAdditionalAddresses,
	}, c.additionalAddresses, req)
	if err != nil {
		return MOBIKEResult{}, err
	}
	res, err := ikev2.RunInformationalExchange(ctx, ikev2.InformationalConfig{
		Transport: c.transport,
		Init:      c.init,
		Keys:      c.keys,
		MessageID: messageID,
		Payloads:  payloads,
		Random:    c.random,
	})
	if err != nil {
		return MOBIKEResult{}, err
	}
	if err := rejectMOBIKEResponse(res.ResponseInner); err != nil {
		return MOBIKEResult{}, err
	}
	return MOBIKEResult{
		Rekeyed:          false,
		OuterLocalIP:     firstPacketNonEmpty(req.NewIP, req.OldIP, c.result.EPDGAddress),
		LocalInnerIP:     c.result.LocalInnerIP,
		RemoteInnerIP:    c.result.RemoteInnerIP,
		IKEEstablished:   true,
		IPsecEstablished: true,
		Reason:           "mobike update sa addresses sent",
		UpdatedAt:        time.Now(),
	}, nil
}

func tunnelResultFromIKE(cfg TunnelConfig, epdg string, init ikev2.InitResult, child ikev2.ChildSAResult, mode string) TunnelResult {
	mode = firstPacketNonEmpty(mode, DataplaneModeUserspace)
	return TunnelResult{
		Ready:             true,
		Mode:              mode,
		EPDGAddress:       epdg,
		LocalInnerIP:      firstPacketNonEmpty(cfg.InnerLocalIP, childConfigurationAddress(child, ikev2.ConfigInternalIPv4Address), childConfigurationAddress(child, ikev2.ConfigInternalIPv6Address)),
		RemoteInnerIP:     strings.TrimSpace(cfg.RemoteInnerIP),
		DNSServers:        childConfigurationDNS(child),
		PCSCFServers:      childConfigurationPCSCF(child),
		IKEEstablished:    true,
		IPsecEstablished:  true,
		MOBIKESupported:   init.MOBIKESupported,
		ChildSAIdentifier: childSAIdentifier(child),
		Reason:            "ike ipsec tunnel ready",
		EstablishedAt:     time.Now(),
	}
}

func childConfigurationAddress(child ikev2.ChildSAResult, attrType uint16) string {
	values := childConfigurationIPStrings(child, attrType)
	if len(values) == 0 {
		return ""
	}
	return values[0]
}

func childConfigurationDNS(child ikev2.ChildSAResult) []string {
	return append(childConfigurationIPStrings(child, ikev2.ConfigInternalIPv4DNS), childConfigurationIPStrings(child, ikev2.ConfigInternalIPv6DNS)...)
}

func childConfigurationPCSCF(child ikev2.ChildSAResult) []string {
	return append(childConfigurationIPStrings(child, ikev2.ConfigPCSCFIPv4Address), childConfigurationIPStrings(child, ikev2.ConfigPCSCFIPv6Address)...)
}

func childConfigurationIPStrings(child ikev2.ChildSAResult, attrType uint16) []string {
	if child.Configuration == nil {
		return nil
	}
	width := 0
	switch attrType {
	case ikev2.ConfigInternalIPv4Address, ikev2.ConfigInternalIPv4DNS, ikev2.ConfigPCSCFIPv4Address:
		width = net.IPv4len
	case ikev2.ConfigInternalIPv6Address, ikev2.ConfigInternalIPv6DNS, ikev2.ConfigPCSCFIPv6Address:
		width = net.IPv6len
	default:
		return nil
	}
	seen := map[string]bool{}
	var out []string
	for _, attr := range child.Configuration.Attributes {
		if attr.Type != attrType {
			continue
		}
		for value := attr.Value; len(value) >= width; value = value[width:] {
			ip := net.IP(value[:width]).String()
			if ip != "" && !seen[ip] {
				out = append(out, ip)
				seen[ip] = true
			}
		}
	}
	return out
}

func childSAIdentifier(child ikev2.ChildSAResult) string {
	local := hex.EncodeToString(child.LocalSPI)
	remote := hex.EncodeToString(child.RemoteSPI)
	switch {
	case local != "" && remote != "":
		return local + "/" + remote
	case local != "":
		return local
	default:
		return remote
	}
}

func epdgAddressForTunnel(cfg TunnelConfig) string {
	if epdg := strings.TrimSpace(cfg.EPDGAddress); epdg != "" {
		return epdg
	}
	mcc, mnc := tunnelMCCMNC(cfg)
	if mcc == "" || mnc == "" {
		return ""
	}
	return fmt.Sprintf("epdg.epc.mnc%s.mcc%s.pub.3gppnetwork.org", leftPadTunnel(mnc, 3), mcc)
}

func eapIdentityForTunnel(cfg TunnelConfig, override string) (string, error) {
	if raw := normalizeTunnelIdentity(override); raw != "" {
		if !strings.Contains(raw, "@") {
			return "", fmt.Errorf("%w: EAP identity override must be a NAI", ErrInvalidTunnelConfig)
		}
		return raw, nil
	}
	imsi := strings.TrimSpace(cfg.IMSI)
	if imsi == "" {
		return "", fmt.Errorf("%w: IMSI is required for EAP identity; IMPI cannot be used as IDi", ErrInvalidTunnelConfig)
	}
	mcc, mnc := tunnelMCCMNC(cfg)
	if mcc == "" || mnc == "" {
		return "", fmt.Errorf("%w: MCC/MNC is required for IMSI-derived EAP identity", ErrInvalidTunnelConfig)
	}
	eapType := eapaka.TypeAKA
	if cfg.NormalizedEAPMethod() == EAPMethodAKAPrime {
		eapType = eapaka.TypeAKAPrime
	}
	identity, err := eapaka.FormatPermanentIdentity(imsi, mcc, mnc, eapType)
	if err != nil {
		return "", fmt.Errorf("%w: format EAP identity: %v", ErrInvalidTunnelConfig, err)
	}
	return identity, nil
}

func initialIKEAuthDiagnostic(cfg TunnelConfig, auth ikev2.FullAuthConfig) string {
	method, prefix, realm, digits := safeEAPIdentitySummary(auth.EAPIdentity)
	mcc, mnc := tunnelMCCMNC(cfg)
	return fmt.Sprintf(
		"IKE_AUTH request payloads=[IDi,IDr,SA,TSi,TSr,CP,INITIAL_CONTACT,MOBIKE_SUPPORTED,EAP_ONLY_AUTHENTICATION] auth=omitted idi=[type=ID_RFC822_ADDR method=%s prefix=%s digits=%d realm=%s] idr=[type=ID_FQDN value=%s] child_sa=%s tsi=%s tsr=%s cp=%s home_plmn=%s/%s",
		method,
		prefix,
		digits,
		realm,
		safeDiagnosticToken(string(auth.ResponderID.Data)),
		safeSADiagnostic(auth.ChildSA),
		safeTSDiagnostic(auth.TSi),
		safeTSDiagnostic(auth.TSr),
		safeCPDiagnostic(auth.Configuration),
		safeDiagnosticToken(mcc),
		safeDiagnosticToken(mnc),
	)
}

func safeEAPIdentitySummary(identity string) (method, prefix, realm string, digits int) {
	identity = normalizeTunnelIdentity(identity)
	username, realm, ok := strings.Cut(identity, "@")
	if !ok {
		return "unknown", "none", "invalid", 0
	}
	realm = strings.ToLower(strings.TrimSpace(realm))
	if len(username) == 0 {
		return "unknown", "none", realm, 0
	}
	prefix = username[:1]
	switch prefix {
	case "0":
		method = EAPMethodAKA
	case "6":
		method = EAPMethodAKAPrime
	default:
		method = "unknown"
	}
	if isDecimalString(username[1:]) {
		digits = len(username) - 1
	}
	return method, prefix, realm, digits
}

func safeSADiagnostic(sa ikev2.SecurityAssociation) string {
	if len(sa.Proposals) == 0 {
		return "default"
	}
	parts := make([]string, 0, len(sa.Proposals[0].Transforms))
	for _, transform := range sa.Proposals[0].Transforms {
		parts = append(parts, fmt.Sprintf("%d:%d", transform.Type, transform.ID))
	}
	return "transforms[" + strings.Join(parts, ",") + "]"
}

func safeTSDiagnostic(selectors ikev2.TrafficSelectors) string {
	if len(selectors.Selectors) == 0 {
		return "default-dual-stack"
	}
	v4, v6 := 0, 0
	for _, selector := range selectors.Selectors {
		switch selector.Type {
		case ikev2.TSIPv4AddressRange:
			v4++
		case ikev2.TSIPv6AddressRange:
			v6++
		}
	}
	return fmt.Sprintf("selectors[v4=%d,v6=%d]", v4, v6)
}

func safeCPDiagnostic(configuration ikev2.Configuration) string {
	if len(configuration.Attributes) == 0 {
		return "request[ipv4-address,ipv4-dns,ipv6-address,ipv6-dns,pcscf-ipv4,pcscf-ipv6]"
	}
	types := make([]string, 0, len(configuration.Attributes))
	for _, attribute := range configuration.Attributes {
		types = append(types, strconv.Itoa(int(attribute.Type)))
	}
	return "attributes[" + strings.Join(types, ",") + "]"
}

func safeDiagnosticToken(value string) string {
	value = strings.TrimSpace(value)
	if value == "" {
		return "none"
	}
	for _, r := range value {
		if (r < 'a' || r > 'z') && (r < 'A' || r > 'Z') && (r < '0' || r > '9') && r != '-' && r != '_' && r != '.' {
			return "invalid"
		}
	}
	return value
}

func eapOperatorRealm(identity string) string {
	identity = normalizeTunnelIdentity(identity)
	at := strings.LastIndexByte(identity, '@')
	if at < 0 || at == len(identity)-1 {
		return ""
	}
	return normalizeEAPOperatorRealm(identity[at+1:])
}

func reauthenticationNow(startedAt time.Time) time.Time {
	if !startedAt.IsZero() {
		return startedAt
	}
	return time.Now()
}

func normalizeTunnelIdentity(identity string) string {
	identity = strings.TrimSpace(identity)
	identity = strings.Trim(identity, "<>")
	if strings.HasPrefix(strings.ToLower(identity), "sip:") {
		identity = identity[4:]
	}
	if semi := strings.IndexByte(identity, ';'); semi >= 0 {
		identity = identity[:semi]
	}
	return strings.TrimSpace(identity)
}

func tunnelMCCMNC(cfg TunnelConfig) (string, string) {
	mcc := strings.TrimSpace(cfg.MCC)
	mnc := strings.TrimSpace(cfg.MNC)
	imsi := strings.TrimSpace(cfg.IMSI)
	if mcc == "" && len(imsi) >= 3 {
		mcc = imsi[:3]
	}
	if mnc == "" && len(imsi) >= 6 {
		mnc = imsi[3:6]
	}
	return mcc, mnc
}

func tunnelUDPAddr(addr string, port uint16) string {
	addr = strings.TrimSpace(addr)
	if _, _, err := net.SplitHostPort(addr); err == nil {
		return addr
	}
	return net.JoinHostPort(strings.Trim(addr, "[]"), strconv.Itoa(int(port)))
}

func tunnelAddressHost(addr string) string {
	addr = strings.TrimSpace(addr)
	if host, _, err := net.SplitHostPort(addr); err == nil {
		return strings.Trim(host, "[]")
	}
	return strings.Trim(addr, "[]")
}

func leftPadTunnel(value string, width int) string {
	value = strings.TrimSpace(value)
	for len(value) < width {
		value = "0" + value
	}
	return value
}

func isDecimalString(value string) bool {
	if value == "" {
		return false
	}
	for _, r := range value {
		if r < '0' || r > '9' {
			return false
		}
	}
	return true
}

func ikeKeysUsable(keys ikev2.IKEKeys) bool {
	p := keys.Profile
	return p.RequiredLength() > 0 &&
		len(keys.SKD) >= p.PRFKeyLength &&
		len(keys.SKAi) >= p.IntegrityKeyLength &&
		len(keys.SKAr) >= p.IntegrityKeyLength &&
		len(keys.SKEi) >= p.EncryptionKeyLength &&
		len(keys.SKEr) >= p.EncryptionKeyLength &&
		len(keys.SKPi) >= p.PRFKeyLength &&
		len(keys.SKPr) >= p.PRFKeyLength
}
