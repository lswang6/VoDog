package eapaka

import (
	"fmt"
	"strings"
)

// FormatPermanentIdentity returns the 3GPP permanent NAI used for EAP-AKA or
// EAP-AKA'. The username prefix selects the EAP method (0 for AKA, 6 for AKA').
// Android IWLAN uses the EPC NAI realm for EAP-AKA, while AKA' uses the WLAN
// realm. Both realms are derived from the subscriber's home PLMN.
func FormatPermanentIdentity(imsi, mcc, mnc string, eapType uint8) (string, error) {
	imsi = strings.TrimSpace(imsi)
	mcc = strings.TrimSpace(mcc)
	mnc = strings.TrimSpace(mnc)
	if !decimalIdentityPart(imsi, 5, 15) {
		return "", fmt.Errorf("invalid IMSI length or characters")
	}
	if mcc == "" && len(imsi) >= 3 {
		mcc = imsi[:3]
	}
	if mnc == "" && len(imsi) >= 6 {
		mnc = imsi[3:6]
	}
	if !decimalIdentityPart(mcc, 3, 3) || !decimalIdentityPart(mnc, 2, 3) {
		return "", fmt.Errorf("invalid MCC/MNC")
	}
	if !strings.HasPrefix(imsi, mcc+mnc) {
		return "", fmt.Errorf("IMSI does not match MCC/MNC")
	}
	prefix := byte(0)
	realmPrefix := ""
	switch eapType {
	case TypeAKA:
		prefix = '0'
		realmPrefix = "nai.epc"
	case TypeAKAPrime:
		prefix = '6'
		realmPrefix = "wlan"
	default:
		return "", fmt.Errorf("unsupported EAP type %d", eapType)
	}
	if len(mnc) == 2 {
		mnc = "0" + mnc
	}
	return fmt.Sprintf("%c%s@%s.mnc%s.mcc%s.3gppnetwork.org", prefix, imsi, realmPrefix, mnc, mcc), nil
}

func decimalIdentityPart(value string, minLength, maxLength int) bool {
	if len(value) < minLength || len(value) > maxLength {
		return false
	}
	for _, digit := range value {
		if digit < '0' || digit > '9' {
			return false
		}
	}
	return true
}
