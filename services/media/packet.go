package main

import (
	"encoding/binary"
	"errors"
)

const headerSize = 16

// Packet is an Opus frame, not raw PCM. Time is a monotonic microsecond timestamp.
type Packet struct {
	Direction   uint8
	DurationMS  uint16
	Sequence    uint32
	TimestampUS uint64
	Opus        []byte
}

func decodePacket(b []byte) (Packet, error) {
	if len(b) < headerSize+1 || len(b) > headerSize+1024 || b[0] != 1 {
		return Packet{}, errors.New("invalid media packet")
	}
	p := Packet{Direction: b[1], DurationMS: binary.BigEndian.Uint16(b[2:4]), Sequence: binary.BigEndian.Uint32(b[4:8]), TimestampUS: binary.BigEndian.Uint64(b[8:16]), Opus: append([]byte(nil), b[16:]...)}
	if p.Direction > 1 || (p.DurationMS != 10 && p.DurationMS != 20 && p.DurationMS != 40 && p.DurationMS != 60) {
		return Packet{}, errors.New("unsupported direction or duration")
	}
	duration, err := opusDurationMS(p.Opus)
	if err != nil || duration != p.DurationMS {
		return Packet{}, errors.New("Opus duration mismatch")
	}
	return p, nil
}
func encodePacket(p Packet) []byte {
	b := make([]byte, headerSize+len(p.Opus))
	b[0] = 1
	b[1] = p.Direction
	binary.BigEndian.PutUint16(b[2:4], p.DurationMS)
	binary.BigEndian.PutUint32(b[4:8], p.Sequence)
	binary.BigEndian.PutUint64(b[8:16], p.TimestampUS)
	copy(b[16:], p.Opus)
	return b
}

// opusDurationMS reads the frame count and TOC per RFC 6716 section 3.1.
// This voice bridge accepts 10/20/40/60ms packets; short music frames are rejected.
func opusDurationMS(b []byte) (uint16, error) {
	if len(b) == 0 {
		return 0, errors.New("empty Opus")
	}
	toc := b[0]
	var samples int
	if toc&0x80 != 0 {
		samples = 120 << ((toc >> 3) & 3)
	} else if toc&0x60 == 0x60 {
		samples = 480
		if toc&8 != 0 {
			samples = 960
		}
	} else {
		samples = 480 << ((toc >> 3) & 3)
		if samples == 3840 {
			samples = 2880
		}
	}
	count := 1
	switch toc & 3 {
	case 1, 2:
		count = 2
	case 3:
		if len(b) < 2 {
			return 0, errors.New("truncated Opus")
		}
		count = int(b[1] & 0x3f)
	}
	total := samples * count
	if total != 480 && total != 960 && total != 1920 && total != 2880 {
		return 0, errors.New("unsupported Opus packet duration")
	}
	return uint16(total / 48), nil
}
