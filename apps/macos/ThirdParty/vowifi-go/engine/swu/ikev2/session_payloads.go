package ikev2

import (
	"bytes"
	"encoding/binary"
	"errors"
	"fmt"
	"net"
)

const (
	IDIPv4Addr   uint8 = 1
	IDFQDN       uint8 = 2
	IDRFC822Addr uint8 = 3
	IDIPv6Addr   uint8 = 5
	IDKeyID      uint8 = 11
)

const (
	CFGRequest uint8 = 1
	CFGReply   uint8 = 2
	CFGSet     uint8 = 3
	CFGAck     uint8 = 4
)

const (
	ConfigInternalIPv4Address   uint16 = 1
	ConfigInternalIPv4DNS       uint16 = 3
	ConfigInternalAddressExpiry uint16 = 5
	ConfigInternalIPv6Address   uint16 = 8
	ConfigInternalIPv6DNS       uint16 = 10
	ConfigInternalIPv4Subnet    uint16 = 13
	ConfigSupportedAttributes   uint16 = 14
	ConfigInternalIPv6Subnet    uint16 = 15
	ConfigPCSCFIPv4Address      uint16 = 20
	ConfigPCSCFIPv6Address      uint16 = 21
)

const (
	TSIPv4AddressRange uint8 = 7
	TSIPv6AddressRange uint8 = 8
)

var (
	ErrInvalidIdentity        = errors.New("invalid ikev2 identity payload")
	ErrInvalidConfiguration   = errors.New("invalid ikev2 configuration payload")
	ErrInvalidTrafficSelector = errors.New("invalid ikev2 traffic selector payload")
)

type Identity struct {
	Type uint8
	Data []byte
}

func (id Identity) MarshalBinary() ([]byte, error) {
	if id.Type == 0 {
		return nil, fmt.Errorf("%w: type is zero", ErrInvalidIdentity)
	}
	out := make([]byte, 4, 4+len(id.Data))
	out[0] = id.Type
	out = append(out, id.Data...)
	return out, nil
}

func ParseIdentity(data []byte) (Identity, error) {
	if len(data) < 4 {
		return Identity{}, ErrInvalidIdentity
	}
	if data[0] == 0 {
		return Identity{}, fmt.Errorf("%w: type is zero", ErrInvalidIdentity)
	}
	return Identity{Type: data[0], Data: append([]byte(nil), data[4:]...)}, nil
}

func IdentityPayload(payloadType uint8, id Identity) (Payload, error) {
	if payloadType != PayloadIDi && payloadType != PayloadIDr {
		return Payload{}, fmt.Errorf("%w: payload type %d", ErrInvalidIdentity, payloadType)
	}
	body, err := id.MarshalBinary()
	if err != nil {
		return Payload{}, err
	}
	return Payload{Type: payloadType, Body: body}, nil
}

type ConfigurationAttribute struct {
	Type  uint16
	Value []byte
}

type Configuration struct {
	Type       uint8
	Attributes []ConfigurationAttribute
}

func (c Configuration) MarshalBinary() ([]byte, error) {
	if c.Type == 0 {
		return nil, fmt.Errorf("%w: type is zero", ErrInvalidConfiguration)
	}
	out := []byte{c.Type, 0, 0, 0}
	for _, attr := range c.Attributes {
		if len(attr.Value) > 0xffff {
			return nil, fmt.Errorf("%w: attribute too long", ErrInvalidConfiguration)
		}
		var hdr [4]byte
		binary.BigEndian.PutUint16(hdr[0:2], attr.Type)
		binary.BigEndian.PutUint16(hdr[2:4], uint16(len(attr.Value)))
		out = append(out, hdr[:]...)
		out = append(out, attr.Value...)
	}
	return out, nil
}

func ParseConfiguration(data []byte) (Configuration, error) {
	if len(data) < 4 {
		return Configuration{}, ErrInvalidConfiguration
	}
	cfg := Configuration{Type: data[0]}
	if cfg.Type == 0 {
		return Configuration{}, fmt.Errorf("%w: type is zero", ErrInvalidConfiguration)
	}
	rest := data[4:]
	for len(rest) > 0 {
		if len(rest) < 4 {
			return Configuration{}, ErrInvalidConfiguration
		}
		length := int(binary.BigEndian.Uint16(rest[2:4]))
		if len(rest) < 4+length {
			return Configuration{}, ErrInvalidConfiguration
		}
		cfg.Attributes = append(cfg.Attributes, ConfigurationAttribute{
			Type:  binary.BigEndian.Uint16(rest[0:2]),
			Value: append([]byte(nil), rest[4:4+length]...),
		})
		rest = rest[4+length:]
	}
	return cfg, nil
}

func ConfigurationPayload(c Configuration) (Payload, error) {
	body, err := c.MarshalBinary()
	if err != nil {
		return Payload{}, err
	}
	return Payload{Type: PayloadCP, Body: body}, nil
}

