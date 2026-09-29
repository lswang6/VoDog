package swu

import (
	"net"
	"strings"
	"time"
)

const defaultMOBIKEPort uint16 = 4500

type MOBIKENATEndpoint struct {
	LocalIP     net.IP
	RemoteIP    net.IP
	LocalPort   uint16
	RemotePort  uint16
	NATDetected bool
}

type MOBIKENATStateConfig struct {
	MOBIKESupported bool
	LocalIP         net.IP
	RemoteIP        net.IP
	LocalPort       uint16
	RemotePort      uint16
	NATDetected     bool
	UpdatedAt       time.Time
}

type MOBIKENATObservation struct {
	DeviceID         string
	TraceID          string
	LocalIP          net.IP
	RemoteIP         net.IP
	LocalPort        uint16
	RemotePort       uint16
	NATDetected      bool
	NATDetectedKnown bool
	At               time.Time
}

type MOBIKENATChange struct {
	Changed              bool
	RequiresMOBIKEUpdate bool
	LocalAddressChanged  bool
	RemoteAddressChanged bool
	PortChanged          bool
	NATChanged           bool
	Previous             MOBIKENATEndpoint
	Current              MOBIKENATEndpoint
	Request              MOBIKERequest
	Reason               string
	At                   time.Time
}

type MOBIKENATState struct {
	mobikeSupported bool
	current         MOBIKENATEndpoint
	updatedAt       time.Time
}

func NewMOBIKENATState(cfg MOBIKENATStateConfig) *MOBIKENATState {
	return &MOBIKENATState{
		mobikeSupported: cfg.MOBIKESupported,
		current: normalizedMOBIKENATEndpoint(MOBIKENATEndpoint{
			LocalIP:     cfg.LocalIP,
			RemoteIP:    cfg.RemoteIP,
			LocalPort:   cfg.LocalPort,
			RemotePort:  cfg.RemotePort,
			NATDetected: cfg.NATDetected,
		}),
		updatedAt: cfg.UpdatedAt,
	}
}

func (s *MOBIKENATState) Observe(obs MOBIKENATObservation) MOBIKENATChange {
	at := obs.At
	if at.IsZero() {
		at = time.Now()
	}
	if s == nil {
		next := normalizedMOBIKENATEndpoint(MOBIKENATEndpoint{
			LocalIP:     obs.LocalIP,
			RemoteIP:    obs.RemoteIP,
			LocalPort:   obs.LocalPort,
			RemotePort:  obs.RemotePort,
			NATDetected: obs.NATDetected,
		})
		return MOBIKENATChange{
			Changed: true,
			Current: next,
			Request: MOBIKERequest{
				DeviceID: obs.DeviceID,
				TraceID:  obs.TraceID,
				NewIP:    ipString(next.LocalIP),
				At:       at,
			},
			Reason: "state missing",
			At:     at,
		}
	}
	natDetected := s.current.NATDetected
	if obs.NATDetectedKnown {
		natDetected = obs.NATDetected
	}
	next := normalizedMOBIKENATEndpoint(MOBIKENATEndpoint{
		LocalIP:     firstMOBIKEIP(obs.LocalIP, s.current.LocalIP),
		RemoteIP:    firstMOBIKEIP(obs.RemoteIP, s.current.RemoteIP),
		LocalPort:   firstMOBIKEPort(obs.LocalPort, s.current.LocalPort),
		RemotePort:  firstMOBIKEPort(obs.RemotePort, s.current.RemotePort),
		NATDetected: natDetected,
	})
	previous := s.current
	localChanged := !ipEqual(previous.LocalIP, next.LocalIP)
	remoteChanged := !ipEqual(previous.RemoteIP, next.RemoteIP)
	portChanged := previous.LocalPort != next.LocalPort || previous.RemotePort != next.RemotePort
	natChanged := previous.NATDetected != next.NATDetected
	changed := localChanged || remoteChanged || portChanged || natChanged
	change := MOBIKENATChange{
		Changed:              changed,
		RequiresMOBIKEUpdate: changed && s.mobikeSupported,
		LocalAddressChanged:  localChanged,
		RemoteAddressChanged: remoteChanged,
		PortChanged:          portChanged,
		NATChanged:           natChanged,
		Previous:             cloneMOBIKENATEndpoint(previous),
		Current:              cloneMOBIKENATEndpoint(next),
		Request: MOBIKERequest{
			DeviceID: obs.DeviceID,
			TraceID:  obs.TraceID,
			OldIP:    ipString(previous.LocalIP),
			NewIP:    ipString(next.LocalIP),
			At:       at,
		},
		Reason: mobikeNATChangeReason(localChanged, remoteChanged, portChanged, natChanged),
		At:     at,
	}
	if changed {
		s.current = next
		s.updatedAt = at
	}
	return change
}

func (s *MOBIKENATState) Snapshot() (MOBIKENATEndpoint, time.Time) {
	if s == nil {
		return MOBIKENATEndpoint{}, time.Time{}
	}
	return cloneMOBIKENATEndpoint(s.current), s.updatedAt
}

func normalizedMOBIKENATEndpoint(in MOBIKENATEndpoint) MOBIKENATEndpoint {
	out := MOBIKENATEndpoint{
		LocalIP:     normalizedMOBIKEIP(in.LocalIP),
		RemoteIP:    normalizedMOBIKEIP(in.RemoteIP),
		LocalPort:   in.LocalPort,
		RemotePort:  in.RemotePort,
		NATDetected: in.NATDetected,
	}
	if out.LocalPort == 0 {
		out.LocalPort = defaultMOBIKEPort
	}
	if out.RemotePort == 0 {
		out.RemotePort = defaultMOBIKEPort
	}
	return out
}

func cloneMOBIKENATEndpoint(in MOBIKENATEndpoint) MOBIKENATEndpoint {
	return MOBIKENATEndpoint{
		LocalIP:     append(net.IP(nil), in.LocalIP...),
		RemoteIP:    append(net.IP(nil), in.RemoteIP...),
		LocalPort:   in.LocalPort,
		RemotePort:  in.RemotePort,
		NATDetected: in.NATDetected,
	}
}

func firstMOBIKEIP(items ...net.IP) net.IP {
	for _, item := range items {
		if ip := normalizedMOBIKEIP(item); ip != nil {
			return ip
		}
	}
	return nil
}

func firstMOBIKEPort(items ...uint16) uint16 {
	for _, item := range items {
		if item != 0 {
			return item
		}
	}
	return defaultMOBIKEPort
}

func ipEqual(a, b net.IP) bool {
	aa := normalizedMOBIKEIP(a)
	bb := normalizedMOBIKEIP(b)
	if aa == nil || bb == nil {
		return aa == nil && bb == nil
	}
	return aa.Equal(bb)
}

func ipString(ip net.IP) string {
	if normalized := normalizedMOBIKEIP(ip); normalized != nil {
		return normalized.String()
	}
	return ""
}

func mobikeNATChangeReason(localChanged, remoteChanged, portChanged, natChanged bool) string {
	var parts []string
	if localChanged {
		parts = append(parts, "local address changed")
	}
	if remoteChanged {
		parts = append(parts, "remote address changed")
	}
	if portChanged {
		parts = append(parts, "udp port changed")
	}
	if natChanged {
		parts = append(parts, "nat status changed")
	}
	if len(parts) == 0 {
		return "unchanged"
	}
	return strings.Join(parts, ", ")
}
