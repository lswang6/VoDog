package esp

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha1"
	"crypto/sha256"
	"encoding/binary"
	"errors"
	"fmt"
	"io"

	"github.com/boa-z/vowifi-go/engine/swu/ikev2"
)

const (
	NextHeaderIPv4 = 4
	NextHeaderIPv6 = 41
)

const (
	aesGCMSaltLength       = 4
	aesGCMExplicitIVLength = 8
	aesGCMICVLength        = 16
	aesGCMPaddingAlignment = 4
)

var (
	ErrInvalidSA     = errors.New("invalid esp sa")
	ErrInvalidPacket = errors.New("invalid esp packet")
	ErrReplay        = errors.New("esp replay detected")
)

type IntegrityAlgorithm uint16

const (
	IntegrityHMACSHA1_96      IntegrityAlgorithm = IntegrityAlgorithm(ikev2.INTEG_HMAC_SHA1_96)
	IntegrityHMACSHA2_256_128 IntegrityAlgorithm = IntegrityAlgorithm(ikev2.INTEG_HMAC_SHA2_256_128)
)

type EncryptionAlgorithm uint16

const (
	EncryptionAESCBC    EncryptionAlgorithm = EncryptionAlgorithm(ikev2.ENCR_AES_CBC)
	EncryptionAESGCM_16 EncryptionAlgorithm = EncryptionAlgorithm(ikev2.ENCR_AES_GCM_16)
)

type SA struct {
	SPI              uint32
	Encryption       EncryptionAlgorithm
	EncryptionKey    []byte
	IntegrityKey     []byte
	Integrity        IntegrityAlgorithm
	ICVLength        int
	BlockSize        int
	Sequence         uint32
	HighestSequence  uint32
	ReplayWindowSize uint32
	ReplayBitmap     uint64
}

type SealOptions struct {
	Sequence uint32
	IV       []byte
	Random   io.Reader
}

type OpenResult struct {
	SPI        uint32
	Sequence   uint32
	NextHeader uint8
	Payload    []byte
}

func NewOutboundSAFromChild(child ikev2.ChildSAResult) (*SA, error) {
	spi, err := spiFromBytes(child.RemoteSPI)
	if err != nil {
		return nil, err
	}
	return NewSA(SA{
		SPI:           spi,
		Encryption:    EncryptionAlgorithm(child.Keys.Profile.EncryptionID),
		EncryptionKey: child.Keys.Outbound.EncryptionKey,
		IntegrityKey:  child.Keys.Outbound.IntegrityKey,
		Integrity:     IntegrityAlgorithm(child.Keys.Profile.IntegrityID),
		ICVLength:     icvLengthForChildProfile(child.Keys.Profile),
		BlockSize:     blockSizeForChildProfile(child.Keys.Profile),
	})
}

func NewInboundSAFromChild(child ikev2.ChildSAResult) (*SA, error) {
	spi, err := spiFromBytes(child.LocalSPI)
	if err != nil {
		return nil, err
	}
	return NewSA(SA{
		SPI:              spi,
		Encryption:       EncryptionAlgorithm(child.Keys.Profile.EncryptionID),
		EncryptionKey:    child.Keys.Inbound.EncryptionKey,
		IntegrityKey:     child.Keys.Inbound.IntegrityKey,
		Integrity:        IntegrityAlgorithm(child.Keys.Profile.IntegrityID),
		ICVLength:        icvLengthForChildProfile(child.Keys.Profile),
		BlockSize:        blockSizeForChildProfile(child.Keys.Profile),
		ReplayWindowSize: 64,
	})
}

