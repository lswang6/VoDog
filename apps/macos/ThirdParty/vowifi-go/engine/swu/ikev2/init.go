package ikev2

import (
	"context"
	"crypto"
	"crypto/ecdh"
	"crypto/rand"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"math/big"
	"net"
	"strings"
	"time"
)

const (
	DefaultNonceLength          = 32
	DefaultIKEKeyMaterialLength = 192
)

var (
	ErrInvalidInitConfig   = errors.New("invalid ikev2 init config")
	ErrInvalidInitResponse = errors.New("invalid ikev2 init response")
)

type InitTransport interface {
	ExchangeIKE(context.Context, []byte) ([]byte, error)
}

type UDPTransport struct {
	RemoteAddr      string
	LocalAddr       string
	Timeout         time.Duration
	UseNonESPMarker bool
	ReadBufferSize  int
}

func (t UDPTransport) ExchangeIKE(ctx context.Context, request []byte) ([]byte, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	remote := strings.TrimSpace(t.RemoteAddr)
	if remote == "" {
		return nil, fmt.Errorf("%w: remote address is empty", ErrInvalidInitConfig)
	}
	dialer := net.Dialer{}
	if strings.TrimSpace(t.LocalAddr) != "" {
		addr, err := net.ResolveUDPAddr("udp", t.LocalAddr)
		if err != nil {
			return nil, err
		}
		dialer.LocalAddr = addr
	}
	conn, err := dialer.DialContext(ctx, "udp", remote)
	if err != nil {
		return nil, err
	}
	defer conn.Close()
	if timeout := t.Timeout; timeout > 0 {
		_ = conn.SetDeadline(time.Now().Add(timeout))
	}
	wire := request
	if t.UseNonESPMarker {
		wire = append([]byte{0, 0, 0, 0}, request...)
	}
	if _, err := conn.Write(wire); err != nil {
		return nil, err
	}
	size := t.ReadBufferSize
	if size <= 0 {
		size = 64 * 1024
	}
	buf := make([]byte, size)
	n, err := conn.Read(buf)
	if err != nil {
		return nil, err
	}
	resp := append([]byte(nil), buf[:n]...)
	if len(resp) >= 4 && resp[0] == 0 && resp[1] == 0 && resp[2] == 0 && resp[3] == 0 {
		resp = resp[4:]
	}
	return resp, nil
}

type InitConfig struct {
	Transport         InitTransport
	Random            io.Reader
	SA                SecurityAssociation
	InitiatorSPI      uint64
	NonceI            []byte
	X25519PrivateKey  []byte
	MODPPrivateKey    []byte
	LocalIP           net.IP
	LocalPort         uint16
	RemoteIP          net.IP
	RemotePort        uint16
	KeyMaterialLength int
}

type InitResult struct {
	RequestBytes    []byte
	ResponseBytes   []byte
	Request         Message
	Response        Message
	SelectedSA      SecurityAssociation
	InitiatorSPI    uint64
	ResponderSPI    uint64
	NonceI          []byte
	NonceR          []byte
	PublicKeyI      []byte
	PublicKeyR      []byte
	SharedSecret    []byte
	PRF             crypto.Hash
	SKEYSEED        []byte
	KeyMaterial     []byte
	Keys            IKEKeys
	MOBIKESupported bool
	NATDetected     bool
}

