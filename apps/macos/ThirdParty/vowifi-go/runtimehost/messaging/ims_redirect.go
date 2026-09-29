package messaging

import (
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/boa-z/vowifi-go/runtimehost/voiceclient"
)

const maxIMSMessagingRedirects = 4

type imsMessagingResponseHandling struct {
	StatusCode                 int
	Reason                     string
	RetryAfter                 time.Duration
	RedirectURI                string
	AuthChallengeHeader        string
	AuthChallenge              string
	AuthAuthorizationHeader    string
	RegistrationRecoveryNeeded bool
	FailureText                string
}

// IMSMessagingSIPRecoveryDecision describes the messaging-layer recovery action
// for a SIP response to SMS MESSAGE or USSD dialog requests.
type IMSMessagingSIPRecoveryDecision struct {
	Method                            string
	StatusCode                        int
	RetryAfter                        time.Duration
	RetryAfterPresent                 bool
	Recoverable                       bool
	TargetFailover                    bool
	RegistrationRecoveryNeeded        bool
	AuthenticationRefresh             bool
	AuthenticationChallengeHeader     string
	AuthenticationChallenge           string
	AuthenticationAuthorizationHeader string
	RedirectURI                       string
	Candidates                        []IMSMessagingRecoveryCandidate
	FailureText                       string
}

type IMSMessagingRecoveryCandidateKind string

const (
	IMSMessagingRecoveryCandidateRetryAfter         IMSMessagingRecoveryCandidateKind = "retry-after"
	IMSMessagingRecoveryCandidateRedirectContact    IMSMessagingRecoveryCandidateKind = "redirect-contact"
	IMSMessagingRecoveryCandidateAlternativeService IMSMessagingRecoveryCandidateKind = "alternative-service"
)

// IMSMessagingRecoveryCandidate is a sorted, local recovery option derived
// from SIP messaging failure metadata.
type IMSMessagingRecoveryCandidate struct {
	Kind              IMSMessagingRecoveryCandidateKind
	StatusCode        int
	URI               string
	RetryAfter        time.Duration
	RetryAfterPresent bool
	Weight            float64
}

// ClassifyIMSMessagingSIPResponseRecovery maps the generic SIP response
// recovery plan into SMS/USSD messaging decisions while preserving the legacy
// registration recovery statuses used by older runtime hosts.
func ClassifyIMSMessagingSIPResponseRecovery(method string, resp voiceclient.SIPResponse) IMSMessagingSIPRecoveryDecision {
	plan := voiceclient.SIPResponseRecoveryPlan(method, resp)
	retryAfter := plan.RetryAfter
	retryAfterPresent := plan.RetryAfterPresent
	if parsed, parsedPresent := imsMessagingResponseRetryAfter(resp); parsedPresent && (parsed > retryAfter || !retryAfterPresent) {
		retryAfter = parsed
		retryAfterPresent = true
	}
	candidates := imsMessagingRecoveryCandidatesForSIPResponse(resp, retryAfter, retryAfterPresent)
	redirectURI := firstMessagingRedirectContactURI(resp)
	decision := IMSMessagingSIPRecoveryDecision{
		Method:                     plan.Method,
		StatusCode:                 plan.StatusCode,
		RetryAfter:                 retryAfter,
		RetryAfterPresent:          retryAfterPresent,
		Recoverable:                plan.Recoverable,
		TargetFailover:             plan.TargetFailover,
		RegistrationRecoveryNeeded: plan.RegistrationRequired || IMSRegistrationRecoveryNeededStatus(resp.StatusCode),
		AuthenticationRefresh:      plan.AuthenticationRefresh,
		RedirectURI:                redirectURI,
		Candidates:                 candidates,
	}
	decision.AuthenticationChallengeHeader, decision.AuthenticationAuthorizationHeader = imsMessagingAuthHeaders(resp.StatusCode)
	if decision.AuthenticationChallengeHeader != "" {
		decision.AuthenticationRefresh = true
		decision.AuthenticationChallenge = firstHeaderValue(resp.Headers, decision.AuthenticationChallengeHeader)
	}
	if redirectURI != "" || firstIMSMessagingRecoveryTarget(candidates) != "" {
		decision.Recoverable = true
		decision.TargetFailover = true
	}
	if resp.StatusCode > 0 && (resp.StatusCode < 200 || resp.StatusCode >= 300) {
		methodName := firstNonEmpty(plan.Method, "MESSAGE")
		decision.FailureText = firstNonEmpty(strings.TrimSpace(resp.Reason), "IMS "+methodName+" rejected: "+strconv.Itoa(resp.StatusCode))
	}
	return decision
}

