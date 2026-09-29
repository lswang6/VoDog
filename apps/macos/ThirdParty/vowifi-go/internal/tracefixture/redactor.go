package tracefixture

import (
	"bytes"
	"fmt"
	"net/netip"
	"regexp"
	"strconv"
	"strings"
	"sync"
)

var (
	sensitiveHeaderLineRE       = regexp.MustCompile(`(?im)^((?:Proxy-)?Authorization|(?:WWW-|Proxy-)?Authenticate|Authentication-Info|Proxy-Authentication-Info|Security-Client|Security-Server|Security-Verify|X-AKA|AKA)\s*:\s*.*$`)
	authParamRE                 = regexp.MustCompile(`(?i)\b(nonce|cnonce|response|auts|res|rand|autn|ck|ik)\b(\s*=\s*)("[^"]*"|[^,;\s]+)`)
	sipURIRE                    = regexp.MustCompile(`(?i)\b(sips?):([^@\s;>,"]+)@((?:\[[0-9a-f:.%]+\]|[A-Za-z0-9._-]+)(?::[0-9]+)?)`)
	telURIRE                    = regexp.MustCompile(`(?i)\btel:\+?[0-9][0-9(). -]{5,}[0-9]`)
	labelledSubscriberIDValueRE = regexp.MustCompile(`(?i)\b((?:imsi|imei|imeisv)\b[^0-9<]*)([0-9][0-9 .-]{12,}[0-9])`)
	labelledMSISDNValueRE       = regexp.MustCompile(`(?i)\b((?:msisdn|phone-number|subscriber-number)\b[^0-9+<]*)(\+?[0-9][0-9(). -]{5,}[0-9])`)
	pAccessNetworkInfoLineRE    = regexp.MustCompile(`(?im)^P-Access-Network-Info\s*:\s*.*$`)
	pAccessNetworkInfoParamRE   = regexp.MustCompile(`(?i)\b(utran-cell-id-3gpp|cell-id-3gpp|cgi-3gpp|ecgi-3gpp|e-ci-3gpp|ci-3gpp2|i-wlan-node-id|bssid|hessid|ssid|dsl-location|eth-location|operator-specific-gi)\b(\s*=\s*)("[^"]*"|[^,;\s]+)`)
	e164RE                      = regexp.MustCompile(`\+[1-9][0-9]{7,14}`)
	macAddressRE                = regexp.MustCompile(`(?i)\b[0-9a-f]{2}(?::[0-9a-f]{2}){5}\b`)
	longDigitRE                 = regexp.MustCompile(`\b[0-9]{14,16}\b`)
	longHexRE                   = regexp.MustCompile(`(?i)\b[0-9a-f]{32,}\b`)
	ipv4RE                      = regexp.MustCompile(`\b(?:[0-9]{1,3}\.){3}[0-9]{1,3}\b`)
)

type Redactor struct {
	mu       sync.Mutex
	counters map[string]int
	values   map[string]string
}

func NewRedactor() *Redactor {
	return &Redactor{
		counters: make(map[string]int),
		values:   make(map[string]string),
	}
}

func RedactString(s string) string {
	return NewRedactor().RedactString(s)
}

func RedactBytes(b []byte) []byte {
	return []byte(RedactString(string(b)))
}

func (r *Redactor) RedactBytes(b []byte) []byte {
	if r == nil {
		return RedactBytes(b)
	}
	return []byte(r.RedactString(string(b)))
}

func RedactSIPString(s string) string {
	return NewRedactor().RedactSIPString(s)
}

func (r *Redactor) RedactSIPString(s string) string {
	if r == nil {
		r = NewRedactor()
	}
	out := r.RedactString(s)
	if fixed, ok := refreshSIPContentLength(out); ok {
		return fixed
	}
	return out
}