func NewSA(sa SA) (*SA, error) {
	if sa.SPI == 0 {
		return nil, fmt.Errorf("%w: spi is zero", ErrInvalidSA)
	}
	switch sa.encryptionAlgorithm() {
	case EncryptionAESCBC:
		if len(sa.EncryptionKey) != 16 && len(sa.EncryptionKey) != 24 && len(sa.EncryptionKey) != 32 {
			return nil, fmt.Errorf("%w: AES key length %d", ErrInvalidSA, len(sa.EncryptionKey))
		}
		if len(sa.IntegrityKey) == 0 {
			return nil, fmt.Errorf("%w: integrity key is empty", ErrInvalidSA)
		}
		if sa.BlockSize == 0 {
			sa.BlockSize = aes.BlockSize
		}
		if sa.BlockSize != aes.BlockSize {
			return nil, fmt.Errorf("%w: block size %d", ErrInvalidSA, sa.BlockSize)
		}
		if sa.ICVLength == 0 {
			sa.ICVLength = integrityICVLength(sa.Integrity)
		}
		if sa.ICVLength <= 0 {
			return nil, fmt.Errorf("%w: unsupported integrity %d", ErrInvalidSA, sa.Integrity)
		}
	case EncryptionAESGCM_16:
		if !validAESGCMKeyLength(len(sa.EncryptionKey)) {
			return nil, fmt.Errorf("%w: AES-GCM key length %d", ErrInvalidSA, len(sa.EncryptionKey))
		}
		if sa.BlockSize == 0 {
			sa.BlockSize = aesGCMPaddingAlignment
		}
		if sa.BlockSize != aesGCMPaddingAlignment {
			return nil, fmt.Errorf("%w: block size %d", ErrInvalidSA, sa.BlockSize)
		}
		if sa.ICVLength == 0 {
			sa.ICVLength = aesGCMICVLength
		}
		if sa.ICVLength != aesGCMICVLength {
			return nil, fmt.Errorf("%w: AES-GCM ICV length %d", ErrInvalidSA, sa.ICVLength)
		}
	default:
		return nil, fmt.Errorf("%w: unsupported encryption %d", ErrInvalidSA, sa.Encryption)
	}
	return &sa, nil
}

func (s *SA) Seal(nextHeader uint8, payload []byte, opts SealOptions) ([]byte, error) {
	if s == nil {
		return nil, ErrInvalidSA
	}
	seq := opts.Sequence
	if seq == 0 {
		if s.Sequence == ^uint32(0) {
			return nil, fmt.Errorf("%w: sequence overflow", ErrInvalidSA)
		}
		s.Sequence++
		seq = s.Sequence
	} else if seq > s.Sequence {
		s.Sequence = seq
	}
	switch s.encryptionAlgorithm() {
	case EncryptionAESCBC:
		return s.sealAESCBC(nextHeader, payload, seq, opts)
	case EncryptionAESGCM_16:
		return s.sealAESGCM(nextHeader, payload, seq, opts)
	default:
		return nil, fmt.Errorf("%w: unsupported encryption %d", ErrInvalidSA, s.Encryption)
	}
}

func (s *SA) sealAESCBC(nextHeader uint8, payload []byte, seq uint32, opts SealOptions) ([]byte, error) {
	iv := append([]byte(nil), opts.IV...)
	if len(iv) == 0 {
		random := opts.Random
		if random == nil {
			random = rand.Reader
		}
		iv = make([]byte, s.BlockSize)
		if _, err := io.ReadFull(random, iv); err != nil {
			return nil, err
		}
	}
	if len(iv) != s.BlockSize {
		return nil, fmt.Errorf("%w: iv length %d", ErrInvalidPacket, len(iv))
	}
	plain := espPlaintext(payload, nextHeader, s.BlockSize)
	ciphertext, err := aesCBCEncrypt(s.EncryptionKey, iv, plain)
	if err != nil {
		return nil, err
	}
	packet := make([]byte, 8, 8+len(iv)+len(ciphertext)+s.ICVLength)
	binary.BigEndian.PutUint32(packet[0:4], s.SPI)
	binary.BigEndian.PutUint32(packet[4:8], seq)
	packet = append(packet, iv...)
	packet = append(packet, ciphertext...)
	icv, err := s.integrity(packet)
	if err != nil {
		return nil, err
	}
	packet = append(packet, icv...)
	return packet, nil
}

