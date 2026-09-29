package voiceclient

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/md5"
	"crypto/sha256"
	"crypto/sha512"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"strconv"
	"strings"
	"time"

	"github.com/boa-z/vowifi-go/engine/sim"
)

var ErrInvalidChallenge = errors.New("invalid SIP digest challenge")
var ErrInvalidAuthorization = errors.New("invalid SIP digest authorization")
var ErrInvalidAuthenticationInfo = errors.New("invalid SIP digest authentication-info")
var ErrRegistrationRejected = errors.New("IMS registration rejected")

type IMSProfile struct {
	IMPI              string
	IMPU              string
	Domain            string
	LocalIP           string
	UserAgent         string
	AccessNetworkInfo string
	VisitedNetworkID  string
}

type DigestChallenge struct {
	Scheme    string
	Realm     string
	Nonce     string
	Algorithm string
	QOP       string
	Opaque    string
	Stale     bool
}

type DigestAuthorization struct {
	Scheme    string
	Username  string
	Realm     string
	Nonce     string
	URI       string
	Response  string
	Algorithm string
	QOP       string
	NC        int
	NCText    string
	CNonce    string
	Opaque    string
	AUTS      []byte
}

type DigestAuthInput struct {
	Method   string
	URI      string
	Username string
	Password string
	CNonce   string
	NC       int
	Body     []byte
	AUTS     []byte
}

type DigestAuthState struct {
	challenge  DigestChallenge
	input      DigestAuthInput
	headerName string
	nextNC     int
	lastHeader string
}

type RegistrationBinding struct {
	ContactURI        string
	PublicIdentity    string
	AssociatedURIs    []string
	ServiceRoutes     []string
	Paths             []string
	SecurityClient    string
	SecurityServer    []string
	SecurityVerify    []string
	SecurityAgreement SecurityAgreement
	SecurityPlan      IMSSecurityAssociationPlan
	Expires           int
	RegistrarContact  string
	AuthHeader        string
	AuthHeaderName    string
	AuthSession       *DigestAuthSession
}

type RegisterMessage struct {
	URI     string
	Headers map[string]string
	Body    []byte
}

type RegisterResponse struct {
	StatusCode int
	Reason     string
	Headers    map[string][]string
	Body       []byte
	RetryAfter time.Duration
}

type SIPRegisterTransport interface {
	RoundTripRegister(context.Context, RegisterMessage) (RegisterResponse, error)
}

type SecurityPlanInstaller interface {
	InstallSecurityPlan(context.Context, IMSSecurityAssociationPlan) error
}

type SecurityPlanRequestInstaller interface {
	InstallSecurityPlanRequest(context.Context, IMSSecurityAssociationInstallRequest) error
}

type SecurityAssociationTransport interface {
	UseSecurityAssociation(context.Context, IMSSecurityAssociationInstallRequest) error
}

type akaPreferenceProvider interface {
	CalculateAKAWithPreference(rand16, autn16 []byte, preference string) (sim.AKAResult, error)
}

type RegisterSession struct {
	Transport             SIPRegisterTransport
	AKAProvider           sim.AKAProvider
	AKAAppPreference      string
	Profile               IMSProfile
	RegistrarURI          string
	ContactURI            string
	CallID                string
	CNonce                string
	Expires               int
	SecurityClient        SecurityAgreement
	SecurityClients       []SecurityAgreement
	SecurityRandom        io.Reader
	SecurityPlanInstaller SecurityPlanInstaller
	SecurityLocalAddr     string
	SecurityRemoteAddr    string
}

type RegisterResult struct {
	Registered     bool
	StatusCode     int
	Reason         string
	Attempts       int
	RetryAfter     time.Duration
	FailureInfo    RegistrationFailureInfo
	Challenge      DigestChallenge
	Binding        RegistrationBinding
	AuthHeader     string
	AuthHeaderName string
	AuthState      DigestAuthState
	NextCSeq       int
}

type DeregisterRequest struct {
	Binding        RegistrationBinding
	CallID         string
	CSeq           int
	AuthHeader     string
	AuthHeaderName string
	AuthState      DigestAuthState
}

type DeregisterResult struct {
	Deregistered bool
	StatusCode   int
	Reason       string
	Attempts     int
	RetryAfter   time.Duration
	FailureInfo  RegistrationFailureInfo
}

type RefreshRequest struct {
	Binding        RegistrationBinding
	CallID         string
	CSeq           int
	Expires        int
	AuthHeader     string
	AuthHeaderName string
	AuthState      DigestAuthState
}

type RefreshResult struct {
	Refreshed      bool
	StatusCode     int
	Reason         string
	Attempts       int
	RetryAfter     time.Duration
	FailureInfo    RegistrationFailureInfo
	Binding        RegistrationBinding
	AuthHeader     string
	AuthHeaderName string
	AuthState      DigestAuthState
	NextCSeq       int
}

type RegistrationFailureInfo struct {
	StatusCode   int
	ReasonPhrase string
	RetryAfter   time.Duration
	Warnings     []string
	Reasons      []string
}

type RegistrationRecoveryAction string

const (
	RegistrationRecoveryActionNone            RegistrationRecoveryAction = "none"
	RegistrationRecoveryActionAuthenticate    RegistrationRecoveryAction = "authenticate"
	RegistrationRecoveryActionRetryMinExpires RegistrationRecoveryAction = "retry_min_expires"
	RegistrationRecoveryActionRefreshIdentity RegistrationRecoveryAction = "refresh_identity"
	RegistrationRecoveryActionBackoffRetry    RegistrationRecoveryAction = "backoff_retry"
	RegistrationRecoveryActionRefreshSecurity RegistrationRecoveryAction = "refresh_security"
)

// RegistrationRecoveryPlan is a pure-data recovery decision for a SIP REGISTER
// response. It is safe to persist or hand to a supervising runtime before the
// next REGISTER attempt is built.
type RegistrationRecoveryPlan struct {
	StatusCode                  int
	Action                      RegistrationRecoveryAction
	Recoverable                 bool
	Retry                       bool
	Terminal                    bool
	AuthenticationRefreshNeeded bool
	IdentityRefreshNeeded       bool
	RegistrationRecoveryNeeded  bool
	SecurityAssociationNeeded   bool
	ChallengeHeaderName         string
	AuthorizationHeaderName     string
	ChallengeHeader             string
	Challenge                   DigestChallenge
	ChallengeValid              bool
	SecurityVerify              string
	SecurityServer              []string
	RequestedExpires            int
	MinExpires                  int
	NextExpires                 int
	RetryAfter                  time.Duration
	RetryAfterPresent           bool
	NextAttemptAt               time.Time
	FailureInfo                 RegistrationFailureInfo
	Reason                      string
}

func ParseWWWAuthenticate(header string) (DigestChallenge, error) {
	var firstErr error
	for _, header := range digestChallengeHeaderValues(header) {
		ch, err := parseDigestChallenge(header)
		if err == nil {
			return ch, nil
		}
		if firstErr == nil {
			firstErr = err
		}
	}
	if firstErr != nil {
		return DigestChallenge{}, firstErr
	}
	return DigestChallenge{}, ErrInvalidChallenge
}

func parseDigestChallenge(header string) (DigestChallenge, error) {
	header = strings.TrimSpace(header)
	if header == "" {
		return DigestChallenge{}, ErrInvalidChallenge
	}
	scheme, rest, ok := strings.Cut(header, " ")
	if !ok {
		return DigestChallenge{}, ErrInvalidChallenge
	}
	ch := DigestChallenge{Scheme: strings.TrimSpace(scheme)}
	if !strings.EqualFold(ch.Scheme, "Digest") {
		return DigestChallenge{}, ErrInvalidChallenge
	}
	for _, part := range splitAuthParams(rest) {
		key, value, ok := strings.Cut(part, "=")
		if !ok {
			continue
		}
		key = strings.ToLower(strings.TrimSpace(key))
		value = unquote(strings.TrimSpace(value))
		switch key {
		case "realm":
			ch.Realm = value
		case "nonce":
			ch.Nonce = value
		case "algorithm":
			ch.Algorithm = value
		case "qop":
			ch.QOP = firstQOP(value)
		case "opaque":
			ch.Opaque = value
		case "stale":
			ch.Stale = strings.EqualFold(value, "true")
		}
	}
	if ch.Realm == "" || ch.Nonce == "" {
		return DigestChallenge{}, ErrInvalidChallenge
	}
	if ch.Algorithm == "" {
		ch.Algorithm = "MD5"
	}
	return ch, nil
}

func ParseDigestAuthorization(header string) (DigestAuthorization, error) {
	header = strings.TrimSpace(header)
	if header == "" {
		return DigestAuthorization{}, ErrInvalidAuthorization
	}
	scheme, rest, ok := strings.Cut(header, " ")
	if !ok {
		return DigestAuthorization{}, ErrInvalidAuthorization
	}
	auth := DigestAuthorization{Scheme: strings.TrimSpace(scheme)}
	if !strings.EqualFold(auth.Scheme, "Digest") {
		return DigestAuthorization{}, ErrInvalidAuthorization
	}
	for _, part := range splitAuthParams(rest) {
		key, value, ok := strings.Cut(part, "=")
		if !ok {
			continue
		}
		key = strings.ToLower(strings.TrimSpace(key))
		value = unquote(strings.TrimSpace(value))
		switch key {
		case "username":
			auth.Username = value
		case "realm":
			auth.Realm = value
		case "nonce":
			auth.Nonce = value
		case "uri":
			auth.URI = value
		case "response":
			auth.Response = strings.ToLower(strings.TrimSpace(value))
		case "algorithm":
			auth.Algorithm = value
		case "qop":
			auth.QOP = strings.ToLower(strings.TrimSpace(value))
		case "nc":
			ncText := strings.ToLower(strings.TrimSpace(value))
			nc, err := parseDigestNonceCount(ncText)
			if err != nil {
				return DigestAuthorization{}, err
			}
			auth.NCText = ncText
			auth.NC = nc
		case "cnonce":
			auth.CNonce = value
		case "opaque":
			auth.Opaque = value
		case "auts":
			auts, err := decodeDigestAUTS(value)
			if err != nil {
				return DigestAuthorization{}, err
			}
			auth.AUTS = auts
		}
	}
	if auth.Username == "" || auth.Realm == "" || auth.Nonce == "" || auth.URI == "" || auth.Response == "" {
		return DigestAuthorization{}, ErrInvalidAuthorization
	}
	if auth.Algorithm == "" {
		auth.Algorithm = "MD5"
	}
	if !validDigestHex(auth.Response, digestResponseHexLength(auth.Algorithm)) {
		return DigestAuthorization{}, fmt.Errorf("%w: invalid response", ErrInvalidAuthorization)
	}
	if auth.QOP != "" && (auth.NC <= 0 || auth.CNonce == "") {
		return DigestAuthorization{}, ErrInvalidAuthorization
	}
	if auth.QOP == "" && digestAlgorithmNeedsCNonce(auth.Algorithm) && auth.CNonce == "" {
		return DigestAuthorization{}, ErrInvalidAuthorization
	}
	return auth, nil
}

