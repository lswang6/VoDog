package messaging

import (
	"testing"
	"time"

	"github.com/boa-z/vowifi-go/runtimehost/voiceclient"
)

func TestClassifyIMSMessagingSIPResponseRecovery(t *testing.T) {
	tests := []struct {
		name                     string
		method                   string
		resp                     voiceclient.SIPResponse
		wantMethod               string
		wantStatus               int
		wantRetryAfter           time.Duration
		wantRetryAfterPresent    bool
		wantRecoverable          bool
		wantTargetFailover       bool
		wantRegistrationRecovery bool
		wantAuthRefresh          bool
		wantRedirectURI          string
		wantFailureText          string
	}{
		{
			name:   "message service unavailable",
			method: "MESSAGE",
			resp: voiceclient.SIPResponse{
				StatusCode: 503,
				Reason:     "Service Unavailable",
				Headers:    map[string][]string{"Retry-After": {"6"}},
			},
			wantMethod:               "MESSAGE",
			wantStatus:               503,
			wantRetryAfter:           6 * time.Second,
			wantRetryAfterPresent:    true,
			wantRecoverable:          true,
			wantTargetFailover:       true,
			wantRegistrationRecovery: true,
			wantFailureText:          "Service Unavailable",
		},
		{
			name:   "ussd invite redirect",
			method: "INVITE",
			resp: voiceclient.SIPResponse{
				StatusCode: 302,
				Reason:     "Moved Temporarily",
				Headers: map[string][]string{
					"Contact": {"<tel:+18005551212>;q=1, <sip:ussd-redirect@ims.example>;q=0.9"},
				},
			},
			wantMethod:         "INVITE",
			wantStatus:         302,
			wantRecoverable:    true,
			wantTargetFailover: true,
			wantRedirectURI:    "sip:ussd-redirect@ims.example",
			wantFailureText:    "Moved Temporarily",
		},
		{
			name:   "legacy dialog missing recovery",
			method: "INFO",
			resp: voiceclient.SIPResponse{
				StatusCode: 481,
				Reason:     "Call/Transaction Does Not Exist",
			},
			wantMethod:               "INFO",
			wantStatus:               481,
			wantRegistrationRecovery: true,
			wantFailureText:          "Call/Transaction Does Not Exist",
		},
		{
			name:   "authentication challenge",
			method: "MESSAGE",
			resp: voiceclient.SIPResponse{
				StatusCode: 401,
				Reason:     "Unauthorized",
				Headers:    map[string][]string{"Retry-After": {"4"}},
			},
			wantMethod:            "MESSAGE",
			wantStatus:            401,
			wantRetryAfter:        4 * time.Second,
			wantRetryAfterPresent: true,
			wantAuthRefresh:       true,
			wantFailureText:       "Unauthorized",
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := ClassifyIMSMessagingSIPResponseRecovery(tc.method, tc.resp)
			if got.Method != tc.wantMethod || got.StatusCode != tc.wantStatus ||
				got.RetryAfter != tc.wantRetryAfter || got.RetryAfterPresent != tc.wantRetryAfterPresent ||
				got.Recoverable != tc.wantRecoverable || got.TargetFailover != tc.wantTargetFailover ||
				got.RegistrationRecoveryNeeded != tc.wantRegistrationRecovery ||
				got.AuthenticationRefresh != tc.wantAuthRefresh ||
				got.RedirectURI != tc.wantRedirectURI || got.FailureText != tc.wantFailureText {
				t.Fatalf("ClassifyIMSMessagingSIPResponseRecovery()=%+v", got)
			}
		})
	}
}

func TestIMSMessagingRecoveryCandidatesSortRedirectContacts(t *testing.T) {
	resp := voiceclient.SIPResponse{
		StatusCode: 302,
		Reason:     "Moved Temporarily",
		Headers: map[string][]string{
			"Retry-After": {"4"},
			"Contact": {
				"<sip:expired@ims.example>;expires=0, <tel:+18005551212>;q=1, sip:preferred@ims.example;transport=tcp;q=0.9",
				"<sip:low@ims.example>;q=0.2, <sip:low@ims.example>;q=0.4",
			},
		},
	}

	got := IMSMessagingRecoveryCandidatesForSIPResponse(resp)
	if len(got) != 2 {
		t.Fatalf("IMSMessagingRecoveryCandidatesForSIPResponse()=%+v", got)
	}
	if got[0].Kind != IMSMessagingRecoveryCandidateRedirectContact ||
		got[0].URI != "sip:preferred@ims.example;transport=tcp" ||
		got[0].StatusCode != 302 ||
		got[0].RetryAfter != 4*time.Second ||
		!got[0].RetryAfterPresent ||
		got[0].Weight != 0.9 {
		t.Fatalf("preferred candidate=%+v", got[0])
	}
	if got[1].Kind != IMSMessagingRecoveryCandidateRedirectContact ||
		got[1].URI != "sip:low@ims.example" ||
		got[1].Weight != 0.4 ||
		got[1].RetryAfter != 4*time.Second ||
		!got[1].RetryAfterPresent {
		t.Fatalf("low candidate=%+v", got[1])
	}

	decision := ClassifyIMSMessagingSIPResponseRecovery("MESSAGE", resp)
	if decision.RedirectURI != "sip:preferred@ims.example;transport=tcp" ||
		len(decision.Candidates) != 2 ||
		decision.Candidates[0].URI != got[0].URI ||
		decision.RetryAfter != 4*time.Second ||
		!decision.RetryAfterPresent ||
		!decision.Recoverable ||
		!decision.TargetFailover {
		t.Fatalf("decision=%+v", decision)
	}
}

