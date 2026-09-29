package messaging

import (
	"context"
	"errors"
	"strconv"
	"strings"

	"github.com/boa-z/vowifi-go/runtimehost/voiceclient"
)

type IMSSMSTransport struct {
	Transport            voiceclient.SIPRequestTransport
	Profile              voiceclient.IMSProfile
	Registration         voiceclient.RegistrationBinding
	Domain               string
	LocalURI             string
	ContactURI           string
	RemoteTargetURI      string
	UserAgent            string
	ContentType          string
	SMSC                 string
	UseCPIM              bool
	IMDNNotifications    []string
	DisableStatusReports bool
}

func (t IMSSMSTransport) SendSMSPart(ctx context.Context, req SMSSendRequest) (SMSSendResult, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	if t.Transport == nil {
		return SMSSendResult{State: "failed", ErrorText: ErrSMSTransportUnavailable.Error()}, ErrSMSTransportUnavailable
	}
	remoteURI := t.remoteURI(req.Peer)
	if remoteURI == "" {
		err := errors.New("sms peer is empty")
		return SMSSendResult{State: "failed", ErrorText: err.Error()}, err
	}
	localURI := firstNonEmpty(t.LocalURI, t.Registration.PublicIdentity, t.Profile.IMPU)
	if localURI == "" {
		err := errors.New("IMS SMS local identity is empty")
		return SMSSendResult{State: "failed", ErrorText: err.Error()}, err
	}
	callID := smsCallID(req)
	cseq := req.Part.PartNo
	if cseq <= 0 {
		cseq = 1
	}
	contentType, body, err := t.messagePayload(req, byte(cseq), localURI, remoteURI, callID)
	if err != nil {
		return SMSSendResult{CallID: callID, RPMR: cseq, State: "failed", ErrorText: err.Error()}, err
	}
	cfg := voiceclient.DialogRequestConfig{
		Profile:         t.Profile,
		Registration:    t.Registration,
		LocalURI:        localURI,
		ContactURI:      firstNonEmpty(t.ContactURI, t.Registration.ContactURI),
		RemoteURI:       remoteURI,
		RemoteTargetURI: firstNonEmpty(t.RemoteTargetURI, remoteURI),
		CallID:          callID,
		LocalTag:        "sms",
		CSeq:            cseq,
		UserAgent:       firstNonEmpty(t.UserAgent, t.Profile.UserAgent, "vowifi-go"),
	}
	var resp voiceclient.SIPResponse
	redirectRetries := 0
	for {
		msg, err := voiceclient.BuildMessageRequest(cfg, contentType, body)
		if err != nil {
			return SMSSendResult{State: "failed", ErrorText: err.Error()}, err
		}
		resp, err = voiceclient.RoundTripRequestWithDigestAuth(ctx, t.Transport, msg)
		if err != nil {
			handling := imsMessagingResponseHandlingFor(resp)
			result := SMSSendResult{CallID: callID, RPMR: cseq, SIPCode: resp.StatusCode, RetryAfter: handling.RetryAfter}
			result.State = "failed"
			result.ErrorText = err.Error()
			result.RegistrationRecoveryNeeded = true
			return result, err
		}
		if redirectRetries < maxIMSMessagingRedirects {
			if retryCfg, ok := retryMessagingDialogConfigForRedirect(cfg, resp, nextMessagingCSeq(cfg.CSeq)); ok {
				cfg = retryCfg
				redirectRetries++
				continue
			}
		}
		break
	}
	handling := imsMessagingResponseHandlingFor(resp)
	result := SMSSendResult{CallID: callID, RPMR: cseq, SIPCode: handling.StatusCode, RetryAfter: handling.RetryAfter}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		result.State = "failed"
		result.ErrorText = handling.FailureText
		result.RegistrationRecoveryNeeded = handling.RegistrationRecoveryNeeded
		return result, errors.New(result.ErrorText)
	}
	result.State = "sent"
	if resp.StatusCode == 202 {
		result.State = "accepted"
	}
	return result, nil
}