func VerifyDigestAuthorization(header string, ch DigestChallenge, in DigestAuthInput) (DigestAuthorization, bool, error) {
	auth, err := ParseDigestAuthorization(header)
	if err != nil {
		return DigestAuthorization{}, false, err
	}
	if ch.Realm == "" || ch.Nonce == "" {
		return auth, false, ErrInvalidChallenge
	}
	algorithm := strings.TrimSpace(ch.Algorithm)
	if algorithm == "" {
		algorithm = "MD5"
	}
	if !strings.EqualFold(auth.Algorithm, algorithm) ||
		auth.Realm != ch.Realm ||
		auth.Nonce != ch.Nonce ||
		(ch.Opaque != "" && auth.Opaque != ch.Opaque) {
		return auth, false, nil
	}
	qop := firstQOP(ch.QOP)
	if qop != auth.QOP {
		return auth, false, nil
	}
	if expected := strings.TrimSpace(in.Username); expected != "" && expected != auth.Username {
		return auth, false, nil
	}
	if expected := strings.TrimSpace(in.URI); expected != "" && expected != auth.URI {
		return auth, false, nil
	}
	if qop != "" {
		if expected := strings.TrimSpace(in.CNonce); expected != "" && expected != auth.CNonce {
			return auth, false, nil
		}
		if in.NC > 0 && in.NC != auth.NC {
			return auth, false, nil
		}
	} else if digestAlgorithmNeedsCNonce(algorithm) {
		if auth.CNonce == "" {
			return auth, false, nil
		}
		if expected := strings.TrimSpace(in.CNonce); expected != "" && expected != auth.CNonce {
			return auth, false, nil
		}
	}
	if len(auth.AUTS) > 0 && len(in.AUTS) == 0 {
		return auth, false, nil
	}
	if len(in.AUTS) > 0 && !bytes.Equal(in.AUTS, auth.AUTS) {
		return auth, false, nil
	}
	input := cloneDigestAuthInput(in)
	input.Username = auth.Username
	input.URI = auth.URI
	input.CNonce = auth.CNonce
	input.NC = auth.NC
	input.AUTS = append([]byte(nil), auth.AUTS...)
	expected, err := BuildDigestAuthorization(ch, input)
	if err != nil {
		return auth, false, err
	}
	expectedAuth, err := ParseDigestAuthorization(expected)
	if err != nil {
		return auth, false, err
	}
	return auth, strings.EqualFold(auth.Response, expectedAuth.Response), nil
}

func ExtractAKAChallengeNonce(nonce string) (rand16, autn16 []byte, ok bool) {
	raw, ok := decodeNonceBytes(nonce)
	if !ok || len(raw) < 32 {
		return nil, nil, false
	}
	return append([]byte(nil), raw[:16]...), append([]byte(nil), raw[16:32]...), true
}

func BuildDigestAuthorization(ch DigestChallenge, in DigestAuthInput) (string, error) {
	method := strings.ToUpper(strings.TrimSpace(in.Method))
	uri := strings.TrimSpace(in.URI)
	username := strings.TrimSpace(in.Username)
	if method == "" || uri == "" || username == "" || ch.Realm == "" || ch.Nonce == "" {
		return "", ErrInvalidChallenge
	}
	algorithm := strings.TrimSpace(ch.Algorithm)
	if algorithm == "" {
		algorithm = "MD5"
	}
	if !digestAlgorithmBuildSupported(algorithm) {
		return "", fmt.Errorf("unsupported digest algorithm %q", algorithm)
	}

	password := in.Password
	if len(in.AUTS) > 0 {
		password = ""
	}
	qop := firstQOP(ch.QOP)
	cnonce := strings.TrimSpace(in.CNonce)
	ha1, err := digestHA1(algorithm, username, ch.Realm, password, ch.Nonce, cnonce)
	if err != nil {
		return "", err
	}
	ha2 := ""
	switch qop {
	case "":
		ha2 = digestHashHex(algorithm, method+":"+uri)
	case "auth":
		ha2 = digestHashHex(algorithm, method+":"+uri)
	case "auth-int":
		ha2 = digestHashHex(algorithm, method+":"+uri+":"+digestHashBytesHex(algorithm, in.Body))
	default:
		return "", fmt.Errorf("unsupported digest qop %q", qop)
	}
	response := ""
	nc := in.NC
	if nc <= 0 {
		nc = 1
	}
	ncText := fmt.Sprintf("%08x", nc)
	if qop != "" {
		if cnonce == "" {
			return "", errors.New("cnonce required when qop is present")
		}
		response = digestHashHex(algorithm, ha1+":"+ch.Nonce+":"+ncText+":"+cnonce+":"+qop+":"+ha2)
	} else {
		response = digestHashHex(algorithm, ha1+":"+ch.Nonce+":"+ha2)
	}

	parts := []string{
		`Digest username="` + quote(username) + `"`,
		`realm="` + quote(ch.Realm) + `"`,
		`nonce="` + quote(ch.Nonce) + `"`,
		`uri="` + quote(uri) + `"`,
		`response="` + response + `"`,
		`algorithm=` + algorithm,
	}
	if ch.Opaque != "" {
		parts = append(parts, `opaque="`+quote(ch.Opaque)+`"`)
	}
	if qop != "" {
		parts = append(parts, `qop=`+qop, `nc=`+ncText, `cnonce="`+quote(cnonce)+`"`)
	} else if digestAlgorithmNeedsCNonce(algorithm) {
		parts = append(parts, `cnonce="`+quote(cnonce)+`"`)
	}
	if len(in.AUTS) > 0 {
		parts = append(parts, `auts="`+base64.StdEncoding.EncodeToString(in.AUTS)+`"`)
	}
	return strings.Join(parts, ", "), nil
}

func (s DigestAuthState) Usable() bool {
	return strings.TrimSpace(s.challenge.Realm) != "" &&
		strings.TrimSpace(s.challenge.Nonce) != "" &&
		strings.TrimSpace(s.input.Username) != "" &&
		len(s.input.AUTS) == 0
}

func (s DigestAuthState) Build(method, uri string) (string, DigestAuthState, error) {
	return s.BuildWithBody(method, uri, nil)
}

func (s DigestAuthState) BuildWithBody(method, uri string, body []byte) (string, DigestAuthState, error) {
	if !s.Usable() {
		return "", s, ErrInvalidChallenge
	}
	next := s.clone()
	input := next.input
	if strings.TrimSpace(method) != "" {
		input.Method = strings.ToUpper(strings.TrimSpace(method))
	}
	if strings.TrimSpace(uri) != "" {
		input.URI = strings.TrimSpace(uri)
	}
	input.Body = append([]byte(nil), body...)
	nc := next.nextNC
	if nc <= 0 {
		nc = input.NC
	}
	if nc <= 0 {
		nc = 1
	}
	input.NC = nc
	authz, err := BuildDigestAuthorization(next.challenge, input)
	if err != nil {
		return "", s, err
	}
	next.input = input
	next.input.AUTS = append([]byte(nil), input.AUTS...)
	next.nextNC = nc + 1
	next.lastHeader = authz
	return authz, next, nil
}

func (s DigestAuthState) clone() DigestAuthState {
	s.input = cloneDigestAuthInput(s.input)
	return s
}

func newDigestAuthState(headerName string, ch DigestChallenge, input DigestAuthInput, authz string) DigestAuthState {
	nextNC := input.NC + 1
	if nextNC <= 1 {
		nextNC = 2
	}
	return DigestAuthState{
		challenge:  ch,
		input:      cloneDigestAuthInput(input),
		headerName: firstNonEmpty(headerName, "Authorization"),
		nextNC:     nextNC,
		lastHeader: strings.TrimSpace(authz),
	}
}

func cloneDigestAuthInput(input DigestAuthInput) DigestAuthInput {
	input.Body = append([]byte(nil), input.Body...)
	input.AUTS = append([]byte(nil), input.AUTS...)
	return input
}

func BuildAKADigestPassword(algorithm string, aka sim.AKAResult) (string, error) {
	switch strings.ToUpper(strings.TrimSpace(algorithm)) {
	case "AKAV1-MD5":
		if len(aka.RES) == 0 {
			return "", errors.New("AKA RES is empty")
		}
		return string(aka.RES), nil
	case "AKAV2-MD5":
		if len(aka.RES) == 0 || len(aka.CK) == 0 || len(aka.IK) == 0 {
			return "", errors.New("AKA RES/CK/IK required for AKAv2-MD5")
		}
		key := make([]byte, 0, len(aka.RES)+len(aka.IK)+len(aka.CK))
		key = append(key, aka.RES...)
		key = append(key, aka.IK...)
		key = append(key, aka.CK...)
		mac := hmac.New(md5.New, key)
		_, _ = mac.Write([]byte("http-digest-akav2-password"))
		return base64.StdEncoding.EncodeToString(mac.Sum(nil)), nil
	default:
		return "", fmt.Errorf("unsupported AKA digest algorithm %q", algorithm)
	}
}

func BuildRegisterHeaders(profile IMSProfile, contactURI, callID, cseq string) map[string]string {
	domain := strings.TrimSpace(profile.Domain)
	impu := strings.TrimSpace(profile.IMPU)
	if impu == "" && domain != "" {
		impu = "sip:" + strings.TrimSpace(profile.IMPI) + "@" + domain
	}
	headers := map[string]string{
		"To":                   "<" + impu + ">",
		"From":                 "<" + impu + ">;tag=vowifi-go",
		"Contact":              buildRegisterContactHeader(contactURI),
		"Call-ID":              strings.TrimSpace(callID),
		"CSeq":                 strings.TrimSpace(cseq) + " REGISTER",
		"Max-Forwards":         "70",
		"User-Agent":           firstNonEmpty(profile.UserAgent, "vowifi-go"),
		"Allow":                "INVITE, ACK, CANCEL, BYE, PRACK, UPDATE, INFO, MESSAGE, REFER, NOTIFY, SUBSCRIBE, OPTIONS",
		"Supported":            "path, gruu, outbound, sec-agree, 100rel, timer",
		"Require":              "sec-agree",
		"P-Preferred-Identity": "<" + impu + ">",
		"Security-Client":      BuildSecurityClientHeader(DefaultSecurityClientAgreement(nil)),
	}
	if accessNetworkInfo := strings.TrimSpace(profile.AccessNetworkInfo); accessNetworkInfo != "" {
		headers["P-Access-Network-Info"] = accessNetworkInfo
	}
	if visitedNetworkID := formatVisitedNetworkIDHeader(profile.VisitedNetworkID); visitedNetworkID != "" {
		headers["P-Visited-Network-ID"] = visitedNetworkID
	}
	return headers
}

func buildRegisterContactHeader(contactURI string) string {
	contact := "<" + strings.TrimSpace(contactURI) + ">;+sip.instance=\"<urn:uuid:vowifi-go>\""
	if imsMMTelContactFeature != "" {
		contact += ";" + imsMMTelContactFeature
	}
	return contact
}

func formatVisitedNetworkIDHeader(value string) string {
	value = strings.TrimSpace(value)
	if value == "" || strings.ContainsAny(value, "\r\n") {
		return ""
	}
	if strings.Contains(value, ",") || (strings.HasPrefix(value, `"`) && strings.HasSuffix(value, `"`)) {
		return value
	}
	return quoteSIPQuotedString(value)
}

