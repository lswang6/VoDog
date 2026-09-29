package messaging

import (
	"strings"
	"testing"
)

func TestIMSUSSDXMLRoundTripRequest(t *testing.T) {
	body, err := BuildIMSUSSDXML(IMSUSSDPayload{
		Language:  "en",
		Text:      "*100#",
		Operation: IMSUSSDOperationRequest,
	})
	if err != nil {
		t.Fatalf("BuildIMSUSSDXML() error = %v", err)
	}
	if !strings.Contains(string(body), "UnstructuredSS-Request") {
		t.Fatalf("body=%s", body)
	}
	payload, err := ParseIMSUSSDXML(body)
	if err != nil {
		t.Fatalf("ParseIMSUSSDXML() error = %v", err)
	}
	if payload.Language != "en" || payload.Text != "*100#" || payload.Operation != IMSUSSDOperationRequest {
		t.Fatalf("payload=%+v", payload)
	}
}

func TestParseIMSUSSDXMLNotifyWithError(t *testing.T) {
	payload, err := ParseIMSUSSDXML([]byte(`<ussd-data><language>en</language><ussd-string>failed</ussd-string><UnstructuredSS-Notify/><error-code>17</error-code></ussd-data>`))
	if err != nil {
		t.Fatalf("ParseIMSUSSDXML() error = %v", err)
	}
	if payload.Operation != IMSUSSDOperationNotify || payload.Text != "failed" || !payload.HasError || payload.ErrorCode != 17 {
		t.Fatalf("payload=%+v", payload)
	}
}

func TestParseIMSUSSDXMLLowercaseNotifyAndOperationText(t *testing.T) {
	payload, err := ParseIMSUSSDXML([]byte(`<ussd-data><language>en</language><ussd-string>Balance: 10</ussd-string><notify/></ussd-data>`))
	if err != nil {
		t.Fatalf("ParseIMSUSSDXML(notify) error = %v", err)
	}
	if payload.Operation != IMSUSSDOperationNotify || payload.RawOperationElement != "notify" || payload.Text != "Balance: 10" {
		t.Fatalf("notify payload=%+v", payload)
	}

	payload, err = ParseIMSUSSDXML([]byte(`<ussd-data><ussd-string>1</ussd-string><anyExt><operation>request</operation></anyExt></ussd-data>`))
	if err != nil {
		t.Fatalf("ParseIMSUSSDXML(operation) error = %v", err)
	}
	if payload.Operation != IMSUSSDOperationRequest || payload.RawOperationElement != "request" || payload.Text != "1" {
		t.Fatalf("operation payload=%+v", payload)
	}
}

func TestIMSUSSDXMLResponseAndReleaseOperations(t *testing.T) {
	responseBody, err := BuildIMSUSSDXML(IMSUSSDPayload{
		Language:  "en",
		Text:      "1",
		Operation: IMSUSSDOperationResponse,
	})
	if err != nil {
		t.Fatalf("BuildIMSUSSDXML(response) error = %v", err)
	}
	if !strings.Contains(string(responseBody), "UnstructuredSS-Response") {
		t.Fatalf("response body=%s", responseBody)
	}
	response, err := ParseIMSUSSDXML(responseBody)
	if err != nil {
		t.Fatalf("ParseIMSUSSDXML(response) error = %v", err)
	}
	if response.Operation != IMSUSSDOperationResponse || response.RawOperationElement != "UnstructuredSS-Response" || response.Text != "1" {
		t.Fatalf("response payload=%+v", response)
	}
	responseResult := ussdResultFromPayload("ussd-response", response, 200)
	if responseResult.Done {
		t.Fatalf("response result=%+v, want open session", responseResult)
	}

	releaseBody, err := BuildIMSUSSDXML(IMSUSSDPayload{Operation: IMSUSSDOperationRelease})
	if err != nil {
		t.Fatalf("BuildIMSUSSDXML(release) error = %v", err)
	}
	if !strings.Contains(string(releaseBody), "UnstructuredSS-Release") {
		t.Fatalf("release body=%s", releaseBody)
	}
	release, err := ParseIMSUSSDXML(releaseBody)
	if err != nil {
		t.Fatalf("ParseIMSUSSDXML(release) error = %v", err)
	}
	if release.Operation != IMSUSSDOperationRelease || release.RawOperationElement != "UnstructuredSS-Release" {
		t.Fatalf("release payload=%+v", release)
	}
	releaseResult := ussdResultFromPayload("ussd-release", release, 200)
	if !releaseResult.Done || releaseResult.SessionID != "ussd-release" {
		t.Fatalf("release result=%+v, want completed session", releaseResult)
	}
}

