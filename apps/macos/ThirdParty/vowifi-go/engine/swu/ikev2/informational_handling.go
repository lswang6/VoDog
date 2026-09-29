package ikev2

import (
	"encoding/binary"
	"errors"
	"fmt"
	"net"
)

type NotifyActionKind uint8

const (
	NotifyActionNone NotifyActionKind = iota
	NotifyActionMOBIKESupported
	NotifyActionMOBIKEUpdateAddresses
	NotifyActionMOBIKEAdditionalAddress
	NotifyActionMOBIKENoAdditionalAddresses
	NotifyActionMOBIKEEchoCookie2
	NotifyActionRekeyChildSA
	NotifyActionRetryWithSuggestedDH
	NotifyActionRetryWithDifferentProposal
	NotifyActionNarrowTrafficSelectors
	NotifyActionRecreateChildSA
	NotifyActionRecreateIKESA
	NotifyActionMOBIKEAddressRecovery
	NotifyActionWaitAndRetry
	NotifyActionReauthenticate
	NotifyActionAbort
)

type NotifyAction struct {
	Notify           Notify
	Kind             NotifyActionKind
	Retry            bool
	RetryLater       bool
	RecreateIKE      bool
	RecreateChild    bool
	SuggestedDHGroup uint16
}

type InformationalHandling struct {
	Empty                 bool
	LivenessCheck         bool
	DeleteIKE             bool
	DeleteESP             [][]byte
	DeleteAH              [][]byte
	UpdateSAAddresses     bool
	NoAdditionalAddresses bool
	AdditionalAddresses   []net.IP
	Cookie2               []byte
	InvalidSelectors      []InvalidSelectorReport
	NotifyError           error
	Notifies              []Notify
	NotifyActions         []NotifyAction
	Deletes               []Delete
}

type InformationalResponsePlan struct {
	Payloads    []Payload
	EchoCookie2 bool
}

type InformationalRecoveryAction uint8

const (
	InformationalRecoveryNoAction InformationalRecoveryAction = iota
	InformationalRecoveryUpdateMOBIKEAddresses
	InformationalRecoveryMOBIKEAddressRecovery
	InformationalRecoveryRekeyChildSA
	InformationalRecoveryRetryExchange
	InformationalRecoveryWaitAndRetry
	InformationalRecoveryRecreateChildSA
	InformationalRecoveryRecreateIKESA
	InformationalRecoveryReauthenticate
	InformationalRecoveryAbort
)

func (a InformationalRecoveryAction) String() string {
	switch a {
	case InformationalRecoveryNoAction:
		return "none"
	case InformationalRecoveryUpdateMOBIKEAddresses:
		return "mobike update addresses"
	case InformationalRecoveryMOBIKEAddressRecovery:
		return "mobike address recovery"
	case InformationalRecoveryRekeyChildSA:
		return "rekey child sa"
	case InformationalRecoveryRetryExchange:
		return "retry exchange"
	case InformationalRecoveryWaitAndRetry:
		return "wait and retry"
	case InformationalRecoveryRecreateChildSA:
		return "recreate child sa"
	case InformationalRecoveryRecreateIKESA:
		return "recreate ike sa"
	case InformationalRecoveryReauthenticate:
		return "reauthenticate"
	case InformationalRecoveryAbort:
		return "abort"
	default:
		return fmt.Sprintf("informational recovery action %d", a)
	}
}

type InformationalRecoveryPlan struct {
	Action                InformationalRecoveryAction
	Reason                string
	Retry                 bool
	RetryLater            bool
	RecreateIKE           bool
	RecreateChild         bool
	RekeyChild            bool
	Reauthenticate        bool
	MOBIKEAddressRecovery bool
	SuggestedDHGroup      uint16
	EchoCookie2           bool
	DeleteIKE             bool
	DeleteCurrentChild    bool
	DeleteOtherChild      bool
	UpdateSAAddresses     bool
	Response              InformationalResponsePlan
	ChildDeletes          ChildSADeleteSummary
	NotifyActions         []NotifyAction
}

func HandleInformationalPayloads(payloads []Payload) (InformationalHandling, error) {
	content, err := ParseInformationalContent(payloads)
	if err != nil {
		return InformationalHandling{}, err
	}
	return HandleInformationalContent(content)
}