func quoteSIPQuotedString(value string) string {
	var b strings.Builder
	b.WriteByte('"')
	for _, r := range value {
		if r == '\\' || r == '"' {
			b.WriteByte('\\')
		}
		b.WriteRune(r)
	}
	b.WriteByte('"')
	return b.String()
}

func (s RegisterSession) Register(ctx context.Context) (RegisterResult, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	if s.Transport == nil {
		return RegisterResult{}, errors.New("nil SIP register transport")
	}
	registrarURI := strings.TrimSpace(s.RegistrarURI)
	contactURI := strings.TrimSpace(s.ContactURI)
	if registrarURI == "" || contactURI == "" {
		return RegisterResult{}, errors.New("registrar URI and contact URI are required")
	}
	callID := firstNonEmpty(s.CallID, "vowifi-go-register")
	expires := s.Expires
	if expires <= 0 {
		expires = 3600
	}
	securityClients := s.securityClientAgreements()
	securityClientHeader := BuildSecurityClientHeaderList(securityClients)

	attempts := 0
	cseq := 1
	sendRegister := func(cseq int, authHeaderName, authz string, challengeHeaders map[string][]string) (RegisterResponse, error) {
		msg := RegisterMessage{
			URI:     registrarURI,
			Headers: BuildRegisterHeaders(s.Profile, contactURI, callID, strconv.Itoa(cseq)),
		}
		msg.Headers["Expires"] = strconv.Itoa(expires)
		msg.Headers["Security-Client"] = securityClientHeader
		if strings.TrimSpace(authHeaderName) != "" && strings.TrimSpace(authz) != "" {
			msg.Headers[authHeaderName] = authz
		}
		if securityVerify := securityVerifyFromChallenge(challengeHeaders); securityVerify != "" {
			msg.Headers["Security-Verify"] = securityVerify
		}
		attempts++
		return s.Transport.RoundTripRegister(ctx, cloneRegisterMessage(msg))
	}
	retryMinExpires := func(resp RegisterResponse, authHeaderName, authz string, challengeHeaders map[string][]string, authInput *DigestAuthInput, ch DigestChallenge) (RegisterResponse, string, bool, error) {
		if resp.StatusCode != 423 {
			return resp, authz, false, nil
		}
		minExpires := minExpiresHeader(resp.Headers)
		if minExpires <= expires {
			return resp, authz, false, nil
		}
		expires = minExpires
		nextAuthz := authz
		if authInput != nil {
			authInput.NC++
			var err error
			nextAuthz, err = BuildDigestAuthorization(ch, *authInput)
			if err != nil {
				return resp, authz, true, err
			}
		}
		cseq++
		nextResp, err := sendRegister(cseq, authHeaderName, nextAuthz, challengeHeaders)
		return nextResp, nextAuthz, true, err
	}

	resp, err := sendRegister(cseq, "", "", nil)
	if err != nil {
		return RegisterResult{}, err
	}
	resp, _, _, err = retryMinExpires(resp, "", "", nil, nil, DigestChallenge{})
	if err != nil {
		return RegisterResult{Attempts: attempts}, err
	}
	if isSIPSuccess(resp.StatusCode) {
		return RegisterResult{
			Registered: true,
			StatusCode: resp.StatusCode,
			Reason:     resp.Reason,
			Attempts:   attempts,
			Binding:    buildRegistrationBindingForClients(s.Profile, contactURI, resp, expires, securityClients, nil),
			NextCSeq:   cseq + 1,
		}, nil
	}
	if resp.StatusCode != 401 && resp.StatusCode != 407 {
		return registerFailureResult(resp, attempts, DigestChallenge{}, ""), fmt.Errorf("%w: %d %s", ErrRegistrationRejected, resp.StatusCode, resp.Reason)
	}

	headerName := "WWW-Authenticate"
	authHeader := firstHeader(resp.Headers, headerName)
	authzHeader := "Authorization"
	if authHeader == "" {
		headerName = "Proxy-Authenticate"
		authHeader = firstHeader(resp.Headers, headerName)
		authzHeader = "Proxy-Authorization"
	}
	ch, err := SelectDigestChallenge(resp.Headers, headerName)
	if err != nil {
		return registerFailureResult(resp, attempts, DigestChallenge{}, ""), err
	}
	securityHeaders := resp.Headers

	authzInput, syncFailure, akaKeys, err := s.digestAuthInputForChallenge(ch, registrarURI)
	if err != nil {
		return registerFailureResult(resp, attempts, ch, ""), err
	}
	currentAuthInput := authzInput
	authz, err := BuildDigestAuthorization(ch, authzInput)
	if err != nil {
		return registerFailureResult(resp, attempts, ch, ""), err
	}
	securityReq, securityOK, err := s.installChallengeSecurityPlan(ctx, resp.Headers, securityClients, akaKeys)
	if err != nil {
		result := registerFailureResult(resp, attempts, ch, authz)
		result.AuthHeaderName = authzHeader
		return result, err
	}
	if err := s.useChallengeSecurityAssociation(ctx, securityReq, securityOK); err != nil {
		result := registerFailureResult(resp, attempts, ch, authz)
		result.AuthHeaderName = authzHeader
		return result, err
	}

	cseq++
	resp2, err := sendRegister(cseq, authzHeader, authz, resp.Headers)
	if err != nil {
		return RegisterResult{Attempts: attempts, Challenge: ch}, err
	}
	resp2, authz, _, err = retryMinExpires(resp2, authzHeader, authz, resp.Headers, &authzInput, ch)
	if err != nil {
		return RegisterResult{Attempts: attempts, Challenge: ch, AuthHeader: authz}, err
	}
	currentAuthInput = authzInput
	if syncFailure {
		if isSIPSuccess(resp2.StatusCode) {
			authState := newDigestAuthState(authzHeader, ch, currentAuthInput, authz)
			authState, err = updateDigestAuthStateFromInfo(authState, resp2.Headers, authzHeader, resp2.Body)
			binding := bindDigestAuthWithChallengeInput(buildRegistrationBindingForClients(s.Profile, contactURI, resp2, expires, securityClients, securityHeaders), authzHeader, authz, authState, s.digestChallengeInputFunc())
			result := RegisterResult{
				Registered:     true,
				StatusCode:     resp2.StatusCode,
				Reason:         resp2.Reason,
				Attempts:       attempts,
				Challenge:      ch,
				Binding:        binding,
				AuthHeader:     authz,
				AuthHeaderName: authzHeader,
				AuthState:      authState,
				NextCSeq:       cseq + 1,
			}
			if err != nil {
				result.Registered = false
				return result, err
			}
			return result, nil
		}
		if resp2.StatusCode != 401 && resp2.StatusCode != 407 {
			return registerFailureResult(resp2, attempts, ch, authz), fmt.Errorf("%w: %d %s", ErrRegistrationRejected, resp2.StatusCode, resp2.Reason)
		}
		nextHeaderName := "WWW-Authenticate"
		nextAuthzHeader := "Authorization"
		if firstHeader(resp2.Headers, nextHeaderName) == "" {
			nextHeaderName = "Proxy-Authenticate"
			nextAuthzHeader = "Proxy-Authorization"
		}
		nextChallenge, err := SelectDigestChallenge(resp2.Headers, nextHeaderName)
		if err != nil {
			return registerFailureResult(resp2, attempts, ch, authz), err
		}
		nextAuthInput, nextSyncFailure, nextAKAKeys, err := s.digestAuthInputForChallenge(nextChallenge, registrarURI)
		if err != nil {
			return registerFailureResult(resp2, attempts, nextChallenge, authz), err
		}
		if nextSyncFailure {
			return registerFailureResult(resp2, attempts, nextChallenge, authz), sim.ErrSyncFailure
		}
		authz, err = BuildDigestAuthorization(nextChallenge, nextAuthInput)
		if err != nil {
			return registerFailureResult(resp2, attempts, nextChallenge, authz), err
		}
		ch = nextChallenge
		authzHeader = nextAuthzHeader
		currentAuthInput = nextAuthInput
		nextChallengeHeaders := resp2.Headers
		securityHeaders = nextChallengeHeaders
		securityReq, securityOK, err := s.installChallengeSecurityPlan(ctx, nextChallengeHeaders, securityClients, nextAKAKeys)
		if err != nil {
			result := registerFailureResult(resp2, attempts, ch, authz)
			result.AuthHeaderName = authzHeader
			return result, err
		}
		if err := s.useChallengeSecurityAssociation(ctx, securityReq, securityOK); err != nil {
			result := registerFailureResult(resp2, attempts, ch, authz)
			result.AuthHeaderName = authzHeader
			return result, err
		}
		cseq++
		resp2, err = sendRegister(cseq, authzHeader, authz, nextChallengeHeaders)
		if err != nil {
			return RegisterResult{Attempts: attempts, Challenge: ch, AuthHeader: authz}, err
		}
		resp2, authz, _, err = retryMinExpires(resp2, authzHeader, authz, nextChallengeHeaders, &nextAuthInput, ch)
		if err != nil {
			return RegisterResult{Attempts: attempts, Challenge: ch, AuthHeader: authz}, err
		}
		currentAuthInput = nextAuthInput
	}
	result := RegisterResult{
		Registered:     isSIPSuccess(resp2.StatusCode),
		StatusCode:     resp2.StatusCode,
		Reason:         resp2.Reason,
		Attempts:       attempts,
		RetryAfter:     SIPResponseRetryAfter(resp2),
		Challenge:      ch,
		Binding:        buildRegistrationBindingForClients(s.Profile, contactURI, resp2, expires, securityClients, securityHeaders),
		AuthHeader:     authz,
		AuthHeaderName: authzHeader,
		AuthState:      newDigestAuthState(authzHeader, ch, currentAuthInput, authz),
		NextCSeq:       cseq + 1,
	}
	if !result.Registered {
		result.FailureInfo = ParseRegistrationFailureInfo(resp2)
		return result, fmt.Errorf("%w: %d %s", ErrRegistrationRejected, resp2.StatusCode, resp2.Reason)
	}
	result.AuthState, err = updateDigestAuthStateFromInfo(result.AuthState, resp2.Headers, authzHeader, resp2.Body)
	if err != nil {
		result.Registered = false
		return result, err
	}
	result.Binding = bindDigestAuthWithChallengeInput(result.Binding, authzHeader, authz, result.AuthState, s.digestChallengeInputFunc())
	return result, nil
}

func registerFailureResult(resp RegisterResponse, attempts int, ch DigestChallenge, authHeader string) RegisterResult {
	return RegisterResult{
		StatusCode:  resp.StatusCode,
		Reason:      resp.Reason,
		Attempts:    attempts,
		RetryAfter:  SIPResponseRetryAfter(resp),
		FailureInfo: ParseRegistrationFailureInfo(resp),
		Challenge:   ch,
		AuthHeader:  authHeader,
	}
}

func ParseRegistrationFailureInfo(resp RegisterResponse) RegistrationFailureInfo {
	return RegistrationFailureInfo{
		StatusCode:   resp.StatusCode,
		ReasonPhrase: strings.TrimSpace(resp.Reason),
		RetryAfter:   SIPResponseRetryAfter(resp),
		Warnings:     trimHeaderValues(headerListValues(resp.Headers, "Warning")),
		Reasons:      trimHeaderValues(headerListValues(resp.Headers, "Reason")),
	}
}

