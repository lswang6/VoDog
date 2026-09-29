package e911

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/boa-z/vowifi-go/runtimehost/carrier"
)

func TestStartEmergencyAddressUpdateClassifiesHTTPAuthenticateChallenge(t *testing.T) {
	client := &fakeHTTPClient{responses: []*HTTPResponse{{
		StatusCode: http.StatusUnauthorized,
		Headers: []HeaderPair{{
			Key:   "WWW-Authenticate",
			Value: `Digest realm="e911.example", nonce="abc,def", algorithm=AKAv1-MD5, qop="auth"`,
		}},
		Body: []byte(`{}`),
	}}}

	_, err := StartEmergencyAddressUpdate(context.Background(), Request{
		Carrier: carrier.EffectiveCarrierConfig{
			E911: carrier.E911Config{
				Provider:            "att-ts43",
				Websheet:            "https://example.test/websheet",
				EntitlementEndpoint: "https://example.test/entitlement",
			},
		},
		Client: client,
	})
	if !errors.Is(err, ErrChallengeNotImplemented) {
		t.Fatalf("err=%v, want ErrChallengeNotImplemented", err)
	}
	var challengeErr *HTTPAuthenticationChallengeError
	if !errors.As(err, &challengeErr) {
		t.Fatalf("err=%T, want HTTPAuthenticationChallengeError", err)
	}
	if challengeErr.StatusCode != http.StatusUnauthorized || len(challengeErr.Challenges) != 1 {
		t.Fatalf("challenge error=%+v", challengeErr)
	}
	challenge := challengeErr.Challenges[0]
	if challenge.Scheme != "Digest" || challenge.Params["algorithm"] != "AKAv1-MD5" || challenge.Params["nonce"] != "abc,def" {
		t.Fatalf("challenge=%+v", challenge)
	}
	if strings.Contains(err.Error(), "abc,def") {
		t.Fatalf("error leaked nonce: %q", err.Error())
	}
}

func TestHTTPAuthenticateChallengeParserSplitsMultipleSchemes(t *testing.T) {
	header := `Basic realm="one", Digest realm="ims", nonce="abc,def", algorithm=AKAv1-MD5, qop="auth,auth-int", Bearer realm="api", error="invalid_token"`
	chunks := splitHTTPAuthenticateChallenges(header)
	if len(chunks) != 3 {
		t.Fatalf("chunks=%q", chunks)
	}
	challenges := httpAuthenticationChallenges(http.StatusUnauthorized, []HeaderPair{{Key: "WWW-Authenticate", Value: header}})
	if len(challenges) != 3 {
		t.Fatalf("challenges=%+v", challenges)
	}
	if challenges[0].Scheme != "Basic" || challenges[0].Params["realm"] != "one" {
		t.Fatalf("basic challenge=%+v", challenges[0])
	}
	if challenges[1].Scheme != "Digest" || challenges[1].Params["nonce"] != "abc,def" || challenges[1].Params["qop"] != "auth,auth-int" {
		t.Fatalf("digest challenge=%+v", challenges[1])
	}
	if challenges[2].Scheme != "Bearer" || challenges[2].Params["error"] != "invalid_token" {
		t.Fatalf("bearer challenge=%+v", challenges[2])
	}
}

func TestHTTPAuthenticateChallengeParserMergesDuplicateParams(t *testing.T) {
	header := `dIgEsT realm="e911,ims", nonce="abc,def", algorithm=akav1-md5, qop="AUTH-INT", qop=AUTH, stale=false, stale=TRUE, opaque="opq,one"`
	challenges := httpAuthenticationChallenges(http.StatusUnauthorized, []HeaderPair{{Key: "www-authenticate", Value: header}})
	if len(challenges) != 1 {
		t.Fatalf("challenges=%+v", challenges)
	}
	challenge := challenges[0]
	if challenge.Header != "Www-Authenticate" || challenge.Scheme != "dIgEsT" {
		t.Fatalf("challenge=%+v", challenge)
	}
	if challenge.Params["realm"] != "e911,ims" || challenge.Params["nonce"] != "abc,def" || challenge.Params["opaque"] != "opq,one" {
		t.Fatalf("quoted params=%+v", challenge.Params)
	}
	if challenge.Params["qop"] != "AUTH-INT,AUTH" || challenge.Params["stale"] != "true" || challenge.Params["algorithm"] != "akav1-md5" {
		t.Fatalf("merged params=%+v", challenge.Params)
	}
}