func RunIKE_SA_INIT(ctx context.Context, cfg InitConfig) (InitResult, error) {
	if cfg.Transport == nil {
		return InitResult{}, fmt.Errorf("%w: transport is nil", ErrInvalidInitConfig)
	}
	random := cfg.Random
	if random == nil {
		random = rand.Reader
	}
	spiI := cfg.InitiatorSPI
	var err error
	if spiI == 0 {
		spiI, err = randomSPI(random)
		if err != nil {
			return InitResult{}, err
		}
	}
	nonceI := append([]byte(nil), cfg.NonceI...)
	if len(nonceI) == 0 {
		nonceI, err = randomBytes(random, DefaultNonceLength)
		if err != nil {
			return InitResult{}, err
		}
	}
	sa := cfg.SA
	if len(sa.Proposals) == 0 {
		sa = DefaultIKEProposal()
	}
	dhGroup, err := keyExchangeGroup(sa)
	if err != nil {
		return InitResult{}, err
	}
	privateKey := cfg.X25519PrivateKey
	if dhGroup == DHGroup2048BitMODP {
		privateKey = cfg.MODPPrivateKey
	}
	ke, err := newKeyExchange(dhGroup, privateKey, random)
	if err != nil {
		return InitResult{}, err
	}
	pubI := ke.publicKey()
	saPayload, err := SecurityAssociationPayload(sa)
	if err != nil {
		return InitResult{}, err
	}
	payloads := []Payload{
		saPayload,
		KeyExchangePayload(dhGroup, pubI),
		NoncePayload(nonceI),
	}
	payloads = append(payloads, initNATPayloads(cfg, spiI, 0)...)
	req, reqBytes, resp, respBytes, err := runIKESAInitRequest(ctx, cfg.Transport, spiI, payloads)
	if err != nil {
		return InitResult{}, err
	}
	parsed, err := parseInitResponse(resp, spiI, dhGroup)
	if err != nil {
		return InitResult{}, err
	}
	if err := ValidateSelectedSA(sa, parsed.sa); err != nil {
		return InitResult{}, err
	}
	shared, err := ke.sharedSecret(parsed.keyExchange.KeyData)
	if err != nil {
		return InitResult{}, fmt.Errorf("%w: responder KE: %w", ErrInvalidInitResponse, err)
	}
	profile, err := KeyMaterialProfileFromSA(parsed.sa)
	if err != nil {
		return InitResult{}, err
	}
	prfHash := profile.PRF
	skeyseed, err := SKEYSEED(prfHash, nonceI, parsed.nonceR, shared)
	if err != nil {
		return InitResult{}, err
	}
	keyMaterialLength := cfg.KeyMaterialLength
	if keyMaterialLength <= 0 {
		keyMaterialLength = profile.RequiredLength()
	}
	keyMaterial, err := DeriveIKESAKeyMaterial(prfHash, skeyseed, nonceI, parsed.nonceR, spiI, resp.Header.ResponderSPI, keyMaterialLength)
	if err != nil {
		return InitResult{}, err
	}
	var keys IKEKeys
	if len(keyMaterial) >= profile.RequiredLength() {
		keys, err = SplitIKEKeys(profile, keyMaterial)
		if err != nil {
			return InitResult{}, err
		}
	}
	return InitResult{
		RequestBytes:    append([]byte(nil), reqBytes...),
		ResponseBytes:   append([]byte(nil), respBytes...),
		Request:         req,
		Response:        resp,
		SelectedSA:      parsed.sa,
		InitiatorSPI:    spiI,
		ResponderSPI:    resp.Header.ResponderSPI,
		NonceI:          nonceI,
		NonceR:          parsed.nonceR,
		PublicKeyI:      pubI,
		PublicKeyR:      parsed.keyExchange.KeyData,
		SharedSecret:    shared,
		PRF:             prfHash,
		SKEYSEED:        skeyseed,
		KeyMaterial:     keyMaterial,
		Keys:            keys,
		MOBIKESupported: parsed.mobikeSupported,
		NATDetected:     detectNAT(parsed.notifies, spiI, resp.Header.ResponderSPI, cfg),
	}, nil
}

func runIKESAInitRequest(ctx context.Context, transport InitTransport, spiI uint64, payloads []Payload) (Message, []byte, Message, []byte, error) {
	var cookie []byte
	var retriedCookie bool
	for {
		reqPayloads := clonePayloads(payloads)
		if len(cookie) > 0 {
			cookiePayload, err := CookieNotify(cookie)
			if err != nil {
				return Message{}, nil, Message{}, nil, err
			}
			reqPayloads = append([]Payload{cookiePayload}, reqPayloads...)
		}
		req := Message{
			Header: Header{
				InitiatorSPI: spiI,
				ExchangeType: ExchangeIKE_SA_INIT,
				Flags:        FlagInitiator,
			},
			Payloads: reqPayloads,
		}
		reqBytes, err := req.MarshalBinary()
		if err != nil {
			return Message{}, nil, Message{}, nil, err
		}
		respBytes, err := transport.ExchangeIKE(ctx, reqBytes)
		if err != nil {
			return Message{}, nil, Message{}, nil, err
		}
		resp, err := ParseMessage(respBytes)
		if err != nil {
			return Message{}, nil, Message{}, nil, err
		}
		nextCookie, ok, err := initResponseCookie(resp, spiI)
		if err != nil {
			return Message{}, nil, Message{}, nil, err
		}
		if !ok {
			return req, reqBytes, resp, respBytes, nil
		}
		if retriedCookie {
			return Message{}, nil, Message{}, nil, fmt.Errorf("%w: repeated COOKIE notify", ErrInvalidInitResponse)
		}
		cookie = nextCookie
		retriedCookie = true
	}
}