// PlanRegistrationRecovery classifies a final SIP REGISTER response into the
// next recovery step a runtime should prepare. currentExpires is the Expires
// value used for the failed REGISTER; it is used to decide whether a 423
// Min-Expires response can be retried.
func PlanRegistrationRecovery(resp RegisterResponse, currentExpires int, now time.Time) RegistrationRecoveryPlan {
	retryAfter, retryAfterPresent := registerResponseRetryAfter(resp)
	plan := RegistrationRecoveryPlan{
		StatusCode:        resp.StatusCode,
		Action:            RegistrationRecoveryActionNone,
		Terminal:          true,
		RequestedExpires:  currentExpires,
		RetryAfter:        retryAfter,
		RetryAfterPresent: retryAfterPresent,
		FailureInfo:       ParseRegistrationFailureInfo(resp),
		Reason:            strings.TrimSpace(resp.Reason),
		SecurityServer:    securityServerHeaderValues(resp.Headers),
		SecurityVerify:    securityVerifyFromChallenge(resp.Headers),
	}
	if plan.Reason == "" && resp.StatusCode > 0 {
		plan.Reason = strconv.Itoa(resp.StatusCode)
	}
	switch {
	case isSIPSuccess(resp.StatusCode):
		return plan
	case resp.StatusCode == 401 || resp.StatusCode == 407:
		plan.Action = RegistrationRecoveryActionAuthenticate
		plan.AuthenticationRefreshNeeded = true
		plan.SecurityAssociationNeeded = len(plan.SecurityServer) > 0
		plan.ChallengeHeaderName, plan.AuthorizationHeaderName = registerAuthenticationHeaderNames(resp)
		plan.ChallengeHeader = firstHeader(resp.Headers, plan.ChallengeHeaderName)
		challenge, err := SelectDigestChallenge(resp.Headers, plan.ChallengeHeaderName)
		if err != nil {
			plan.Reason = firstNonEmpty(strings.TrimSpace(err.Error()), plan.Reason)
			return plan
		}
		plan.Challenge = challenge
		plan.ChallengeValid = true
		plan.Recoverable = true
		plan.Retry = true
		plan.Terminal = false
	case resp.StatusCode == 423:
		plan.MinExpires = minExpiresHeader(resp.Headers)
		plan.NextExpires = plan.MinExpires
		if plan.MinExpires > 0 && (currentExpires <= 0 || plan.MinExpires > currentExpires) {
			plan.Action = RegistrationRecoveryActionRetryMinExpires
			plan.Recoverable = true
			plan.Retry = true
			plan.Terminal = false
		}
	case resp.StatusCode == 403:
		plan.Action = RegistrationRecoveryActionRefreshIdentity
		plan.IdentityRefreshNeeded = true
	case resp.StatusCode == 494:
		plan.Action = RegistrationRecoveryActionRefreshSecurity
		plan.SecurityAssociationNeeded = true
		plan.Retry = len(plan.SecurityServer) > 0
		plan.Recoverable = plan.Retry
		plan.Terminal = !plan.Retry
	case registerResponseNeedsBackoffRecovery(resp.StatusCode):
		plan.Action = RegistrationRecoveryActionBackoffRetry
		plan.Recoverable = true
		plan.Retry = true
		plan.Terminal = false
		plan.RegistrationRecoveryNeeded = true
	}
	if plan.Retry && retryAfterPresent && !now.IsZero() {
		plan.NextAttemptAt = now.Add(retryAfter)
	}
	return plan
}

func deregisterFailureResult(resp RegisterResponse, attempts int) DeregisterResult {
	return DeregisterResult{
		StatusCode:  resp.StatusCode,
		Reason:      resp.Reason,
		Attempts:    attempts,
		RetryAfter:  SIPResponseRetryAfter(resp),
		FailureInfo: ParseRegistrationFailureInfo(resp),
	}
}

func refreshFailureResult(resp RegisterResponse, attempts int, authHeader, authHeaderName string, authState DigestAuthState) RefreshResult {
	return RefreshResult{
		StatusCode:     resp.StatusCode,
		Reason:         resp.Reason,
		Attempts:       attempts,
		RetryAfter:     SIPResponseRetryAfter(resp),
		FailureInfo:    ParseRegistrationFailureInfo(resp),
		AuthHeader:     authHeader,
		AuthHeaderName: authHeaderName,
		AuthState:      authState,
	}
}

func (s RegisterSession) Deregister(ctx context.Context, req DeregisterRequest) (DeregisterResult, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	if s.Transport == nil {
		return DeregisterResult{}, errors.New("nil SIP register transport")
	}
	registrarURI := strings.TrimSpace(s.RegistrarURI)
	contactURI := firstNonEmpty(req.Binding.ContactURI, s.ContactURI)
	if registrarURI == "" || contactURI == "" {
		return DeregisterResult{}, errors.New("registrar URI and contact URI are required")
	}
	callID := firstNonEmpty(req.CallID, s.CallID, "vowifi-go-register")
	cseq := req.CSeq
	if cseq <= 0 {
		cseq = 1
	}
	attempts := 0
	sendDeregister := func(cseq int, authHeaderName, authz string, challengeHeaders map[string][]string) (RegisterResponse, error) {
		msg := RegisterMessage{
			URI:     registrarURI,
			Headers: BuildRegisterHeaders(s.Profile, contactURI, callID, strconv.Itoa(cseq)),
		}
		msg.Headers["Expires"] = "0"
		msg.Headers["Contact"] = deregisterContactHeader(msg.Headers["Contact"])
		if securityClient := strings.TrimSpace(req.Binding.SecurityClient); securityClient != "" {
			msg.Headers["Security-Client"] = securityClient
		}
		if strings.TrimSpace(authHeaderName) != "" && strings.TrimSpace(authz) != "" {
			msg.Headers[authHeaderName] = authz
		}
		if securityVerify := securityVerifyFromChallenge(challengeHeaders); securityVerify != "" {
			msg.Headers["Security-Verify"] = securityVerify
		} else if len(req.Binding.SecurityVerify) > 0 {
			msg.Headers["Security-Verify"] = strings.Join(trimHeaderValues(req.Binding.SecurityVerify), ", ")
		}
		attempts++
		return s.Transport.RoundTripRegister(ctx, cloneRegisterMessage(msg))
	}
	authHeaderName, authz, _, err := nextDigestAuthorization(req.AuthState, "REGISTER", registrarURI, req.AuthHeaderName, req.AuthHeader)
	if err != nil {
		return DeregisterResult{Attempts: attempts}, err
	}
	resp, err := sendDeregister(cseq, authHeaderName, authz, nil)
	if err != nil {
		return DeregisterResult{Attempts: attempts}, err
	}
	if isSIPSuccess(resp.StatusCode) {
		return DeregisterResult{Deregistered: true, StatusCode: resp.StatusCode, Reason: resp.Reason, Attempts: attempts}, nil
	}
	if resp.StatusCode != 401 && resp.StatusCode != 407 {
		result := deregisterFailureResult(resp, attempts)
		return result, fmt.Errorf("%w: deregister %d %s", ErrRegistrationRejected, resp.StatusCode, resp.Reason)
	}
	ch, authHeaderName, err := registerDigestChallenge(resp.Headers)
	if err != nil {
		return deregisterFailureResult(resp, attempts), err
	}
	authInput, syncFailure, akaKeys, err := s.digestAuthInputForChallenge(ch, registrarURI)
	if err != nil {
		return deregisterFailureResult(resp, attempts), err
	}
	authz, err = BuildDigestAuthorization(ch, authInput)
	if err != nil {
		return deregisterFailureResult(resp, attempts), err
	}
	securityReq, securityOK, err := s.installChallengeSecurityPlan(ctx, resp.Headers, securityClientsFromBinding(req.Binding), akaKeys)
	if err != nil {
		return deregisterFailureResult(resp, attempts), err
	}
	if err := s.useChallengeSecurityAssociation(ctx, securityReq, securityOK); err != nil {
		return deregisterFailureResult(resp, attempts), err
	}
	cseq++
	resp2, err := sendDeregister(cseq, authHeaderName, authz, resp.Headers)
	if err != nil {
		return DeregisterResult{Attempts: attempts}, err
	}
	if syncFailure && !isSIPSuccess(resp2.StatusCode) {
		if resp2.StatusCode != 401 && resp2.StatusCode != 407 {
			result := deregisterFailureResult(resp2, attempts)
			return result, fmt.Errorf("%w: deregister %d %s", ErrRegistrationRejected, resp2.StatusCode, resp2.Reason)
		}
		ch, authHeaderName, err = registerDigestChallenge(resp2.Headers)
		if err != nil {
			return deregisterFailureResult(resp2, attempts), err
		}
		authInput, syncFailure, akaKeys, err = s.digestAuthInputForChallenge(ch, registrarURI)
		if err != nil {
			return deregisterFailureResult(resp2, attempts), err
		}
		if syncFailure {
			return deregisterFailureResult(resp2, attempts), sim.ErrSyncFailure
		}
		authz, err = BuildDigestAuthorization(ch, authInput)
		if err != nil {
			return deregisterFailureResult(resp2, attempts), err
		}
		securityReq, securityOK, err = s.installChallengeSecurityPlan(ctx, resp2.Headers, securityClientsFromBinding(req.Binding), akaKeys)
		if err != nil {
			return deregisterFailureResult(resp2, attempts), err
		}
		if err := s.useChallengeSecurityAssociation(ctx, securityReq, securityOK); err != nil {
			return deregisterFailureResult(resp2, attempts), err
		}
		cseq++
		resp2, err = sendDeregister(cseq, authHeaderName, authz, resp2.Headers)
		if err != nil {
			return DeregisterResult{Attempts: attempts}, err
		}
	}
	result := DeregisterResult{Deregistered: isSIPSuccess(resp2.StatusCode), StatusCode: resp2.StatusCode, Reason: resp2.Reason, Attempts: attempts, RetryAfter: SIPResponseRetryAfter(resp2)}
	if !result.Deregistered {
		result.FailureInfo = ParseRegistrationFailureInfo(resp2)
		return result, fmt.Errorf("%w: deregister %d %s", ErrRegistrationRejected, resp2.StatusCode, resp2.Reason)
	}
	return result, nil
}