// IMSMessagingRecoveryCandidatesForSIPResponse extracts target and backoff
// hints from a SIP response. Candidates are returned from most to least useful
// for messaging recovery: direct target candidates first, higher q/weight first,
// and standalone Retry-After backoff only when no direct target is present.
func IMSMessagingRecoveryCandidatesForSIPResponse(resp voiceclient.SIPResponse) []IMSMessagingRecoveryCandidate {
	retryAfter, retryAfterPresent := imsMessagingResponseRetryAfter(resp)
	return imsMessagingRecoveryCandidatesForSIPResponse(resp, retryAfter, retryAfterPresent)
}

func imsMessagingResponseHandlingFor(resp voiceclient.SIPResponse) imsMessagingResponseHandling {
	recovery := ClassifyIMSMessagingSIPResponseRecovery("MESSAGE", resp)
	info := imsMessagingResponseHandling{
		StatusCode:                 resp.StatusCode,
		Reason:                     strings.TrimSpace(resp.Reason),
		RetryAfter:                 recovery.RetryAfter,
		RedirectURI:                recovery.RedirectURI,
		RegistrationRecoveryNeeded: recovery.RegistrationRecoveryNeeded,
		FailureText:                recovery.FailureText,
	}
	info.AuthChallengeHeader, info.AuthAuthorizationHeader = imsMessagingAuthHeaders(resp.StatusCode)
	if info.AuthChallengeHeader != "" {
		info.AuthChallenge = firstHeaderValue(resp.Headers, info.AuthChallengeHeader)
	}
	return info
}

func imsMessagingAuthHeaders(statusCode int) (challengeHeader, authorizationHeader string) {
	switch statusCode {
	case 401:
		return "WWW-Authenticate", "Authorization"
	case 407:
		return "Proxy-Authenticate", "Proxy-Authorization"
	default:
		return "", ""
	}
}

func retryMessagingDialogConfigForRedirect(cfg voiceclient.DialogRequestConfig, resp voiceclient.SIPResponse, cseq int) (voiceclient.DialogRequestConfig, bool) {
	target := imsMessagingResponseHandlingFor(resp).RedirectURI
	if target == "" {
		return voiceclient.DialogRequestConfig{}, false
	}
	retryCfg := cfg
	retryCfg.RemoteTargetURI = target
	retryCfg.CSeq = cseq
	return retryCfg, true
}

func imsMessagingRecoveryCandidatesForSIPResponse(resp voiceclient.SIPResponse, retryAfter time.Duration, retryAfterPresent bool) []IMSMessagingRecoveryCandidate {
	var candidates []IMSMessagingRecoveryCandidate
	switch {
	case resp.StatusCode == 380:
		candidates = append(candidates, messagingRecoveryCandidatesFromHeader(resp.Headers, "Alternative-Service", IMSMessagingRecoveryCandidateAlternativeService, resp.StatusCode, retryAfter, retryAfterPresent)...)
		candidates = append(candidates, messagingRecoveryCandidatesFromHeader(resp.Headers, "Contact", IMSMessagingRecoveryCandidateAlternativeService, resp.StatusCode, retryAfter, retryAfterPresent)...)
	case resp.StatusCode >= 300 && resp.StatusCode < 400:
		candidates = append(candidates, messagingRecoveryCandidatesFromHeader(resp.Headers, "Contact", IMSMessagingRecoveryCandidateRedirectContact, resp.StatusCode, retryAfter, retryAfterPresent)...)
	}
	candidates = dedupeIMSMessagingRecoveryCandidates(candidates)
	sortIMSMessagingRecoveryCandidates(candidates)
	if len(candidates) == 0 && retryAfterPresent {
		candidates = append(candidates, IMSMessagingRecoveryCandidate{
			Kind:              IMSMessagingRecoveryCandidateRetryAfter,
			StatusCode:        resp.StatusCode,
			RetryAfter:        retryAfter,
			RetryAfterPresent: true,
		})
	}
	return candidates
}