func TestHTTPAuthenticateChallengeParserMergesUnquotedQOPList(t *testing.T) {
	header := `Digest realm="e911", nonce="abc,def", algorithm=AKAv1-MD5, qop=auth-int,auth, Basic realm="legacy"`
	chunks := splitHTTPAuthenticateChallenges(header)
	if len(chunks) != 2 {
		t.Fatalf("chunks=%q", chunks)
	}
	challenges := httpAuthenticationChallenges(http.StatusUnauthorized, []HeaderPair{{Key: "WWW-Authenticate", Value: header}})
	if len(challenges) != 2 {
		t.Fatalf("challenges=%+v", challenges)
	}
	if challenges[0].Scheme != "Digest" || challenges[0].Params["qop"] != "auth-int,auth" {
		t.Fatalf("digest challenge=%+v", challenges[0])
	}
	if challenges[1].Scheme != "Basic" || challenges[1].Params["realm"] != "legacy" {
		t.Fatalf("basic challenge=%+v", challenges[1])
	}
}

func TestHTTPAuthenticateChallengeParserClassifiesProxyHeader(t *testing.T) {
	challenges := httpAuthenticationChallenges(http.StatusProxyAuthRequired, []HeaderPair{
		{Key: "www-authenticate", Value: `Digest realm="origin", nonce="ignored"`},
		{Key: "proxy-authenticate", Value: `Digest realm="proxy", nonce="proxy,nonce"`},
	})
	if len(challenges) != 1 {
		t.Fatalf("challenges=%+v", challenges)
	}
	challenge := challenges[0]
	if challenge.Header != "Proxy-Authenticate" || challenge.Params["realm"] != "proxy" || challenge.Params["nonce"] != "proxy,nonce" {
		t.Fatalf("proxy challenge=%+v", challenge)
	}
}

func TestClassifyEntitlementHTTPStatusParsesRetryAfterDelta(t *testing.T) {
	status := ClassifyEntitlementHTTPStatus(&HTTPResponse{
		StatusCode: http.StatusTooManyRequests,
		Headers:    []HeaderPair{{Key: "retry-after", Value: "17"}},
	}, time.Date(2026, 7, 7, 9, 0, 0, 0, time.UTC))

	if status.Class != EntitlementHTTPStatusRateLimited || !status.Retryable || status.Success {
		t.Fatalf("status=%+v", status)
	}
	if status.RetryAfter != 17*time.Second || !status.RetryAfterAt.IsZero() || status.RetryAfterRaw != "17" {
		t.Fatalf("retry after=%+v", status)
	}
}

func TestClassifyEntitlementHTTPStatusParsesRetryAfterHTTPDate(t *testing.T) {
	now := time.Date(2026, 7, 7, 9, 0, 0, 0, time.UTC)
	retryAt := now.Add(2 * time.Minute).Format(http.TimeFormat)
	status := ClassifyEntitlementHTTPStatus(&HTTPResponse{
		StatusCode: http.StatusServiceUnavailable,
		Headers:    []HeaderPair{{Key: "Retry-After", Value: retryAt}},
	}, now)

	if status.Class != EntitlementHTTPStatusUnavailable || !status.Retryable {
		t.Fatalf("status=%+v", status)
	}
	if status.RetryAfter != 2*time.Minute || !status.RetryAfterAt.Equal(now.Add(2*time.Minute)) {
		t.Fatalf("retry after=%+v", status)
	}
}

func TestClassifyEntitlementHTTPStatusRetryAfterScopeAndMalformed(t *testing.T) {
	now := time.Date(2026, 7, 7, 9, 0, 0, 0, time.UTC)
	authStatus := ClassifyEntitlementHTTPStatus(&HTTPResponse{
		StatusCode: http.StatusUnauthorized,
		Headers:    []HeaderPair{{Key: "Retry-After", Value: "3"}},
	}, now)
	if authStatus.Class != EntitlementHTTPStatusAuthenticationNeeded || authStatus.RetryAfter != 3*time.Second {
		t.Fatalf("auth status=%+v", authStatus)
	}
	proxyStatus := ClassifyEntitlementHTTPStatus(&HTTPResponse{
		StatusCode: http.StatusProxyAuthRequired,
		Headers:    []HeaderPair{{Key: "Retry-After", Value: "4"}},
	}, now)
	if proxyStatus.Class != EntitlementHTTPStatusAuthenticationNeeded || proxyStatus.RetryAfter != 4*time.Second {
		t.Fatalf("proxy status=%+v", proxyStatus)
	}

	forbidden := ClassifyEntitlementHTTPStatus(&HTTPResponse{
		StatusCode: http.StatusForbidden,
		Headers:    []HeaderPair{{Key: "Retry-After", Value: "not-a-date"}},
	}, now)
	if forbidden.Class != EntitlementHTTPStatusForbidden || forbidden.Retryable || forbidden.RetryAfter != 0 || forbidden.RetryAfterRaw != "" {
		t.Fatalf("forbidden=%+v", forbidden)
	}

	serverError := ClassifyEntitlementHTTPStatus(&HTTPResponse{
		StatusCode: http.StatusInternalServerError,
		Headers:    []HeaderPair{{Key: "Retry-After", Value: "9"}},
	}, now)
	if serverError.Class != EntitlementHTTPStatusRetryableFailure || !serverError.Retryable || serverError.RetryAfter != 9*time.Second {
		t.Fatalf("server error=%+v", serverError)
	}
}

