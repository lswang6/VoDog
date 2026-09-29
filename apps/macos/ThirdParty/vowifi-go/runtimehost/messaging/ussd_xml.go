package messaging

import (
	"bytes"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"mime"
	"mime/multipart"
	"strconv"
	"strings"
)

const IMSUSSDContentType = "application/vnd.3gpp.ussd+xml"
const IMSUSSDInfoPackage = "g.3gpp.ussd"
const IMSUSSDContentDisposition = "Info-Package"

type IMSUSSDOperation string

const (
	IMSUSSDOperationRequest  IMSUSSDOperation = "request"
	IMSUSSDOperationResponse IMSUSSDOperation = "response"
	IMSUSSDOperationNotify   IMSUSSDOperation = "notify"
	IMSUSSDOperationRelease  IMSUSSDOperation = "release"
)

type IMSUSSDPayload struct {
	Language            string
	Text                string
	Operation           IMSUSSDOperation
	ErrorCode           int
	HasError            bool
	AlertingPattern     int
	HasAlertingPattern  bool
	RawOperationElement string
}

type ussdDataXML struct {
	XMLName                xml.Name       `xml:"ussd-data"`
	Language               string         `xml:"language,omitempty"`
	String                 string         `xml:"ussd-string,omitempty"`
	ErrorCode              string         `xml:"error-code,omitempty"`
	Operation              string         `xml:"operation,omitempty"`
	UnstructuredSSRequest  *struct{}      `xml:"UnstructuredSS-Request,omitempty"`
	UnstructuredSSResponse *struct{}      `xml:"UnstructuredSS-Response,omitempty"`
	UnstructuredSSNotify   *struct{}      `xml:"UnstructuredSS-Notify,omitempty"`
	UnstructuredSSRelease  *struct{}      `xml:"UnstructuredSS-Release,omitempty"`
	Request                *struct{}      `xml:"request,omitempty"`
	Response               *struct{}      `xml:"response,omitempty"`
	Notify                 *struct{}      `xml:"notify,omitempty"`
	Release                *struct{}      `xml:"release,omitempty"`
	AlertingPattern        string         `xml:"alertingPattern,omitempty"`
	AnyExt                 *ussdAnyExtXML `xml:"anyExt,omitempty"`
}

type ussdAnyExtXML struct {
	UnstructuredSSRequest  *struct{} `xml:"UnstructuredSS-Request,omitempty"`
	UnstructuredSSResponse *struct{} `xml:"UnstructuredSS-Response,omitempty"`
	UnstructuredSSNotify   *struct{} `xml:"UnstructuredSS-Notify,omitempty"`
	UnstructuredSSRelease  *struct{} `xml:"UnstructuredSS-Release,omitempty"`
	Request                *struct{} `xml:"request,omitempty"`
	Response               *struct{} `xml:"response,omitempty"`
	Notify                 *struct{} `xml:"notify,omitempty"`
	Release                *struct{} `xml:"release,omitempty"`
	Operation              string    `xml:"operation,omitempty"`
	AlertingPattern        string    `xml:"alertingPattern,omitempty"`
}

func BuildIMSUSSDXML(payload IMSUSSDPayload) ([]byte, error) {
	op := payload.Operation
	if op == "" {
		op = IMSUSSDOperationRequest
	}
	text := strings.TrimSpace(payload.Text)
	if text == "" && !payload.HasError && op != IMSUSSDOperationRelease {
		return nil, errors.New("USSD text is empty")
	}
	language := strings.TrimSpace(payload.Language)
	if language == "" {
		language = "en"
	}
	if strings.ContainsAny(language, " \t\r\n") {
		return nil, fmt.Errorf("USSD language contains whitespace: %q", language)
	}
	data := ussdDataXML{
		Language: language,
		String:   text,
	}
	if payload.HasError {
		if payload.ErrorCode < 0 || payload.ErrorCode > 65535 {
			return nil, fmt.Errorf("USSD error code out of range: %d", payload.ErrorCode)
		}
		data.ErrorCode = strconv.Itoa(payload.ErrorCode)
	}
	switch op {
	case IMSUSSDOperationRequest:
		data.UnstructuredSSRequest = &struct{}{}
	case IMSUSSDOperationResponse:
		data.UnstructuredSSResponse = &struct{}{}
	case IMSUSSDOperationNotify:
		data.UnstructuredSSNotify = &struct{}{}
	case IMSUSSDOperationRelease:
		data.UnstructuredSSRelease = &struct{}{}
	default:
		return nil, fmt.Errorf("unsupported USSD operation: %s", op)
	}
	if payload.HasAlertingPattern {
		if payload.AlertingPattern < 0 || payload.AlertingPattern > 255 {
			return nil, fmt.Errorf("USSD alerting pattern out of range: %d", payload.AlertingPattern)
		}
		data.AlertingPattern = strconv.Itoa(payload.AlertingPattern)
	}
	out, err := xml.Marshal(data)
	if err != nil {
		return nil, err
	}
	return append([]byte(xml.Header), out...), nil
}