func HandleInformationalContent(content InformationalContent) (InformationalHandling, error) {
	handling := InformationalHandling{
		Empty:         len(content.Payloads) == 0,
		LivenessCheck: len(content.Payloads) == 0,
		NotifyError:   cloneNotifyError(content.NotifyError),
		Notifies:      cloneNotifies(content.Notifies),
		Deletes:       cloneDeletes(content.Deletes),
	}
	for _, deletePayload := range content.Deletes {
		switch deletePayload.ProtocolID {
		case ProtocolIKE:
			handling.DeleteIKE = true
		case ProtocolESP:
			handling.DeleteESP = append(handling.DeleteESP, cloneByteSlices(deletePayload.SPIs)...)
		case ProtocolAH:
			handling.DeleteAH = append(handling.DeleteAH, cloneByteSlices(deletePayload.SPIs)...)
		}
	}
	for _, notify := range content.Notifies {
		if err := handleInformationalNotify(&handling, notify); err != nil {
			return InformationalHandling{}, err
		}
		if action := ClassifyNotifyAction(notify); action.Kind != NotifyActionNone {
			handling.NotifyActions = append(handling.NotifyActions, action)
		}
	}
	return handling, nil
}

func PlanInformationalResponse(handling InformationalHandling) (InformationalResponsePlan, error) {
	var payloads []Payload
	echoCookie2 := len(handling.Cookie2) > 0
	if echoCookie2 {
		payload, err := Cookie2Notify(handling.Cookie2)
		if err != nil {
			return InformationalResponsePlan{}, fmt.Errorf("%w: %w", ErrInvalidInformational, err)
		}
		payloads = append(payloads, payload)
	}
	return InformationalResponsePlan{
		Payloads:    clonePayloads(payloads),
		EchoCookie2: echoCookie2,
	}, nil
}

func PlanInformationalRecoveryPayloads(payloads []Payload, child ChildSAResult) (InformationalRecoveryPlan, error) {
	content, err := ParseInformationalContent(payloads)
	if err != nil {
		return InformationalRecoveryPlan{}, err
	}
	return PlanInformationalRecovery(content, child)
}

func PlanInformationalRecovery(content InformationalContent, child ChildSAResult) (InformationalRecoveryPlan, error) {
	handling, err := HandleInformationalContent(content)
	if err != nil {
		return InformationalRecoveryPlan{}, err
	}
	response, err := PlanInformationalResponse(handling)
	if err != nil {
		return InformationalRecoveryPlan{}, err
	}
	childDeletes := ClassifyChildSADeletes(content, child)
	plan := InformationalRecoveryPlan{
		Action:            InformationalRecoveryNoAction,
		Reason:            "no recovery needed",
		EchoCookie2:       response.EchoCookie2,
		DeleteIKE:         handling.DeleteIKE || childDeletes.DeleteIKE,
		UpdateSAAddresses: handling.UpdateSAAddresses,
		Response: InformationalResponsePlan{
			Payloads:    clonePayloads(response.Payloads),
			EchoCookie2: response.EchoCookie2,
		},
		ChildDeletes:  cloneChildSADeleteSummary(childDeletes),
		NotifyActions: cloneNotifyActions(handling.NotifyActions),
	}
	plan.DeleteCurrentChild = childDeletes.Outcome == ChildSADeleteCurrent || childDeletes.Outcome == ChildSADeleteMixed
	plan.DeleteOtherChild = len(childDeletes.OtherSPIs) > 0
	if handling.LivenessCheck {
		plan.Reason = "liveness check"
		return plan, nil
	}

	priority := 0
	if plan.DeleteIKE {
		plan.considerRecovery(&priority, InformationalRecoveryRecreateIKESA, 80, "ike delete received", func() {
			plan.Retry = true
			plan.RecreateIKE = true
		})
	}
	if plan.DeleteCurrentChild {
		plan.considerRecovery(&priority, InformationalRecoveryRecreateChildSA, 70, "tracked child sa delete received", func() {
			plan.Retry = true
			plan.RecreateChild = true
		})
	} else if plan.DeleteOtherChild {
		plan.Reason = "no tracked child sa deleted"
	}
	if plan.UpdateSAAddresses {
		plan.considerRecovery(&priority, InformationalRecoveryUpdateMOBIKEAddresses, 30, "UPDATE_SA_ADDRESSES notify received", nil)
	}
	for _, action := range handling.NotifyActions {
		plan.considerNotifyRecovery(&priority, action)
	}
	if priority == 0 && plan.EchoCookie2 {
		plan.Reason = "COOKIE2 response required"
	}
	return plan, nil
}