func TestClassifyEntitlementHTTPRecoverySelectsDigestAuthentication(t *testing.T) {
	origin := ClassifyEntitlementHTTPRecovery(&HTTPResponse{
		StatusCode: http.StatusUnauthorized,
		Headers: []HeaderPair{{
			Key:   "WWW-Authenticate",
			Value: `Basic realm="legacy", Digest realm="e911", nonce="nonce-one", algorithm=AKAv1-MD5, qop="auth"`,
		}},
	}, time.Date(2026, 7, 7, 9, 0, 0, 0, time.UTC))
	if origin.Action != EntitlementHTTPRecoveryActionAuthenticate ||
		origin.ChallengeHeader != "WWW-Authenticate" ||
		origin.AuthorizationHeader != "Authorization" ||
		origin.SelectedAuthenticationScheme != "Digest" {
		t.Fatalf("origin decision=%+v", origin)
	}
	if len(origin.AuthenticationSchemes) != 2 || origin.AuthenticationSchemes[0] != "Basic" || origin.AuthenticationSchemes[1] != "Digest" {
		t.Fatalf("origin schemes=%+v", origin.AuthenticationSchemes)
	}

	proxy := ClassifyEntitlementHTTPRecovery(&HTTPResponse{
		StatusCode: http.StatusProxyAuthRequired,
		Headers: []HeaderPair{
			{Key: "WWW-Authenticate", Value: `Digest realm="origin", nonce="ignored", algorithm=AKAv1-MD5`},
			{Key: "Proxy-Authenticate", Value: `Digest realm="proxy", nonce="nonce-two", algorithm=AKAv2-MD5, qop=auth-int,auth`},
		},
	}, time.Date(2026, 7, 7, 9, 0, 0, 0, time.UTC))
	if proxy.Action != EntitlementHTTPRecoveryActionAuthenticate ||
		proxy.ChallengeHeader != "Proxy-Authenticate" ||
		proxy.AuthorizationHeader != "Proxy-Authorization" ||
		proxy.SelectedAuthenticationScheme != "Digest" ||
		len(proxy.Challenges) != 1 ||
		proxy.Challenges[0].Params["realm"] != "proxy" {
		t.Fatalf("proxy decision=%+v", proxy)
	}
}

func TestClassifyEntitlementHTTPRecoveryDefersDigestAuthenticationForRetryAfter(t *testing.T) {
	now := time.Date(2026, 7, 7, 9, 0, 0, 0, time.UTC)
	tests := []struct {
		name              string
		statusCode        int
		challengeHeader   string
		authorizationName string
	}{
		{
			name:              "origin",
			statusCode:        http.StatusUnauthorized,
			challengeHeader:   "WWW-Authenticate",
			authorizationName: "Authorization",
		},
		{
			name:              "proxy",
			statusCode:        http.StatusProxyAuthRequired,
			challengeHeader:   "Proxy-Authenticate",
			authorizationName: "Proxy-Authorization",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			decision := ClassifyEntitlementHTTPRecovery(&HTTPResponse{
				StatusCode: tt.statusCode,
				Headers: []HeaderPair{
					{Key: "Retry-After", Value: "7"},
					{Key: tt.challengeHeader, Value: `Digest realm="e911", nonce="nonce-one", algorithm=AKAv1-MD5, qop="auth"`},
				},
			}, now)

			if decision.Action != EntitlementHTTPRecoveryActionBackoff ||
				decision.Status.RetryAfter != 7*time.Second ||
				decision.SelectedAuthenticationScheme != "Digest" ||
				!decision.AuthenticationDeferredByRetryAfter {
				t.Fatalf("decision=%+v", decision)
			}
			if decision.ChallengeHeader != tt.challengeHeader || decision.AuthorizationHeader != tt.authorizationName {
				t.Fatalf("headers=%q/%q", decision.ChallengeHeader, decision.AuthorizationHeader)
			}
			if len(decision.Challenges) != 1 || decision.Challenges[0].Params["nonce"] != "nonce-one" {
				t.Fatalf("challenges=%+v", decision.Challenges)
			}
		})
	}

	unsupported := ClassifyEntitlementHTTPRecovery(&HTTPResponse{
		StatusCode: http.StatusUnauthorized,
		Headers: []HeaderPair{
			{Key: "Retry-After", Value: "5"},
			{Key: "WWW-Authenticate", Value: `Digest realm="legacy", nonce="nonce-two", algorithm=MD5, qop="auth"`},
		},
	}, now)
	if unsupported.Action != EntitlementHTTPRecoveryActionBackoff ||
		unsupported.SelectedAuthenticationScheme != "" ||
		unsupported.AuthenticationDeferredByRetryAfter {
		t.Fatalf("unsupported decision=%+v", unsupported)
	}
}

