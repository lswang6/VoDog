package voiceclient

import (
	"bufio"
	"bytes"
	"context"
	"crypto/rand"
	"crypto/tls"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net"
	"sort"
	"strconv"
	"strings"
	"syscall"
	"time"
)

var ErrInvalidSIPMessage = errors.New("invalid SIP message")

type WireRegisterTransport struct {
	Network               string
	ServerAddr            string
	LocalAddr             string
	Resolver              SIPServerResolver
	Timeout               time.Duration
	RetransmitInterval    time.Duration
	MaxRetransmitInterval time.Duration
	MaxRetransmits        int
	FinalResponseDrain    time.Duration
	TLSConfig             *tls.Config
}

func (t WireRegisterTransport) RoundTripRegister(ctx context.Context, msg RegisterMessage) (RegisterResponse, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	network := sipNetworkForRequest(t.Network, msg.URI)
	targets, err := sipTargetsForRequest(ctx, t.Resolver, network, t.ServerAddr, msg.URI)
	if err != nil {
		return RegisterResponse{}, err
	}
	timeout := t.Timeout
	if timeout <= 0 {
		timeout = 5 * time.Second
	}
	var lastErr error
	redirects := 0
	for idx := 0; idx < len(targets); idx++ {
		target := targets[idx]
		var resp RegisterResponse
		var err error
		switch {
		case isSIPUDPNetwork(network):
			resp, err = t.roundTripUDP(ctx, network, target, timeout, msg)
		case isSIPStreamNetwork(network):
			resp, err = t.roundTripTCP(ctx, network, target, timeout, msg)
		default:
			return RegisterResponse{}, fmt.Errorf("unsupported SIP register network %q", network)
		}
		if err == nil {
			if redirects < maxSIPRedirectTargets && sipRedirectStatus(resp.StatusCode) {
				if nextTargets, nextIndex, ok := sipTargetsWithRedirects(targets, idx, sipRedirectTargets(resp)); ok {
					targets = nextTargets
					idx = nextIndex - 1
					redirects++
					continue
				}
			}
			if sipRegisterTargetFailoverStatus(resp.StatusCode) && idx+1 < len(targets) {
				continue
			}
			return resp, nil
		}
		if ctx.Err() != nil {
			return RegisterResponse{}, ctx.Err()
		}
		lastErr = err
		if !isSIPRetryableTransportError(err) {
			break
		}
	}
	if lastErr != nil {
		return RegisterResponse{}, lastErr
	}
	return RegisterResponse{}, errSIPDNSResolverEmpty()
}

func sipTargetsForRequest(ctx context.Context, resolver SIPServerResolver, network, serverAddr, uri string) ([]string, error) {
	target := strings.TrimSpace(serverAddr)
	if target != "" {
		return []string{target}, nil
	}
	targets, err := resolveSIPServerAddrs(ctx, resolver, network, uri)
	if err != nil {
		return nil, err
	}
	targets = appendSIPTargets(nil, targets...)
	if len(targets) == 0 {
		return nil, errSIPDNSResolverEmpty()
	}
	return targets, nil
}

func sipNetworkForRequest(network, uri string) string {
	network = normalizeSIPNetwork(network)
	if network != "" {
		return network
	}
	endpoint, err := parseSIPURIEndpoint(uri)
	if err == nil && endpoint.Secure {
		return "tls"
	}
	return "udp"
}

func normalizeSIPNetwork(network string) string {
	network = strings.ToLower(strings.TrimSpace(network))
	switch network {
	case "udp", "udp4", "udp6", "tcp", "tcp4", "tcp6", "tls", "tls4", "tls6":
		return network
	default:
		return network
	}
}

func isSIPUDPNetwork(network string) bool {
	switch normalizeSIPNetwork(network) {
	case "udp", "udp4", "udp6":
		return true
	default:
		return false
	}
}

func isSIPTCPNetwork(network string) bool {
	switch normalizeSIPNetwork(network) {
	case "tcp", "tcp4", "tcp6":
		return true
	default:
		return false
	}
}

func isSIPTLSNetwork(network string) bool {
	switch normalizeSIPNetwork(network) {
	case "tls", "tls4", "tls6":
		return true
	default:
		return false
	}
}

func isSIPStreamNetwork(network string) bool {
	return isSIPTCPNetwork(network) || isSIPTLSNetwork(network)
}

func sipDialNetwork(network string) (string, error) {
	switch normalizeSIPNetwork(network) {
	case "", "udp":
		return "udp", nil
	case "udp4":
		return "udp4", nil
	case "udp6":
		return "udp6", nil
	case "tcp", "tls":
		return "tcp", nil
	case "tcp4", "tls4":
		return "tcp4", nil
	case "tcp6", "tls6":
		return "tcp6", nil
	default:
		return "", fmt.Errorf("unsupported SIP network %q", network)
	}
}

func dialSIPConn(ctx context.Context, network, target, localAddr string, timeout time.Duration, tlsConfig *tls.Config, tlsServerName string) (net.Conn, error) {
	network = normalizeSIPNetwork(network)
	dialNetwork, err := sipDialNetwork(network)
	if err != nil {
		return nil, err
	}
	dialer := net.Dialer{Timeout: timeout}
	switch {
	case isSIPUDPNetwork(network):
		if strings.TrimSpace(localAddr) != "" {
			addr, err := net.ResolveUDPAddr(dialNetwork, localAddr)
			if err != nil {
				return nil, err
			}
			dialer.LocalAddr = addr
		}
	case isSIPStreamNetwork(network):
		if strings.TrimSpace(localAddr) != "" {
			addr, err := net.ResolveTCPAddr(dialNetwork, localAddr)
			if err != nil {
				return nil, err
			}
			dialer.LocalAddr = addr
		}
	}
	if isSIPTLSNetwork(network) {
		tlsDialer := tls.Dialer{
			NetDialer: &dialer,
			Config:    sipTLSConfigForTarget(tlsConfig, target, tlsServerName),
		}
		return tlsDialer.DialContext(ctx, dialNetwork, target)
	}
	return dialer.DialContext(ctx, dialNetwork, target)
}

