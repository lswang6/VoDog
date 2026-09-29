package simauth

import (
	"bytes"
	"errors"
	"reflect"
	"testing"

	swusim "github.com/boa-z/vowifi-go/engine/sim"
	"github.com/boa-z/vowifi-go/runtimehost/simtransport"
)

type fakeHostAKAResult struct {
	result AKAResult
	err    error
}

type fakeHostAKAAuthenticator struct {
	calls   []swusim.AKAAuthRequest
	results []fakeHostAKAResult
}

func (f *fakeHostAKAAuthenticator) AuthenticateAKA(req swusim.AKAAuthRequest) (AKAResult, error) {
	f.calls = append(f.calls, req.Clone())
	if len(req.RAND) > 0 {
		req.RAND[0] ^= 0xFF
	}
	if len(req.AUTN) > 0 {
		req.AUTN[0] ^= 0xFF
	}
	if len(f.results) == 0 {
		return AKAResult{}, errors.New("unexpected host AKA call")
	}
	out := f.results[0]
	f.results = f.results[1:]
	return out.result, out.err
}

type fakeFallbackAKAProvider struct {
	calls      []string
	isimCalls  int
	result     AKAResult
	err        error
	isimResult AKAResult
	isimErr    error
}

func (f *fakeFallbackAKAProvider) CalculateAKA(rand16, autn16 []byte) (AKAResult, error) {
	f.calls = append(f.calls, AKAAppPreferenceUSIM)
	return f.result, f.err
}

func (f *fakeFallbackAKAProvider) CalculateISIMAKA(rand16, autn16 []byte) (AKAResult, error) {
	f.isimCalls++
	f.calls = append(f.calls, AKAAppPreferenceISIMStrict)
	return f.isimResult, f.isimErr
}

func (f *fakeFallbackAKAProvider) CalculateAKAWithPreference(rand16, autn16 []byte, preference string) (AKAResult, error) {
	f.calls = append(f.calls, preference)
	if preference == AKAAppPreferenceISIMStrict {
		f.isimCalls++
		return f.isimResult, f.isimErr
	}
	return f.result, f.err
}

func TestAKAHostProviderFallsBackWhenNativeAuthUnsupported(t *testing.T) {
	rand16 := bytesFrom(0x10, 16)
	autn16 := bytesFrom(0x30, 16)
	want := AKAResult{RES: []byte{1, 2, 3, 4}, CK: bytesFrom(0x40, 16), IK: bytesFrom(0x60, 16)}
	host := &fakeHostAKAAuthenticator{results: []fakeHostAKAResult{
		{err: swusim.ErrAKAUnsupported},
	}}
	fallback := &fakeFallbackAKAProvider{result: want}
	provider := NewAKAHostProvider(host, fallback)

	got, err := provider.CalculateAKA(rand16, autn16)
	if err != nil {
		t.Fatalf("CalculateAKA() error = %v", err)
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("CalculateAKA() = %+v, want %+v", got, want)
	}
	if len(host.calls) != 1 || host.calls[0].Application != swusim.AKAApplicationUSIM {
		t.Fatalf("host calls = %+v, want one USIM call", host.calls)
	}
	if !reflect.DeepEqual(fallback.calls, []string{AKAAppPreferenceUSIM}) {
		t.Fatalf("fallback calls = %#v, want USIM preference", fallback.calls)
	}
}

func TestAKAHostProviderRecoversAndRetriesTransientNativeAuth(t *testing.T) {
	rand16 := bytesFrom(0x10, 16)
	autn16 := bytesFrom(0x30, 16)
	want := AKAResult{RES: []byte{5, 6, 7, 8}, CK: bytesFrom(0x41, 16), IK: bytesFrom(0x61, 16)}
	host := &fakeHostAKAAuthenticator{results: []fakeHostAKAResult{
		{err: errors.New("native SIM AUTH: SIM busy")},
		{result: want},
	}}
	fallback := &fakeFallbackAKAProvider{err: errors.New("fallback should not be used")}
	var recovery []AKAHostRecoveryRequest
	provider := NewAKAHostProvider(host, fallback)
	provider.Recovery = AKAHostRecoveryFunc(func(req AKAHostRecoveryRequest) error {
		recovery = append(recovery, req)
		return nil
	})

	got, err := provider.CalculateAKA(rand16, autn16)
	if err != nil {
		t.Fatalf("CalculateAKA() error = %v", err)
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("CalculateAKA() = %+v, want %+v", got, want)
	}
	if len(host.calls) != 2 {
		t.Fatalf("host call count = %d, want retry", len(host.calls))
	}
	if !bytes.Equal(host.calls[0].RAND, rand16) || !bytes.Equal(host.calls[1].AUTN, autn16) {
		t.Fatalf("host calls did not receive stable request copies: %+v", host.calls)
	}
	if len(recovery) != 1 ||
		recovery[0].Application != swusim.AKAApplicationUSIM ||
		recovery[0].Attempt != 1 ||
		recovery[0].Class != simtransport.RecoveryClassSIMBusy {
		t.Fatalf("recovery = %+v, want one USIM SIM-busy recovery", recovery)
	}
	if len(fallback.calls) != 0 {
		t.Fatalf("fallback calls = %#v, want none", fallback.calls)
	}
}