func initResponseCookie(resp Message, spiI uint64) ([]byte, bool, error) {
	h := resp.Header
	if h.InitiatorSPI != spiI {
		return nil, false, fmt.Errorf("%w: initiator SPI mismatch", ErrInvalidInitResponse)
	}
	if h.ExchangeType != ExchangeIKE_SA_INIT || h.MessageID != 0 || h.Flags&FlagResponse == 0 {
		return nil, false, fmt.Errorf("%w: unexpected header", ErrInvalidInitResponse)
	}
	if err := FirstNotifyError(resp.Payloads); err != nil {
		return nil, false, fmt.Errorf("%w: %w", ErrInvalidInitResponse, err)
	}
	for _, payload := range resp.Payloads {
		if payload.Type != PayloadNotify {
			continue
		}
		notify, err := ParseNotify(payload.Body)
		if err != nil {
			return nil, false, fmt.Errorf("%w: %w", ErrInvalidInitResponse, err)
		}
		cookie, ok, err := notify.Cookie()
		if err != nil {
			return nil, false, fmt.Errorf("%w: %w", ErrInvalidInitResponse, err)
		}
		if ok {
			return cookie, true, nil
		}
	}
	return nil, false, nil
}

type parsedInitResponse struct {
	sa              SecurityAssociation
	keyExchange     KeyExchange
	nonceR          []byte
	notifies        []Notify
	mobikeSupported bool
}

func parseInitResponse(resp Message, spiI uint64, expectedDHGroup uint16) (parsedInitResponse, error) {
	h := resp.Header
	if h.InitiatorSPI != spiI {
		return parsedInitResponse{}, fmt.Errorf("%w: initiator SPI mismatch", ErrInvalidInitResponse)
	}
	if h.ExchangeType != ExchangeIKE_SA_INIT || h.MessageID != 0 || h.Flags&FlagResponse == 0 {
		return parsedInitResponse{}, fmt.Errorf("%w: unexpected header", ErrInvalidInitResponse)
	}
	if err := FirstNotifyError(resp.Payloads); err != nil {
		return parsedInitResponse{}, fmt.Errorf("%w: %w", ErrInvalidInitResponse, err)
	}
	if h.ResponderSPI == 0 {
		return parsedInitResponse{}, fmt.Errorf("%w: responder SPI is zero", ErrInvalidInitResponse)
	}
	var out parsedInitResponse
	for _, p := range resp.Payloads {
		switch p.Type {
		case PayloadSA:
			sa, err := ParseSecurityAssociation(p.Body)
			if err != nil {
				return parsedInitResponse{}, err
			}
			out.sa = sa
		case PayloadKE:
			ke, err := ParseKeyExchange(p.Body)
			if err != nil {
				return parsedInitResponse{}, err
			}
			if ke.DHGroup != expectedDHGroup {
				return parsedInitResponse{}, fmt.Errorf("%w: responder DH group %d != requested %d", ErrInvalidInitResponse, ke.DHGroup, expectedDHGroup)
			}
			out.keyExchange = ke
		case PayloadNonce:
			out.nonceR = append([]byte(nil), p.Body...)
		case PayloadNotify:
			n, err := ParseNotify(p.Body)
			if err != nil {
				return parsedInitResponse{}, err
			}
			out.notifies = append(out.notifies, n)
			if n.NotifyType == NotifyMOBIKESupported {
				out.mobikeSupported = true
			}
		}
	}
	if len(out.sa.Proposals) == 0 {
		return parsedInitResponse{}, fmt.Errorf("%w: missing SA", ErrInvalidInitResponse)
	}
	if len(out.keyExchange.KeyData) == 0 {
		return parsedInitResponse{}, fmt.Errorf("%w: missing KE", ErrInvalidInitResponse)
	}
	if len(out.nonceR) == 0 {
		return parsedInitResponse{}, fmt.Errorf("%w: missing nonce", ErrInvalidInitResponse)
	}
	return out, nil
}