func (r *Redactor) RedactString(s string) string {
	if r == nil {
		r = NewRedactor()
	}
	out := sensitiveHeaderLineRE.ReplaceAllStringFunc(s, func(line string) string {
		if name, _, ok := strings.Cut(line, ":"); ok {
			return strings.TrimSpace(name) + ": <redacted>"
		}
		return "<redacted>"
	})
	out = pAccessNetworkInfoLineRE.ReplaceAllStringFunc(out, r.redactPAccessNetworkInfoLine)
	out = authParamRE.ReplaceAllStringFunc(out, redactAuthParamAssignment)
	out = sipURIRE.ReplaceAllStringFunc(out, func(uri string) string {
		match := sipURIRE.FindStringSubmatch(uri)
		if len(match) != 4 {
			return uri
		}
		user := r.placeholder("sip-user", match[2])
		domain := r.redactDomain(match[3])
		return match[1] + ":" + user + "@" + domain
	})
	out = telURIRE.ReplaceAllStringFunc(out, func(v string) string {
		prefix := v[:strings.Index(v, ":")+1]
		return prefix + r.placeholder("msisdn", v[len(prefix):])
	})
	out = labelledSubscriberIDValueRE.ReplaceAllStringFunc(out, func(v string) string {
		match := labelledSubscriberIDValueRE.FindStringSubmatch(v)
		if len(match) != 3 {
			return v
		}
		return match[1] + r.placeholder("id", compactRedactionValue(match[2]))
	})
	out = labelledMSISDNValueRE.ReplaceAllStringFunc(out, func(v string) string {
		match := labelledMSISDNValueRE.FindStringSubmatch(v)
		if len(match) != 3 {
			return v
		}
		return match[1] + r.placeholder("msisdn", compactRedactionValue(match[2]))
	})
	out = e164RE.ReplaceAllStringFunc(out, func(v string) string {
		return "+" + r.placeholder("msisdn", v)
	})
	out = macAddressRE.ReplaceAllStringFunc(out, func(v string) string {
		return r.placeholder("mac", strings.ToLower(v))
	})
	out = ipv4RE.ReplaceAllStringFunc(out, func(v string) string {
		addr, err := netip.ParseAddr(v)
		if err != nil || !addr.Is4() {
			return v
		}
		return r.placeholder("ipv4", v)
	})
	out = ipv6CandidateRE.ReplaceAllStringFunc(out, r.redactIPv6Candidate)
	out = longDigitRE.ReplaceAllStringFunc(out, func(v string) string {
		return r.placeholder("id", v)
	})
	out = longHexRE.ReplaceAllStringFunc(out, func(v string) string {
		return r.placeholder("hex", strings.ToLower(v))
	})
	return out
}

func (r *Redactor) redactDomain(domain string) string {
	host, suffix := splitSIPHostPort(domain)
	if host == "" {
		return "redacted.invalid" + suffix
	}
	addrText := host
	bracketed := strings.HasPrefix(host, "[") && strings.HasSuffix(host, "]")
	if bracketed {
		addrText = strings.TrimSuffix(strings.TrimPrefix(host, "["), "]")
	}
	addrKey := stripIPZone(addrText)
	if addr, err := netip.ParseAddr(addrKey); err == nil {
		kind := "ipv4"
		if addr.Is6() {
			kind = "ipv6"
		}
		placeholder := r.placeholder(kind, strings.ToLower(addrText))
		if bracketed {
			placeholder = "[" + placeholder + "]"
		}
		return placeholder + suffix
	}
	return r.placeholder("domain", strings.ToLower(host)) + ".invalid" + suffix
}

func (r *Redactor) redactPAccessNetworkInfoLine(line string) string {
	return pAccessNetworkInfoParamRE.ReplaceAllStringFunc(line, func(param string) string {
		match := pAccessNetworkInfoParamRE.FindStringSubmatch(param)
		if len(match) != 4 {
			return param
		}
		return match[1] + match[2] + r.redactedParamValue("pani", match[3])
	})
}

func redactAuthParamAssignment(param string) string {
	match := authParamRE.FindStringSubmatch(param)
	if len(match) != 4 {
		return param
	}
	return match[1] + match[2] + redactedLiteralParamValue(match[3])
}

func (r *Redactor) redactedParamValue(kind, value string) string {
	return quoteLikeParamValue(value, r.placeholder(kind, unquoteParamValue(value)))
}

func redactedLiteralParamValue(value string) string {
	return quoteLikeParamValue(value, "<redacted>")
}