func (s RegisterSession) Refresh(ctx context.Context, req RefreshRequest) (RefreshResult, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	if s.Transport == nil {
		return RefreshResult{}, errors.New("nil SIP register transport")
	}
	registrarURI := strings.TrimSpace(s.RegistrarURI)
	contactURI := firstNonEmpty(req.Binding.ContactURI, s.ContactURI)
	if registrarURI == "" || contactURI == "" {
		return RefreshResult{}, errors.New("registrar URI and contact URI are required")
	}
	callID := firstNonEmpty(req.CallID, s.CallID, "vowifi-go-register")
	cseq := req.CSeq
	if cseq <= 0 {
		cseq = 1
	}
	expires := req.Expires
	if expires <= 0 {
		expires = req.Binding.Expires
	}
	if expires <= 0 {
		expires = s.Expires
	}
	if expires <= 0 {
		expires = 3600
	}
	attempts := 0
	sendRefresh := func(cseq int, authHeaderName, authz string, challengeHeaders map[string][]string) (RegisterResponse, error) {
		msg := RegisterMessage{
			URI:     registrarURI,
			Headers: BuildRegisterHeaders(s.Profile, contactURI, callID, strconv.Itoa(cseq)),
		}
		msg.Headers["Expires"] = strconv.Itoa(expires)
		if securityClient := strings.TrimSpace(req.Binding.SecurityClient); securityClient != "" {
			msg.Headers["Security-Client"] = securityClient
		}
		if strings.TrimSpace(authHeaderName) != "" && strings.TrimSpace(authz) != "" {
			msg.Headers[authHeaderName] = authz
		}
		if securityVerify := securityVerifyFromChallenge(challengeHeaders); securityVerify != "" {
			msg.Headers["Security-Verify"] = securityVerify
		} else if len(req.Binding.SecurityVerify) > 0 {
			msg.Headers["Security-Verify"] = strings.Join(trimHeaderValues(req.Binding.SecurityVerify), ", ")
		}
		attempts++
		return s.Transport.RoundTripRegister(ctx, cloneRegisterMessage(msg))
	}
	retryMinExpires := func(resp RegisterResponse, authHeaderName, authz string, authState DigestAuthState, challengeHeaders map[string][]string) (RegisterResponse, string, string, DigestAuthState, bool, error) {
		if resp.StatusCode != 423 {
			return resp, authHeaderName, authz, authState, false, nil
		}
		minExpires := minExpiresHeader(resp.Headers)
		if minExpires <= expires {
			return resp, authHeaderName, authz, authState, false, nil
		}
		expires = minExpires
		nextAuthHeaderName := authHeaderName
		nextAuthz := authz
		nextAuthState := authState
		if authState.Usable() {
			var err error
			nextAuthHeaderName, nextAuthz, nextAuthState, err = nextDigestAuthorization(authState, "REGISTER", registrarURI, authHeaderName, "")
			if err != nil {
				return resp, authHeaderName, authz, authState, true, err
			}
		}
		cseq++
		nextResp, err := sendRefresh(cseq, nextAuthHeaderName, nextAuthz, challengeHeaders)
		return nextResp, nextAuthHeaderName, nextAuthz, nextAuthState, true, err
	}
	authHeaderName, authz, authState, err := nextDigestAuthorization(req.AuthState, "REGISTER", registrarURI, req.AuthHeaderName, req.AuthHeader)
	if err != nil {
		return RefreshResult{Attempts: attempts}, err
	}
	resp, err := sendRefresh(cseq, authHeaderName, authz, nil)
	if err != nil {
		return RefreshResult{Attempts: attempts}, err
	}
	resp, authHeaderName, authz, authState, _, err = retryMinExpires(resp, authHeaderName, authz, authState, nil)
	if err != nil {
		return RefreshResult{Attempts: attempts, AuthHeader: authz, AuthHeaderName: authHeaderName, AuthState: authState}, err
	}
	if isSIPSuccess(resp.StatusCode) {
		binding := mergeRefreshBinding(req.Binding, buildRegistrationBindingForClients(s.Profile, contactURI, resp, expires, securityClientsFromBinding(req.Binding), nil))
		authState, err = updateDigestAuthStateFromInfo(authState, resp.Headers, authHeaderName, resp.Body)
		binding = bindDigestAuthWithChallengeInput(binding, authHeaderName, authz, authState, s.digestChallengeInputFunc())
		result := RefreshResult{
			Refreshed:      true,
			StatusCode:     resp.StatusCode,
			Reason:         resp.Reason,
			Attempts:       attempts,
			Binding:        binding,
			AuthHeader:     authz,
			AuthHeaderName: authHeaderName,
			AuthState:      authState,
			NextCSeq:       cseq + 1,
		}
		if err != nil {
			result.Refreshed = false
			return result, err
		}
		return result, nil
	}
	if resp.StatusCode != 401 && resp.StatusCode != 407 {
		result := refreshFailureResult(resp, attempts, "", "", DigestAuthState{})
		return result, fmt.Errorf("%w: refresh %d %s", ErrRegistrationRejected, resp.StatusCode, resp.Reason)
	}
	ch, authHeaderName, err := registerDigestChallenge(resp.Headers)
	if err != nil {
		return refreshFailureResult(resp, attempts, "", "", DigestAuthState{}), err
	}
	authInput, syncFailure, akaKeys, err := s.digestAuthInputForChallenge(ch, registrarURI)
	if err != nil {
		return refreshFailureResult(resp, attempts, "", "", DigestAuthState{}), err
	}
	authz, err = BuildDigestAuthorization(ch, authInput)
	if err != nil {
		return refreshFailureResult(resp, attempts, "", "", DigestAuthState{}), err
	}
	if syncFailure {
		authState = DigestAuthState{}
	} else {
		authState = newDigestAuthState(authHeaderName, ch, authInput, authz)
	}
	securityReq, securityOK, err := s.installChallengeSecurityPlan(ctx, resp.Headers, securityClientsFromBinding(req.Binding), akaKeys)
	if err != nil {
		return refreshFailureResult(resp, attempts, authz, authHeaderName, authState), err
	}
	if err := s.useChallengeSecurityAssociation(ctx, securityReq, securityOK); err != nil {
		return refreshFailureResult(resp, attempts, authz, authHeaderName, authState), err
	}
	cseq++
	resp2, err := sendRefresh(cseq, authHeaderName, authz, resp.Headers)
	if err != nil {
		return RefreshResult{Attempts: attempts}, err
	}
	challengeHeaders := resp.Headers
	if syncFailure && !isSIPSuccess(resp2.StatusCode) {
		if resp2.StatusCode != 401 && resp2.StatusCode != 407 {
			result := refreshFailureResult(resp2, attempts, authz, authHeaderName, authState)
			return result, fmt.Errorf("%w: refresh %d %s", ErrRegistrationRejected, resp2.StatusCode, resp2.Reason)
		}
		ch, authHeaderName, err = registerDigestChallenge(resp2.Headers)
		if err != nil {
			return refreshFailureResult(resp2, attempts, authz, authHeaderName, authState), err
		}
		authInput, syncFailure, akaKeys, err = s.digestAuthInputForChallenge(ch, registrarURI)
		if err != nil {
			return refreshFailureResult(resp2, attempts, authz, authHeaderName, authState), err
		}
		if syncFailure {
			return refreshFailureResult(resp2, attempts, authz, authHeaderName, authState), sim.ErrSyncFailure
		}
		authz, err = BuildDigestAuthorization(ch, authInput)
		if err != nil {
			return refreshFailureResult(resp2, attempts, authz, authHeaderName, authState), err
		}
		authState = newDigestAuthState(authHeaderName, ch, authInput, authz)
		challengeHeaders = resp2.Headers
		securityReq, securityOK, err = s.installChallengeSecurityPlan(ctx, challengeHeaders, securityClientsFromBinding(req.Binding), akaKeys)
		if err != nil {
			return refreshFailureResult(resp2, attempts, authz, authHeaderName, authState), err
		}
		if err := s.useChallengeSecurityAssociation(ctx, securityReq, securityOK); err != nil {
			return refreshFailureResult(resp2, attempts, authz, authHeaderName, authState), err
		}
		cseq++
		resp2, err = sendRefresh(cseq, authHeaderName, authz, challengeHeaders)
		if err != nil {
			return RefreshResult{Attempts: attempts, AuthHeader: authz, AuthHeaderName: authHeaderName, AuthState: authState}, err
		}
	}
	resp2, authHeaderName, authz, authState, _, err = retryMinExpires(resp2, authHeaderName, authz, authState, challengeHeaders)
	if err != nil {
		return RefreshResult{Attempts: attempts, AuthHeader: authz, AuthHeaderName: authHeaderName, AuthState: authState}, err
	}
	resultBinding := mergeRefreshBinding(req.Binding, buildRegistrationBindingForClients(s.Profile, contactURI, resp2, expires, securityClientsFromBinding(req.Binding), challengeHeaders))
	result := RefreshResult{
		Refreshed:      isSIPSuccess(resp2.StatusCode),
		StatusCode:     resp2.StatusCode,
		Reason:         resp2.Reason,
		Attempts:       attempts,
		RetryAfter:     SIPResponseRetryAfter(resp2),
		Binding:        resultBinding,
		AuthHeader:     authz,
		AuthHeaderName: authHeaderName,
		AuthState:      authState,
		NextCSeq:       cseq + 1,
	}
	if !result.Refreshed {
		result.FailureInfo = ParseRegistrationFailureInfo(resp2)
		return result, fmt.Errorf("%w: refresh %d %s", ErrRegistrationRejected, resp2.StatusCode, resp2.Reason)
	}
	result.AuthState, err = updateDigestAuthStateFromInfo(result.AuthState, resp2.Headers, authHeaderName, resp2.Body)
	if err != nil {
		result.Refreshed = false
		return result, err
	}
	result.Binding = bindDigestAuthWithChallengeInput(result.Binding, authHeaderName, authz, result.AuthState, s.digestChallengeInputFunc())
	return result, nil
}

func (s RegisterSession) securityClientAgreements() []SecurityAgreement {
	if len(s.SecurityClients) > 0 {
		return completeSecurityClientAgreements(s.SecurityClients, s.SecurityRandom)
	}
	if !isZeroSecurityAgreement(s.SecurityClient) {
		return []SecurityAgreement{completeSecurityClientAgreement(s.SecurityClient, s.SecurityRandom)}
	}
	return []SecurityAgreement{DefaultSecurityClientAgreement(s.SecurityRandom)}
}

func (s RegisterSession) installChallengeSecurityPlan(ctx context.Context, headers map[string][]string, clients []SecurityAgreement, akaKeys IMSSecurityAKAKeys) (IMSSecurityAssociationInstallRequest, bool, error) {
	agreement, plan, ok := securityPlanFromChallenge(headers, clients)
	if !ok {
		return IMSSecurityAssociationInstallRequest{}, false, nil
	}
	req := buildIMSSecurityAssociationInstallRequest(plan, agreement, akaKeys, s.SecurityLocalAddr, s.SecurityRemoteAddr, s.ContactURI, s.RegistrarURI)
	if s.SecurityPlanInstaller == nil {
		return req, false, nil
	}
	if requestInstaller, ok := s.SecurityPlanInstaller.(SecurityPlanRequestInstaller); ok {
		return req, true, requestInstaller.InstallSecurityPlanRequest(ctx, req)
	}
	return req, true, s.SecurityPlanInstaller.InstallSecurityPlan(ctx, plan)
}

func (s RegisterSession) useChallengeSecurityAssociation(ctx context.Context, req IMSSecurityAssociationInstallRequest, ok bool) error {
	if !ok {
		return nil
	}
	transport, ok := s.Transport.(SecurityAssociationTransport)
	if !ok {
		return nil
	}
	return transport.UseSecurityAssociation(ctx, req)
}

func nextDigestAuthorization(state DigestAuthState, method, uri, fallbackName, fallbackHeader string) (string, string, DigestAuthState, error) {
	return nextDigestAuthorizationWithBody(state, method, uri, nil, fallbackName, fallbackHeader)
}