func TestClassifyIMSMessagingSIPResponseRecoveryIncludesAuthChallenge(t *testing.T) {
	tests := []struct {
		name            string
		statusCode      int
		headers         map[string][]string
		wantChallenge   string
		wantAuthHeader  string
		wantAuthzHeader string
	}{
		{
			name:       "www authenticate",
			statusCode: 401,
			headers: map[string][]string{
				"WWW-Authenticate": {`Digest realm="ims.example", nonce="n1", algorithm=AKAv1-MD5`},
			},
			wantChallenge:   `Digest realm="ims.example", nonce="n1", algorithm=AKAv1-MD5`,
			wantAuthHeader:  "WWW-Authenticate",
			wantAuthzHeader: "Authorization",
		},
		{
			name:       "proxy authenticate",
			statusCode: 407,
			headers: map[string][]string{
				"Proxy-Authenticate": {`Digest realm="ims.example", nonce="p1", algorithm=AKAv2-MD5`},
			},
			wantChallenge:   `Digest realm="ims.example", nonce="p1", algorithm=AKAv2-MD5`,
			wantAuthHeader:  "Proxy-Authenticate",
			wantAuthzHeader: "Proxy-Authorization",
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := ClassifyIMSMessagingSIPResponseRecovery("MESSAGE", voiceclient.SIPResponse{
				StatusCode: tc.statusCode,
				Reason:     "authentication required",
				Headers:    tc.headers,
			})
			if !got.AuthenticationRefresh ||
				got.AuthenticationChallengeHeader != tc.wantAuthHeader ||
				got.AuthenticationAuthorizationHeader != tc.wantAuthzHeader ||
				got.AuthenticationChallenge != tc.wantChallenge {
				t.Fatalf("ClassifyIMSMessagingSIPResponseRecovery()=%+v", got)
			}
		})
	}
}

func TestIMSMessagingRecoveryCandidatesParseAlternativeService(t *testing.T) {
	resp := voiceclient.SIPResponse{
		StatusCode: 380,
		Reason:     "Alternative Service",
		Headers: map[string][]string{
			"Retry-After": {"0"},
			"Alternative-Service": {
				`<sip:ussd-alt@ims.example>;q=0.7, <sip:ussd-expired@ims.example>;expires=0`,
			},
			"Contact": {`<sip:ussd-contact@ims.example>;q=0.5`},
		},
	}

	got := IMSMessagingRecoveryCandidatesForSIPResponse(resp)
	if len(got) != 2 {
		t.Fatalf("IMSMessagingRecoveryCandidatesForSIPResponse()=%+v", got)
	}
	if got[0].Kind != IMSMessagingRecoveryCandidateAlternativeService ||
		got[0].URI != "sip:ussd-alt@ims.example" ||
		got[0].RetryAfter != 0 ||
		!got[0].RetryAfterPresent ||
		got[0].Weight != 0.7 {
		t.Fatalf("alternative candidate=%+v", got[0])
	}
	if got[1].Kind != IMSMessagingRecoveryCandidateAlternativeService ||
		got[1].URI != "sip:ussd-contact@ims.example" ||
		got[1].Weight != 0.5 ||
		!got[1].RetryAfterPresent {
		t.Fatalf("contact alternative candidate=%+v", got[1])
	}

	decision := ClassifyIMSMessagingSIPResponseRecovery("INVITE", resp)
	if decision.RedirectURI != "sip:ussd-contact@ims.example" ||
		len(decision.Candidates) != 2 ||
		!decision.RetryAfterPresent ||
		!decision.Recoverable ||
		!decision.TargetFailover {
		t.Fatalf("decision=%+v", decision)
	}
}

func TestIMSMessagingRecoveryCandidatesIncludeStandaloneRetryAfter(t *testing.T) {
	resp := voiceclient.SIPResponse{
		StatusCode: 503,
		Reason:     "Service Unavailable",
		Headers:    map[string][]string{"Retry-After": {"0"}},
	}

	got := IMSMessagingRecoveryCandidatesForSIPResponse(resp)
	if len(got) != 1 ||
		got[0].Kind != IMSMessagingRecoveryCandidateRetryAfter ||
		got[0].StatusCode != 503 ||
		got[0].RetryAfter != 0 ||
		!got[0].RetryAfterPresent ||
		got[0].URI != "" {
		t.Fatalf("retry-after candidates=%+v", got)
	}
	decision := ClassifyIMSMessagingSIPResponseRecovery("MESSAGE", resp)
	if !decision.RetryAfterPresent || decision.RetryAfter != 0 || len(decision.Candidates) != 1 {
		t.Fatalf("decision=%+v", decision)
	}
}