func initNATPayloads(cfg InitConfig, spiI, spiR uint64) []Payload {
	if cfg.LocalIP == nil || cfg.RemoteIP == nil || cfg.LocalPort == 0 || cfg.RemotePort == 0 {
		return nil
	}
	src, err := NATDetectionNotify(NotifyNATDetectionSourceIP, spiI, spiR, cfg.LocalIP, cfg.LocalPort)
	if err != nil {
		return nil
	}
	dst, err := NATDetectionNotify(NotifyNATDetectionDestinationIP, spiI, spiR, cfg.RemoteIP, cfg.RemotePort)
	if err != nil {
		return nil
	}
	return []Payload{src, dst}
}

func detectNAT(notifies []Notify, spiI, spiR uint64, cfg InitConfig) bool {
	if cfg.LocalIP == nil || cfg.RemoteIP == nil || cfg.LocalPort == 0 || cfg.RemotePort == 0 {
		return false
	}
	sourceHash, sourceErr := NATDetectionHash(spiI, spiR, cfg.RemoteIP, cfg.RemotePort)
	destHash, destErr := NATDetectionHash(spiI, spiR, cfg.LocalIP, cfg.LocalPort)
	if sourceErr != nil || destErr != nil {
		return false
	}
	for _, n := range notifies {
		switch n.NotifyType {
		case NotifyNATDetectionSourceIP:
			if !bytesEqual(n.NotificationData, sourceHash) {
				return true
			}
		case NotifyNATDetectionDestinationIP:
			if !bytesEqual(n.NotificationData, destHash) {
				return true
			}
		}
	}
	return false
}

func selectedPRFHash(sa SecurityAssociation) crypto.Hash {
	for _, p := range sa.Proposals {
		for _, tr := range p.Transforms {
			if tr.Type == TransformPRF {
				if h, err := PRFHashForTransform(tr.ID); err == nil {
					return h
				}
			}
		}
	}
	return crypto.SHA256
}

func x25519PrivateKey(raw []byte, random io.Reader) (*ecdh.PrivateKey, error) {
	if len(raw) > 0 {
		return ecdh.X25519().NewPrivateKey(append([]byte(nil), raw...))
	}
	return ecdh.X25519().GenerateKey(random)
}

type initKeyExchange interface {
	publicKey() []byte
	sharedSecret(peerPublic []byte) ([]byte, error)
}

type x25519KeyExchange struct {
	private *ecdh.PrivateKey
}

func (k x25519KeyExchange) publicKey() []byte {
	return k.private.PublicKey().Bytes()
}

func (k x25519KeyExchange) sharedSecret(peerPublic []byte) ([]byte, error) {
	peer, err := ecdh.X25519().NewPublicKey(peerPublic)
	if err != nil {
		return nil, err
	}
	return k.private.ECDH(peer)
}

type modpKeyExchange struct {
	private *big.Int
	public  []byte
}

var modp2048Prime = mustBigIntHex(
	"FFFFFFFFFFFFFFFFC90FDAA22168C234C4C6628B80DC1CD1" +
		"29024E088A67CC74020BBEA63B139B22514A08798E3404DD" +
		"EF9519B3CD3A431B302B0A6DF25F14374FE1356D6D51C245" +
		"E485B576625E7EC6F44C42E9A637ED6B0BFF5CB6F406B7ED" +
		"EE386BFB5A899FA5AE9F24117C4B1FE649286651ECE45B3D" +
		"C2007CB8A163BF0598DA48361C55D39A69163FA8FD24CF5F" +
		"83655D23DCA3AD961C62F356208552BB9ED529077096966D" +
		"670C354E4ABC9804F1746C08CA18217C32905E462E36CE3B" +
		"E39E772C180E86039B2783A2EC07A28FB5C55DF06F4C52C9" +
		"DE2BCBF6955817183995497CEA956AE515D2261898FA0510" +
		"15728E5A8AACAA68FFFFFFFFFFFFFFFF",
)