func SWuConfigurationRequest() Configuration {
	return Configuration{Type: CFGRequest, Attributes: []ConfigurationAttribute{
		{Type: ConfigInternalIPv4Address},
		{Type: ConfigInternalIPv4DNS},
		{Type: ConfigInternalIPv6Address},
		{Type: ConfigInternalIPv6DNS},
		{Type: ConfigPCSCFIPv4Address},
		{Type: ConfigPCSCFIPv6Address},
	}}
}

type TrafficSelector struct {
	Type       uint8
	IPProtocol uint8
	StartPort  uint16
	EndPort    uint16
	StartAddr  net.IP
	EndAddr    net.IP
}

type TrafficSelectors struct {
	Selectors []TrafficSelector
}

type trafficSelectorRange struct {
	Type       uint8
	IPProtocol uint8
	StartPort  uint16
	EndPort    uint16
	StartAddr  []byte
	EndAddr    []byte
}

func (ts TrafficSelectors) MarshalBinary() ([]byte, error) {
	if len(ts.Selectors) == 0 || len(ts.Selectors) > 0xff {
		return nil, fmt.Errorf("%w: selector count %d", ErrInvalidTrafficSelector, len(ts.Selectors))
	}
	out := []byte{byte(len(ts.Selectors)), 0, 0, 0}
	for _, selector := range ts.Selectors {
		body, err := selector.MarshalBinary()
		if err != nil {
			return nil, err
		}
		out = append(out, body...)
	}
	return out, nil
}

func ParseTrafficSelectors(data []byte) (TrafficSelectors, error) {
	if len(data) < 4 {
		return TrafficSelectors{}, ErrInvalidTrafficSelector
	}
	count := int(data[0])
	rest := data[4:]
	var out TrafficSelectors
	for len(rest) > 0 {
		selector, length, err := parseTrafficSelector(rest)
		if err != nil {
			return TrafficSelectors{}, err
		}
		out.Selectors = append(out.Selectors, selector)
		rest = rest[length:]
	}
	if len(out.Selectors) != count {
		return TrafficSelectors{}, fmt.Errorf("%w: selector count %d != %d", ErrInvalidTrafficSelector, len(out.Selectors), count)
	}
	return out, nil
}

func TrafficSelectorsPayload(payloadType uint8, ts TrafficSelectors) (Payload, error) {
	if payloadType != PayloadTSi && payloadType != PayloadTSr {
		return Payload{}, fmt.Errorf("%w: payload type %d", ErrInvalidTrafficSelector, payloadType)
	}
	body, err := ts.MarshalBinary()
	if err != nil {
		return Payload{}, err
	}
	return Payload{Type: payloadType, Body: body}, nil
}

func IPv4AnyTrafficSelectors() TrafficSelectors {
	return TrafficSelectors{Selectors: []TrafficSelector{{
		Type:      TSIPv4AddressRange,
		StartPort: 0,
		EndPort:   65535,
		StartAddr: net.IPv4(0, 0, 0, 0),
		EndAddr:   net.IPv4(255, 255, 255, 255),
	}}}
}

func IPv6AnyTrafficSelectors() TrafficSelectors {
	return TrafficSelectors{Selectors: []TrafficSelector{{
		Type:      TSIPv6AddressRange,
		StartPort: 0,
		EndPort:   65535,
		StartAddr: net.ParseIP("::"),
		EndAddr:   net.ParseIP("ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff"),
	}}}
}

// DualStackAnyTrafficSelectors matches SWuConfigurationRequest, which asks the
// ePDG for both IPv4 and IPv6 addresses and DNS servers.
func DualStackAnyTrafficSelectors() TrafficSelectors {
	v4 := IPv4AnyTrafficSelectors()
	v6 := IPv6AnyTrafficSelectors()
	return TrafficSelectors{Selectors: append(v4.Selectors, v6.Selectors...)}
}

func ValidateTrafficSelectorNarrowing(offered, selected TrafficSelectors) error {
	if len(offered.Selectors) == 0 {
		return fmt.Errorf("%w: offered selector count 0", ErrInvalidTrafficSelector)
	}
	if len(selected.Selectors) == 0 {
		return fmt.Errorf("%w: selected selector count 0", ErrInvalidTrafficSelector)
	}
	offeredRanges := make([]trafficSelectorRange, 0, len(offered.Selectors))
	for _, selector := range offered.Selectors {
		normalized, err := normalizeTrafficSelectorRange(selector)
		if err != nil {
			return err
		}
		offeredRanges = append(offeredRanges, normalized)
	}
	for i, selector := range selected.Selectors {
		normalized, err := normalizeTrafficSelectorRange(selector)
		if err != nil {
			return err
		}
		if trafficSelectorCoveredByAny(offeredRanges, normalized) {
			continue
		}
		return fmt.Errorf("%w: selected selector %d is outside offered selectors", ErrInvalidTrafficSelector, i)
	}
	return nil
}

