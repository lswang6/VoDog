package simauth

import (
	"errors"
	"fmt"
	"strings"

	swusim "github.com/boa-z/vowifi-go/engine/sim"
	"github.com/boa-z/vowifi-go/runtimehost/simtransport"
)

const defaultAKAHostRecoveryAttempts = 1

type AKAHostRecoveryRequest struct {
	Application swusim.AKAApplication
	Attempt     int
	Class       simtransport.RecoveryClass
	Err         error
}

type AKAHostRecoveryHook interface {
	RecoverAKAHost(req AKAHostRecoveryRequest) error
}

type AKAHostRecoveryFunc func(req AKAHostRecoveryRequest) error

func (f AKAHostRecoveryFunc) RecoverAKAHost(req AKAHostRecoveryRequest) error {
	if f == nil {
		return errors.New("nil AKA host recovery func")
	}
	return f(req)
}

type AKAHostErrorDecision struct {
	Class    simtransport.RecoveryClass
	Recover  bool
	Fallback bool
}

type AKAAppFallbackDecision struct {
	Preference string
	Primary    swusim.AKAApplication
	Fallback   swusim.AKAApplication
	Allow      bool
	Strict     bool
}

func (d AKAAppFallbackDecision) Applications() []swusim.AKAApplication {
	if d.Primary == "" {
		return nil
	}
	apps := []swusim.AKAApplication{d.Primary}
	if d.Allow && d.Fallback != "" && d.Fallback != d.Primary {
		apps = append(apps, d.Fallback)
	}
	return apps
}

type AKAHostProvider struct {
	Primary          swusim.AKAAuthenticator
	Fallback         swusim.AKAProvider
	Recovery         AKAHostRecoveryHook
	RecoveryAttempts int
	ClassifyError    func(error) AKAHostErrorDecision
}

func NewAKAHostProvider(primary swusim.AKAAuthenticator, fallback swusim.AKAProvider) *AKAHostProvider {
	return &AKAHostProvider{Primary: primary, Fallback: fallback}
}

func (p *AKAHostProvider) CalculateAKA(rand16, autn16 []byte) (AKAResult, error) {
	return p.CalculateAKAWithPreference(rand16, autn16, AKAAppPreferenceUSIM)
}

func (p *AKAHostProvider) CalculateISIMAKA(rand16, autn16 []byte) (AKAResult, error) {
	return p.CalculateAKAWithPreference(rand16, autn16, AKAAppPreferenceISIMStrict)
}

func (p *AKAHostProvider) CalculateAKAWithPreference(rand16, autn16 []byte, preference string) (AKAResult, error) {
	if p == nil {
		return AKAResult{}, errors.New("nil AKA host provider")
	}
	apps := akaApplicationsForPreference(preference)
	var primaryErrs []error
	if p.Primary != nil {
		for _, app := range apps {
			res, err := p.calculateHostAKA(app, rand16, autn16)
			if err == nil {
				return res, nil
			}
			decision := p.classifyHostError(err)
			if !decision.Fallback {
				return res, err
			}
			primaryErrs = append(primaryErrs, fmt.Errorf("host %s AKA: %w", strings.ToUpper(string(app)), err))
		}
	}
	if p.Fallback != nil {
		res, err := calculateFallbackAKA(p.Fallback, rand16, autn16, preference)
		if err == nil {
			return res, nil
		}
		res = akaResultWithSyncFailureAUTS(res, err)
		if len(primaryErrs) > 0 {
			errs := append(primaryErrs, fmt.Errorf("fallback AKA: %w", err))
			return res, errors.Join(errs...)
		}
		return res, err
	}
	if len(primaryErrs) > 0 {
		return AKAResult{}, errors.Join(primaryErrs...)
	}
	return AKAResult{}, errors.New("no AKA provider configured")
}

func (p *AKAHostProvider) calculateHostAKA(application swusim.AKAApplication, rand16, autn16 []byte) (AKAResult, error) {
	req, err := swusim.NewAKAAuthRequest(application, rand16, autn16)
	if err != nil {
		return AKAResult{}, err
	}
	attempts := p.hostRecoveryAttempts()
	for attempt := 0; ; attempt++ {
		res, err := p.Primary.AuthenticateAKA(req.Clone())
		if err == nil {
			return res, nil
		}
		decision := p.classifyHostError(err)
		if p.Recovery == nil || !decision.Recover || attempt >= attempts {
			return akaResultWithSyncFailureAUTS(res, err), err
		}
		recoveryReq := AKAHostRecoveryRequest{
			Application: req.Application,
			Attempt:     attempt + 1,
			Class:       decision.Class,
			Err:         err,
		}
		if recoveryErr := p.Recovery.RecoverAKAHost(recoveryReq); recoveryErr != nil {
			return akaResultWithSyncFailureAUTS(res, err), errors.Join(err, fmt.Errorf("AKA host recovery: %w", recoveryErr))
		}
	}
}

func (p *AKAHostProvider) hostRecoveryAttempts() int {
	if p.RecoveryAttempts < 0 {
		return 0
	}
	if p.RecoveryAttempts > 0 {
		return p.RecoveryAttempts
	}
	return defaultAKAHostRecoveryAttempts
}