func handleInformationalNotify(handling *InformationalHandling, notify Notify) error {
	switch notify.NotifyType {
	case NotifyUpdateSAAddresses:
		handling.UpdateSAAddresses = true
	case NotifyNoAdditionalAddresses:
		handling.NoAdditionalAddresses = true
	case NotifyAdditionalIPv4Address:
		if len(notify.NotificationData) != net.IPv4len {
			return fmt.Errorf("%w: %w: ADDITIONAL_IP4_ADDRESS length %d", ErrInvalidInformational, ErrInvalidNotify, len(notify.NotificationData))
		}
		handling.AdditionalAddresses = append(handling.AdditionalAddresses, append(net.IP(nil), notify.NotificationData...))
	case NotifyAdditionalIPv6Address:
		if len(notify.NotificationData) != net.IPv6len {
			return fmt.Errorf("%w: %w: ADDITIONAL_IP6_ADDRESS length %d", ErrInvalidInformational, ErrInvalidNotify, len(notify.NotificationData))
		}
		handling.AdditionalAddresses = append(handling.AdditionalAddresses, append(net.IP(nil), notify.NotificationData...))
	case NotifyCookie2:
		if len(notify.NotificationData) < 8 || len(notify.NotificationData) > 64 {
			return fmt.Errorf("%w: %w: COOKIE2 length %d", ErrInvalidInformational, ErrInvalidNotify, len(notify.NotificationData))
		}
		handling.Cookie2 = append([]byte(nil), notify.NotificationData...)
	case NotifyInvalidSelectors:
		report, _, err := notify.InvalidSelectorReport()
		if err != nil {
			return fmt.Errorf("%w: %w", ErrInvalidInformational, err)
		}
		handling.InvalidSelectors = append(handling.InvalidSelectors, report)
	}
	return nil
}

func ClassifyNotifyAction(notify Notify) NotifyAction {
	action := NotifyAction{Notify: cloneNotify(notify)}
	switch notify.NotifyType {
	case NotifyMOBIKESupported:
		action.Kind = NotifyActionMOBIKESupported
	case NotifyUpdateSAAddresses:
		action.Kind = NotifyActionMOBIKEUpdateAddresses
	case NotifyAdditionalIPv4Address, NotifyAdditionalIPv6Address:
		action.Kind = NotifyActionMOBIKEAdditionalAddress
	case NotifyNoAdditionalAddresses:
		action.Kind = NotifyActionMOBIKENoAdditionalAddresses
	case NotifyCookie2:
		action.Kind = NotifyActionMOBIKEEchoCookie2
	case NotifyRekeySA:
		action.Kind = NotifyActionRekeyChildSA
	case NotifyInvalidKEPayload:
		if len(notify.NotificationData) == 2 {
			action.Kind = NotifyActionRetryWithSuggestedDH
			action.Retry = true
			action.SuggestedDHGroup = binary.BigEndian.Uint16(notify.NotificationData)
		} else {
			action.Kind = NotifyActionAbort
		}
	case NotifyNoProposalChosen:
		action.Kind = NotifyActionRetryWithDifferentProposal
		action.Retry = true
	case NotifySinglePairRequired, NotifyTSUnacceptable, NotifyInvalidSelectors:
		action.Kind = NotifyActionNarrowTrafficSelectors
		action.Retry = true
		action.RecreateChild = true
	case NotifyInvalidSPI:
		action.Kind = NotifyActionRecreateChildSA
		action.Retry = true
		action.RecreateChild = true
	case NotifyNoAdditionalSAs:
		action.Kind = NotifyActionWaitAndRetry
		action.Retry = true
		action.RetryLater = true
	case NotifyInvalidIKESPI, NotifyInternalAddressFailure, NotifyFailedCPRequired:
		action.Kind = NotifyActionRecreateIKESA
		action.Retry = true
		action.RecreateIKE = true
	case NotifyUnacceptableAddresses, NotifyUnexpectedNATDetected, NotifyNoNATsAllowed:
		action.Kind = NotifyActionMOBIKEAddressRecovery
		action.Retry = true
	case NotifyAuthenticationFailed:
		action.Kind = NotifyActionReauthenticate
		action.RecreateIKE = true
	case NotifyUnsupportedCriticalPayload, NotifyInvalidMajorVersion, NotifyInvalidSyntax, NotifyInvalidMessageID:
		action.Kind = NotifyActionAbort
	default:
		if notify.NotifyType < 16384 {
			action.Kind = NotifyActionAbort
		}
	}
	return action
}

