package esp

import (
	"bytes"
	"encoding/binary"
	"errors"
	"testing"

	"github.com/boa-z/vowifi-go/engine/swu/ikev2"
)

func TestSealOpenRoundTrip(t *testing.T) {
	sa, err := NewSA(SA{
		SPI:           0xdeadbeef,
		EncryptionKey: bytes.Repeat([]byte{0x11}, 16),
		IntegrityKey:  bytes.Repeat([]byte{0x22}, 32),
		Integrity:     IntegrityHMACSHA2_256_128,
	})
	if err != nil {
		t.Fatalf("NewSA() error = %v", err)
	}
	payload := []byte{0x45, 0x00, 0x00, 0x14, 0xaa, 0xbb, 0xcc}
	packet, err := sa.Seal(NextHeaderIPv4, payload, SealOptions{
		Sequence: 7,
		IV:       bytes.Repeat([]byte{0xa5}, 16),
	})
	if err != nil {
		t.Fatalf("Seal() error = %v", err)
	}
	if binary.BigEndian.Uint32(packet[0:4]) != 0xdeadbeef || binary.BigEndian.Uint32(packet[4:8]) != 7 {
		t.Fatalf("packet header=%x", packet[:8])
	}
	if len(packet) != 8+16+16+16 {
		t.Fatalf("packet len=%d", len(packet))
	}
	openSA, err := NewSA(SA{
		SPI:           0xdeadbeef,
		EncryptionKey: bytes.Repeat([]byte{0x11}, 16),
		IntegrityKey:  bytes.Repeat([]byte{0x22}, 32),
		Integrity:     IntegrityHMACSHA2_256_128,
	})
	if err != nil {
		t.Fatalf("NewSA(open) error = %v", err)
	}
	out, err := openSA.Open(packet)
	if err != nil {
		t.Fatalf("Open() error = %v", err)
	}
	if out.SPI != 0xdeadbeef || out.Sequence != 7 || out.NextHeader != NextHeaderIPv4 || !bytes.Equal(out.Payload, payload) {
		t.Fatalf("open=%+v payload=%x", out, out.Payload)
	}
}

func TestOpenRejectsTamperedICV(t *testing.T) {
	sa, err := NewSA(SA{
		SPI:           0x01020304,
		EncryptionKey: bytes.Repeat([]byte{0x33}, 16),
		IntegrityKey:  bytes.Repeat([]byte{0x44}, 32),
		Integrity:     IntegrityHMACSHA2_256_128,
	})
	if err != nil {
		t.Fatalf("NewSA() error = %v", err)
	}
	packet, err := sa.Seal(NextHeaderIPv6, []byte{0x60, 0x00, 0x00}, SealOptions{Sequence: 1, IV: bytes.Repeat([]byte{0x55}, 16)})
	if err != nil {
		t.Fatalf("Seal() error = %v", err)
	}
	packet[len(packet)-1] ^= 0xff
	_, err = sa.Open(packet)
	if !errors.Is(err, ErrInvalidPacket) {
		t.Fatalf("Open() err=%v, want ErrInvalidPacket", err)
	}
}

func TestAESGCMSealOpenRoundTrip(t *testing.T) {
	key := append(bytes.Repeat([]byte{0x11}, 16), 0xa1, 0xa2, 0xa3, 0xa4)
	sa, err := NewSA(SA{
		SPI:           0x11223344,
		Encryption:    EncryptionAESGCM_16,
		EncryptionKey: key,
	})
	if err != nil {
		t.Fatalf("NewSA() error = %v", err)
	}
	payload := []byte{0x45, 0x00, 0x00, 0x14, 0xaa, 0xbb, 0xcc}
	packet, err := sa.Seal(NextHeaderIPv4, payload, SealOptions{
		Sequence: 9,
		IV:       []byte{0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08},
	})
	if err != nil {
		t.Fatalf("Seal() error = %v", err)
	}
	if binary.BigEndian.Uint32(packet[0:4]) != 0x11223344 || binary.BigEndian.Uint32(packet[4:8]) != 9 {
		t.Fatalf("packet header=%x", packet[:8])
	}
	if len(packet) != 8+8+12+16 {
		t.Fatalf("packet len=%d", len(packet))
	}
	if !bytes.Equal(packet[8:16], []byte{0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08}) {
		t.Fatalf("explicit iv=%x", packet[8:16])
	}
	openSA, err := NewSA(SA{
		SPI:           0x11223344,
		Encryption:    EncryptionAESGCM_16,
		EncryptionKey: key,
	})
	if err != nil {
		t.Fatalf("NewSA(open) error = %v", err)
	}
	out, err := openSA.Open(packet)
	if err != nil {
		t.Fatalf("Open() error = %v", err)
	}
	if out.SPI != 0x11223344 || out.Sequence != 9 || out.NextHeader != NextHeaderIPv4 || !bytes.Equal(out.Payload, payload) {
		t.Fatalf("open=%+v payload=%x", out, out.Payload)
	}
}