func nextDigestAuthorizationWithBody(state DigestAuthState, method, uri string, body []byte, fallbackName, fallbackHeader string) (string, string, DigestAuthState, error) {
	headerName := firstNonEmpty(state.headerName, fallbackName, "Authorization")
	if state.Usable() {
		authz, next, err := state.BuildWithBody(method, uri, body)
		if err != nil {
			return headerName, "", state, err
		}
		return firstNonEmpty(next.headerName, headerName), authz, next, nil
	}
	return firstNonEmpty(fallbackName, headerName), strings.TrimSpace(fallbackHeader), state.clone(), nil
}

func registerDigestChallenge(headers map[string][]string) (DigestChallenge, string, error) {
	challengeHeader := "WWW-Authenticate"
	authHeaderName := "Authorization"
	if firstHeader(headers, challengeHeader) == "" {
		challengeHeader = "Proxy-Authenticate"
		authHeaderName = "Proxy-Authorization"
	}
	ch, err := SelectDigestChallenge(headers, challengeHeader)
	return ch, authHeaderName, err
}

func registerAuthenticationHeaderNames(resp RegisterResponse) (challengeHeader, authHeader string) {
	if resp.StatusCode == 407 || firstHeader(resp.Headers, "WWW-Authenticate") == "" {
		return "Proxy-Authenticate", "Proxy-Authorization"
	}
	return "WWW-Authenticate", "Authorization"
}

func registerResponseRetryAfter(resp RegisterResponse) (time.Duration, bool) {
	retryAfter := SIPResponseRetryAfter(resp)
	if retryAfter > 0 || resp.RetryAfter > 0 {
		return retryAfter, true
	}
	for _, value := range rawHeaderValues(resp.Headers, "Retry-After") {
		if registerRetryAfterValuePresent(value) {
			return retryAfter, true
		}
	}
	return 0, false
}

func registerRetryAfterValuePresent(value string) bool {
	value = strings.TrimSpace(value)
	if value == "" {
		return false
	}
	end := 0
	for end < len(value) {
		switch value[end] {
		case ' ', '\t', ';', '(', ',':
			goto parse
		default:
			end++
		}
	}
parse:
	if token := strings.TrimSpace(value[:end]); token != "" {
		seconds, err := strconv.Atoi(token)
		if err == nil && seconds >= 0 {
			return true
		}
	}
	dateValue := strings.TrimSpace(value)
	if semi := strings.IndexByte(dateValue, ';'); semi >= 0 {
		dateValue = strings.TrimSpace(dateValue[:semi])
	}
	for _, layout := range []string{time.RFC1123, time.RFC1123Z, time.RFC850, time.ANSIC} {
		if _, err := time.Parse(layout, dateValue); err == nil {
			return true
		}
	}
	return false
}

func registerResponseNeedsBackoffRecovery(statusCode int) bool {
	switch statusCode {
	case 408, 430, 480, 500, 502, 503, 504, 580:
		return true
	default:
		return statusCode >= 500 && statusCode < 600
	}
}

func updateDigestAuthStateFromInfo(state DigestAuthState, headers map[string][]string, authHeaderName string, body []byte) (DigestAuthState, error) {
	if !state.Usable() {
		return state, nil
	}
	params := digestInfoParams(headers, authHeaderName)
	if rspauth := strings.TrimSpace(params["rspauth"]); rspauth != "" {
		expected, err := digestRspauth(state, firstNonEmpty(params["qop"], state.challenge.QOP), body)
		if err != nil {
			return state, err
		}
		if !strings.EqualFold(rspauth, expected) {
			return state, fmt.Errorf("%w: rspauth mismatch", ErrInvalidAuthenticationInfo)
		}
	}
	nextNonce := strings.TrimSpace(params["nextnonce"])
	if nextNonce == "" || nextNonce == state.challenge.Nonce {
		return state, nil
	}
	next := state.clone()
	next.challenge.Nonce = nextNonce
	next.input.NC = 1
	next.nextNC = 1
	next.lastHeader = ""
	return next, nil
}

func digestInfoNextNonce(headers map[string][]string, authHeaderName string) string {
	return digestInfoParams(headers, authHeaderName)["nextnonce"]
}

func digestInfoParams(headers map[string][]string, authHeaderName string) map[string]string {
	params := make(map[string]string)
	for _, name := range digestInfoHeaderNames(authHeaderName) {
		for _, header := range rawHeaderValues(headers, name) {
			for _, part := range splitAuthParams(header) {
				key, value, ok := strings.Cut(part, "=")
				if !ok {
					continue
				}
				key = strings.ToLower(strings.TrimSpace(key))
				value = unquote(strings.TrimSpace(value))
				if key != "" && value != "" {
					params[key] = value
				}
			}
		}
		if len(params) > 0 {
			return params
		}
	}
	return params
}

func digestInfoHeaderNames(authHeaderName string) []string {
	if strings.EqualFold(strings.TrimSpace(authHeaderName), "Proxy-Authorization") {
		return []string{"Proxy-Authentication-Info", "Authentication-Info"}
	}
	return []string{"Authentication-Info", "Proxy-Authentication-Info"}
}

func digestRspauth(state DigestAuthState, qop string, body []byte) (string, error) {
	input := state.input
	qop = firstQOP(qop)
	cnonce := strings.TrimSpace(input.CNonce)
	ha1, err := digestHA1(state.challenge.Algorithm, input.Username, state.challenge.Realm, input.Password, state.challenge.Nonce, cnonce)
	if err != nil {
		return "", fmt.Errorf("%w: %v", ErrInvalidAuthenticationInfo, err)
	}
	algorithm := state.challenge.Algorithm
	ha2 := ""
	switch qop {
	case "":
		ha2 = digestHashHex(algorithm, ":"+input.URI)
	case "auth":
		ha2 = digestHashHex(algorithm, ":"+input.URI)
	case "auth-int":
		ha2 = digestHashHex(algorithm, ":"+input.URI+":"+digestHashBytesHex(algorithm, body))
	default:
		return "", fmt.Errorf("%w: unsupported rspauth qop %q", ErrInvalidAuthenticationInfo, qop)
	}
	nc := input.NC
	if nc <= 0 {
		nc = 1
	}
	if qop == "" {
		return digestHashHex(algorithm, ha1+":"+state.challenge.Nonce+":"+ha2), nil
	}
	if cnonce == "" {
		return "", fmt.Errorf("%w: cnonce required", ErrInvalidAuthenticationInfo)
	}
	return digestHashHex(algorithm, ha1+":"+state.challenge.Nonce+":"+fmt.Sprintf("%08x", nc)+":"+cnonce+":"+qop+":"+ha2), nil
}

func securityClientFromBinding(binding RegistrationBinding) SecurityAgreement {
	agreements := securityClientsFromBinding(binding)
	if len(agreements) > 0 {
		return agreements[0]
	}
	return SecurityAgreement{}
}

func securityClientsFromBinding(binding RegistrationBinding) []SecurityAgreement {
	return ParseSecurityAgreements([]string{binding.SecurityClient})
}

func mergeRefreshBinding(previous, next RegistrationBinding) RegistrationBinding {
	if strings.TrimSpace(next.ContactURI) == "" {
		next.ContactURI = previous.ContactURI
	}
	if strings.TrimSpace(next.PublicIdentity) == "" {
		next.PublicIdentity = previous.PublicIdentity
	}
	if len(next.AssociatedURIs) == 0 {
		next.AssociatedURIs = append([]string(nil), previous.AssociatedURIs...)
	}
	if len(next.ServiceRoutes) == 0 {
		next.ServiceRoutes = append([]string(nil), previous.ServiceRoutes...)
	}
	if len(next.Paths) == 0 {
		next.Paths = append([]string(nil), previous.Paths...)
	}
	if strings.TrimSpace(next.SecurityClient) == "" {
		next.SecurityClient = previous.SecurityClient
	}
	if len(next.SecurityServer) == 0 {
		next.SecurityServer = append([]string(nil), previous.SecurityServer...)
	}
	if len(next.SecurityVerify) == 0 {
		next.SecurityVerify = append([]string(nil), previous.SecurityVerify...)
	}
	if isZeroSecurityAgreement(next.SecurityAgreement) {
		next.SecurityAgreement = previous.SecurityAgreement
	}
	if isZeroIMSSecurityAssociationPlan(next.SecurityPlan) {
		next.SecurityPlan = previous.SecurityPlan
	}
	if next.Expires <= 0 {
		next.Expires = previous.Expires
	}
	if strings.TrimSpace(next.RegistrarContact) == "" {
		next.RegistrarContact = previous.RegistrarContact
	}
	if strings.TrimSpace(next.AuthHeader) == "" {
		next.AuthHeader = previous.AuthHeader
	}
	if strings.TrimSpace(next.AuthHeaderName) == "" {
		next.AuthHeaderName = previous.AuthHeaderName
	}
	if next.AuthSession == nil {
		next.AuthSession = previous.AuthSession
	}
	return next
}

func (s RegisterSession) digestAuthInputForChallenge(ch DigestChallenge, registrarURI string) (DigestAuthInput, bool, IMSSecurityAKAKeys, error) {
	input := DigestAuthInput{
		Method:   "REGISTER",
		URI:      registrarURI,
		Username: firstNonEmpty(s.Profile.IMPI, s.Profile.IMPU),
		CNonce:   firstNonEmpty(s.CNonce, "vowifi-go"),
		NC:       1,
	}
	if !isAKADigestAlgorithm(ch.Algorithm) {
		return input, false, IMSSecurityAKAKeys{}, nil
	}
	rand16, autn16, ok := ExtractAKAChallengeNonce(ch.Nonce)
	if !ok {
		return input, false, IMSSecurityAKAKeys{}, ErrInvalidChallenge
	}
	aka, err := calculateRegisterAKA(s.AKAProvider, rand16, autn16, s.AKAAppPreference)
	if errors.Is(err, sim.ErrSyncFailure) {
		if len(aka.AUTS) == 0 {
			return input, false, IMSSecurityAKAKeys{}, err
		}
		input.AUTS = append([]byte(nil), aka.AUTS...)
		return input, true, IMSSecurityAKAKeys{}, nil
	}
	if err != nil {
		return input, false, IMSSecurityAKAKeys{}, err
	}
	password, err := BuildAKADigestPassword(ch.Algorithm, aka)
	if err != nil {
		return input, false, IMSSecurityAKAKeys{}, err
	}
	input.Password = password
	return input, false, IMSSecurityAKAKeys{
		CK: append([]byte(nil), aka.CK...),
		IK: append([]byte(nil), aka.IK...),
	}, nil
}

func (s RegisterSession) digestChallengeInputFunc() DigestChallengeInputFunc {
	profile := s.Profile
	akaProvider := s.AKAProvider
	akaAppPreference := s.AKAAppPreference
	cnonce := s.CNonce
	return func(ch DigestChallenge, uri string) (DigestAuthInput, error) {
		input, _, _, err := (RegisterSession{
			AKAProvider:      akaProvider,
			AKAAppPreference: akaAppPreference,
			Profile:          profile,
			CNonce:           cnonce,
		}).digestAuthInputForChallenge(ch, uri)
		return input, err
	}
}