func TestAKAHostProviderDoesNotFallbackForSIMAuthOutcome(t *testing.T) {
	rand16 := bytesFrom(0x10, 16)
	autn16 := bytesFrom(0x30, 16)
	auts := bytesFrom(0xA0, AKAAUTSLength)
	host := &fakeHostAKAAuthenticator{results: []fakeHostAKAResult{
		{result: AKAResult{AUTS: auts}, err: swusim.NewSyncFailureError(auts)},
	}}
	fallback := &fakeFallbackAKAProvider{result: AKAResult{RES: []byte{0xFF}}}
	provider := NewAKAHostProvider(host, fallback)

	got, err := provider.CalculateAKA(rand16, autn16)
	if !errors.Is(err, swusim.ErrSyncFailure) {
		t.Fatalf("CalculateAKA() err=%v, want sync failure", err)
	}
	if !bytes.Equal(got.AUTS, auts) {
		t.Fatalf("CalculateAKA() AUTS = % X, want % X", got.AUTS, auts)
	}
	if len(fallback.calls) != 0 {
		t.Fatalf("fallback calls = %#v, want none", fallback.calls)
	}
}

func TestAKAHostProviderReturnsAUTSFromSyncFailureError(t *testing.T) {
	rand16 := bytesFrom(0x10, 16)
	autn16 := bytesFrom(0x30, 16)
	auts := bytesFrom(0xB0, AKAAUTSLength)
	host := &fakeHostAKAAuthenticator{results: []fakeHostAKAResult{
		{err: swusim.NewSyncFailureError(auts)},
	}}
	fallback := &fakeFallbackAKAProvider{result: AKAResult{RES: []byte{0xFF}}}
	provider := NewAKAHostProvider(host, fallback)

	got, err := provider.CalculateAKA(rand16, autn16)
	if !errors.Is(err, swusim.ErrSyncFailure) {
		t.Fatalf("CalculateAKA() err=%v, want sync failure", err)
	}
	if !bytes.Equal(got.AUTS, auts) {
		t.Fatalf("CalculateAKA() AUTS = % X, want % X", got.AUTS, auts)
	}
	if len(fallback.calls) != 0 {
		t.Fatalf("fallback calls = %#v, want none", fallback.calls)
	}
}

func TestAKAHostProviderStrictISIMFallbackUsesISIMProvider(t *testing.T) {
	rand16 := bytesFrom(0x10, 16)
	autn16 := bytesFrom(0x30, 16)
	want := AKAResult{RES: []byte{9, 10, 11, 12}, CK: bytesFrom(0x42, 16), IK: bytesFrom(0x62, 16)}
	host := &fakeHostAKAAuthenticator{results: []fakeHostAKAResult{
		{err: swusim.ErrAKAUnsupported},
	}}
	fallback := &fakeFallbackAKAProvider{isimResult: want}
	provider := NewAKAHostProvider(host, fallback)

	got, err := provider.CalculateISIMAKA(rand16, autn16)
	if err != nil {
		t.Fatalf("CalculateISIMAKA() error = %v", err)
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("CalculateISIMAKA() = %+v, want %+v", got, want)
	}
	if len(host.calls) != 1 || host.calls[0].Application != swusim.AKAApplicationISIM {
		t.Fatalf("host calls = %+v, want one ISIM call", host.calls)
	}
	if fallback.isimCalls != 1 || !reflect.DeepEqual(fallback.calls, []string{AKAAppPreferenceISIMStrict}) {
		t.Fatalf("fallback calls = %#v isim=%d, want strict ISIM", fallback.calls, fallback.isimCalls)
	}
}