func (ts TrafficSelector) MarshalBinary() ([]byte, error) {
	start, end, err := normalizeSelectorAddresses(ts.Type, ts.StartAddr, ts.EndAddr)
	if err != nil {
		return nil, err
	}
	length := 8 + len(start) + len(end)
	if length > 0xffff {
		return nil, fmt.Errorf("%w: selector too long", ErrInvalidTrafficSelector)
	}
	out := make([]byte, 8, length)
	out[0] = ts.Type
	out[1] = ts.IPProtocol
	binary.BigEndian.PutUint16(out[2:4], uint16(length))
	binary.BigEndian.PutUint16(out[4:6], ts.StartPort)
	binary.BigEndian.PutUint16(out[6:8], ts.EndPort)
	out = append(out, start...)
	out = append(out, end...)
	return out, nil
}

func parseTrafficSelector(data []byte) (TrafficSelector, int, error) {
	if len(data) < 8 {
		return TrafficSelector{}, 0, ErrInvalidTrafficSelector
	}
	length := int(binary.BigEndian.Uint16(data[2:4]))
	if length < 16 || length > len(data) {
		return TrafficSelector{}, 0, fmt.Errorf("%w: selector length %d", ErrInvalidTrafficSelector, length)
	}
	addrLen := 0
	switch data[0] {
	case TSIPv4AddressRange:
		addrLen = 4
	case TSIPv6AddressRange:
		addrLen = 16
	default:
		return TrafficSelector{}, 0, fmt.Errorf("%w: selector type %d", ErrInvalidTrafficSelector, data[0])
	}
	if length != 8+addrLen*2 {
		return TrafficSelector{}, 0, fmt.Errorf("%w: selector length %d for type %d", ErrInvalidTrafficSelector, length, data[0])
	}
	return TrafficSelector{
		Type:       data[0],
		IPProtocol: data[1],
		StartPort:  binary.BigEndian.Uint16(data[4:6]),
		EndPort:    binary.BigEndian.Uint16(data[6:8]),
		StartAddr:  append(net.IP(nil), data[8:8+addrLen]...),
		EndAddr:    append(net.IP(nil), data[8+addrLen:length]...),
	}, length, nil
}

func normalizeSelectorAddresses(selectorType uint8, start, end net.IP) ([]byte, []byte, error) {
	switch selectorType {
	case TSIPv4AddressRange:
		start4, end4 := start.To4(), end.To4()
		if start4 == nil || end4 == nil {
			return nil, nil, fmt.Errorf("%w: invalid IPv4 selector address", ErrInvalidTrafficSelector)
		}
		return append([]byte(nil), start4...), append([]byte(nil), end4...), nil
	case TSIPv6AddressRange:
		start16, end16 := start.To16(), end.To16()
		if start16 == nil || end16 == nil || start.To4() != nil || end.To4() != nil {
			return nil, nil, fmt.Errorf("%w: invalid IPv6 selector address", ErrInvalidTrafficSelector)
		}
		return append([]byte(nil), start16...), append([]byte(nil), end16...), nil
	default:
		return nil, nil, fmt.Errorf("%w: selector type %d", ErrInvalidTrafficSelector, selectorType)
	}
}

func trafficSelectorsOrIPv4Any(ts TrafficSelectors) TrafficSelectors {
	if len(ts.Selectors) == 0 {
		return DualStackAnyTrafficSelectors()
	}
	return ts
}

func normalizeTrafficSelectorRange(selector TrafficSelector) (trafficSelectorRange, error) {
	start, end, err := normalizeSelectorAddresses(selector.Type, selector.StartAddr, selector.EndAddr)
	if err != nil {
		return trafficSelectorRange{}, err
	}
	if selector.StartPort > selector.EndPort {
		return trafficSelectorRange{}, fmt.Errorf("%w: selector port range %d-%d", ErrInvalidTrafficSelector, selector.StartPort, selector.EndPort)
	}
	if bytes.Compare(start, end) > 0 {
		return trafficSelectorRange{}, fmt.Errorf("%w: selector address range %s-%s", ErrInvalidTrafficSelector, selector.StartAddr, selector.EndAddr)
	}
	return trafficSelectorRange{
		Type:       selector.Type,
		IPProtocol: selector.IPProtocol,
		StartPort:  selector.StartPort,
		EndPort:    selector.EndPort,
		StartAddr:  start,
		EndAddr:    end,
	}, nil
}

func trafficSelectorCoveredByAny(offered []trafficSelectorRange, selected trafficSelectorRange) bool {
	for _, candidate := range offered {
		if trafficSelectorCovers(candidate, selected) {
			return true
		}
	}
	return false
}

func trafficSelectorCovers(offered, selected trafficSelectorRange) bool {
	if offered.Type != selected.Type {
		return false
	}
	if offered.IPProtocol != 0 && offered.IPProtocol != selected.IPProtocol {
		return false
	}
	if selected.IPProtocol == 0 && offered.IPProtocol != 0 {
		return false
	}
	if offered.StartPort > selected.StartPort || selected.EndPort > offered.EndPort {
		return false
	}
	return bytes.Compare(offered.StartAddr, selected.StartAddr) <= 0 &&
		bytes.Compare(selected.EndAddr, offered.EndAddr) <= 0
}