func (s *SA) sealAESGCM(nextHeader uint8, payload []byte, seq uint32, opts SealOptions) ([]byte, error) {
	iv := append([]byte(nil), opts.IV...)
	if len(iv) == 0 {
		iv = make([]byte, aesGCMExplicitIVLength)
		binary.BigEndian.PutUint64(iv, uint64(seq))
	}
	if len(iv) != aesGCMExplicitIVLength {
		return nil, fmt.Errorf("%w: iv length %d", ErrInvalidPacket, len(iv))
	}
	aead, salt, err := s.aesGCMAEAD()
	if err != nil {
		return nil, err
	}
	plain := espPlaintext(payload, nextHeader, s.BlockSize)
	packet := make([]byte, 8, 8+len(iv)+len(plain)+aead.Overhead())
	binary.BigEndian.PutUint32(packet[0:4], s.SPI)
	binary.BigEndian.PutUint32(packet[4:8], seq)
	packet = append(packet, iv...)
	nonce := aesGCMNonce(salt, iv)
	packet = aead.Seal(packet, nonce, plain, packet[:8])
	return packet, nil
}

func (s *SA) Open(packet []byte) (OpenResult, error) {
	if s == nil {
		return OpenResult{}, ErrInvalidSA
	}
	switch s.encryptionAlgorithm() {
	case EncryptionAESCBC:
		return s.openAESCBC(packet)
	case EncryptionAESGCM_16:
		return s.openAESGCM(packet)
	default:
		return OpenResult{}, fmt.Errorf("%w: unsupported encryption %d", ErrInvalidSA, s.Encryption)
	}
}

func (s *SA) openAESCBC(packet []byte) (OpenResult, error) {
	if len(packet) < 8+s.BlockSize+s.ICVLength+s.BlockSize {
		return OpenResult{}, fmt.Errorf("%w: too short", ErrInvalidPacket)
	}
	spi := binary.BigEndian.Uint32(packet[0:4])
	if spi != s.SPI {
		return OpenResult{}, fmt.Errorf("%w: spi %08x != %08x", ErrInvalidPacket, spi, s.SPI)
	}
	seq := binary.BigEndian.Uint32(packet[4:8])
	if seq == 0 {
		return OpenResult{}, fmt.Errorf("%w: sequence zero", ErrInvalidPacket)
	}
	bodyEnd := len(packet) - s.ICVLength
	gotICV := packet[bodyEnd:]
	wantICV, err := s.integrity(packet[:bodyEnd])
	if err != nil {
		return OpenResult{}, err
	}
	if !hmac.Equal(gotICV, wantICV) {
		return OpenResult{}, fmt.Errorf("%w: icv mismatch", ErrInvalidPacket)
	}
	if err := s.checkReplay(seq); err != nil {
		return OpenResult{}, err
	}
	body := packet[8:bodyEnd]
	if len(body) < s.BlockSize || (len(body)-s.BlockSize)%s.BlockSize != 0 {
		return OpenResult{}, fmt.Errorf("%w: invalid encrypted body length", ErrInvalidPacket)
	}
	iv := body[:s.BlockSize]
	ciphertext := body[s.BlockSize:]
	plain, err := aesCBCDecrypt(s.EncryptionKey, iv, ciphertext)
	if err != nil {
		return OpenResult{}, err
	}
	payload, nextHeader, err := parseESPPlaintext(plain)
	if err != nil {
		return OpenResult{}, err
	}
	s.acceptSequence(seq)
	return OpenResult{SPI: spi, Sequence: seq, NextHeader: nextHeader, Payload: payload}, nil
}