func TestAESGCMOpenRejectsTamperedTag(t *testing.T) {
	key := append(bytes.Repeat([]byte{0x21}, 16), 0xb1, 0xb2, 0xb3, 0xb4)
	sa, err := NewSA(SA{
		SPI:           0x55667788,
		Encryption:    EncryptionAESGCM_16,
		EncryptionKey: key,
	})
	if err != nil {
		t.Fatalf("NewSA() error = %v", err)
	}
	packet, err := sa.Seal(NextHeaderIPv6, []byte{0x60, 0x00, 0x00}, SealOptions{
		Sequence: 3,
		IV:       bytes.Repeat([]byte{0x45}, 8),
	})
	if err != nil {
		t.Fatalf("Seal() error = %v", err)
	}
	packet[len(packet)-1] ^= 0xff
	if _, err := sa.Open(packet); !errors.Is(err, ErrInvalidPacket) {
		t.Fatalf("Open(tampered) err=%v, want ErrInvalidPacket", err)
	}
}

func TestAESGCMSealDerivesDefaultIVFromSequence(t *testing.T) {
	key := append(bytes.Repeat([]byte{0x31}, 16), 0xc1, 0xc2, 0xc3, 0xc4)
	sa, err := NewSA(SA{
		SPI:           0xaabbccdd,
		Encryption:    EncryptionAESGCM_16,
		EncryptionKey: key,
	})
	if err != nil {
		t.Fatalf("NewSA() error = %v", err)
	}
	packet, err := sa.Seal(NextHeaderIPv4, []byte{0x45, 0x00}, SealOptions{Sequence: 0x01020304})
	if err != nil {
		t.Fatalf("Seal() error = %v", err)
	}
	if got, want := packet[8:16], []byte{0x00, 0x00, 0x00, 0x00, 0x01, 0x02, 0x03, 0x04}; !bytes.Equal(got, want) {
		t.Fatalf("explicit iv=%x, want %x", got, want)
	}
}

func TestNewSAFromChildAESGCMUsesCombinedModeKeys(t *testing.T) {
	aOutboundKey := append(bytes.Repeat([]byte{0x10}, 16), 0x01, 0x02, 0x03, 0x04)
	aInboundKey := append(bytes.Repeat([]byte{0x30}, 16), 0x05, 0x06, 0x07, 0x08)
	child := ikev2.ChildSAResult{
		LocalSPI:  []byte{0xca, 0xfe, 0xba, 0xbe},
		RemoteSPI: []byte{0xde, 0xad, 0xbe, 0xef},
		Keys: ikev2.ChildSAKeys{
			Profile: ikev2.ESPKeyProfile{
				EncryptionID:        ikev2.ENCR_AES_GCM_16,
				EncryptionKeyLength: 20,
			},
			Outbound: ikev2.ESPKeys{EncryptionKey: aOutboundKey},
			Inbound:  ikev2.ESPKeys{EncryptionKey: aInboundKey},
		},
	}
	outbound, err := NewOutboundSAFromChild(child)
	if err != nil {
		t.Fatalf("NewOutboundSAFromChild() error = %v", err)
	}
	peer := child
	peer.LocalSPI = append([]byte(nil), child.RemoteSPI...)
	peer.RemoteSPI = append([]byte(nil), child.LocalSPI...)
	peer.Keys.Inbound = ikev2.ESPKeys{EncryptionKey: aOutboundKey}
	inbound, err := NewInboundSAFromChild(peer)
	if err != nil {
		t.Fatalf("NewInboundSAFromChild() error = %v", err)
	}
	if outbound.Encryption != EncryptionAESGCM_16 || inbound.Encryption != EncryptionAESGCM_16 {
		t.Fatalf("encryption outbound=%d inbound=%d", outbound.Encryption, inbound.Encryption)
	}
	if outbound.BlockSize != aesGCMPaddingAlignment || outbound.ICVLength != aesGCMICVLength || len(outbound.IntegrityKey) != 0 {
		t.Fatalf("outbound block=%d icv=%d integ=%x", outbound.BlockSize, outbound.ICVLength, outbound.IntegrityKey)
	}
	payload := []byte{0x45, 0x00, 0x00, 0x14}
	packet, err := outbound.Seal(NextHeaderIPv4, payload, SealOptions{
		Sequence: 4,
		IV:       bytes.Repeat([]byte{0x99}, 8),
	})
	if err != nil {
		t.Fatalf("Seal() error = %v", err)
	}
	out, err := inbound.Open(packet)
	if err != nil {
		t.Fatalf("Open() error = %v", err)
	}
	if out.SPI != 0xdeadbeef || out.Sequence != 4 || out.NextHeader != NextHeaderIPv4 || !bytes.Equal(out.Payload, payload) {
		t.Fatalf("open=%+v payload=%x", out, out.Payload)
	}
}