func ParseIMSUSSDXML(body []byte) (IMSUSSDPayload, error) {
	body = []byte(strings.TrimSpace(string(body)))
	if len(body) == 0 {
		return IMSUSSDPayload{}, errors.New("USSD XML body is empty")
	}
	var data ussdDataXML
	if err := xml.Unmarshal(body, &data); err != nil {
		return IMSUSSDPayload{}, err
	}
	if data.XMLName.Local != "ussd-data" {
		return IMSUSSDPayload{}, fmt.Errorf("unexpected USSD XML root: %s", data.XMLName.Local)
	}
	payload := IMSUSSDPayload{
		Language: strings.TrimSpace(data.Language),
		Text:     strings.ToValidUTF8(data.String, ""),
	}
	if data.UnstructuredSSRequest != nil {
		setIMSUSSDPayloadOperation(&payload, IMSUSSDOperationRequest, "UnstructuredSS-Request", true)
	}
	if data.Request != nil {
		setIMSUSSDPayloadOperation(&payload, IMSUSSDOperationRequest, "request", true)
	}
	if data.UnstructuredSSResponse != nil {
		setIMSUSSDPayloadOperation(&payload, IMSUSSDOperationResponse, "UnstructuredSS-Response", true)
	}
	if data.Response != nil {
		setIMSUSSDPayloadOperation(&payload, IMSUSSDOperationResponse, "response", true)
	}
	if op, raw := parseIMSUSSDOperationText(data.Operation); op != "" {
		setIMSUSSDPayloadOperation(&payload, op, raw, false)
	}
	if data.UnstructuredSSNotify != nil {
		setIMSUSSDPayloadOperation(&payload, IMSUSSDOperationNotify, "UnstructuredSS-Notify", true)
	}
	if data.Notify != nil {
		setIMSUSSDPayloadOperation(&payload, IMSUSSDOperationNotify, "notify", true)
	}
	if data.UnstructuredSSRelease != nil {
		setIMSUSSDPayloadOperation(&payload, IMSUSSDOperationRelease, "UnstructuredSS-Release", true)
	}
	if data.Release != nil {
		setIMSUSSDPayloadOperation(&payload, IMSUSSDOperationRelease, "release", true)
	}
	if data.AnyExt != nil {
		if data.AnyExt.UnstructuredSSRequest != nil {
			setIMSUSSDPayloadOperation(&payload, IMSUSSDOperationRequest, "UnstructuredSS-Request", false)
		}
		if data.AnyExt.Request != nil {
			setIMSUSSDPayloadOperation(&payload, IMSUSSDOperationRequest, "request", false)
		}
		if data.AnyExt.UnstructuredSSResponse != nil {
			setIMSUSSDPayloadOperation(&payload, IMSUSSDOperationResponse, "UnstructuredSS-Response", false)
		}
		if data.AnyExt.Response != nil {
			setIMSUSSDPayloadOperation(&payload, IMSUSSDOperationResponse, "response", false)
		}
		if op, raw := parseIMSUSSDOperationText(data.AnyExt.Operation); op != "" {
			setIMSUSSDPayloadOperation(&payload, op, raw, false)
		}
		if data.AnyExt.UnstructuredSSNotify != nil {
			setIMSUSSDPayloadOperation(&payload, IMSUSSDOperationNotify, "UnstructuredSS-Notify", false)
		}
		if data.AnyExt.Notify != nil {
			setIMSUSSDPayloadOperation(&payload, IMSUSSDOperationNotify, "notify", false)
		}
		if data.AnyExt.UnstructuredSSRelease != nil {
			setIMSUSSDPayloadOperation(&payload, IMSUSSDOperationRelease, "UnstructuredSS-Release", false)
		}
		if data.AnyExt.Release != nil {
			setIMSUSSDPayloadOperation(&payload, IMSUSSDOperationRelease, "release", false)
		}
		if strings.TrimSpace(data.AlertingPattern) == "" {
			data.AlertingPattern = data.AnyExt.AlertingPattern
		}
	}
	if strings.TrimSpace(data.ErrorCode) != "" {
		code, err := strconv.Atoi(strings.TrimSpace(data.ErrorCode))
		if err != nil {
			return IMSUSSDPayload{}, fmt.Errorf("invalid USSD error code: %w", err)
		}
		payload.ErrorCode = code
		payload.HasError = true
	}
	if strings.TrimSpace(data.AlertingPattern) != "" {
		pattern, err := strconv.Atoi(strings.TrimSpace(data.AlertingPattern))
		if err != nil {
			return IMSUSSDPayload{}, fmt.Errorf("invalid USSD alerting pattern: %w", err)
		}
		payload.AlertingPattern = pattern
		payload.HasAlertingPattern = true
	}
	if payload.Operation == "" {
		payload.Operation = IMSUSSDOperationNotify
	}
	return payload, nil
}

func setIMSUSSDPayloadOperation(payload *IMSUSSDPayload, op IMSUSSDOperation, raw string, override bool) {
	if payload == nil || op == "" {
		return
	}
	if payload.Operation != "" && !override {
		return
	}
	payload.Operation = op
	payload.RawOperationElement = strings.TrimSpace(raw)
}