func TestClassifyAKAAppFallback(t *testing.T) {
	tests := []struct {
		name string
		pref string
		want AKAAppFallbackDecision
		apps []swusim.AKAApplication
	}{
		{
			name: "empty defaults to strict USIM",
			want: AKAAppFallbackDecision{
				Preference: AKAAppPreferenceUSIM,
				Primary:    swusim.AKAApplicationUSIM,
				Strict:     true,
			},
			apps: []swusim.AKAApplication{swusim.AKAApplicationUSIM},
		},
		{
			name: "auto tries ISIM then USIM",
			pref: " AUTO ",
			want: AKAAppFallbackDecision{
				Preference: AKAAppPreferenceAuto,
				Primary:    swusim.AKAApplicationISIM,
				Fallback:   swusim.AKAApplicationUSIM,
				Allow:      true,
			},
			apps: []swusim.AKAApplication{swusim.AKAApplicationISIM, swusim.AKAApplicationUSIM},
		},
		{
			name: "isim permits USIM fallback",
			pref: AKAAppPreferenceISIM,
			want: AKAAppFallbackDecision{
				Preference: AKAAppPreferenceISIM,
				Primary:    swusim.AKAApplicationISIM,
				Fallback:   swusim.AKAApplicationUSIM,
				Allow:      true,
			},
			apps: []swusim.AKAApplication{swusim.AKAApplicationISIM, swusim.AKAApplicationUSIM},
		},
		{
			name: "strict ISIM stays on ISIM",
			pref: AKAAppPreferenceISIMStrict,
			want: AKAAppFallbackDecision{
				Preference: AKAAppPreferenceISIMStrict,
				Primary:    swusim.AKAApplicationISIM,
				Strict:     true,
			},
			apps: []swusim.AKAApplication{swusim.AKAApplicationISIM},
		},
		{
			name: "unknown preference normalizes to strict USIM",
			pref: "native",
			want: AKAAppFallbackDecision{
				Preference: AKAAppPreferenceUSIM,
				Primary:    swusim.AKAApplicationUSIM,
				Strict:     true,
			},
			apps: []swusim.AKAApplication{swusim.AKAApplicationUSIM},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := ClassifyAKAAppFallback(tt.pref)
			if got != tt.want {
				t.Fatalf("ClassifyAKAAppFallback() = %+v, want %+v", got, tt.want)
			}
			if apps := got.Applications(); !reflect.DeepEqual(apps, tt.apps) {
				t.Fatalf("Applications() = %+v, want %+v", apps, tt.apps)
			}
			if apps := akaApplicationsForPreference(tt.pref); !reflect.DeepEqual(apps, tt.apps) {
				t.Fatalf("akaApplicationsForPreference() = %+v, want %+v", apps, tt.apps)
			}
		})
	}
}

func TestClassifyAKAHostErrorDecisions(t *testing.T) {
	tests := []struct {
		name string
		err  error
		want AKAHostErrorDecision
	}{
		{
			name: "unsupported sentinel",
			err:  swusim.ErrAKAUnsupported,
			want: AKAHostErrorDecision{Fallback: true},
		},
		{
			name: "temporary sentinel",
			err:  swusim.ErrAKATemporaryFailure,
			want: AKAHostErrorDecision{Class: simtransport.RecoveryClassSIMBusy, Recover: true, Fallback: true},
		},
		{
			name: "native unsupported text",
			err:  errors.New("QMI SIM AUTH operation not supported"),
			want: AKAHostErrorDecision{Fallback: true},
		},
		{
			name: "auth failure",
			err:  swusim.ErrAuthFailure,
			want: AKAHostErrorDecision{},
		},
		{
			name: "deadline",
			err:  errors.New("context deadline exceeded"),
			want: AKAHostErrorDecision{Class: simtransport.RecoveryClassControlPortHung, Recover: true, Fallback: true},
		},
		{
			name: "qmi no memory",
			err:  errors.New("QMI UIM authenticate failed: authentication failed: no memory"),
			want: AKAHostErrorDecision{Fallback: true},
		},
		{
			name: "qmi invalid arguments",
			err:  errors.New("QMI UIM authenticate failed: invalid arguments"),
			want: AKAHostErrorDecision{Fallback: true},
		},
		{
			name: "native modem busy",
			err:  errors.New("native SIM auth already in use"),
			want: AKAHostErrorDecision{Class: simtransport.RecoveryClassSIMBusy, Recover: true, Fallback: true},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := ClassifyAKAHostError(tt.err); got != tt.want {
				t.Fatalf("ClassifyAKAHostError() = %+v, want %+v", got, tt.want)
			}
		})
	}
}