func newKeyExchange(group uint16, raw []byte, random io.Reader) (initKeyExchange, error) {
	switch group {
	case DHGroupCurve25519:
		private, err := x25519PrivateKey(raw, random)
		if err != nil {
			return nil, err
		}
		return x25519KeyExchange{private: private}, nil
	case DHGroup2048BitMODP:
		private, err := modpPrivateKey(raw, random)
		if err != nil {
			return nil, err
		}
		public := new(big.Int).Exp(big.NewInt(2), private, modp2048Prime)
		return modpKeyExchange{private: private, public: leftPad(public.Bytes(), 256)}, nil
	default:
		return nil, fmt.Errorf("%w: unsupported DH group %d", ErrInvalidInitConfig, group)
	}
}

func (k modpKeyExchange) publicKey() []byte {
	return append([]byte(nil), k.public...)
}

func (k modpKeyExchange) sharedSecret(peerPublic []byte) ([]byte, error) {
	if len(peerPublic) != 256 {
		return nil, fmt.Errorf("MODP 2048 public key length %d", len(peerPublic))
	}
	peer := new(big.Int).SetBytes(peerPublic)
	upper := new(big.Int).Sub(modp2048Prime, big.NewInt(2))
	if peer.Cmp(big.NewInt(2)) < 0 || peer.Cmp(upper) > 0 {
		return nil, errors.New("MODP 2048 public key out of range")
	}
	shared := new(big.Int).Exp(peer, k.private, modp2048Prime)
	return leftPad(shared.Bytes(), 256), nil
}

func modpPrivateKey(raw []byte, random io.Reader) (*big.Int, error) {
	upper := new(big.Int).Sub(modp2048Prime, big.NewInt(3))
	if len(raw) == 0 {
		private, err := rand.Int(random, upper)
		if err != nil {
			return nil, err
		}
		return private.Add(private, big.NewInt(2)), nil
	}
	private := new(big.Int).SetBytes(raw)
	max := new(big.Int).Sub(modp2048Prime, big.NewInt(2))
	if private.Cmp(big.NewInt(2)) < 0 || private.Cmp(max) > 0 {
		return nil, fmt.Errorf("%w: MODP 2048 private key out of range", ErrInvalidInitConfig)
	}
	return private, nil
}

func keyExchangeGroup(sa SecurityAssociation) (uint16, error) {
	for _, proposal := range sa.Proposals {
		if proposal.ProtocolID != ProtocolIKE {
			continue
		}
		if transform, ok := findTransform(proposal, TransformDHRGroup); ok {
			return transform.ID, nil
		}
	}
	return 0, fmt.Errorf("%w: IKE proposal has no DH transform", ErrInvalidInitConfig)
}

func leftPad(value []byte, length int) []byte {
	if len(value) >= length {
		return append([]byte(nil), value...)
	}
	out := make([]byte, length)
	copy(out[length-len(value):], value)
	return out
}

func mustBigIntHex(value string) *big.Int {
	out, ok := new(big.Int).SetString(value, 16)
	if !ok {
		panic("invalid MODP prime")
	}
	return out
}

func randomSPI(random io.Reader) (uint64, error) {
	for {
		b, err := randomBytes(random, 8)
		if err != nil {
			return 0, err
		}
		spi := binary.BigEndian.Uint64(b)
		if spi != 0 {
			return spi, nil
		}
	}
}

func randomBytes(random io.Reader, n int) ([]byte, error) {
	if n <= 0 {
		return nil, fmt.Errorf("%w: invalid random length %d", ErrInvalidInitConfig, n)
	}
	b := make([]byte, n)
	if _, err := io.ReadFull(random, b); err != nil {
		return nil, err
	}
	return b, nil
}

func bytesEqual(a, b []byte) bool {
	if len(a) != len(b) {
		return false
	}
	var diff byte
	for i := range a {
		diff |= a[i] ^ b[i]
	}
	return diff == 0
}
