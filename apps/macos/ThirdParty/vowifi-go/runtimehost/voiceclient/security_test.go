package voiceclient

import "testing"

func TestSelectSecurityAgreementPrefersInstallableIPSecSA(t *testing.T) {
	const installable = `IPSEC-3GPP;Q="0.2";ALG="HMAC-SHA-1-96";EALG="NULL";SPI-C="333";SPI-S="444";PORT-C="5064";PORT-S="5065";PROT=ESP;MODE=TRANSPORT`
	cases := []struct {
		name string
		bad  string
	}{
		{
			name: "invalid client port",
			bad:  `ipsec-3gpp;q=1.0;alg=hmac-sha-1-96;ealg=null;spi-c=111;spi-s=222;port-c=70000;port-s=5063`,
		},
		{
			name: "zero client spi",
			bad:  `ipsec-3gpp;q=1.0;alg=hmac-sha-1-96;ealg=null;spi-c=0;spi-s=222;port-c=5062;port-s=5063`,
		},
		{
			name: "oversized server spi",
			bad:  `ipsec-3gpp;q=1.0;alg=hmac-sha-1-96;ealg=null;spi-c=111;spi-s=4294967296;port-c=5062;port-s=5063`,
		},
	}

	client := SecurityAgreement{
		Protocol:            DefaultSecurityProtocol,
		Algorithm:           DefaultSecurityAlgorithm,
		EncryptionAlgorithm: DefaultSecurityEAlg,
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			selected, ok := SelectSecurityAgreement([]string{tc.bad + ", " + installable}, client)
			if !ok {
				t.Fatal("SelectSecurityAgreement() ok=false")
			}
			if selected.SPIClient != 333 || selected.SPIServer != 444 ||
				selected.PortClient != 5064 || selected.PortServer != 5065 ||
				selected.Parameters["q"] != "0.2" ||
				selected.Parameters["mode"] != "TRANSPORT" ||
				selected.Raw == "" {
				t.Fatalf("selected=%+v", selected)
			}
			plan, ok := BuildIMSSecurityAssociationPlan(selected)
			if !ok {
				t.Fatalf("BuildIMSSecurityAssociationPlan(%+v) ok=false", selected)
			}
			if plan.SPIClient != 333 || plan.SPIServer != 444 ||
				plan.PortClient != 5064 || plan.PortServer != 5065 ||
				plan.Mode != "transport" || plan.QValue != "0.2" {
				t.Fatalf("plan=%+v", plan)
			}
		})
	}
}

func TestSelectSecurityAgreementPreservesSelectedRawFormatting(t *testing.T) {
	const selectedRaw = `IPSEC-3GPP;Q="0.7";PORT-S="5063";SPI-S="222";PORT-C="5062";SPI-C="111";EALG="NULL";ALG="HMAC-SHA-1-96";note="v,1;quoted";PROT=ESP;MODE=TRANSPORT`
	selected, ok := SelectSecurityAgreement([]string{
		`ipsec-3gpp;alg=hmac-md5-96;ealg=null;spi-c=333;spi-s=444;port-c=5064;port-s=5065;q=1.0,` + selectedRaw,
	}, SecurityAgreement{
		Protocol:            DefaultSecurityProtocol,
		Algorithm:           DefaultSecurityAlgorithm,
		EncryptionAlgorithm: DefaultSecurityEAlg,
	})
	if !ok {
		t.Fatal("SelectSecurityAgreement() ok=false")
	}
	if selected.Raw != selectedRaw || selected.Parameters["note"] != "v,1;quoted" || selected.SPIClient != 111 || selected.SPIServer != 222 {
		t.Fatalf("selected=%+v, want raw %q", selected, selectedRaw)
	}
	plan, ok := BuildIMSSecurityAssociationPlan(selected)
	if !ok {
		t.Fatalf("BuildIMSSecurityAssociationPlan(%+v) ok=false", selected)
	}
	if plan.Source != selectedRaw || plan.QValue != "0.7" || plan.Mode != "transport" {
		t.Fatalf("plan=%+v, want source %q", plan, selectedRaw)
	}
}