func (s *SA) openAESGCM(packet []byte) (OpenResult, error) {
	if len(packet) < 8+aesGCMExplicitIVLength+s.ICVLength+2 {
		return OpenResult{}, fmt.Errorf("%w: too short", ErrInvalidPacket)
	}
	spi := binary.BigEndian.Uint32(packet[0:4])
	if spi != s.SPI {
		return OpenResult{}, fmt.Errorf("%w: spi %08x != %08x", ErrInvalidPacket, spi, s.SPI)
	}
	seq := binary.BigEndian.Uint32(packet[4:8])
	if seq == 0 {
		return OpenResult{}, fmt.Errorf("%w: sequence zero", ErrInvalidPacket)
	}
	aead, salt, err := s.aesGCMAEAD()
	if err != nil {
		return OpenResult{}, err
	}
	body := packet[8:]
	iv := body[:aesGCMExplicitIVLength]
	ciphertext := body[aesGCMExplicitIVLength:]
	plain, err := aead.Open(nil, aesGCMNonce(salt, iv), ciphertext, packet[:8])
	if err != nil {
		return OpenResult{}, fmt.Errorf("%w: icv mismatch", ErrInvalidPacket)
	}
	if err := s.checkReplay(seq); err != nil {
		return OpenResult{}, err
	}
	payload, nextHeader, err := parseESPPlaintext(plain)
	if err != nil {
		return OpenResult{}, err
	}
	s.acceptSequence(seq)
	return OpenResult{SPI: spi, Sequence: seq, NextHeader: nextHeader, Payload: payload}, nil
}

func (s *SA) integrity(data []byte) ([]byte, error) {
	var mac hashMAC
	switch s.Integrity {
	case IntegrityHMACSHA1_96:
		mac = hmac.New(sha1.New, s.IntegrityKey)
	case IntegrityHMACSHA2_256_128:
		mac = hmac.New(sha256.New, s.IntegrityKey)
	default:
		return nil, fmt.Errorf("%w: unsupported integrity %d", ErrInvalidSA, s.Integrity)
	}
	_, _ = mac.Write(data)
	sum := mac.Sum(nil)
	if s.ICVLength > len(sum) {
		return nil, fmt.Errorf("%w: icv length %d", ErrInvalidSA, s.ICVLength)
	}
	return append([]byte(nil), sum[:s.ICVLength]...), nil
}

func (s *SA) aesGCMAEAD() (cipher.AEAD, []byte, error) {
	keyLen := len(s.EncryptionKey) - aesGCMSaltLength
	block, err := aes.NewCipher(s.EncryptionKey[:keyLen])
	if err != nil {
		return nil, nil, err
	}
	aead, err := cipher.NewGCMWithTagSize(block, s.ICVLength)
	if err != nil {
		return nil, nil, err
	}
	return aead, s.EncryptionKey[keyLen:], nil
}

func aesGCMNonce(salt, iv []byte) []byte {
	nonce := make([]byte, 0, len(salt)+len(iv))
	nonce = append(nonce, salt...)
	nonce = append(nonce, iv...)
	return nonce
}

type hashMAC interface {
	Write([]byte) (int, error)
	Sum([]byte) []byte
}

func (s *SA) checkReplay(seq uint32) error {
	if s.ReplayWindowSize == 0 {
		return nil
	}
	window := s.ReplayWindowSize
	if window > 64 {
		window = 64
	}
	if seq > s.HighestSequence {
		return nil
	}
	diff := s.HighestSequence - seq
	if diff >= window {
		return ErrReplay
	}
	if s.ReplayBitmap&(uint64(1)<<diff) != 0 {
		return ErrReplay
	}
	return nil
}

func (s *SA) acceptSequence(seq uint32) {
	if s.ReplayWindowSize == 0 {
		if seq > s.HighestSequence {
			s.HighestSequence = seq
		}
		return
	}
	if seq > s.HighestSequence {
		diff := seq - s.HighestSequence
		if diff >= 64 {
			s.ReplayBitmap = 1
		} else {
			s.ReplayBitmap = (s.ReplayBitmap << diff) | 1
		}
		s.HighestSequence = seq
		return
	}
	diff := s.HighestSequence - seq
	if diff < 64 {
		s.ReplayBitmap |= uint64(1) << diff
	}
}