func (p *AKAHostProvider) classifyHostError(err error) AKAHostErrorDecision {
	if p != nil && p.ClassifyError != nil {
		return p.ClassifyError(err)
	}
	return ClassifyAKAHostError(err)
}

type syncFailureAUTSCarrier interface {
	AUTS() []byte
}

func akaResultWithSyncFailureAUTS(result AKAResult, err error) AKAResult {
	if len(result.AUTS) > 0 || !errors.Is(err, swusim.ErrSyncFailure) {
		return result
	}
	var carrier syncFailureAUTSCarrier
	if errors.As(err, &carrier) {
		result.AUTS = append([]byte(nil), carrier.AUTS()...)
	}
	return result
}

type akaPreferenceProvider interface {
	CalculateAKAWithPreference(rand16, autn16 []byte, preference string) (AKAResult, error)
}

func calculateFallbackAKA(provider swusim.AKAProvider, rand16, autn16 []byte, preference string) (AKAResult, error) {
	if provider == nil {
		return AKAResult{}, errors.New("aka fallback provider is nil")
	}
	if p, ok := provider.(akaPreferenceProvider); ok {
		return p.CalculateAKAWithPreference(rand16, autn16, preference)
	}
	pref := strings.ToLower(strings.TrimSpace(preference))
	switch pref {
	case AKAAppPreferenceISIMStrict:
		isim, ok := provider.(swusim.ISIMAKAProvider)
		if !ok {
			return AKAResult{}, errors.New("AKA fallback provider does not support ISIM AKA")
		}
		return isim.CalculateISIMAKA(rand16, autn16)
	case AKAAppPreferenceAuto, AKAAppPreferenceISIM:
		if isim, ok := provider.(swusim.ISIMAKAProvider); ok {
			if res, err := isim.CalculateISIMAKA(rand16, autn16); err == nil {
				return res, nil
			}
		}
		return provider.CalculateAKA(rand16, autn16)
	default:
		return provider.CalculateAKA(rand16, autn16)
	}
}

func akaApplicationsForPreference(preference string) []swusim.AKAApplication {
	return ClassifyAKAAppFallback(preference).Applications()
}

func ClassifyAKAAppFallback(preference string) AKAAppFallbackDecision {
	pref := strings.ToLower(strings.TrimSpace(preference))
	switch pref {
	case AKAAppPreferenceAuto, AKAAppPreferenceISIM:
		return AKAAppFallbackDecision{
			Preference: pref,
			Primary:    swusim.AKAApplicationISIM,
			Fallback:   swusim.AKAApplicationUSIM,
			Allow:      true,
		}
	case AKAAppPreferenceISIMStrict:
		return AKAAppFallbackDecision{
			Preference: AKAAppPreferenceISIMStrict,
			Primary:    swusim.AKAApplicationISIM,
			Strict:     true,
		}
	default:
		return AKAAppFallbackDecision{
			Preference: AKAAppPreferenceUSIM,
			Primary:    swusim.AKAApplicationUSIM,
			Strict:     true,
		}
	}
}

func ClassifyAKAHostError(err error) AKAHostErrorDecision {
	if err == nil {
		return AKAHostErrorDecision{}
	}
	if errors.Is(err, swusim.ErrSyncFailure) || errors.Is(err, swusim.ErrAuthFailure) {
		return AKAHostErrorDecision{}
	}
	if errors.Is(err, swusim.ErrAKAUnsupported) {
		return AKAHostErrorDecision{Fallback: true}
	}
	if errors.Is(err, swusim.ErrAKATemporaryFailure) {
		return AKAHostErrorDecision{
			Class:    simtransport.RecoveryClassSIMBusy,
			Recover:  true,
			Fallback: true,
		}
	}
	class := simtransport.ClassifyError(err)
	switch class {
	case simtransport.RecoveryClassControlPortHung,
		simtransport.RecoveryClassSIMBusy,
		simtransport.RecoveryClassMalformedReply,
		simtransport.RecoveryClassATError:
		return AKAHostErrorDecision{Class: class, Recover: true, Fallback: true}
	case simtransport.RecoveryClassFileNotFound:
		return AKAHostErrorDecision{Class: class, Fallback: true}
	case simtransport.RecoveryClassEmptyEF:
		return AKAHostErrorDecision{Class: class}
	}
	text := strings.ToLower(strings.TrimSpace(err.Error()))
	switch {
	case strings.Contains(text, "not supported") ||
		strings.Contains(text, "unsupported") ||
		strings.Contains(text, "unimplemented") ||
		strings.Contains(text, "no native aka") ||
		strings.Contains(text, "no sim auth") ||
		strings.Contains(text, "sim auth failed") ||
		strings.Contains(text, "sim auth unavailable") ||
		strings.Contains(text, "authentication failed: no memory") ||
		strings.Contains(text, "invalid argument") ||
		strings.Contains(text, "invalid arguments") ||
		strings.Contains(text, "operation not allowed"):
		return AKAHostErrorDecision{Fallback: true}
	case strings.Contains(text, "temporarily unavailable") ||
		strings.Contains(text, "temporarily not allowed") ||
		strings.Contains(text, "in use"):
		return AKAHostErrorDecision{
			Class:    simtransport.RecoveryClassSIMBusy,
			Recover:  true,
			Fallback: true,
		}
	default:
		return AKAHostErrorDecision{}
	}
}