func (p *InformationalRecoveryPlan) considerNotifyRecovery(priority *int, action NotifyAction) {
	switch action.Kind {
	case NotifyActionMOBIKEUpdateAddresses:
		p.considerRecovery(priority, InformationalRecoveryUpdateMOBIKEAddresses, 30, notifyRecoveryReason(action), nil)
	case NotifyActionRekeyChildSA:
		p.considerRecovery(priority, InformationalRecoveryRekeyChildSA, 40, notifyRecoveryReason(action), func() {
			p.Retry = true
			p.RekeyChild = true
		})
	case NotifyActionRetryWithSuggestedDH, NotifyActionRetryWithDifferentProposal:
		p.considerRecovery(priority, InformationalRecoveryRetryExchange, 55, notifyRecoveryReason(action), func() {
			p.Retry = true
			p.SuggestedDHGroup = action.SuggestedDHGroup
		})
	case NotifyActionNarrowTrafficSelectors, NotifyActionRecreateChildSA:
		p.considerRecovery(priority, InformationalRecoveryRecreateChildSA, 70, notifyRecoveryReason(action), func() {
			p.Retry = true
			p.RecreateChild = true
			p.SuggestedDHGroup = action.SuggestedDHGroup
		})
	case NotifyActionWaitAndRetry:
		p.considerRecovery(priority, InformationalRecoveryWaitAndRetry, 50, notifyRecoveryReason(action), func() {
			p.Retry = true
			p.RetryLater = true
		})
	case NotifyActionRecreateIKESA:
		p.considerRecovery(priority, InformationalRecoveryRecreateIKESA, 80, notifyRecoveryReason(action), func() {
			p.Retry = true
			p.RecreateIKE = true
		})
	case NotifyActionMOBIKEAddressRecovery:
		p.considerRecovery(priority, InformationalRecoveryMOBIKEAddressRecovery, 60, notifyRecoveryReason(action), func() {
			p.Retry = true
			p.MOBIKEAddressRecovery = true
		})
	case NotifyActionReauthenticate:
		p.considerRecovery(priority, InformationalRecoveryReauthenticate, 90, notifyRecoveryReason(action), func() {
			p.Retry = true
			p.RecreateIKE = true
			p.Reauthenticate = true
		})
	case NotifyActionAbort:
		p.considerRecovery(priority, InformationalRecoveryAbort, 100, notifyRecoveryReason(action), nil)
	}
}

func (p *InformationalRecoveryPlan) considerRecovery(priority *int, action InformationalRecoveryAction, nextPriority int, reason string, apply func()) {
	if nextPriority <= *priority {
		return
	}
	*priority = nextPriority
	p.Action = action
	p.Reason = reason
	p.Retry = false
	p.RetryLater = false
	p.RecreateIKE = false
	p.RecreateChild = false
	p.RekeyChild = false
	p.Reauthenticate = false
	p.MOBIKEAddressRecovery = false
	p.SuggestedDHGroup = 0
	if apply != nil {
		apply()
	}
}

func notifyRecoveryReason(action NotifyAction) string {
	if action.Notify.NotifyType == 0 {
		return "notify recovery required"
	}
	return fmt.Sprintf("%s notify", NotifyTypeName(action.Notify.NotifyType))
}

func NotifyActionFromError(err error) (NotifyAction, bool) {
	if err == nil {
		return NotifyAction{}, false
	}
	var notifyErr *NotifyError
	if !errors.As(err, &notifyErr) {
		return NotifyAction{}, false
	}
	action := ClassifyNotifyAction(notifyErr.Notify)
	return action, action.Kind != NotifyActionNone
}