func messagingRecoveryCandidatesFromHeader(headers map[string][]string, header string, kind IMSMessagingRecoveryCandidateKind, statusCode int, retryAfter time.Duration, retryAfterPresent bool) []IMSMessagingRecoveryCandidate {
	var candidates []IMSMessagingRecoveryCandidate
	for _, value := range messagingSplitHeaderValues(headers, header) {
		uri := messagingHeaderURIValue(value)
		if !isMessagingRedirectTargetURI(uri) || messagingRedirectContactExpired(value) {
			continue
		}
		candidates = append(candidates, IMSMessagingRecoveryCandidate{
			Kind:              kind,
			StatusCode:        statusCode,
			URI:               uri,
			RetryAfter:        retryAfter,
			RetryAfterPresent: retryAfterPresent,
			Weight:            messagingRedirectContactQ(value),
		})
	}
	return candidates
}

func dedupeIMSMessagingRecoveryCandidates(in []IMSMessagingRecoveryCandidate) []IMSMessagingRecoveryCandidate {
	out := make([]IMSMessagingRecoveryCandidate, 0, len(in))
	for _, candidate := range in {
		duplicate := -1
		for i, existing := range out {
			if existing.Kind == candidate.Kind && existing.URI == candidate.URI {
				duplicate = i
				break
			}
		}
		if duplicate < 0 {
			out = append(out, candidate)
			continue
		}
		if candidate.Weight > out[duplicate].Weight {
			out[duplicate].Weight = candidate.Weight
		}
	}
	return out
}

func sortIMSMessagingRecoveryCandidates(candidates []IMSMessagingRecoveryCandidate) {
	sort.SliceStable(candidates, func(i, j int) bool {
		if left, right := imsMessagingRecoveryCandidateKindRank(candidates[i].Kind), imsMessagingRecoveryCandidateKindRank(candidates[j].Kind); left != right {
			return left < right
		}
		if candidates[i].Weight != candidates[j].Weight {
			return candidates[i].Weight > candidates[j].Weight
		}
		if candidates[i].RetryAfter != candidates[j].RetryAfter {
			return candidates[i].RetryAfter < candidates[j].RetryAfter
		}
		return false
	})
}

func imsMessagingRecoveryCandidateKindRank(kind IMSMessagingRecoveryCandidateKind) int {
	switch kind {
	case IMSMessagingRecoveryCandidateAlternativeService:
		return 0
	case IMSMessagingRecoveryCandidateRedirectContact:
		return 1
	case IMSMessagingRecoveryCandidateRetryAfter:
		return 2
	default:
		return 3
	}
}

func firstIMSMessagingRecoveryTarget(candidates []IMSMessagingRecoveryCandidate) string {
	for _, candidate := range candidates {
		if candidate.URI != "" {
			return candidate.URI
		}
	}
	return ""
}

func nextMessagingCSeq(cseq int) int {
	if cseq <= 0 {
		return 1
	}
	return cseq + 1
}

func firstMessagingRedirectContactURI(resp voiceclient.SIPResponse) string {
	if resp.StatusCode < 300 || resp.StatusCode >= 400 {
		return ""
	}
	for _, uri := range messagingRedirectContactURIs(resp.Headers) {
		return uri
	}
	return ""
}

func messagingRedirectContactURIs(headers map[string][]string) []string {
	contacts := messagingRecoveryCandidatesFromHeader(headers, "Contact", IMSMessagingRecoveryCandidateRedirectContact, 0, 0, false)
	contacts = dedupeIMSMessagingRecoveryCandidates(contacts)
	sortIMSMessagingRecoveryCandidates(contacts)
	out := make([]string, 0, len(contacts))
	for _, contact := range contacts {
		out = append(out, contact.URI)
	}
	return out
}

func isMessagingRedirectTargetURI(uri string) bool {
	uri = strings.TrimSpace(uri)
	if uri == "" || uri == "*" {
		return false
	}
	lower := strings.ToLower(uri)
	return strings.HasPrefix(lower, "sip:") || strings.HasPrefix(lower, "sips:")
}

func messagingRedirectContactQ(contact string) float64 {
	value, ok := sipContactHeaderParam(contact, "q")
	if !ok {
		return 1
	}
	q, err := strconv.ParseFloat(value, 64)
	if err != nil || q < 0 || q > 1 {
		return 1
	}
	return q
}