func sipTLSConfigForTarget(cfg *tls.Config, target, serverName string) *tls.Config {
	var out *tls.Config
	if cfg != nil {
		out = cfg.Clone()
	} else {
		out = &tls.Config{MinVersion: tls.VersionTLS12}
	}
	if out.ServerName == "" {
		out.ServerName = firstNonEmptySIPString(sipHostForTLSName(serverName), sipHostForTLSName(target))
	}
	if out.MinVersion == 0 {
		out.MinVersion = tls.VersionTLS12
	}
	return out
}

func sipTLSServerNameForURI(uri string) string {
	endpoint, err := parseSIPURIEndpoint(uri)
	if err != nil {
		return ""
	}
	return endpoint.Host
}

func sipHostForTLSName(value string) string {
	value = strings.TrimSpace(value)
	if value == "" {
		return ""
	}
	if host, _, err := net.SplitHostPort(value); err == nil {
		return strings.Trim(host, "[]")
	}
	if strings.HasPrefix(value, "[") {
		if end := strings.IndexByte(value, ']'); end > 0 {
			return strings.TrimSpace(value[1:end])
		}
	}
	if idx := strings.LastIndex(value, ":"); idx > 0 && strings.Count(value, ":") == 1 {
		return strings.TrimSpace(value[:idx])
	}
	return strings.Trim(value, "[]")
}

func firstNonEmptySIPString(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return strings.TrimSpace(value)
		}
	}
	return ""
}

func (t WireRegisterTransport) roundTripUDP(ctx context.Context, network, target string, timeout time.Duration, msg RegisterMessage) (RegisterResponse, error) {
	conn, err := dialSIPConn(ctx, network, target, t.LocalAddr, timeout, nil, "")
	if err != nil {
		return RegisterResponse{}, err
	}
	defer conn.Close()
	if err := conn.SetDeadline(time.Now().Add(timeout)); err != nil {
		return RegisterResponse{}, err
	}
	attempt := SIPRequestMessage{
		Method:  "REGISTER",
		URI:     msg.URI,
		Headers: cloneStringMap(msg.Headers),
		Body:    append([]byte(nil), msg.Body...),
	}
	ensureSIPRequestVia(&attempt, "UDP", conn.LocalAddr())
	wire, err := buildSIPRequestWire(attempt, "UDP", conn.LocalAddr())
	if err != nil {
		return RegisterResponse{}, err
	}
	if _, err := conn.Write(wire); err != nil {
		return RegisterResponse{}, err
	}
	buf := make([]byte, 65535)
	interval := sipRetransmitInterval(attempt.Method, timeout, t.RetransmitInterval)
	maxInterval := sipMaxRetransmitInterval(attempt.Method, timeout, t.MaxRetransmitInterval)
	deadline := time.Now().Add(timeout)
	retransmits := 0
	gotResponse := false
	for {
		readInterval := interval
		if gotResponse {
			readInterval = time.Until(deadline)
		}
		if err := conn.SetReadDeadline(nextSIPReadDeadline(deadline, readInterval)); err != nil {
			return RegisterResponse{}, err
		}
		n, err := conn.Read(buf)
		if err == nil {
			if !isSIPResponseWire(buf[:n]) {
				continue
			}
			resp, err := ParseSIPResponse(buf[:n])
			if err != nil {
				return RegisterResponse{}, err
			}
			if !sipResponseMatchesRequest(resp, attempt) {
				continue
			}
			if isSIPProvisionalResponse(resp.StatusCode) {
				gotResponse = true
				continue
			}
			drainSIPUDPFinalResponses(ctx, conn, attempt, sipFinalResponseDrainDuration(attempt.Method, t.FinalResponseDrain))
			return resp, nil
		}
		if ctx.Err() != nil {
			return RegisterResponse{}, ctx.Err()
		}
		if !isSIPTimeout(err) || !time.Now().Before(deadline) {
			return RegisterResponse{}, err
		}
		if !gotResponse && shouldSIPRetransmit(retransmits, t.MaxRetransmits) {
			if _, writeErr := conn.Write(wire); writeErr != nil {
				return RegisterResponse{}, writeErr
			}
			retransmits++
			interval = nextSIPRetransmitInterval(interval, maxInterval)
			continue
		}
		interval = time.Until(deadline)
	}
}

func (t WireRegisterTransport) roundTripTCP(ctx context.Context, network, target string, timeout time.Duration, msg RegisterMessage) (RegisterResponse, error) {
	conn, err := dialSIPConn(ctx, network, target, t.LocalAddr, timeout, t.TLSConfig, sipTLSServerNameForURI(msg.URI))
	if err != nil {
		return RegisterResponse{}, err
	}
	defer conn.Close()
	if err := conn.SetDeadline(time.Now().Add(timeout)); err != nil {
		return RegisterResponse{}, err
	}
	attempt := SIPRequestMessage{
		Method:  "REGISTER",
		URI:     msg.URI,
		Headers: cloneStringMap(msg.Headers),
		Body:    append([]byte(nil), msg.Body...),
	}
	transport := transportName(network)
	ensureSIPRequestVia(&attempt, transport, conn.LocalAddr())
	wire, err := buildSIPRequestWire(attempt, transport, conn.LocalAddr())
	if err != nil {
		return RegisterResponse{}, err
	}
	if _, err := conn.Write(wire); err != nil {
		return RegisterResponse{}, err
	}
	reader := bufio.NewReader(conn)
	for {
		raw, err := readSIPStreamMessage(reader)
		if err != nil {
			return RegisterResponse{}, err
		}
		resp, err := ParseSIPResponse(raw)
		if err != nil {
			return RegisterResponse{}, err
		}
		if sipResponseMatchesRequest(resp, attempt) {
			if isSIPProvisionalResponse(resp.StatusCode) {
				continue
			}
			return resp, nil
		}
	}
}