func calculateRegisterAKA(provider sim.AKAProvider, rand16, autn16 []byte, preference string) (sim.AKAResult, error) {
	if provider == nil {
		return sim.AKAResult{}, errors.New("AKA provider required for IMS digest AKA")
	}
	preference = strings.ToLower(strings.TrimSpace(preference))
	if preference == "" {
		return provider.CalculateAKA(rand16, autn16)
	}
	if p, ok := provider.(akaPreferenceProvider); ok {
		return p.CalculateAKAWithPreference(rand16, autn16, preference)
	}
	switch preference {
	case "isim_strict":
		isim, ok := provider.(sim.ISIMAKAProvider)
		if !ok {
			return sim.AKAResult{}, errors.New("AKA provider does not support ISIM AKA")
		}
		return isim.CalculateISIMAKA(rand16, autn16)
	case "isim", "auto":
		if isim, ok := provider.(sim.ISIMAKAProvider); ok {
			if aka, err := isim.CalculateISIMAKA(rand16, autn16); err == nil {
				return aka, nil
			}
		}
	}
	return provider.CalculateAKA(rand16, autn16)
}

func SelectDigestChallenge(headers map[string][]string, name string) (DigestChallenge, error) {
	var best DigestChallenge
	bestScore := -1
	var firstErr error
	for _, header := range rawHeaderValues(headers, name) {
		challenges := digestChallengeHeaderValues(header)
		if len(challenges) == 0 && firstErr == nil {
			firstErr = ErrInvalidChallenge
		}
		for _, challenge := range challenges {
			ch, err := parseDigestChallenge(challenge)
			if err != nil {
				if firstErr == nil {
					firstErr = err
				}
				continue
			}
			if !digestChallengeSupported(ch) {
				if firstErr == nil {
					firstErr = unsupportedDigestChallengeError(ch)
				}
				continue
			}
			score := digestAlgorithmScore(ch.Algorithm)
			if score > bestScore {
				best = ch
				bestScore = score
			}
		}
	}
	if bestScore >= 0 {
		return best, nil
	}
	if firstErr != nil {
		return DigestChallenge{}, firstErr
	}
	return DigestChallenge{}, ErrInvalidChallenge
}

func digestChallengeSupported(ch DigestChallenge) bool {
	return digestAlgorithmScore(ch.Algorithm) > 0 && digestQOPSupported(ch.QOP)
}

func digestQOPSupported(qop string) bool {
	qop = strings.TrimSpace(qop)
	if qop == "" {
		return true
	}
	switch firstQOP(qop) {
	case "auth", "auth-int":
		return true
	default:
		return false
	}
}

func unsupportedDigestChallengeError(ch DigestChallenge) error {
	if digestAlgorithmScore(ch.Algorithm) <= 0 {
		return fmt.Errorf("unsupported digest algorithm %q", ch.Algorithm)
	}
	return fmt.Errorf("unsupported digest qop %q", ch.QOP)
}

func BuildRegistrationBinding(profile IMSProfile, contactURI string, resp RegisterResponse, requestedExpires int) RegistrationBinding {
	return buildRegistrationBinding(profile, contactURI, resp, requestedExpires, SecurityAgreement{}, nil)
}

func buildRegistrationBinding(profile IMSProfile, contactURI string, resp RegisterResponse, requestedExpires int, securityClient SecurityAgreement, securityFallback map[string][]string) RegistrationBinding {
	var securityClients []SecurityAgreement
	if !isZeroSecurityAgreement(securityClient) {
		securityClients = []SecurityAgreement{securityClient}
	}
	return buildRegistrationBindingForClients(profile, contactURI, resp, requestedExpires, securityClients, securityFallback)
}

func buildRegistrationBindingForClients(profile IMSProfile, contactURI string, resp RegisterResponse, requestedExpires int, securityClients []SecurityAgreement, securityFallback map[string][]string) RegistrationBinding {
	associated := normalizeAddressValues(headerListValues(resp.Headers, "P-Associated-URI"))
	securityServer := trimHeaderValues(headerListValues(resp.Headers, "Security-Server"))
	securityVerify := securityServerHeaderValues(resp.Headers)
	if len(securityServer) == 0 && securityFallback != nil {
		securityServer = trimHeaderValues(headerListValues(securityFallback, "Security-Server"))
	}
	if len(securityVerify) == 0 && securityFallback != nil {
		securityVerify = securityServerHeaderValues(securityFallback)
	}
	securityClientHeader := ""
	if len(securityClients) > 0 {
		securityClientHeader = BuildSecurityClientHeaderList(securityClients)
	}
	registrarContact := registrationContactHeader(resp.Headers, contactURI)
	binding := RegistrationBinding{
		ContactURI:       strings.TrimSpace(contactURI),
		PublicIdentity:   defaultPublicIdentity(profile, associated),
		AssociatedURIs:   associated,
		ServiceRoutes:    trimHeaderValues(headerListValues(resp.Headers, "Service-Route")),
		Paths:            trimHeaderValues(headerListValues(resp.Headers, "Path")),
		SecurityClient:   securityClientHeader,
		SecurityServer:   securityServer,
		SecurityVerify:   securityVerify,
		Expires:          registrationExpires(resp.Headers, contactURI, requestedExpires),
		RegistrarContact: registrarContact,
	}
	if selected, ok := SelectSecurityAgreementForClients(binding.SecurityServer, securityClients); ok {
		binding.SecurityAgreement = selected
		if plan, ok := BuildIMSSecurityAssociationPlan(selected); ok {
			binding.SecurityPlan = plan
		}
	}
	if len(binding.AssociatedURIs) == 0 && binding.PublicIdentity != "" {
		binding.AssociatedURIs = []string{binding.PublicIdentity}
	}
	return binding
}

func splitAuthParams(s string) []string {
	var out []string
	var cur strings.Builder
	inQuote := false
	escaped := false
	for _, r := range s {
		switch {
		case escaped:
			cur.WriteRune(r)
			escaped = false
		case r == '\\' && inQuote:
			cur.WriteRune(r)
			escaped = true
		case r == '"':
			cur.WriteRune(r)
			inQuote = !inQuote
		case r == ',' && !inQuote:
			if part := strings.TrimSpace(cur.String()); part != "" {
				out = append(out, part)
			}
			cur.Reset()
		default:
			cur.WriteRune(r)
		}
	}
	if part := strings.TrimSpace(cur.String()); part != "" {
		out = append(out, part)
	}
	return out
}

func digestChallengeHeaderValues(header string) []string {
	var out []string
	for _, challenge := range splitAuthenticateChallenges(header) {
		if strings.EqualFold(authChallengeScheme(challenge), "Digest") {
			out = append(out, challenge)
		}
	}
	return out
}

func splitAuthenticateChallenges(header string) []string {
	header = strings.TrimSpace(header)
	if header == "" {
		return nil
	}
	var out []string
	start := 0
	inQuote := false
	escaped := false
	for i := 0; i < len(header); i++ {
		switch header[i] {
		case '\\':
			if inQuote && !escaped {
				escaped = true
				continue
			}
			escaped = false
		case '"':
			if !escaped {
				inQuote = !inQuote
			}
			escaped = false
		case ',':
			if !inQuote && authChallengeStarts(header[i+1:]) {
				if part := strings.TrimSpace(header[start:i]); part != "" {
					out = append(out, part)
				}
				start = i + 1
			}
			escaped = false
		default:
			escaped = false
		}
	}
	if part := strings.TrimSpace(header[start:]); part != "" {
		out = append(out, part)
	}
	return out
}

func authChallengeScheme(challenge string) string {
	challenge = strings.TrimSpace(challenge)
	end := 0
	for end < len(challenge) && isAuthTokenChar(challenge[end]) {
		end++
	}
	return challenge[:end]
}

func authChallengeStarts(s string) bool {
	s = strings.TrimLeft(s, " \t")
	end := 0
	for end < len(s) && isAuthTokenChar(s[end]) {
		end++
	}
	if end == 0 || end >= len(s) {
		return false
	}
	if s[end] != ' ' && s[end] != '\t' {
		return false
	}
	rest := strings.TrimLeft(s[end:], " \t")
	return rest != "" && rest[0] != '='
}

func isAuthTokenChar(c byte) bool {
	switch {
	case c >= '0' && c <= '9':
		return true
	case c >= 'A' && c <= 'Z':
		return true
	case c >= 'a' && c <= 'z':
		return true
	}
	switch c {
	case '!', '#', '$', '%', '&', '\'', '*', '+', '-', '.', '^', '_', '`', '|', '~':
		return true
	default:
		return false
	}
}

func parseDigestNonceCount(value string) (int, error) {
	if len(value) != 8 {
		return 0, fmt.Errorf("%w: invalid nonce count", ErrInvalidAuthorization)
	}
	n, err := strconv.ParseUint(value, 16, 32)
	if err != nil || n == 0 {
		return 0, fmt.Errorf("%w: invalid nonce count", ErrInvalidAuthorization)
	}
	return int(n), nil
}

func validDigestHex(value string, size int) bool {
	if len(value) != size {
		return false
	}
	for _, r := range value {
		if (r >= '0' && r <= '9') || (r >= 'a' && r <= 'f') || (r >= 'A' && r <= 'F') {
			continue
		}
		return false
	}
	return true
}

func decodeDigestAUTS(value string) ([]byte, error) {
	value = strings.TrimSpace(value)
	if value == "" {
		return nil, fmt.Errorf("%w: invalid auts", ErrInvalidAuthorization)
	}
	if raw, err := base64.StdEncoding.DecodeString(value); err == nil {
		return raw, nil
	}
	if raw, err := base64.RawStdEncoding.DecodeString(value); err == nil {
		return raw, nil
	}
	return nil, fmt.Errorf("%w: invalid auts", ErrInvalidAuthorization)
}

func firstQOP(qop string) string {
	for _, part := range strings.Split(qop, ",") {
		p := strings.ToLower(strings.TrimSpace(part))
		if p == "auth" {
			return p
		}
	}
	for _, part := range strings.Split(qop, ",") {
		p := strings.ToLower(strings.TrimSpace(part))
		if p == "auth-int" {
			return p
		}
	}
	return strings.ToLower(strings.TrimSpace(qop))
}

func firstHeader(headers map[string][]string, name string) string {
	return firstTrimmed(rawHeaderValues(headers, name)...)
}

func isSIPSuccess(code int) bool {
	return code >= 200 && code < 300
}

func cloneRegisterMessage(msg RegisterMessage) RegisterMessage {
	out := RegisterMessage{
		URI:     msg.URI,
		Headers: make(map[string]string, len(msg.Headers)),
		Body:    append([]byte(nil), msg.Body...),
	}
	for k, v := range msg.Headers {
		out.Headers[k] = v
	}
	return out
}

func deregisterContactHeader(contact string) string {
	contact = strings.TrimSpace(contact)
	if contact == "" {
		return ""
	}
	parts := splitSemicolonParams(contact)
	if len(parts) == 0 {
		return contact + ";expires=0"
	}
	var out []string
	replaced := false
	for i, part := range parts {
		if i > 0 {
			key, _, ok := strings.Cut(part, "=")
			if ok && strings.EqualFold(strings.TrimSpace(key), "expires") {
				out = append(out, "expires=0")
				replaced = true
				continue
			}
		}
		out = append(out, part)
	}
	if !replaced {
		out = append(out, "expires=0")
	}
	return strings.Join(out, ";")
}