func TestReplayDetection(t *testing.T) {
	sealer, err := NewSA(SA{
		SPI:              0x11111111,
		EncryptionKey:    bytes.Repeat([]byte{0x77}, 16),
		IntegrityKey:     bytes.Repeat([]byte{0x88}, 32),
		Integrity:        IntegrityHMACSHA2_256_128,
		ReplayWindowSize: 64,
	})
	if err != nil {
		t.Fatalf("NewSA() error = %v", err)
	}
	packet10, err := sealer.Seal(NextHeaderIPv4, []byte{1, 2, 3}, SealOptions{Sequence: 10, IV: bytes.Repeat([]byte{0x99}, 16)})
	if err != nil {
		t.Fatalf("Seal() error = %v", err)
	}
	packet9, err := sealer.Seal(NextHeaderIPv4, []byte{4, 5, 6}, SealOptions{Sequence: 9, IV: bytes.Repeat([]byte{0xaa}, 16)})
	if err != nil {
		t.Fatalf("Seal(9) error = %v", err)
	}
	opener, err := NewSA(SA{
		SPI:              0x11111111,
		EncryptionKey:    bytes.Repeat([]byte{0x77}, 16),
		IntegrityKey:     bytes.Repeat([]byte{0x88}, 32),
		Integrity:        IntegrityHMACSHA2_256_128,
		ReplayWindowSize: 64,
	})
	if err != nil {
		t.Fatalf("NewSA(open) error = %v", err)
	}
	if _, err := opener.Open(packet10); err != nil {
		t.Fatalf("Open(10) error = %v", err)
	}
	if _, err := opener.Open(packet9); err != nil {
		t.Fatalf("Open(9 out-of-order) error = %v", err)
	}
	if _, err := opener.Open(packet9); !errors.Is(err, ErrReplay) {
		t.Fatalf("Open(replay) err=%v, want ErrReplay", err)
	}
}

func TestOpenRejectsWrongSPIAndSequenceZeroWithoutAdvancingReplay(t *testing.T) {
	sealer := newTestSA(t, 0xabcdef01, 0)
	packet, err := sealer.Seal(NextHeaderIPv4, []byte{1, 2, 3}, SealOptions{
		Sequence: 5,
		IV:       bytes.Repeat([]byte{0x51}, 16),
	})
	if err != nil {
		t.Fatalf("Seal() error = %v", err)
	}
	opener := newTestSA(t, 0xabcdef01, 64)
	wrongSPI := append([]byte(nil), packet...)
	binary.BigEndian.PutUint32(wrongSPI[0:4], 0xabcdef02)
	if _, err := opener.Open(wrongSPI); !errors.Is(err, ErrInvalidPacket) {
		t.Fatalf("Open(wrong SPI) err=%v, want ErrInvalidPacket", err)
	}
	zeroSequence := append([]byte(nil), packet...)
	binary.BigEndian.PutUint32(zeroSequence[4:8], 0)
	if _, err := opener.Open(zeroSequence); !errors.Is(err, ErrInvalidPacket) {
		t.Fatalf("Open(sequence zero) err=%v, want ErrInvalidPacket", err)
	}
	out, err := opener.Open(packet)
	if err != nil {
		t.Fatalf("Open(valid after rejects) error = %v", err)
	}
	if out.Sequence != 5 || opener.HighestSequence != 5 {
		t.Fatalf("sequence=%d highest=%d, want 5", out.Sequence, opener.HighestSequence)
	}
}

