package simauth

import (
	"fmt"
	"math"
)

type TLV struct {
	Tag   int
	Value []byte
}

func EncodeTLV(tag int, value []byte) ([]byte, error) {
	tagBytes, err := encodeTag(tag)
	if err != nil {
		return nil, err
	}
	lengthBytes, err := encodeLength(len(value))
	if err != nil {
		return nil, err
	}
	out := make([]byte, 0, len(tagBytes)+len(lengthBytes)+len(value))
	out = append(out, tagBytes...)
	out = append(out, lengthBytes...)
	out = append(out, value...)
	return out, nil
}

func ParseTLVList(data []byte) ([]TLV, error) {
	var out []TLV
	for len(data) > 0 {
		data = trimTLVPadding(data)
		if len(data) == 0 {
			break
		}
		tag, rest, err := readTag(data)
		if err != nil {
			return out, err
		}
		length, rest, err := readLength(rest)
		if err != nil {
			return out, err
		}
		if length > len(rest) {
			return out, fmt.Errorf("TLV tag 0x%X length %d exceeds remaining %d", tag, length, len(rest))
		}
		out = append(out, TLV{Tag: tag, Value: append([]byte(nil), rest[:length]...)})
		data = rest[length:]
	}
	return out, nil
}

func trimTLVPadding(data []byte) []byte {
	for len(data) > 0 && (data[0] == 0x00 || data[0] == 0xFF) {
		data = data[1:]
	}
	return data
}

func FindTLV(data []byte, tag int) ([]byte, bool) {
	items, err := ParseTLVList(data)
	if err != nil {
		return nil, false
	}
	for _, item := range items {
		if item.Tag == tag {
			return item.Value, true
		}
		if isConstructed(item.Tag) {
			if v, ok := FindTLV(item.Value, tag); ok {
				return v, true
			}
		}
	}
	return nil, false
}

func encodeTag(tag int) ([]byte, error) {
	if tag <= 0 {
		return nil, fmt.Errorf("invalid TLV tag 0x%X", tag)
	}
	if tag <= 0xFF {
		return []byte{byte(tag)}, nil
	}
	var stack [4]byte
	i := len(stack)
	for tag > 0 {
		i--
		stack[i] = byte(tag)
		tag >>= 8
	}
	return append([]byte(nil), stack[i:]...), nil
}

func encodeLength(length int) ([]byte, error) {
	switch {
	case length < 0:
		return nil, fmt.Errorf("invalid TLV length %d", length)
	case length <= 0x7f:
		return []byte{byte(length)}, nil
	case length <= 0xff:
		return []byte{0x81, byte(length)}, nil
	case length <= 0xffff:
		return []byte{0x82, byte(length >> 8), byte(length)}, nil
	case length <= 0xffffff:
		return []byte{0x83, byte(length >> 16), byte(length >> 8), byte(length)}, nil
	case uint64(length) <= 0xffffffff:
		return []byte{0x84, byte(length >> 24), byte(length >> 16), byte(length >> 8), byte(length)}, nil
	default:
		return nil, fmt.Errorf("TLV length %d exceeds supported long form", length)
	}
}

func FileSizeFromFCP(fcp []byte) int {
	body := fcp
	if v, ok := FindTLV(fcp, 0x62); ok {
		body = v
	}
	if v, ok := FindTLV(body, 0x80); ok {
		return beInt(v)
	}
	if v, ok := FindTLV(body, 0x81); ok {
		return beInt(v)
	}
	return 0
}

func RecordInfoFromFCP(fcp []byte) (recordLength int, recordCount int) {
	body := fcp
	if v, ok := FindTLV(fcp, 0x62); ok {
		body = v
	}
	if v, ok := FindTLV(body, 0x82); ok && len(v) >= 5 {
		recordLength = int(v[2])<<8 | int(v[3])
		recordCount = int(v[4])
	}
	return recordLength, recordCount
}

func readTag(data []byte) (int, []byte, error) {
	if len(data) == 0 {
		return 0, nil, fmt.Errorf("empty TLV tag")
	}
	tag := int(data[0])
	data = data[1:]
	if (tag & 0x1F) == 0x1F {
		tag = tag << 8
		for {
			if len(data) == 0 {
				return 0, nil, fmt.Errorf("truncated high-tag-number TLV")
			}
			b := data[0]
			data = data[1:]
			tag |= int(b)
			if b&0x80 == 0 {
				break
			}
			tag <<= 8
		}
	}
	return tag, data, nil
}

func readLength(data []byte) (int, []byte, error) {
	if len(data) == 0 {
		return 0, nil, fmt.Errorf("empty TLV length")
	}
	b := data[0]
	data = data[1:]
	if b&0x80 == 0 {
		return int(b), data, nil
	}
	n := int(b & 0x7F)
	if n == 0 {
		return 0, nil, fmt.Errorf("unsupported indefinite TLV length form 0x%02X", b)
	}
	if n > 4 {
		return 0, nil, fmt.Errorf("unsupported TLV length form 0x%02X", b)
	}
	if len(data) < n {
		return 0, nil, fmt.Errorf("truncated TLV long length")
	}
	length := 0
	for _, part := range data[:n] {
		if length > (math.MaxInt-int(part))/256 {
			return 0, nil, fmt.Errorf("TLV length overflows int")
		}
		length = (length << 8) | int(part)
	}
	return length, data[n:], nil
}

func isConstructed(tag int) bool {
	if tag <= 0xFF {
		return tag&0x20 != 0
	}
	for tag > 0xFF {
		tag >>= 8
	}
	return tag&0x20 != 0
}

func beInt(v []byte) int {
	out := 0
	for _, b := range v {
		out = (out << 8) | int(b)
	}
	return out
}
