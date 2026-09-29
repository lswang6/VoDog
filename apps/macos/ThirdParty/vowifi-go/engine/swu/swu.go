package swu

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"
)

const (
	DataplaneModeDisabled  = "disabled"
	DataplaneModeUserspace = "userspace"
	DataplaneModeKernel    = "kernel"
	EAPMethodAKA           = "aka"
	EAPMethodAKAPrime      = "aka-prime"
)

var (
	ErrInvalidTunnelConfig = errors.New("invalid swu tunnel config")
	ErrTunnelNotReady      = errors.New("swu tunnel not ready")
)

type ProxyConfig struct {
	ID       string
	URL      string
	Address  string
	Addr     string
	Username string
	Password string
	Country  string
	Enabled  bool
}

type IMSIdentity struct {
	IMPI   string
	IMPU   string
	Domain string
}

type TunnelConfig struct {
	DeviceID       string
	TraceID        string
	Mode           string
	EPDGAddress    string
	EPDGSource     string
	LocalInterface string
	OuterLocalIP   string
	InnerLocalIP   string
	RemoteInnerIP  string
	IMSI           string
	MCC            string
	MNC            string
	EAPMethod      string
	IMEI           string
	APN            string
	Identity       IMSIdentity
	Proxy          *ProxyConfig
	StartedAt      time.Time
}

func (c TunnelConfig) NormalizedEAPMethod() string {
	method := strings.ToLower(strings.TrimSpace(c.EAPMethod))
	method = strings.ReplaceAll(method, "_", "-")
	switch method {
	case "", EAPMethodAKA:
		return EAPMethodAKA
	case EAPMethodAKAPrime, "aka'", "akaprime":
		return EAPMethodAKAPrime
	default:
		return method
	}
}

func (c TunnelConfig) NormalizedMode() string {
	mode := strings.ToLower(strings.TrimSpace(c.Mode))
	if mode == "" {
		return DataplaneModeUserspace
	}
	return mode
}

func (c TunnelConfig) Validate() error {
	if strings.TrimSpace(c.DeviceID) == "" {
		return fmt.Errorf("%w: device_id is empty", ErrInvalidTunnelConfig)
	}
	switch mode := c.NormalizedMode(); mode {
	case DataplaneModeDisabled:
		return nil
	case DataplaneModeUserspace, DataplaneModeKernel:
	default:
		return fmt.Errorf("%w: unsupported dataplane mode %q", ErrInvalidTunnelConfig, mode)
	}
	if strings.TrimSpace(c.EPDGAddress) == "" && (strings.TrimSpace(c.MCC) == "" || strings.TrimSpace(c.MNC) == "") {
		return fmt.Errorf("%w: ePDG address or MCC/MNC is required", ErrInvalidTunnelConfig)
	}
	if method := c.NormalizedEAPMethod(); method != EAPMethodAKA && method != EAPMethodAKAPrime {
		return fmt.Errorf("%w: unsupported EAP method %q", ErrInvalidTunnelConfig, c.EAPMethod)
	}
	if strings.TrimSpace(c.IMSI) == "" && strings.TrimSpace(c.Identity.IMPI) == "" {
		return fmt.Errorf("%w: IMSI or IMPI is required", ErrInvalidTunnelConfig)
	}
	return nil
}

type TunnelResult struct {
	Ready             bool
	Mode              string
	EPDGAddress       string
	LocalInnerIP      string
	RemoteInnerIP     string
	DNSServers        []string
	PCSCFServers      []string
	IKEEstablished    bool
	IPsecEstablished  bool
	MOBIKESupported   bool
	ChildSAIdentifier string
	Reason            string
	EstablishedAt     time.Time
}

func (r TunnelResult) IsReady() bool {
	return r.Ready && r.IKEEstablished && r.IPsecEstablished
}

func cloneTunnelResult(r TunnelResult) TunnelResult {
	r.DNSServers = append([]string(nil), r.DNSServers...)
	r.PCSCFServers = append([]string(nil), r.PCSCFServers...)
	return r
}

func isZeroTunnelResult(r TunnelResult) bool {
	return !r.Ready &&
		strings.TrimSpace(r.Mode) == "" &&
		strings.TrimSpace(r.EPDGAddress) == "" &&
		strings.TrimSpace(r.LocalInnerIP) == "" &&
		strings.TrimSpace(r.RemoteInnerIP) == "" &&
		len(r.DNSServers) == 0 &&
		len(r.PCSCFServers) == 0 &&
		!r.IKEEstablished &&
		!r.IPsecEstablished &&
		!r.MOBIKESupported &&
		strings.TrimSpace(r.ChildSAIdentifier) == "" &&
		strings.TrimSpace(r.Reason) == "" &&
		r.EstablishedAt.IsZero()
}

type MOBIKERequest struct {
	DeviceID string
	TraceID  string
	OldIP    string
	NewIP    string
	At       time.Time
}

type MOBIKEResult struct {
	Rekeyed          bool
	OuterLocalIP     string
	LocalInnerIP     string
	RemoteInnerIP    string
	DNSServers       []string
	IKEEstablished   bool
	IPsecEstablished bool
	Reason           string
	UpdatedAt        time.Time
}

type TunnelSession interface {
	Result() TunnelResult
	MOBIKE(context.Context, MOBIKERequest) (MOBIKEResult, error)
	Close(context.Context) error
}

type MOBIKENATObserver interface {
	ObserveMOBIKENAT(context.Context, MOBIKENATObservation) (MOBIKENATChange, MOBIKEResult, error)
	MOBIKENATSnapshot() (MOBIKENATEndpoint, time.Time)
}

type IKELivenessController interface {
	AdvanceIKELiveness(context.Context, time.Time) (IKELivenessDecision, error)
	RecordIKELivenessInbound(time.Time)
	RecordIKELivenessOutbound(time.Time)
	RecordIKELivenessResult(time.Time, bool)
	IKELivenessSnapshot() IKELivenessSnapshot
}

type ChildSARekeyController interface {
	RekeyChildSA(context.Context) (TunnelResult, error)
}

type TunnelManager interface {
	EstablishTunnel(context.Context, TunnelConfig) (TunnelSession, error)
}