func TestClassifyEntitlementHTTPRecoveryBackoffRetryAndFail(t *testing.T) {
	now := time.Date(2026, 7, 7, 9, 0, 0, 0, time.UTC)
	forbidden := ClassifyEntitlementHTTPRecovery(&HTTPResponse{
		StatusCode: http.StatusForbidden,
		Headers:    []HeaderPair{{Key: "Retry-After", Value: "11"}},
	}, now)
	if forbidden.Action != EntitlementHTTPRecoveryActionBackoff || forbidden.Status.RetryAfter != 11*time.Second {
		t.Fatalf("forbidden decision=%+v", forbidden)
	}

	serverError := ClassifyEntitlementHTTPRecovery(&HTTPResponse{
		StatusCode: http.StatusBadGateway,
	}, now)
	if serverError.Action != EntitlementHTTPRecoveryActionRetry {
		t.Fatalf("server error decision=%+v", serverError)
	}

	unsupportedChallenge := ClassifyEntitlementHTTPRecovery(&HTTPResponse{
		StatusCode: http.StatusUnauthorized,
		Headers:    []HeaderPair{{Key: "WWW-Authenticate", Value: `Basic realm="legacy"`}},
	}, now)
	if unsupportedChallenge.Action != EntitlementHTTPRecoveryActionFail ||
		unsupportedChallenge.SelectedAuthenticationScheme != "" ||
		len(unsupportedChallenge.AuthenticationSchemes) != 1 ||
		unsupportedChallenge.AuthenticationSchemes[0] != "Basic" {
		t.Fatalf("unsupported challenge decision=%+v", unsupportedChallenge)
	}

	passwordDigest := ClassifyEntitlementHTTPRecovery(&HTTPResponse{
		StatusCode: http.StatusUnauthorized,
		Headers:    []HeaderPair{{Key: "WWW-Authenticate", Value: `Digest realm="legacy", nonce="nonce-three", algorithm=MD5, qop="auth"`}},
	}, now)
	if passwordDigest.Action != EntitlementHTTPRecoveryActionFail ||
		passwordDigest.SelectedAuthenticationScheme != "" ||
		len(passwordDigest.AuthenticationSchemes) != 1 ||
		passwordDigest.AuthenticationSchemes[0] != "Digest" {
		t.Fatalf("password digest decision=%+v", passwordDigest)
	}
}

func TestParseHTTPRetryAfterRejectsNegativeDeltaAndClampsPastDate(t *testing.T) {
	now := time.Date(2026, 7, 7, 9, 0, 0, 0, time.UTC)
	if _, _, ok := ParseHTTPRetryAfter("-1", now); ok {
		t.Fatal("negative retry delta parsed successfully")
	}
	delay, at, ok := ParseHTTPRetryAfter(now.Add(-time.Minute).Format(http.TimeFormat), now)
	if !ok || delay != 0 || !at.Equal(now.Add(-time.Minute)) {
		t.Fatalf("past date delay=%s at=%s ok=%v", delay, at, ok)
	}
}

func TestDefaultHTTPClientCapturesResponseHeaders(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Add("WWW-Authenticate", `Digest realm="e911.example", nonce="header-copy"`)
		w.WriteHeader(http.StatusUnauthorized)
	}))
	defer server.Close()

	resp, err := NewDefaultHTTPClient().Do(&HTTPRequest{URL: server.URL})
	if err != nil {
		t.Fatalf("Do() error = %v", err)
	}
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("StatusCode=%d", resp.StatusCode)
	}
	if got := headerValue(resp.Headers, "WWW-Authenticate"); !strings.Contains(got, `nonce="header-copy"`) {
		t.Fatalf("WWW-Authenticate=%q headers=%+v", got, resp.Headers)
	}
}