func TestReplayWindowRejectsPacketsOutsideWindow(t *testing.T) {
	sealer := newTestSA(t, 0x22222222, 0)
	packet66, err := sealer.Seal(NextHeaderIPv4, []byte{0x66}, SealOptions{Sequence: 66, IV: bytes.Repeat([]byte{0x66}, 16)})
	if err != nil {
		t.Fatalf("Seal(66) error = %v", err)
	}
	packet3, err := sealer.Seal(NextHeaderIPv4, []byte{0x03}, SealOptions{Sequence: 3, IV: bytes.Repeat([]byte{0x03}, 16)})
	if err != nil {
		t.Fatalf("Seal(3) error = %v", err)
	}
	packet2, err := sealer.Seal(NextHeaderIPv4, []byte{0x02}, SealOptions{Sequence: 2, IV: bytes.Repeat([]byte{0x02}, 16)})
	if err != nil {
		t.Fatalf("Seal(2) error = %v", err)
	}
	opener := newTestSA(t, 0x22222222, 64)
	if _, err := opener.Open(packet66); err != nil {
		t.Fatalf("Open(66) error = %v", err)
	}
	if _, err := opener.Open(packet3); err != nil {
		t.Fatalf("Open(3 boundary) error = %v", err)
	}
	if _, err := opener.Open(packet2); !errors.Is(err, ErrReplay) {
		t.Fatalf("Open(2 outside window) err=%v, want ErrReplay", err)
	}
}

func TestReplayWindowSizeCapsAt64Packets(t *testing.T) {
	sealer := newTestSA(t, 0x33333333, 0)
	packet100, err := sealer.Seal(NextHeaderIPv4, []byte{0x10, 0x00}, SealOptions{Sequence: 100, IV: bytes.Repeat([]byte{0x10}, 16)})
	if err != nil {
		t.Fatalf("Seal(100) error = %v", err)
	}
	packet37, err := sealer.Seal(NextHeaderIPv4, []byte{0x37}, SealOptions{Sequence: 37, IV: bytes.Repeat([]byte{0x37}, 16)})
	if err != nil {
		t.Fatalf("Seal(37) error = %v", err)
	}
	packet36, err := sealer.Seal(NextHeaderIPv4, []byte{0x36}, SealOptions{Sequence: 36, IV: bytes.Repeat([]byte{0x36}, 16)})
	if err != nil {
		t.Fatalf("Seal(36) error = %v", err)
	}
	opener := newTestSA(t, 0x33333333, 128)
	if _, err := opener.Open(packet100); err != nil {
		t.Fatalf("Open(100) error = %v", err)
	}
	if _, err := opener.Open(packet37); err != nil {
		t.Fatalf("Open(37 capped boundary) error = %v", err)
	}
	if _, err := opener.Open(packet36); !errors.Is(err, ErrReplay) {
		t.Fatalf("Open(36 outside capped window) err=%v, want ErrReplay", err)
	}
}

func TestReplayWindowIgnoresFailedIntegrityPacket(t *testing.T) {
	sealer := newTestSA(t, 0x34343434, 0)
	packet, err := sealer.Seal(NextHeaderIPv4, []byte{0x45, 0x00, 0x00, 0x14}, SealOptions{
		Sequence: 7,
		IV:       bytes.Repeat([]byte{0x34}, 16),
	})
	if err != nil {
		t.Fatalf("Seal() error = %v", err)
	}
	tampered := append([]byte(nil), packet...)
	tampered[len(tampered)-1] ^= 0xff
	opener := newTestSA(t, 0x34343434, 64)
	if _, err := opener.Open(tampered); !errors.Is(err, ErrInvalidPacket) {
		t.Fatalf("Open(tampered) err=%v, want ErrInvalidPacket", err)
	}
	out, err := opener.Open(packet)
	if err != nil {
		t.Fatalf("Open(valid after tampered) error = %v", err)
	}
	if out.Sequence != 7 || opener.HighestSequence != 7 || opener.ReplayBitmap != 1 {
		t.Fatalf("out=%+v highest=%d bitmap=%064b", out, opener.HighestSequence, opener.ReplayBitmap)
	}
}

