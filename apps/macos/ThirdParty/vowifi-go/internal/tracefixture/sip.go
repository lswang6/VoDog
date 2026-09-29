package tracefixture

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"mime"
	"mime/multipart"
	"net/textproto"
	"strconv"
	"strings"
)

var ErrInvalidSIPMessage = errors.New("invalid SIP message")

type SIPMessage struct {
	StartLine  string
	IsRequest  bool
	IsStatus   bool
	Method     string
	RequestURI string
	Version    string
	StatusCode int
	Reason     string
	Headers    map[string][]string
	Body       []byte
}

type SIPMultipartLeaf struct {
	Path               []int
	Headers            map[string][]string
	ContentType        string
	ContentDisposition string
	ContentID          string
	Body               []byte
}

func (event ReplayEvent) SIPMessage() (SIPMessage, error) {
	msg, err := ParseSIPMessage(event.Wire)
	if err != nil {
		return SIPMessage{}, fmt.Errorf("event %d %q: %w", event.Index, event.Label, err)
	}
	return msg, nil
}

func ParseSIPMessage(wire []byte) (SIPMessage, error) {
	head, body, err := splitSIPWire(wire)
	if err != nil {
		return SIPMessage{}, err
	}
	lines := splitSIPHeaderLines(head)
	if len(lines) == 0 || strings.TrimSpace(lines[0]) == "" {
		return SIPMessage{}, fmt.Errorf("%w: empty start line", ErrInvalidSIPMessage)
	}

	msg := SIPMessage{
		StartLine: strings.TrimRight(lines[0], "\r"),
		Headers:   make(map[string][]string),
	}
	if err := parseSIPStartLine(&msg); err != nil {
		return SIPMessage{}, err
	}
	if err := parseSIPHeaders(msg.Headers, lines[1:]); err != nil {
		return SIPMessage{}, err
	}
	body, err = validateSIPContentLength(msg.Headers, body)
	if err != nil {
		return SIPMessage{}, err
	}
	msg.Body = bytes.Clone(body)
	return msg, nil
}

func (msg SIPMessage) Header(name string) string {
	values := msg.HeaderValues(name)
	if len(values) == 0 {
		return ""
	}
	return values[0]
}

func (msg SIPMessage) HeaderValues(name string) []string {
	if len(msg.Headers) == 0 {
		return nil
	}
	values := msg.Headers[canonicalSIPHeaderName(name)]
	if len(values) == 0 {
		return nil
	}
	out := make([]string, len(values))
	copy(out, values)
	return out
}

func (msg SIPMessage) CSeq() (int, string, bool) {
	value := msg.Header("CSeq")
	fields := strings.Fields(value)
	if len(fields) != 2 {
		return 0, "", false
	}
	seq, err := strconv.Atoi(fields[0])
	if err != nil || seq < 0 {
		return 0, "", false
	}
	method := strings.ToUpper(fields[1])
	if method == "" {
		return 0, "", false
	}
	return seq, method, true
}

func (msg SIPMessage) ContentType() (string, map[string]string, bool, error) {
	return parseSIPContentType(msg.Header("Content-Type"))
}

func (msg SIPMessage) MultipartLeaves() ([]SIPMultipartLeaf, error) {
	mediaType, params, ok, err := msg.ContentType()
	if err != nil || !ok || !strings.HasPrefix(mediaType, "multipart/") {
		return nil, err
	}
	boundary := params["boundary"]
	if boundary == "" {
		return nil, fmt.Errorf("%w: multipart content type missing boundary", ErrInvalidSIPMessage)
	}
	leaves, err := multipartLeaves(msg.Body, boundary, nil)
	if err != nil {
		return nil, err
	}
	return leaves, nil
}

func (leaf SIPMultipartLeaf) Header(name string) string {
	values := leaf.HeaderValues(name)
	if len(values) == 0 {
		return ""
	}
	return values[0]
}

func (leaf SIPMultipartLeaf) HeaderValues(name string) []string {
	if len(leaf.Headers) == 0 {
		return nil
	}
	values := leaf.Headers[canonicalSIPHeaderName(name)]
	if len(values) == 0 {
		return nil
	}
	out := make([]string, len(values))
	copy(out, values)
	return out
}