func IMSRegistrationRecoveryNeededStatus(code int) bool {
	switch code {
	case 408, 430, 480, 481, 500, 502, 503, 504, 580:
		return true
	default:
		return code >= 500 && code < 600
	}
}

func (t IMSSMSTransport) messagePayload(req SMSSendRequest, rpMR byte, localURI, remoteURI, messageID string) (string, []byte, error) {
	contentType := firstNonEmpty(t.ContentType, IMS3GPPSMSContentType)
	if strings.HasPrefix(strings.ToLower(contentType), "text/plain") {
		return contentType, []byte(req.Part.Text), nil
	}
	part := req.Part
	if !t.DisableStatusReports {
		part.RequestStatusReport = true
	}
	tpdu, err := BuildSMSSubmitTPDU(req.Peer, part, rpMR)
	if err != nil {
		return "", nil, err
	}
	rpData, err := BuildSMSRPData(rpMR, t.SMSC, tpdu)
	if err != nil {
		return "", nil, err
	}
	if t.UseCPIM {
		messageHeaders := BuildIMSCPIMIMDNMessageHeaders(localURI, remoteURI, messageID, t.imdnNotifications())
		cpim, err := BuildIMSCPIMMessageWithHeaders(messageHeaders, map[string][]string{"Content-Type": {contentType}}, rpData)
		if err != nil {
			return "", nil, err
		}
		return IMSCPIMContentType, cpim, nil
	}
	return contentType, rpData, nil
}

func (t IMSSMSTransport) imdnNotifications() []string {
	if len(t.IMDNNotifications) > 0 {
		return NormalizeIMSIMDNDispositionNotifications(t.IMDNNotifications...)
	}
	if t.DisableStatusReports {
		return nil
	}
	return []string{IMSIMDNDispositionPositiveDelivery, IMSIMDNDispositionNegativeDelivery}
}

func (t IMSSMSTransport) remoteURI(peer string) string {
	peer = strings.TrimSpace(peer)
	if peer == "" {
		return ""
	}
	lower := strings.ToLower(peer)
	if strings.HasPrefix(lower, "sip:") || strings.HasPrefix(lower, "sips:") || strings.HasPrefix(lower, "tel:") {
		return peer
	}
	if strings.Contains(peer, "@") {
		return "sip:" + peer
	}
	domain := firstNonEmpty(t.Domain, t.Profile.Domain, smsDomainFromURI(t.Registration.PublicIdentity), smsDomainFromURI(t.Profile.IMPU))
	if domain == "" {
		return "tel:" + peer
	}
	return "sip:" + peer + "@" + domain
}

func smsCallID(req SMSSendRequest) string {
	id := smsToken(firstNonEmpty(req.MessageID, "sms"))
	partNo := req.Part.PartNo
	if partNo <= 0 {
		partNo = 1
	}
	return id + "-" + strconv.Itoa(partNo) + "@vowifi-go"
}

func smsToken(value string) string {
	value = strings.TrimSpace(value)
	if value == "" {
		return "sms"
	}
	var b strings.Builder
	lastDash := false
	for _, r := range value {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9', r == '.', r == '_', r == '-':
			b.WriteRune(r)
			lastDash = false
		default:
			if !lastDash {
				b.WriteByte('-')
				lastDash = true
			}
		}
	}
	out := strings.Trim(b.String(), "-")
	if out == "" {
		return "sms"
	}
	return out
}

func smsDomainFromURI(uri string) string {
	uri = strings.TrimSpace(uri)
	if strings.HasPrefix(strings.ToLower(uri), "sip:") {
		uri = uri[4:]
	}
	if _, host, ok := strings.Cut(uri, "@"); ok {
		if semi := strings.IndexByte(host, ';'); semi >= 0 {
			host = host[:semi]
		}
		return strings.Trim(strings.TrimSpace(host), "<>")
	}
	return ""
}
