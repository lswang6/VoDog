package eapaka

import "testing"

func TestFormatPermanentIdentity(t *testing.T) {
	tests := []struct {
		name    string
		eapType uint8
		mnc     string
		want    string
	}{
		{name: "AKA", eapType: TypeAKA, mnc: "240", want: "0310240123456789@nai.epc.mnc240.mcc310.3gppnetwork.org"},
		{name: "AKA prime", eapType: TypeAKAPrime, mnc: "240", want: "6310240123456789@wlan.mnc240.mcc310.3gppnetwork.org"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			got, err := FormatPermanentIdentity("310240123456789", "310", test.mnc, test.eapType)
			if err != nil || got != test.want {
				t.Fatalf("FormatPermanentIdentity()=%q, %v; want %q", got, err, test.want)
			}
		})
	}
}

func TestFormatPermanentIdentityRejectsMismatchedPLMN(t *testing.T) {
	if _, err := FormatPermanentIdentity("310240123456789", "310", "260", TypeAKAPrime); err == nil {
		t.Fatal("FormatPermanentIdentity() accepted mismatched MNC")
	}
}