func messagingRedirectContactExpired(contact string) bool {
	value, ok := sipContactHeaderParam(contact, "expires")
	if !ok {
		return false
	}
	expires, err := strconv.Atoi(value)
	return err == nil && expires <= 0
}

func sipContactHeaderParam(contact, name string) (string, bool) {
	for _, param := range sipContactHeaderParams(contact) {
		key, raw, ok := strings.Cut(strings.TrimSpace(param), "=")
		if !ok || !strings.EqualFold(strings.TrimSpace(key), name) {
			continue
		}
		return strings.Trim(strings.TrimSpace(raw), `"`), true
	}
	return "", false
}

func sipContactHeaderParams(contact string) []string {
	var out []string
	var cur strings.Builder
	inQuote := false
	escaped := false
	angleDepth := 0
	collecting := false
	for _, r := range contact {
		switch {
		case escaped:
			if collecting {
				cur.WriteRune(r)
			}
			escaped = false
		case r == '\\' && inQuote:
			if collecting {
				cur.WriteRune(r)
			}
			escaped = true
		case r == '"':
			if collecting {
				cur.WriteRune(r)
			}
			inQuote = !inQuote
		case r == '<' && !inQuote:
			if collecting {
				cur.WriteRune(r)
			}
			angleDepth++
		case r == '>' && !inQuote:
			if collecting {
				cur.WriteRune(r)
			}
			if angleDepth > 0 {
				angleDepth--
			}
		case r == ';' && !inQuote && angleDepth == 0:
			if collecting {
				if part := strings.TrimSpace(cur.String()); part != "" {
					out = append(out, part)
				}
				cur.Reset()
			}
			collecting = true
		default:
			if collecting {
				cur.WriteRune(r)
			}
		}
	}
	if collecting {
		if part := strings.TrimSpace(cur.String()); part != "" {
			out = append(out, part)
		}
	}
	return out
}

func imsMessagingResponseRetryAfter(resp voiceclient.SIPResponse) (time.Duration, bool) {
	retryAfter := voiceclient.SIPResponseRetryAfter(resp)
	if retryAfter > 0 || resp.RetryAfter > 0 {
		return retryAfter, true
	}
	for _, value := range imsMessagingRawHeaderValues(resp.Headers, "Retry-After") {
		if imsMessagingRetryAfterValuePresent(value) {
			return retryAfter, true
		}
	}
	return 0, false
}

func imsMessagingRetryAfterValuePresent(value string) bool {
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

func imsMessagingRawHeaderValues(headers map[string][]string, name string) []string {
	var out []string
	for key, values := range headers {
		if !strings.EqualFold(key, name) {
			continue
		}
		for _, value := range values {
			if value = strings.TrimSpace(value); value != "" {
				out = append(out, value)
			}
		}
	}
	return out
}

func messagingSplitHeaderValues(headers map[string][]string, name string) []string {
	var out []string
	for key, values := range headers {
		if !strings.EqualFold(key, name) {
			continue
		}
		for _, value := range values {
			for _, part := range splitUSSDHeaderValues(value) {
				if part = strings.TrimSpace(part); part != "" {
					out = append(out, part)
				}
			}
		}
	}
	return out
}

func messagingHeaderURIValue(value string) string {
	value = strings.TrimSpace(value)
	if value == "" {
		return ""
	}
	if start := strings.IndexByte(value, '<'); start >= 0 {
		if end := strings.IndexByte(value[start+1:], '>'); end >= 0 {
			return strings.TrimSpace(value[start+1 : start+1+end])
		}
		return ""
	}
	uri := value
	if semi := strings.IndexByte(uri, ';'); semi >= 0 {
		uri = uri[:semi]
	}
	uri = strings.TrimSpace(strings.Trim(uri, "<>"))
	for _, param := range sipContactHeaderParams(value) {
		param = strings.TrimSpace(param)
		if param == "" || messagingHeaderURIValueSkipsParam(param) {
			continue
		}
		uri += ";" + param
	}
	return uri
}

func messagingHeaderURIValueSkipsParam(param string) bool {
	key, _, ok := strings.Cut(strings.TrimSpace(param), "=")
	if !ok {
		return false
	}
	switch strings.ToLower(strings.TrimSpace(key)) {
	case "expires", "q":
		return true
	default:
		return false
	}
}