func espPlaintext(payload []byte, nextHeader uint8, blockSize int) []byte {
	padLen := (blockSize - ((len(payload) + 2) % blockSize)) % blockSize
	out := make([]byte, 0, len(payload)+padLen+2)
	out = append(out, payload...)
	for i := 1; i <= padLen; i++ {
		out = append(out, byte(i))
	}
	out = append(out, byte(padLen), nextHeader)
	return out
}

func parseESPPlaintext(plain []byte) ([]byte, uint8, error) {
	if len(plain) < 2 {
		return nil, 0, fmt.Errorf("%w: plaintext too short", ErrInvalidPacket)
	}
	padLen := int(plain[len(plain)-2])
	nextHeader := plain[len(plain)-1]
	if padLen+2 > len(plain) {
		return nil, 0, fmt.Errorf("%w: pad length %d", ErrInvalidPacket, padLen)
	}
	paddingStart := len(plain) - 2 - padLen
	for i := 0; i < padLen; i++ {
		if plain[paddingStart+i] != byte(i+1) {
			return nil, 0, fmt.Errorf("%w: bad padding", ErrInvalidPacket)
		}
	}
	return append([]byte(nil), plain[:paddingStart]...), nextHeader, nil
}

func aesCBCEncrypt(key, iv, plain []byte) ([]byte, error) {
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	if len(iv) != block.BlockSize() || len(plain)%block.BlockSize() != 0 {
		return nil, fmt.Errorf("%w: invalid AES-CBC input", ErrInvalidPacket)
	}
	out := make([]byte, len(plain))
	cipher.NewCBCEncrypter(block, iv).CryptBlocks(out, plain)
	return out, nil
}

func aesCBCDecrypt(key, iv, ciphertext []byte) ([]byte, error) {
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	if len(iv) != block.BlockSize() || len(ciphertext)%block.BlockSize() != 0 {
		return nil, fmt.Errorf("%w: invalid AES-CBC input", ErrInvalidPacket)
	}
	out := make([]byte, len(ciphertext))
	cipher.NewCBCDecrypter(block, iv).CryptBlocks(out, ciphertext)
	return out, nil
}

func (s *SA) encryptionAlgorithm() EncryptionAlgorithm {
	if s.Encryption == 0 {
		return EncryptionAESCBC
	}
	return s.Encryption
}

func validAESGCMKeyLength(n int) bool {
	switch n {
	case 16 + aesGCMSaltLength, 24 + aesGCMSaltLength, 32 + aesGCMSaltLength:
		return true
	default:
		return false
	}
}

func blockSizeForChildProfile(profile ikev2.ESPKeyProfile) int {
	if EncryptionAlgorithm(profile.EncryptionID) == EncryptionAESGCM_16 {
		return aesGCMPaddingAlignment
	}
	return aes.BlockSize
}

func icvLengthForChildProfile(profile ikev2.ESPKeyProfile) int {
	if EncryptionAlgorithm(profile.EncryptionID) == EncryptionAESGCM_16 {
		return aesGCMICVLength
	}
	return integrityICVLength(IntegrityAlgorithm(profile.IntegrityID))
}

func integrityICVLength(integ IntegrityAlgorithm) int {
	switch integ {
	case IntegrityHMACSHA1_96:
		return 12
	case IntegrityHMACSHA2_256_128:
		return 16
	default:
		return 0
	}
}

func spiFromBytes(spi []byte) (uint32, error) {
	if len(spi) != 4 {
		return 0, fmt.Errorf("%w: spi length %d", ErrInvalidSA, len(spi))
	}
	v := binary.BigEndian.Uint32(spi)
	if v == 0 {
		return 0, fmt.Errorf("%w: spi is zero", ErrInvalidSA)
	}
	return v, nil
}