func splitSIPWire(wire []byte) (string, []byte, error) {
	if len(wire) == 0 {
		return "", nil, fmt.Errorf("%w: empty wire", ErrInvalidSIPMessage)
	}
	if at := bytes.Index(wire, []byte("\r\n\r\n")); at >= 0 {
		return string(wire[:at]), wire[at+4:], nil
	}
	if at := bytes.Index(wire, []byte("\n\n")); at >= 0 {
		return string(wire[:at]), wire[at+2:], nil
	}
	return "", nil, fmt.Errorf("%w: missing header terminator", ErrInvalidSIPMessage)
}

func splitSIPHeaderLines(head string) []string {
	if strings.Contains(head, "\r\n") {
		return strings.Split(head, "\r\n")
	}
	return strings.Split(head, "\n")
}

func parseSIPStartLine(msg *SIPMessage) error {
	if strings.HasPrefix(msg.StartLine, "SIP/") {
		fields := strings.Fields(msg.StartLine)
		if len(fields) < 2 || fields[0] == "" || fields[1] == "" {
			return fmt.Errorf("%w: malformed status line", ErrInvalidSIPMessage)
		}
		statusCode, err := strconv.Atoi(fields[1])
		if err != nil || statusCode < 100 || statusCode > 699 {
			return fmt.Errorf("%w: invalid status code", ErrInvalidSIPMessage)
		}
		msg.IsStatus = true
		msg.Version = fields[0]
		msg.StatusCode = statusCode
		if len(fields) > 2 {
			msg.Reason = strings.Join(fields[2:], " ")
		}
		return nil
	}

	fields := strings.Fields(msg.StartLine)
	if len(fields) != 3 || fields[0] == "" || fields[1] == "" || !strings.HasPrefix(fields[2], "SIP/") {
		return fmt.Errorf("%w: malformed request line", ErrInvalidSIPMessage)
	}
	msg.IsRequest = true
	msg.Method = strings.ToUpper(fields[0])
	msg.RequestURI = fields[1]
	msg.Version = fields[2]
	return nil
}

func parseSIPHeaders(headers map[string][]string, lines []string) error {
	var currentName string
	for _, line := range lines {
		line = strings.TrimRight(line, "\r")
		if line == "" {
			return fmt.Errorf("%w: unexpected blank header line", ErrInvalidSIPMessage)
		}
		if line[0] == ' ' || line[0] == '\t' {
			if currentName == "" {
				return fmt.Errorf("%w: folded header without a previous field", ErrInvalidSIPMessage)
			}
			values := headers[currentName]
			values[len(values)-1] += " " + strings.TrimSpace(line)
			headers[currentName] = values
			continue
		}

		name, value, ok := strings.Cut(line, ":")
		if !ok {
			return fmt.Errorf("%w: malformed header", ErrInvalidSIPMessage)
		}
		name = strings.TrimSpace(name)
		if !validSIPHeaderName(name) {
			return fmt.Errorf("%w: invalid header name", ErrInvalidSIPMessage)
		}
		currentName = canonicalSIPHeaderName(name)
		headers[currentName] = append(headers[currentName], strings.TrimSpace(value))
	}
	return nil
}

func validateSIPContentLength(headers map[string][]string, body []byte) ([]byte, error) {
	values := headers[canonicalSIPHeaderName("Content-Length")]
	if len(values) == 0 {
		if len(body) != 0 {
			return nil, fmt.Errorf("%w: body without content length", ErrInvalidSIPMessage)
		}
		return body, nil
	}

	want := -1
	for _, value := range values {
		n, err := strconv.Atoi(strings.TrimSpace(value))
		if err != nil || n < 0 {
			return nil, fmt.Errorf("%w: invalid content length", ErrInvalidSIPMessage)
		}
		if want >= 0 && n != want {
			return nil, fmt.Errorf("%w: conflicting content length", ErrInvalidSIPMessage)
		}
		want = n
	}
	if len(body) != want {
		return nil, fmt.Errorf("%w: content length %d does not match body length %d", ErrInvalidSIPMessage, want, len(body))
	}
	return body, nil
}