func TestReplayWindowDisabledAllowsDuplicatePackets(t *testing.T) {
	sealer := newTestSA(t, 0x35353535, 0)
	packet, err := sealer.Seal(NextHeaderIPv4, []byte{0x45, 0x00}, SealOptions{
		Sequence: 5,
		IV:       bytes.Repeat([]byte{0x35}, 16),
	})
	if err != nil {
		t.Fatalf("Seal() error = %v", err)
	}
	opener := newTestSA(t, 0x35353535, 0)
	if _, err := opener.Open(packet); err != nil {
		t.Fatalf("Open(first) error = %v", err)
	}
	if _, err := opener.Open(packet); err != nil {
		t.Fatalf("Open(duplicate with replay disabled) error = %v", err)
	}
	if opener.HighestSequence != 5 || opener.ReplayBitmap != 0 {
		t.Fatalf("highest=%d bitmap=%064b", opener.HighestSequence, opener.ReplayBitmap)
	}
}

func TestSealRejectsSequenceOverflow(t *testing.T) {
	sa := newTestSA(t, 0x44444444, 0)
	sa.Sequence = ^uint32(0)
	_, err := sa.Seal(NextHeaderIPv4, []byte{0x45, 0x00}, SealOptions{IV: bytes.Repeat([]byte{0x44}, 16)})
	if !errors.Is(err, ErrInvalidSA) {
		t.Fatalf("Seal(sequence overflow) err=%v, want ErrInvalidSA", err)
	}
}

func TestNewSAFromChildDirections(t *testing.T) {
	child := ikev2.ChildSAResult{
		LocalSPI:  []byte{0xca, 0xfe, 0xba, 0xbe},
		RemoteSPI: []byte{0xde, 0xad, 0xbe, 0xef},
		Keys: ikev2.ChildSAKeys{
			Profile: ikev2.ESPKeyProfile{IntegrityID: ikev2.INTEG_HMAC_SHA2_256_128},
			Outbound: ikev2.ESPKeys{
				EncryptionKey: bytes.Repeat([]byte{0x10}, 16),
				IntegrityKey:  bytes.Repeat([]byte{0x20}, 32),
			},
			Inbound: ikev2.ESPKeys{
				EncryptionKey: bytes.Repeat([]byte{0x30}, 16),
				IntegrityKey:  bytes.Repeat([]byte{0x40}, 32),
			},
		},
	}
	outbound, err := NewOutboundSAFromChild(child)
	if err != nil {
		t.Fatalf("NewOutboundSAFromChild() error = %v", err)
	}
	inbound, err := NewInboundSAFromChild(child)
	if err != nil {
		t.Fatalf("NewInboundSAFromChild() error = %v", err)
	}
	if outbound.SPI != 0xdeadbeef || inbound.SPI != 0xcafebabe {
		t.Fatalf("SPIs outbound=%08x inbound=%08x", outbound.SPI, inbound.SPI)
	}
	if !bytes.Equal(outbound.EncryptionKey, bytes.Repeat([]byte{0x10}, 16)) ||
		!bytes.Equal(inbound.EncryptionKey, bytes.Repeat([]byte{0x30}, 16)) {
		t.Fatalf("keys outbound=%x inbound=%x", outbound.EncryptionKey, inbound.EncryptionKey)
	}
}

func newTestSA(t *testing.T, spi uint32, replayWindow uint32) *SA {
	t.Helper()
	sa, err := NewSA(SA{
		SPI:              spi,
		EncryptionKey:    bytes.Repeat([]byte{0x91}, 16),
		IntegrityKey:     bytes.Repeat([]byte{0xa2}, 32),
		Integrity:        IntegrityHMACSHA2_256_128,
		ReplayWindowSize: replayWindow,
	})
	if err != nil {
		t.Fatalf("NewSA() error = %v", err)
	}
	return sa
}