func buildSIPRequestWire(msg SIPRequestMessage, transport string, localAddr net.Addr) ([]byte, error) {
	method := strings.ToUpper(strings.TrimSpace(msg.Method))
	if method == "" {
		return nil, errors.New("SIP method is empty")
	}
	uri := strings.TrimSpace(msg.URI)
	if uri == "" {
		return nil, errors.New("SIP request URI is empty")
	}
	headers := make(map[string]string, len(msg.Headers)+4)
	for k, v := range msg.Headers {
		if strings.TrimSpace(k) != "" {
			headers[strings.TrimSpace(k)] = strings.TrimSpace(v)
		}
	}
	if firstHeaderValue(headers, "Via") == "" {
		headers["Via"] = buildViaHeader(transport, localAddr)
	}
	if firstHeaderValue(headers, "Content-Length") == "" {
		headers["Content-Length"] = strconv.Itoa(len(msg.Body))
	}
	var out bytes.Buffer
	out.WriteString(method)
	out.WriteString(" ")
	out.WriteString(uri)
	out.WriteString(" SIP/2.0\r\n")
	writeOrderedHeaders(&out, headers)
	out.WriteString("\r\n")
	out.Write(msg.Body)
	return out.Bytes(), nil
}

func ensureSIPRequestVia(msg *SIPRequestMessage, transport string, localAddr net.Addr) {
	if msg == nil {
		return
	}
	if msg.Headers == nil {
		msg.Headers = make(map[string]string)
	}
	viaKey := ""
	viaValue := ""
	for key, value := range msg.Headers {
		if strings.EqualFold(key, "Via") {
			viaKey = key
			viaValue = strings.TrimSpace(value)
			break
		}
	}
	if viaValue == "" {
		msg.Headers["Via"] = buildViaHeader(transport, localAddr)
		return
	}
	if sipViaBranch(viaValue) == "" {
		msg.Headers[viaKey] = strings.TrimRight(viaValue, " \t;") + ";branch=" + newBranch()
	}
}

func writeOrderedHeaders(out *bytes.Buffer, headers map[string]string) {
	order := []string{
		"Via", "Route", "Max-Forwards", "To", "From", "Call-ID", "CSeq", "Contact",
		"Expires", "P-Preferred-Identity", "User-Agent", "Allow", "Supported", "Require",
		"P-Preferred-Service", "Accept-Contact",
		"P-Access-Network-Info", "P-Visited-Network-ID", "Security-Client", "Security-Verify", "Authorization",
		"Proxy-Authorization", "Refer-To", "Referred-By", "Refer-Sub", "Request-Disposition",
		"Reject-Contact", "Session-Expires", "Min-SE", "Event", "Subscription-State",
		"Allow-Events", "Content-Type", "Accept",
	}
	written := make(map[string]bool, len(order))
	contentLength := ""
	for _, name := range order {
		for key, value := range headers {
			if strings.EqualFold(key, name) && strings.TrimSpace(value) != "" {
				out.WriteString(name)
				out.WriteString(": ")
				out.WriteString(value)
				out.WriteString("\r\n")
				written[strings.ToLower(key)] = true
			}
		}
	}
	for key, value := range headers {
		if strings.EqualFold(key, "Content-Length") {
			contentLength = strings.TrimSpace(value)
			written[strings.ToLower(key)] = true
			continue
		}
		if written[strings.ToLower(key)] || strings.TrimSpace(value) == "" {
			continue
		}
		out.WriteString(key)
		out.WriteString(": ")
		out.WriteString(value)
		out.WriteString("\r\n")
	}
	if contentLength != "" {
		out.WriteString("Content-Length: ")
		out.WriteString(contentLength)
		out.WriteString("\r\n")
	}
}

func buildViaHeader(transport string, addr net.Addr) string {
	host, port := localHostPort(addr)
	if host == "" {
		host = "0.0.0.0"
	}
	if port == 0 {
		port = 5060
	}
	return "SIP/2.0/" + strings.ToUpper(strings.TrimSpace(transport)) + " " + host + ":" + strconv.Itoa(port) + ";branch=" + newBranch() + ";rport"
}

func localHostPort(addr net.Addr) (string, int) {
	if addr == nil {
		return "", 0
	}
	host, portText, err := net.SplitHostPort(addr.String())
	if err != nil {
		return "", 0
	}
	port, _ := strconv.Atoi(portText)
	if strings.Contains(host, ":") && !strings.HasPrefix(host, "[") {
		host = "[" + host + "]"
	}
	return host, port
}

func newBranch() string {
	var b [8]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "z9hG4bKvowifigo"
	}
	return "z9hG4bK" + hex.EncodeToString(b[:])
}

func ParseSIPResponse(raw []byte) (RegisterResponse, error) {
	head, body, err := splitSIPMessage(raw)
	if err != nil {
		return RegisterResponse{}, err
	}
	lines := splitHeaderLines(head)
	if len(lines) == 0 {
		return RegisterResponse{}, ErrInvalidSIPMessage
	}
	parts := strings.SplitN(lines[0], " ", 3)
	if len(parts) < 2 || !strings.EqualFold(parts[0], "SIP/2.0") {
		return RegisterResponse{}, fmt.Errorf("%w: invalid status line", ErrInvalidSIPMessage)
	}
	statusToken := strings.TrimSpace(parts[1])
	if !validSIPStatusToken(statusToken) {
		return RegisterResponse{}, fmt.Errorf("%w: invalid status code", ErrInvalidSIPMessage)
	}
	code, _ := strconv.Atoi(statusToken)
	if !validSIPStatusCode(code) {
		return RegisterResponse{}, fmt.Errorf("%w: invalid status code", ErrInvalidSIPMessage)
	}
	reason := ""
	if len(parts) == 3 {
		reason = strings.TrimSpace(parts[2])
	}
	headers, err := parseSIPHeaders(lines[1:])
	if err != nil {
		return RegisterResponse{}, err
	}
	body, err = sipBodyByContentLength(headers, body)
	if err != nil {
		return RegisterResponse{}, err
	}
	return RegisterResponse{
		StatusCode: code,
		Reason:     reason,
		Headers:    headers,
		Body:       append([]byte(nil), body...),
		RetryAfter: SIPRetryAfterDelay(headers),
	}, nil
}