func decodeNonceBytes(nonce string) ([]byte, bool) {
	nonce = strings.TrimSpace(nonce)
	if nonce == "" {
		return nil, false
	}
	clean := strings.NewReplacer(":", "", "-", "", " ", "").Replace(nonce)
	if raw, err := hex.DecodeString(clean); err == nil {
		return raw, true
	}
	if raw, err := base64.StdEncoding.DecodeString(nonce); err == nil {
		return raw, true
	}
	if raw, err := base64.RawStdEncoding.DecodeString(nonce); err == nil {
		return raw, true
	}
	return nil, false
}

func isAKADigestAlgorithm(algorithm string) bool {
	alg := strings.ToUpper(strings.TrimSpace(algorithm))
	return alg == "AKAV1-MD5" || alg == "AKAV2-MD5"
}

func digestAlgorithmBuildSupported(algorithm string) bool {
	switch strings.ToUpper(strings.TrimSpace(algorithm)) {
	case "MD5", "MD5-SESS", "AKAV1-MD5", "AKAV2-MD5", "SHA-256", "SHA-256-SESS", "SHA-512-256", "SHA-512-256-SESS":
		return true
	default:
		return false
	}
}

func digestAlgorithmNeedsCNonce(algorithm string) bool {
	return strings.HasSuffix(strings.ToUpper(strings.TrimSpace(algorithm)), "-SESS")
}

func digestHA1(algorithm, username, realm, password, nonce, cnonce string) (string, error) {
	algorithm = strings.TrimSpace(algorithm)
	if algorithm == "" {
		algorithm = "MD5"
	}
	if !digestAlgorithmBuildSupported(algorithm) {
		return "", fmt.Errorf("unsupported digest algorithm %q", algorithm)
	}
	base := digestHashHex(algorithm, username+":"+realm+":"+password)
	if !digestAlgorithmNeedsCNonce(algorithm) {
		return base, nil
	}
	cnonce = strings.TrimSpace(cnonce)
	if cnonce == "" {
		return "", fmt.Errorf("cnonce required for %s", algorithm)
	}
	return digestHashHex(algorithm, base+":"+nonce+":"+cnonce), nil
}

func digestAlgorithmScore(algorithm string) int {
	switch strings.ToUpper(strings.TrimSpace(algorithm)) {
	case "AKAV2-MD5":
		return 30
	case "AKAV1-MD5":
		return 20
	case "SHA-512-256-SESS":
		return 15
	case "SHA-512-256":
		return 14
	case "SHA-256-SESS":
		return 13
	case "SHA-256":
		return 12
	case "MD5-SESS":
		return 11
	case "MD5":
		return 10
	default:
		return 0
	}
}

func digestResponseHexLength(algorithm string) int {
	switch digestBaseAlgorithm(algorithm) {
	case "SHA-256", "SHA-512-256":
		return 64
	default:
		return 32
	}
}

func digestHashHex(algorithm, value string) string {
	return digestHashBytesHex(algorithm, []byte(value))
}

func digestHashBytesHex(algorithm string, value []byte) string {
	switch digestBaseAlgorithm(algorithm) {
	case "SHA-256":
		sum := sha256.Sum256(value)
		return hex.EncodeToString(sum[:])
	case "SHA-512-256":
		sum := sha512.Sum512_256(value)
		return hex.EncodeToString(sum[:])
	default:
		sum := md5.Sum(value)
		return hex.EncodeToString(sum[:])
	}
}

func digestBaseAlgorithm(algorithm string) string {
	algorithm = strings.ToUpper(strings.TrimSpace(algorithm))
	if strings.HasSuffix(algorithm, "-SESS") {
		algorithm = strings.TrimSuffix(algorithm, "-SESS")
	}
	switch algorithm {
	case "SHA-256", "SHA-512-256":
		return algorithm
	default:
		return "MD5"
	}
}

func rawHeaderValues(headers map[string][]string, name string) []string {
	var out []string
	for key, values := range headers {
		if strings.EqualFold(key, name) {
			for _, value := range values {
				if strings.TrimSpace(value) != "" {
					out = append(out, strings.TrimSpace(value))
				}
			}
		}
	}
	return out
}

func headerListValues(headers map[string][]string, name string) []string {
	var out []string
	for _, value := range rawHeaderValues(headers, name) {
		out = append(out, splitSIPHeaderValues(value)...)
	}
	return out
}

func splitSIPHeaderValues(s string) []string {
	var out []string
	var cur strings.Builder
	inQuote := false
	escaped := false
	angleDepth := 0
	for _, r := range s {
		switch {
		case escaped:
			cur.WriteRune(r)
			escaped = false
		case r == '\\' && inQuote:
			cur.WriteRune(r)
			escaped = true
		case r == '"':
			cur.WriteRune(r)
			inQuote = !inQuote
		case r == '<' && !inQuote:
			angleDepth++
			cur.WriteRune(r)
		case r == '>' && !inQuote:
			if angleDepth > 0 {
				angleDepth--
			}
			cur.WriteRune(r)
		case r == ',' && !inQuote && angleDepth == 0:
			if part := strings.TrimSpace(cur.String()); part != "" {
				out = append(out, part)
			}
			cur.Reset()
		default:
			cur.WriteRune(r)
		}
	}
	if part := strings.TrimSpace(cur.String()); part != "" {
		out = append(out, part)
	}
	return out
}

func normalizeAddressValues(values []string) []string {
	out := make([]string, 0, len(values))
	for _, value := range values {
		if uri := extractAddressURI(value); uri != "" {
			out = append(out, uri)
		}
	}
	return out
}

func trimHeaderValues(values []string) []string {
	out := make([]string, 0, len(values))
	for _, value := range values {
		if trimmed := strings.TrimSpace(value); trimmed != "" {
			out = append(out, trimmed)
		}
	}
	return out
}

func extractAddressURI(value string) string {
	value = strings.TrimSpace(value)
	if value == "" {
		return ""
	}
	if start := strings.IndexByte(value, '<'); start >= 0 {
		if end := strings.IndexByte(value[start+1:], '>'); end >= 0 {
			return strings.TrimSpace(value[start+1 : start+1+end])
		}
	}
	if fields := strings.Fields(value); len(fields) > 0 {
		value = fields[0]
	}
	return strings.TrimSpace(strings.Trim(value, "<>"))
}

func defaultPublicIdentity(profile IMSProfile, associated []string) string {
	if len(associated) > 0 {
		return associated[0]
	}
	if impu := strings.TrimSpace(profile.IMPU); impu != "" {
		return impu
	}
	if strings.TrimSpace(profile.IMPI) != "" && strings.TrimSpace(profile.Domain) != "" {
		return "sip:" + strings.TrimSpace(profile.IMPI) + "@" + strings.TrimSpace(profile.Domain)
	}
	return strings.TrimSpace(profile.IMPI)
}

func registrationExpires(headers map[string][]string, contactURI string, fallback int) int {
	if contact, ok := matchingRegistrationContactHeader(headers, contactURI); ok {
		if n, ok := headerParamInt(contact, "expires"); ok {
			return n
		}
	}
	for _, value := range rawHeaderValues(headers, "Expires") {
		if n, err := strconv.Atoi(strings.TrimSpace(value)); err == nil {
			return n
		}
	}
	if fallback > 0 {
		return fallback
	}
	return 0
}

func registrationContactHeader(headers map[string][]string, contactURI string) string {
	contacts := trimHeaderValues(headerListValues(headers, "Contact"))
	if len(contacts) == 0 {
		return ""
	}
	if contact, ok := matchingRegistrationContactHeader(headers, contactURI); ok {
		return contact
	}
	return contacts[0]
}

func matchingRegistrationContactHeader(headers map[string][]string, contactURI string) (string, bool) {
	contacts := trimHeaderValues(headerListValues(headers, "Contact"))
	if len(contacts) == 0 {
		return "", false
	}
	target := normalizeSIPURIForContactMatch(contactURI)
	if target == "" {
		return contacts[0], true
	}
	for _, contact := range contacts {
		if normalizeSIPURIForContactMatch(extractAddressURI(contact)) == target {
			return contact, true
		}
	}
	return "", false
}

func normalizeSIPURIForContactMatch(uri string) string {
	uri = strings.TrimSpace(strings.Trim(uri, "<>"))
	if uri == "" || uri == "*" {
		return ""
	}
	if semi := strings.IndexByte(uri, ';'); semi >= 0 {
		uri = uri[:semi]
	}
	return strings.ToLower(strings.TrimSpace(uri))
}

func minExpiresHeader(headers map[string][]string) int {
	for _, value := range rawHeaderValues(headers, "Min-Expires") {
		if n, err := strconv.Atoi(strings.TrimSpace(value)); err == nil && n > 0 {
			return n
		}
	}
	return 0
}

func headerParamInt(value, name string) (int, bool) {
	raw, ok := headerParamValue(value, name)
	if !ok {
		return 0, false
	}
	n, err := strconv.Atoi(raw)
	return n, err == nil
}

func headerParamValue(value, name string) (string, bool) {
	name = strings.ToLower(strings.TrimSpace(name))
	if name == "" {
		return "", false
	}
	for _, part := range splitSIPHeaderParams(value) {
		key, raw, ok := strings.Cut(strings.TrimSpace(part), "=")
		if !ok || strings.ToLower(strings.TrimSpace(key)) != name {
			continue
		}
		return strings.Trim(strings.TrimSpace(raw), `"`), true
	}
	return "", false
}

func securityVerifyFromChallenge(headers map[string][]string) string {
	values := securityServerHeaderValues(headers)
	if len(values) == 0 {
		return ""
	}
	return strings.Join(values, ", ")
}

func securityServerHeaderValues(headers map[string][]string) []string {
	return trimHeaderValues(rawHeaderValues(headers, "Security-Server"))
}

func securityPlanFromChallenge(headers map[string][]string, clients []SecurityAgreement) (SecurityAgreement, IMSSecurityAssociationPlan, bool) {
	return securityPlanFromValues(securityServerHeaderValues(headers), clients)
}

func securityPlanFromValues(values []string, clients []SecurityAgreement) (SecurityAgreement, IMSSecurityAssociationPlan, bool) {
	selected, ok := SelectSecurityAgreementForClients(values, clients)
	if !ok {
		return SecurityAgreement{}, IMSSecurityAssociationPlan{}, false
	}
	plan, ok := BuildIMSSecurityAssociationPlan(selected)
	if !ok {
		return selected, IMSSecurityAssociationPlan{}, false
	}
	return selected, plan, true
}

func md5Hex(s string) string {
	sum := md5.Sum([]byte(s))
	return hex.EncodeToString(sum[:])
}

func md5HexBytes(b []byte) string {
	sum := md5.Sum(b)
	return hex.EncodeToString(sum[:])
}

func unquote(s string) string {
	if len(s) >= 2 && s[0] == '"' && s[len(s)-1] == '"' {
		if out, err := strconv.Unquote(s); err == nil {
			return out
		}
		return s[1 : len(s)-1]
	}
	return s
}

func quote(s string) string {
	return strings.NewReplacer(`\`, `\\`, `"`, `\"`).Replace(s)
}

func firstNonEmpty(items ...string) string {
	for _, item := range items {
		if strings.TrimSpace(item) != "" {
			return strings.TrimSpace(item)
		}
	}
	return ""
}

func firstTrimmed(items ...string) string {
	for _, item := range items {
		if strings.TrimSpace(item) != "" {
			return strings.TrimSpace(item)
		}
	}
	return ""
}