func multipartLeaves(body []byte, boundary string, path []int) ([]SIPMultipartLeaf, error) {
	reader := multipart.NewReader(bytes.NewReader(body), boundary)
	var leaves []SIPMultipartLeaf
	for index := 0; ; index++ {
		part, err := reader.NextRawPart()
		if errors.Is(err, io.EOF) {
			return leaves, nil
		}
		if err != nil {
			return nil, fmt.Errorf("%w: malformed multipart body", ErrInvalidSIPMessage)
		}
		partBody, err := io.ReadAll(part)
		if err != nil {
			return nil, fmt.Errorf("%w: read multipart body: %v", ErrInvalidSIPMessage, err)
		}
		partPath := append(append([]int(nil), path...), index)
		headers := cloneSIPHeaderMap(part.Header)
		contentType := firstSIPHeader(headers, "Content-Type")
		mediaType, params, ok, err := parseSIPContentType(contentType)
		if err != nil {
			return nil, err
		}
		if ok && strings.HasPrefix(mediaType, "multipart/") {
			boundary := params["boundary"]
			if boundary == "" {
				return nil, fmt.Errorf("%w: nested multipart content type missing boundary", ErrInvalidSIPMessage)
			}
			nested, err := multipartLeaves(partBody, boundary, partPath)
			if err != nil {
				return nil, err
			}
			leaves = append(leaves, nested...)
			continue
		}
		leaves = append(leaves, SIPMultipartLeaf{
			Path:               partPath,
			Headers:            headers,
			ContentType:        contentType,
			ContentDisposition: firstSIPHeader(headers, "Content-Disposition"),
			ContentID:          firstSIPHeader(headers, "Content-ID"),
			Body:               bytes.Clone(partBody),
		})
	}
}

func parseSIPContentType(value string) (string, map[string]string, bool, error) {
	if strings.TrimSpace(value) == "" {
		return "", nil, false, nil
	}
	mediaType, params, err := mime.ParseMediaType(value)
	if err != nil {
		return "", nil, true, fmt.Errorf("%w: invalid content type", ErrInvalidSIPMessage)
	}
	out := make(map[string]string, len(params))
	for name, value := range params {
		out[strings.ToLower(name)] = value
	}
	return strings.ToLower(mediaType), out, true, nil
}

func cloneSIPHeaderMap(headers map[string][]string) map[string][]string {
	out := make(map[string][]string, len(headers))
	for name, values := range headers {
		canonicalName := canonicalSIPHeaderName(name)
		out[canonicalName] = append(out[canonicalName], values...)
	}
	return out
}

func firstSIPHeader(headers map[string][]string, name string) string {
	values := headers[canonicalSIPHeaderName(name)]
	if len(values) == 0 {
		return ""
	}
	return values[0]
}

func validSIPHeaderName(name string) bool {
	if name == "" {
		return false
	}
	for _, r := range name {
		switch {
		case r >= 'A' && r <= 'Z':
		case r >= 'a' && r <= 'z':
		case r >= '0' && r <= '9':
		case r == '-':
		default:
			return false
		}
	}
	return true
}

func canonicalSIPHeaderName(name string) string {
	switch strings.ToLower(strings.TrimSpace(name)) {
	case "cseq":
		return "CSeq"
	case "call-id", "i":
		return "Call-ID"
	case "content-length", "l":
		return "Content-Length"
	case "content-type", "c":
		return "Content-Type"
	case "from", "f":
		return "From"
	case "to", "t":
		return "To"
	case "via", "v":
		return "Via"
	case "contact", "m":
		return "Contact"
	case "www-authenticate":
		return "WWW-Authenticate"
	case "proxy-authenticate":
		return "Proxy-Authenticate"
	case "authorization":
		return "Authorization"
	case "proxy-authorization":
		return "Proxy-Authorization"
	case "p-associated-uri":
		return "P-Associated-URI"
	case "security-client":
		return "Security-Client"
	case "security-server":
		return "Security-Server"
	case "security-verify":
		return "Security-Verify"
	default:
		return textproto.CanonicalMIMEHeaderKey(strings.TrimSpace(name))
	}
}