func SIPResponseRetryAfter(resp RegisterResponse) time.Duration {
	if resp.RetryAfter > 0 {
		return resp.RetryAfter
	}
	return SIPRetryAfterDelay(resp.Headers)
}

type sipTransactionKind int

const (
	sipTransactionNonInvite sipTransactionKind = iota
	sipTransactionInvite
)

type sipTransactionFailure struct {
	Method               string
	Transaction          sipTransactionKind
	StatusCode           int
	TimedOut             bool
	FinalResponseTimeout bool
	RetryAfter           time.Duration
	RetryAfterPresent    bool
}

func sipTransactionFailureFor(method string, resp SIPResponse, err error) sipTransactionFailure {
	method = strings.ToUpper(strings.TrimSpace(method))
	out := sipTransactionFailure{
		Method:      method,
		Transaction: sipTransactionKindForMethod(method),
	}
	if err != nil {
		switch {
		case errors.Is(err, ErrSIPFinalResponseTimeout):
			out.TimedOut = true
			out.FinalResponseTimeout = true
		case isSIPTimeout(err):
			out.TimedOut = true
		}
	}
	if resp.StatusCode == 0 {
		return out
	}
	out.StatusCode = resp.StatusCode
	if resp.StatusCode == 408 {
		out.TimedOut = true
	}
	if sipRetryAfterResponseStatus(resp.StatusCode) {
		out.RetryAfter, out.RetryAfterPresent = sipResponseRetryAfterDelay(resp)
	}
	return out
}

func sipTransactionKindForMethod(method string) sipTransactionKind {
	if strings.EqualFold(strings.TrimSpace(method), "INVITE") {
		return sipTransactionInvite
	}
	return sipTransactionNonInvite
}

func sipRetryAfterResponseStatus(code int) bool {
	return code == 408 || code == 503
}

func sipResponseRetryAfterDelay(resp RegisterResponse) (time.Duration, bool) {
	if resp.RetryAfter > 0 {
		return resp.RetryAfter, true
	}
	return sipRetryAfterDelay(resp.Headers)
}

type sipFailureKind int

const (
	sipFailureNone sipFailureKind = iota
	sipFailureSIPStatus
	sipFailureTransport
)

// SIPRecoveryPlan describes how an IMS client should recover after a SIP failure.
type SIPRecoveryPlan struct {
	Method                string
	StatusCode            int
	RetryAfter            time.Duration
	RetryAfterPresent     bool
	Recoverable           bool
	TargetFailover        bool
	RegistrationRefresh   bool
	RegistrationRequired  bool
	AuthenticationRefresh bool
	TransportFailure      bool
	TimedOut              bool
	FinalResponseTimeout  bool
}

// SIPResponseRecoveryPlan classifies a final SIP response for IMS retry handling.
func SIPResponseRecoveryPlan(method string, resp SIPResponse) SIPRecoveryPlan {
	method = strings.ToUpper(strings.TrimSpace(method))
	failure := sipTransactionFailureFor(method, resp, nil)
	scope := sipRecoveryDialog
	if strings.EqualFold(method, "REGISTER") {
		scope = sipRecoveryRegister
	}
	recovery := sipResponseFailureRecovery(scope, resp.StatusCode)
	plan := SIPRecoveryPlan{
		Method:               failure.Method,
		StatusCode:           failure.StatusCode,
		RetryAfter:           failure.RetryAfter,
		RetryAfterPresent:    failure.RetryAfterPresent,
		Recoverable:          recovery.Recoverable,
		TargetFailover:       recovery.TargetFailover,
		TimedOut:             failure.TimedOut,
		FinalResponseTimeout: failure.FinalResponseTimeout,
	}
	switch resp.StatusCode {
	case 401, 407:
		plan.AuthenticationRefresh = true
	case 423:
		plan.RegistrationRefresh = strings.EqualFold(method, "REGISTER")
	case 408, 430, 480, 500, 502, 503, 504, 580:
		plan.RegistrationRequired = !strings.EqualFold(method, "REGISTER")
	default:
		if resp.StatusCode >= 500 && resp.StatusCode < 600 {
			plan.RegistrationRequired = !strings.EqualFold(method, "REGISTER")
		}
	}
	return plan
}

// SIPTransportRecoveryPlan classifies transport errors for IMS retry handling.
func SIPTransportRecoveryPlan(method string, err error) SIPRecoveryPlan {
	method = strings.ToUpper(strings.TrimSpace(method))
	failure := sipTransactionFailureFor(method, SIPResponse{}, err)
	recovery := sipTransportFailureRecovery(err)
	return SIPRecoveryPlan{
		Method:               failure.Method,
		Recoverable:          recovery.Recoverable,
		TargetFailover:       recovery.TargetFailover,
		RegistrationRequired: recovery.Recoverable && !strings.EqualFold(method, "REGISTER"),
		TransportFailure:     err != nil,
		TimedOut:             failure.TimedOut,
		FinalResponseTimeout: failure.FinalResponseTimeout,
	}
}

type sipRecoveryScope int

const (
	sipRecoveryRegister sipRecoveryScope = iota
	sipRecoveryDialog
)

type sipFailureRecovery struct {
	Kind           sipFailureKind
	StatusCode     int
	Err            error
	Recoverable    bool
	TargetFailover bool
}

func sipResponseFailureRecovery(scope sipRecoveryScope, code int) sipFailureRecovery {
	if !sipRecoverableResponseStatus(scope, code) {
		return sipFailureRecovery{Kind: sipFailureSIPStatus, StatusCode: code}
	}
	return sipFailureRecovery{
		Kind:           sipFailureSIPStatus,
		StatusCode:     code,
		Recoverable:    true,
		TargetFailover: true,
	}
}

func sipRecoverableResponseStatus(scope sipRecoveryScope, code int) bool {
	switch code {
	case 408, 430, 500, 502, 503, 504, 580:
		return true
	case 480:
		return scope == sipRecoveryRegister
	default:
		return code >= 500 && code < 600
	}
}

func sipRegisterTargetFailoverStatus(code int) bool {
	return sipResponseFailureRecovery(sipRecoveryRegister, code).TargetFailover
}