func quoteLikeParamValue(original, replacement string) string {
	trimmed := strings.TrimSpace(original)
	if len(trimmed) >= 2 && strings.HasPrefix(trimmed, `"`) && strings.HasSuffix(trimmed, `"`) {
		return `"` + replacement + `"`
	}
	return replacement
}

func unquoteParamValue(value string) string {
	value = strings.TrimSpace(value)
	if len(value) >= 2 && strings.HasPrefix(value, `"`) && strings.HasSuffix(value, `"`) {
		return value[1 : len(value)-1]
	}
	return value
}

func (r *Redactor) redactIPv6Candidate(candidate string) string {
	normalized := normalizeIPCandidate(candidate)
	if !strings.Contains(normalized, ":") {
		return candidate
	}
	addrText := stripIPZone(normalized)
	addr, err := netip.ParseAddr(addrText)
	if err != nil || !addr.Is6() {
		return candidate
	}
	return strings.Replace(candidate, normalized, r.placeholder("ipv6", strings.ToLower(normalized)), 1)
}

func splitSIPHostPort(hostport string) (string, string) {
	if strings.HasPrefix(hostport, "[") {
		if end := strings.IndexByte(hostport, ']'); end >= 0 {
			return hostport[:end+1], hostport[end+1:]
		}
		return hostport, ""
	}
	if at := strings.LastIndexByte(hostport, ':'); at > 0 && strings.Count(hostport, ":") == 1 && allDigits(hostport[at+1:]) {
		return hostport[:at], hostport[at:]
	}
	return hostport, ""
}

func stripIPZone(value string) string {
	if zone := strings.IndexByte(value, '%'); zone >= 0 {
		return value[:zone]
	}
	return value
}

func allDigits(value string) bool {
	if value == "" {
		return false
	}
	for _, r := range value {
		if r < '0' || r > '9' {
			return false
		}
	}
	return true
}

func compactRedactionValue(value string) string {
	var b strings.Builder
	for _, r := range value {
		switch {
		case r >= '0' && r <= '9':
			b.WriteRune(r)
		case r >= 'A' && r <= 'Z':
			b.WriteRune(r + ('a' - 'A'))
		case r >= 'a' && r <= 'z':
			b.WriteRune(r)
		case r == '+':
			b.WriteRune(r)
		}
	}
	if b.Len() == 0 {
		return strings.TrimSpace(value)
	}
	return b.String()
}

func refreshSIPContentLength(wire string) (string, bool) {
	separator := "\r\n\r\n"
	lineSeparator := "\r\n"
	at := strings.Index(wire, separator)
	if at < 0 {
		separator = "\n\n"
		lineSeparator = "\n"
		at = strings.Index(wire, separator)
	}
	if at < 0 {
		return wire, false
	}

	head := wire[:at]
	body := wire[at+len(separator):]
	lines := strings.Split(head, lineSeparator)
	if len(lines) == 0 {
		return wire, false
	}

	contentLength := strconv.Itoa(len(body))
	updated := false
	for i, line := range lines {
		name, _, ok := strings.Cut(line, ":")
		if !ok || canonicalSIPHeaderName(name) != "Content-Length" {
			continue
		}
		lines[i] = strings.TrimSpace(name) + ": " + contentLength
		updated = true
	}
	if !updated && body != "" {
		lines = append(lines, "Content-Length: "+contentLength)
		updated = true
	}
	if !updated {
		return wire, false
	}
	return strings.Join(lines, lineSeparator) + separator + body, true
}

func (r *Redactor) placeholder(kind, value string) string {
	value = strings.TrimSpace(value)
	if value == "" {
		return "<redacted-" + kind + ">"
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	key := kind + "\x00" + value
	if out, ok := r.values[key]; ok {
		return out
	}
	r.counters[kind]++
	out := fmt.Sprintf("<redacted-%s-%d>", kind, r.counters[kind])
	r.values[key] = out
	return out
}

func RedactLines(lines [][]byte) [][]byte {
	r := NewRedactor()
	out := make([][]byte, len(lines))
	for i, line := range lines {
		out[i] = r.RedactBytes(bytes.Clone(line))
	}
	return out
}