func TestParseIMSUSSDXMLResponseAndReleaseAliases(t *testing.T) {
	tests := []struct {
		name string
		body string
		want IMSUSSDOperation
		raw  string
		done bool
	}{
		{
			name: "lower response",
			body: `<ussd-data><ussd-string>2</ussd-string><response/></ussd-data>`,
			want: IMSUSSDOperationResponse,
			raw:  "response",
		},
		{
			name: "operation response in anyExt",
			body: `<ussd-data><ussd-string>2</ussd-string><anyExt><operation>UnstructuredSS-Response</operation></anyExt></ussd-data>`,
			want: IMSUSSDOperationResponse,
			raw:  "UnstructuredSS-Response",
		},
		{
			name: "lower release",
			body: `<ussd-data><release/></ussd-data>`,
			want: IMSUSSDOperationRelease,
			raw:  "release",
			done: true,
		},
		{
			name: "operation release in anyExt",
			body: `<ussd-data><anyExt><operation>unstructuredSSRelease</operation></anyExt></ussd-data>`,
			want: IMSUSSDOperationRelease,
			raw:  "unstructuredSSRelease",
			done: true,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			payload, err := ParseIMSUSSDXML([]byte(tt.body))
			if err != nil {
				t.Fatalf("ParseIMSUSSDXML() error = %v", err)
			}
			if payload.Operation != tt.want || payload.RawOperationElement != tt.raw {
				t.Fatalf("payload=%+v, want op=%q raw=%q", payload, tt.want, tt.raw)
			}
			result := ussdResultFromPayload("ussd-alias", payload, 200)
			if result.Done != tt.done {
				t.Fatalf("result=%+v, want Done=%v", result, tt.done)
			}
		})
	}
}

func TestDecodeIMSUSSDDocumentFromMultipart(t *testing.T) {
	xmlBody, err := BuildIMSUSSDXML(IMSUSSDPayload{Text: "Balance: 10", Operation: IMSUSSDOperationNotify})
	if err != nil {
		t.Fatalf("BuildIMSUSSDXML() error = %v", err)
	}
	body := buildIMSUSSDMultipartBody("192.0.2.10", "b1", xmlBody)
	payload, ok, err := DecodeIMSUSSDDocument(`multipart/mixed; boundary="b1"`, body)
	if err != nil {
		t.Fatalf("DecodeIMSUSSDDocument() error = %v", err)
	}
	if !ok || payload.Text != "Balance: 10" || payload.Operation != IMSUSSDOperationNotify {
		t.Fatalf("ok=%v payload=%+v", ok, payload)
	}
}

func TestDecodeIMSUSSDDocumentHonorsMultipartRelatedStartContentID(t *testing.T) {
	firstXML, err := BuildIMSUSSDXML(IMSUSSDPayload{Text: "ignored", Operation: IMSUSSDOperationNotify})
	if err != nil {
		t.Fatalf("BuildIMSUSSDXML(first) error = %v", err)
	}
	selectedXML, err := BuildIMSUSSDXML(IMSUSSDPayload{Text: "selected", Operation: IMSUSSDOperationResponse})
	if err != nil {
		t.Fatalf("BuildIMSUSSDXML(selected) error = %v", err)
	}
	body := buildUSSDMultipartTestBody("ussd-start", []ussdMultipartTestPart{
		{contentType: IMSUSSDContentType, contentID: "<first@ims.test>", body: firstXML},
		{contentType: IMSUSSDContentType, contentID: "<selected@ims.test>", body: selectedXML},
	})

	payload, ok, err := DecodeIMSUSSDDocument(`multipart/related; boundary="ussd-start"; start="<selected@ims.test>"`, body)
	if err != nil {
		t.Fatalf("DecodeIMSUSSDDocument() error = %v", err)
	}
	if !ok || payload.Text != "selected" || payload.Operation != IMSUSSDOperationResponse {
		t.Fatalf("ok=%v payload=%+v, want selected response", ok, payload)
	}
}

func TestDecodeIMSUSSDDocumentFallsBackWhenMultipartStartIsNotUSSD(t *testing.T) {
	xmlBody, err := BuildIMSUSSDXML(IMSUSSDPayload{Text: "fallback", Operation: IMSUSSDOperationNotify})
	if err != nil {
		t.Fatalf("BuildIMSUSSDXML() error = %v", err)
	}
	body := buildUSSDMultipartTestBody("ussd-start-sdp", []ussdMultipartTestPart{
		{contentType: "application/sdp", contentID: "<root@ims.test>", body: []byte("v=0\r\ns=-\r\n")},
		{contentType: IMSUSSDContentType, contentID: "<ussd@ims.test>", body: xmlBody},
	})

	payload, ok, err := DecodeIMSUSSDDocument(`multipart/related; boundary="ussd-start-sdp"; start="<root@ims.test>"`, body)
	if err != nil {
		t.Fatalf("DecodeIMSUSSDDocument() error = %v", err)
	}
	if !ok || payload.Text != "fallback" || payload.Operation != IMSUSSDOperationNotify {
		t.Fatalf("ok=%v payload=%+v, want fallback notify", ok, payload)
	}
}

type ussdMultipartTestPart struct {
	contentType string
	contentID   string
	body        []byte
}

func buildUSSDMultipartTestBody(boundary string, parts []ussdMultipartTestPart) []byte {
	var out strings.Builder
	for _, part := range parts {
		out.WriteString("--")
		out.WriteString(boundary)
		out.WriteString("\r\nContent-Type: ")
		out.WriteString(part.contentType)
		out.WriteString("\r\n")
		if part.contentID != "" {
			out.WriteString("Content-ID: ")
			out.WriteString(part.contentID)
			out.WriteString("\r\n")
		}
		out.WriteString("\r\n")
		out.Write(part.body)
		out.WriteString("\r\n")
	}
	out.WriteString("--")
	out.WriteString(boundary)
	out.WriteString("--\r\n")
	return []byte(out.String())
}