func sipDialogTargetFailoverStatus(code int) bool {
	return sipResponseFailureRecovery(sipRecoveryDialog, code).TargetFailover
}

const maxSIPRedirectTargets = 4

func sipRedirectStatus(code int) bool {
	return code >= 300 && code < 400
}

func sipRedirectTargets(resp SIPResponse) []string {
	type redirectContact struct {
		target string
		q      float64
	}

	var contacts []redirectContact
	for _, contact := range headerListValues(resp.Headers, "Contact") {
		if sipContactExpired(contact) {
			continue
		}
		uri := extractAddressURI(contact)
		if uri == "" || uri == "*" {
			continue
		}
		target, err := sipURIAddr(uri)
		if err != nil {
			continue
		}
		q := sipContactQ(contact)
		duplicate := -1
		for i, existing := range contacts {
			if existing.target == target {
				duplicate = i
				break
			}
		}
		if duplicate >= 0 {
			if q > contacts[duplicate].q {
				contacts[duplicate].q = q
			}
			continue
		}
		contacts = append(contacts, redirectContact{target: target, q: q})
	}
	sort.SliceStable(contacts, func(i, j int) bool {
		return contacts[i].q > contacts[j].q
	})
	targets := make([]string, 0, len(contacts))
	for _, contact := range contacts {
		targets = appendSIPTargets(targets, contact.target)
	}
	return targets
}

func sipContactQ(contact string) float64 {
	value, ok := headerParamValue(contact, "q")
	if !ok {
		return 1
	}
	q, err := strconv.ParseFloat(value, 64)
	if err != nil || q < 0 || q > 1 {
		return 1
	}
	return q
}

func sipContactExpired(contact string) bool {
	value, ok := headerParamValue(contact, "expires")
	if !ok {
		return false
	}
	expires, err := strconv.Atoi(value)
	return err == nil && expires <= 0
}

func sipTargetsWithRedirects(targets []string, currentIndex int, redirects []string) ([]string, int, bool) {
	if len(redirects) == 0 {
		return targets, currentIndex, false
	}
	if currentIndex < 0 {
		currentIndex = 0
	}
	if currentIndex >= len(targets) {
		currentIndex = len(targets) - 1
	}
	if currentIndex < 0 {
		targets = appendSIPTargets(nil, redirects...)
		return targets, 0, len(targets) > 0
	}
	out := appendSIPTargets(nil, targets[:currentIndex+1]...)
	out = appendSIPTargets(out, redirects...)
	out = appendSIPTargets(out, targets[currentIndex+1:]...)
	for _, redirect := range redirects {
		redirect = strings.TrimSpace(redirect)
		if redirect == "" {
			continue
		}
		for idx, target := range out {
			if target == redirect && idx != currentIndex {
				return out, idx, true
			}
		}
	}
	return out, currentIndex, false
}

func SIPRetryAfterDelay(headers map[string][]string) time.Duration {
	delay, _ := sipRetryAfterDelay(headers)
	return delay
}

func sipRetryAfterDelay(headers map[string][]string) (time.Duration, bool) {
	var delay time.Duration
	seen := false
	now := time.Now()
	for _, value := range rawHeaderValues(headers, "Retry-After") {
		parsed, ok := parseSIPRetryAfterValueAt(value, now)
		if !ok {
			continue
		}
		seen = true
		if parsed > delay {
			delay = parsed
		}
	}
	return delay, seen
}

func parseSIPRetryAfterValue(value string) (time.Duration, bool) {
	return parseSIPRetryAfterValueAt(value, time.Now())
}