func parseIMSUSSDOperationText(value string) (IMSUSSDOperation, string) {
	raw := strings.TrimSpace(value)
	switch strings.ToLower(raw) {
	case "request", "unstructuredss-request", "unstructuredssrequest":
		return IMSUSSDOperationRequest, firstNonEmpty(raw, "request")
	case "response", "unstructuredss-response", "unstructuredssresponse":
		return IMSUSSDOperationResponse, firstNonEmpty(raw, "response")
	case "notify", "notification", "unstructuredss-notify", "unstructuredssnotify":
		return IMSUSSDOperationNotify, firstNonEmpty(raw, "notify")
	case "release", "unstructuredss-release", "unstructuredssrelease":
		return IMSUSSDOperationRelease, firstNonEmpty(raw, "release")
	default:
		return "", ""
	}
}

func normalizeUSSDContentType(contentType string) string {
	contentType = strings.ToLower(strings.TrimSpace(contentType))
	if semi := strings.IndexByte(contentType, ';'); semi >= 0 {
		contentType = strings.TrimSpace(contentType[:semi])
	}
	return contentType
}

func DecodeIMSUSSDDocument(contentType string, body []byte) (IMSUSSDPayload, bool, error) {
	contentType = strings.TrimSpace(contentType)
	if len(bytes.TrimSpace(body)) == 0 {
		return IMSUSSDPayload{}, false, nil
	}
	mediaType, params, err := mime.ParseMediaType(contentType)
	if err != nil {
		mediaType = normalizeUSSDContentType(contentType)
	}
	switch strings.ToLower(mediaType) {
	case IMSUSSDContentType:
		payload, err := ParseIMSUSSDXML(body)
		return payload, true, err
	case "multipart/mixed", "multipart/related":
		boundary := strings.TrimSpace(params["boundary"])
		if boundary == "" {
			return IMSUSSDPayload{}, false, errors.New("USSD multipart boundary is empty")
		}
		parts, err := readIMSUSSDMultipartParts(body, boundary)
		if err != nil {
			return IMSUSSDPayload{}, false, err
		}
		if part, ok := imsUSSDMultipartStartPart(parts, imsUSSDMultipartStartContentID(params["start"])); ok {
			payload, err := ParseIMSUSSDXML(part.Body)
			return payload, true, err
		}
		for _, part := range parts {
			if normalizeUSSDContentType(part.ContentType) == IMSUSSDContentType {
				payload, err := ParseIMSUSSDXML(part.Body)
				return payload, true, err
			}
		}
		return IMSUSSDPayload{}, false, nil
	default:
		if bytes.HasPrefix(bytes.TrimSpace(body), []byte("<")) {
			payload, err := ParseIMSUSSDXML(body)
			return payload, true, err
		}
		return IMSUSSDPayload{}, false, nil
	}
}

type imsUSSDMultipartPart struct {
	ContentType string
	ContentID   string
	Body        []byte
}

func readIMSUSSDMultipartParts(body []byte, boundary string) ([]imsUSSDMultipartPart, error) {
	reader := multipart.NewReader(bytes.NewReader(body), boundary)
	var parts []imsUSSDMultipartPart
	for {
		part, err := reader.NextPart()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return nil, err
		}
		partBody, err := io.ReadAll(part)
		if err != nil {
			return nil, err
		}
		parts = append(parts, imsUSSDMultipartPart{
			ContentType: part.Header.Get("Content-Type"),
			ContentID:   part.Header.Get("Content-ID"),
			Body:        partBody,
		})
	}
	return parts, nil
}

func imsUSSDMultipartStartContentID(value string) string {
	value = strings.Trim(strings.TrimSpace(value), `"`)
	value = strings.Trim(strings.TrimSpace(value), "<>")
	return strings.ToLower(value)
}

func imsUSSDMultipartStartPart(parts []imsUSSDMultipartPart, startContentID string) (imsUSSDMultipartPart, bool) {
	startContentID = imsUSSDMultipartStartContentID(startContentID)
	if startContentID == "" {
		return imsUSSDMultipartPart{}, false
	}
	for _, part := range parts {
		if imsUSSDMultipartStartContentID(part.ContentID) != startContentID {
			continue
		}
		if normalizeUSSDContentType(part.ContentType) != IMSUSSDContentType {
			return imsUSSDMultipartPart{}, false
		}
		return part, true
	}
	return imsUSSDMultipartPart{}, false
}

func ussdResultFromPayload(sessionID string, payload IMSUSSDPayload, status int) USSDResult {
	done := payload.HasError || payload.Operation == IMSUSSDOperationNotify || payload.Operation == IMSUSSDOperationRelease
	res := USSDResult{
		SessionID: sessionID,
		Text:      payload.Text,
		RawText:   payload.Text,
		Status:    status,
		DCS:       15,
		Done:      done,
	}
	if payload.HasError {
		res.Status = payload.ErrorCode
	}
	return normalizeUSSDResult(res, sessionID)
}