func parseSIPRetryAfterValueAt(value string, now time.Time) (time.Duration, bool) {
	value = strings.TrimSpace(value)
	if value == "" {
		return 0, false
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
	token := strings.TrimSpace(value[:end])
	if token != "" {
		seconds, err := strconv.Atoi(token)
		if err == nil && seconds >= 0 {
			return time.Duration(seconds) * time.Second, true
		}
	}
	candidate := sipRetryAfterDateValue(value)
	for _, layout := range []string{time.RFC1123, time.RFC1123Z, time.RFC850, time.ANSIC} {
		t, err := time.Parse(layout, candidate)
		if err != nil {
			continue
		}
		if now.IsZero() {
			now = time.Now()
		}
		delay := t.Sub(now)
		if delay < 0 {
			delay = 0
		}
		return delay, true
	}
	return 0, false
}

func sipRetryAfterDateValue(value string) string {
	value = strings.TrimSpace(value)
	if semi := strings.IndexByte(value, ';'); semi >= 0 {
		value = value[:semi]
	}
	if open := strings.IndexByte(value, '('); open >= 0 {
		value = value[:open]
	}
	return strings.TrimSpace(value)
}

func validSIPStatusCode(code int) bool {
	return code >= 100 && code <= 699
}

func validSIPStatusToken(token string) bool {
	if len(token) != 3 {
		return false
	}
	for _, r := range token {
		if r < '0' || r > '9' {
			return false
		}
	}
	return true
}

func sipResponseMatchesRequest(resp RegisterResponse, req SIPRequestMessage) bool {
	if !sipResponseHeaderMatchesRequest(resp.Headers, req.Headers, "Call-ID") {
		return false
	}
	if !sipResponseCSeqMatchesRequest(resp, req) {
		return false
	}
	if !sipResponseViaMatchesRequest(resp, req) {
		return false
	}
	return true
}

func sipResponseHeaderMatchesRequest(respHeaders map[string][]string, reqHeaders map[string]string, name string) bool {
	respValue := firstHeader(respHeaders, name)
	if respValue == "" {
		return true
	}
	reqValue := firstHeaderValue(reqHeaders, name)
	return reqValue != "" && strings.TrimSpace(respValue) == strings.TrimSpace(reqValue)
}

func sipResponseCSeqMatchesRequest(resp RegisterResponse, req SIPRequestMessage) bool {
	respValue := firstHeader(resp.Headers, "CSeq")
	if respValue == "" {
		return true
	}
	respSeq, respMethod, ok := sipCSeqParts(respValue)
	if !ok {
		return false
	}
	reqSeq, reqMethod, ok := sipCSeqParts(firstHeaderValue(req.Headers, "CSeq"))
	if !ok {
		return false
	}
	return respSeq == reqSeq && strings.EqualFold(respMethod, reqMethod)
}

func sipCSeqParts(value string) (int, string, bool) {
	fields := strings.Fields(value)
	if len(fields) < 2 {
		return 0, "", false
	}
	seq, err := strconv.Atoi(fields[0])
	if err != nil || seq <= 0 {
		return 0, "", false
	}
	method := strings.ToUpper(strings.TrimSpace(fields[1]))
	if method == "" {
		return 0, "", false
	}
	return seq, method, true
}

func sipResponseViaMatchesRequest(resp RegisterResponse, req SIPRequestMessage) bool {
	respVia := firstHeader(resp.Headers, "Via")
	if respVia == "" {
		return true
	}
	reqVia := firstHeaderValue(req.Headers, "Via")
	if reqVia == "" {
		return false
	}
	respBranch := sipViaBranch(respVia)
	reqBranch := sipViaBranch(reqVia)
	if respBranch != "" || reqBranch != "" {
		return respBranch != "" && reqBranch != "" && respBranch == reqBranch
	}
	return true
}

func sipViaBranch(via string) string {
	for _, part := range strings.Split(via, ";") {
		key, value, ok := strings.Cut(strings.TrimSpace(part), "=")
		if ok && strings.EqualFold(strings.TrimSpace(key), "branch") {
			return strings.TrimSpace(value)
		}
	}
	return ""
}

func ParseSIPRequest(raw []byte) (SIPIncomingRequest, error) {
	head, body, err := splitSIPMessage(raw)
	if err != nil {
		return SIPIncomingRequest{}, err
	}
	lines := splitHeaderLines(head)
	if len(lines) == 0 {
		return SIPIncomingRequest{}, ErrInvalidSIPMessage
	}
	parts := strings.Fields(lines[0])
	if len(parts) != 3 || !strings.EqualFold(parts[2], "SIP/2.0") {
		return SIPIncomingRequest{}, fmt.Errorf("%w: invalid request line", ErrInvalidSIPMessage)
	}
	method := strings.ToUpper(strings.TrimSpace(parts[0]))
	uri := strings.TrimSpace(parts[1])
	if method == "" || uri == "" {
		return SIPIncomingRequest{}, fmt.Errorf("%w: empty method or URI", ErrInvalidSIPMessage)
	}
	headers, err := parseSIPHeaders(lines[1:])
	if err != nil {
		return SIPIncomingRequest{}, err
	}
	body, err = sipBodyByContentLength(headers, body)
	if err != nil {
		return SIPIncomingRequest{}, err
	}
	return SIPIncomingRequest{
		Method:  method,
		URI:     uri,
		Headers: headers,
		Body:    append([]byte(nil), body...),
	}, nil
}

func BuildSIPResponseWire(req SIPIncomingRequest, statusCode int, reason string, headers map[string]string, body []byte) ([]byte, error) {
	if !validSIPStatusCode(statusCode) {
		return nil, fmt.Errorf("%w: invalid response status", ErrInvalidSIPMessage)
	}
	reason = strings.TrimSpace(reason)
	if reason == "" {
		reason = defaultSIPReason(statusCode)
	}
	outHeaders := make(map[string][]string, len(headers)+6)
	copyIncomingHeader(outHeaders, req.Headers, "Via")
	copyIncomingHeader(outHeaders, req.Headers, "To")
	copyIncomingHeader(outHeaders, req.Headers, "From")
	copyIncomingHeader(outHeaders, req.Headers, "Call-ID")
	copyIncomingHeader(outHeaders, req.Headers, "CSeq")
	for key, value := range headers {
		key = strings.TrimSpace(key)
		value = strings.TrimSpace(value)
		if key == "" || value == "" || strings.EqualFold(key, "Content-Length") {
			continue
		}
		canonical := canonicalHeaderName(key)
		outHeaders[canonical] = append(outHeaders[canonical], value)
	}
	outHeaders["Content-Length"] = []string{strconv.Itoa(len(body))}
	var out bytes.Buffer
	out.WriteString("SIP/2.0 ")
	out.WriteString(strconv.Itoa(statusCode))
	out.WriteString(" ")
	out.WriteString(reason)
	out.WriteString("\r\n")
	writeOrderedHeaderValues(&out, outHeaders)
	out.WriteString("\r\n")
	out.Write(body)
	return out.Bytes(), nil
}

func ReadSIPStreamMessage(r *bufio.Reader) ([]byte, error) {
	return readSIPStreamMessage(r)
}

func splitSIPMessage(raw []byte) (string, []byte, error) {
	if idx := bytes.Index(raw, []byte("\r\n\r\n")); idx >= 0 {
		return string(raw[:idx]), raw[idx+4:], nil
	}
	if idx := bytes.Index(raw, []byte("\n\n")); idx >= 0 {
		return string(raw[:idx]), raw[idx+2:], nil
	}
	return "", nil, fmt.Errorf("%w: missing header terminator", ErrInvalidSIPMessage)
}

func writeOrderedHeaderValues(out *bytes.Buffer, headers map[string][]string) {
	order := []string{
		"Via", "Record-Route", "Route", "Max-Forwards", "To", "From", "Call-ID",
		"CSeq", "Contact", "Expires", "P-Associated-URI", "Service-Route", "Path",
		"P-Preferred-Identity", "User-Agent", "Allow", "Supported", "Require",
		"P-Access-Network-Info", "P-Visited-Network-ID", "Security-Client", "Security-Verify",
		"Authorization", "Proxy-Authorization", "WWW-Authenticate",
		"Proxy-Authenticate", "Refer-To", "Referred-By", "Refer-Sub", "Request-Disposition",
		"Reject-Contact", "Session-Expires", "Min-SE", "Event", "Subscription-State",
		"Allow-Events", "Content-Type", "Accept",
	}
	written := make(map[string]bool, len(order))
	var contentLength []string
	for _, name := range order {
		for key, values := range headers {
			if !strings.EqualFold(key, name) {
				continue
			}
			for _, value := range values {
				if strings.TrimSpace(value) == "" {
					continue
				}
				out.WriteString(name)
				out.WriteString(": ")
				out.WriteString(strings.TrimSpace(value))
				out.WriteString("\r\n")
			}
			written[strings.ToLower(key)] = true
		}
	}
	for key, values := range headers {
		if strings.EqualFold(key, "Content-Length") {
			contentLength = trimHeaderValues(values)
			written[strings.ToLower(key)] = true
			continue
		}
		if written[strings.ToLower(key)] {
			continue
		}
		for _, value := range values {
			if strings.TrimSpace(key) == "" || strings.TrimSpace(value) == "" {
				continue
			}
			out.WriteString(key)
			out.WriteString(": ")
			out.WriteString(strings.TrimSpace(value))
			out.WriteString("\r\n")
		}
	}
	for _, value := range contentLength {
		if strings.TrimSpace(value) == "" {
			continue
		}
		out.WriteString("Content-Length: ")
		out.WriteString(strings.TrimSpace(value))
		out.WriteString("\r\n")
	}
}

func copyIncomingHeader(dst map[string][]string, src map[string][]string, name string) {
	for key, values := range src {
		if strings.EqualFold(key, name) && len(values) > 0 {
			dst[name] = append(dst[name], trimHeaderValues(values)...)
		}
	}
}

func defaultSIPReason(code int) string {
	switch code {
	case 100:
		return "Trying"
	case 180:
		return "Ringing"
	case 183:
		return "Session Progress"
	case 200:
		return "OK"
	case 202:
		return "Accepted"
	case 400:
		return "Bad Request"
	case 480:
		return "Temporarily Unavailable"
	case 481:
		return "Call/Transaction Does Not Exist"
	case 486:
		return "Busy Here"
	case 487:
		return "Request Terminated"
	case 488:
		return "Not Acceptable Here"
	case 491:
		return "Request Pending"
	case 500:
		return "Server Internal Error"
	case 503:
		return "Service Unavailable"
	default:
		return "Status"
	}
}

func splitHeaderLines(head string) []string {
	raw := strings.Split(strings.ReplaceAll(head, "\r\n", "\n"), "\n")
	out := make([]string, 0, len(raw))
	for _, line := range raw {
		if line == "" {
			continue
		}
		if (strings.HasPrefix(line, " ") || strings.HasPrefix(line, "\t")) && len(out) > 0 {
			out[len(out)-1] += " " + strings.TrimSpace(line)
			continue
		}
		out = append(out, strings.TrimSpace(line))
	}
	return out
}

func parseSIPHeaders(lines []string) (map[string][]string, error) {
	headers := make(map[string][]string)
	for _, line := range lines {
		name, value, ok := strings.Cut(line, ":")
		if !ok {
			return nil, fmt.Errorf("%w: malformed header %q", ErrInvalidSIPMessage, line)
		}
		name = strings.TrimSpace(name)
		value = strings.TrimSpace(value)
		if name == "" {
			return nil, fmt.Errorf("%w: empty header name", ErrInvalidSIPMessage)
		}
		canonical := canonicalHeaderName(name)
		headers[canonical] = append(headers[canonical], value)
	}
	return headers, nil
}

func readSIPStreamMessage(r *bufio.Reader) ([]byte, error) {
	var raw []byte
	for {
		line, err := r.ReadBytes('\n')
		if err != nil {
			return nil, err
		}
		if len(raw) == 0 && isSIPBlankLine(line) {
			continue
		}
		raw = append(raw, line...)
		if bytes.HasSuffix(raw, []byte("\r\n\r\n")) || bytes.HasSuffix(raw, []byte("\n\n")) {
			break
		}
	}
	headers, _, err := splitSIPMessage(raw)
	if err != nil {
		return nil, err
	}
	parsed, err := parseSIPHeaders(splitHeaderLines(headers)[1:])
	if err != nil {
		return nil, err
	}
	n, ok, err := strictContentLength(parsed)
	if err != nil {
		return nil, err
	}
	if ok && n > 0 {
		body := make([]byte, n)
		if _, err := io.ReadFull(r, body); err != nil {
			return nil, err
		}
		raw = append(raw, body...)
	}
	return raw, nil
}

func isSIPBlankLine(line []byte) bool {
	return len(bytes.TrimSpace(line)) == 0
}

func isSIPResponseWire(raw []byte) bool {
	return bytes.HasPrefix(bytes.TrimLeft(raw, "\r\n\t "), []byte("SIP/2.0"))
}

func sipBodyByContentLength(headers map[string][]string, body []byte) ([]byte, error) {
	n, ok, err := strictContentLength(headers)
	if err != nil {
		return nil, err
	}
	if !ok {
		return body, nil
	}
	if n > len(body) {
		return nil, fmt.Errorf("%w: content length %d exceeds body length %d", ErrInvalidSIPMessage, n, len(body))
	}
	return body[:n], nil
}

func strictContentLength(headers map[string][]string) (int, bool, error) {
	var length int
	seen := false
	for key, values := range headers {
		if !strings.EqualFold(key, "Content-Length") && !strings.EqualFold(key, "l") {
			continue
		}
		if len(values) == 0 {
			return 0, false, fmt.Errorf("%w: invalid content length", ErrInvalidSIPMessage)
		}
		for _, value := range values {
			n, err := strconv.Atoi(strings.TrimSpace(value))
			if err != nil || n < 0 {
				return 0, false, fmt.Errorf("%w: invalid content length", ErrInvalidSIPMessage)
			}
			if seen && n != length {
				return 0, false, fmt.Errorf("%w: conflicting content length", ErrInvalidSIPMessage)
			}
			length = n
			seen = true
		}
	}
	return length, seen, nil
}

func sipRetransmitInterval(method string, timeout, configured time.Duration) time.Duration {
	if configured > 0 {
		return configured
	}
	interval := DefaultSIPTransactionTimerPolicy(method).T1
	if timeout > 0 && timeout < interval {
		return timeout
	}
	return interval
}

func sipMaxRetransmitInterval(method string, timeout, configured time.Duration) time.Duration {
	if configured > 0 {
		return configured
	}
	interval := DefaultSIPTransactionTimerPolicy(method).T2
	if timeout > 0 && timeout < interval {
		return timeout
	}
	return interval
}

func nextSIPReadDeadline(deadline time.Time, interval time.Duration) time.Time {
	if interval <= 0 {
		return deadline
	}
	next := time.Now().Add(interval)
	if deadline.IsZero() || next.Before(deadline) {
		return next
	}
	return deadline
}

func nextSIPRetransmitInterval(interval, maxInterval time.Duration) time.Duration {
	if interval <= 0 {
		return maxInterval
	}
	next := interval * 2
	if maxInterval > 0 && next > maxInterval {
		return maxInterval
	}
	return next
}

func shouldSIPRetransmit(done, max int) bool {
	return max <= 0 || done < max
}

func sipFinalResponseDrainDuration(method string, configured time.Duration) time.Duration {
	if configured <= 0 || strings.EqualFold(strings.TrimSpace(method), "INVITE") {
		return 0
	}
	return configured
}

func drainSIPUDPFinalResponses(ctx context.Context, conn net.Conn, msg SIPRequestMessage, duration time.Duration) {
	if duration <= 0 || conn == nil {
		return
	}
	if ctx == nil {
		ctx = context.Background()
	}
	deadline := time.Now().Add(duration)
	buf := make([]byte, 65535)
	for time.Now().Before(deadline) {
		if ctx.Err() != nil {
			return
		}
		if err := conn.SetReadDeadline(deadline); err != nil {
			return
		}
		n, err := conn.Read(buf)
		if err != nil {
			return
		}
		if !isSIPResponseWire(buf[:n]) {
			continue
		}
		resp, err := ParseSIPResponse(buf[:n])
		if err != nil || !sipResponseMatchesRequest(resp, msg) {
			continue
		}
		if isSIPProvisionalResponse(resp.StatusCode) {
			continue
		}
	}
}

func isSIPTimeout(err error) bool {
	var netErr net.Error
	return errors.As(err, &netErr) && netErr.Timeout()
}

func isSIPRetryableTransportError(err error) bool {
	return sipTransportFailureRecovery(err).TargetFailover
}

func sipTransportFailureRecovery(err error) sipFailureRecovery {
	if err == nil {
		return sipFailureRecovery{Kind: sipFailureTransport}
	}
	if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
		return sipFailureRecovery{Kind: sipFailureTransport, Err: err}
	}
	if isSIPTimeout(err) || errors.Is(err, io.EOF) || errors.Is(err, net.ErrClosed) ||
		errors.Is(err, syscall.ECONNRESET) || errors.Is(err, syscall.ECONNABORTED) ||
		errors.Is(err, syscall.ECONNREFUSED) || errors.Is(err, syscall.EPIPE) {
		return sipFailureRecovery{Kind: sipFailureTransport, Err: err, Recoverable: true, TargetFailover: true}
	}
	var opErr *net.OpError
	if errors.As(err, &opErr) {
		return sipFailureRecovery{Kind: sipFailureTransport, Err: err, Recoverable: true, TargetFailover: true}
	}
	return sipFailureRecovery{Kind: sipFailureTransport, Err: err}
}

func sipURIAddr(uri string) (string, error) {
	endpoint, err := parseSIPURIEndpoint(uri)
	if err != nil {
		return "", err
	}
	return endpoint.addr(), nil
}

func canonicalHeaderName(name string) string {
	switch strings.ToLower(strings.TrimSpace(name)) {
	case "a":
		return "Accept-Contact"
	case "accept-contact":
		return "Accept-Contact"
	case "b":
		return "Referred-By"
	case "referred-by":
		return "Referred-By"
	case "d":
		return "Request-Disposition"
	case "request-disposition":
		return "Request-Disposition"
	case "e":
		return "Content-Encoding"
	case "content-encoding":
		return "Content-Encoding"
	case "i":
		return "Call-ID"
	case "call-id":
		return "Call-ID"
	case "j":
		return "Reject-Contact"
	case "reject-contact":
		return "Reject-Contact"
	case "k":
		return "Supported"
	case "supported":
		return "Supported"
	case "m":
		return "Contact"
	case "contact":
		return "Contact"
	case "o":
		return "Event"
	case "event":
		return "Event"
	case "r":
		return "Refer-To"
	case "refer-to":
		return "Refer-To"
	case "s":
		return "Subject"
	case "subject":
		return "Subject"
	case "u":
		return "Allow-Events"
	case "allow-events":
		return "Allow-Events"
	case "subscription-state":
		return "Subscription-State"
	case "x":
		return "Session-Expires"
	case "session-expires":
		return "Session-Expires"
	case "l":
		return "Content-Length"
	case "content-length":
		return "Content-Length"
	case "c":
		return "Content-Type"
	case "content-type":
		return "Content-Type"
	case "min-se":
		return "Min-SE"
	case "f":
		return "From"
	case "t":
		return "To"
	case "v":
		return "Via"
	case "www-authenticate":
		return "WWW-Authenticate"
	case "proxy-authenticate":
		return "Proxy-Authenticate"
	case "p-associated-uri":
		return "P-Associated-URI"
	case "p-preferred-identity":
		return "P-Preferred-Identity"
	case "p-access-network-info":
		return "P-Access-Network-Info"
	case "p-visited-network-id":
		return "P-Visited-Network-ID"
	case "service-route":
		return "Service-Route"
	case "security-server":
		return "Security-Server"
	case "security-client":
		return "Security-Client"
	case "security-verify":
		return "Security-Verify"
	default:
		parts := strings.Split(name, "-")
		for i, part := range parts {
			if part == "" {
				continue
			}
			parts[i] = strings.ToUpper(part[:1]) + strings.ToLower(part[1:])
		}
		return strings.Join(parts, "-")
	}
}

func firstHeaderValue(headers map[string]string, name string) string {
	for key, value := range headers {
		if strings.EqualFold(key, name) {
			return strings.TrimSpace(value)
		}
	}
	return ""
}
