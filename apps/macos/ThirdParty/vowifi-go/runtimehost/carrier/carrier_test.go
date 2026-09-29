package carrier

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func TestResolveEffectiveCarrierConfigEnablesATTNativeE911(t *testing.T) {
	ClearCarrierOverrides()
	cfg := ResolveEffectiveCarrierConfig(EffectiveCarrierConfigInput{MCC: "310", MNC: "280"})
	if cfg.PresetID != "310280" {
		t.Fatalf("PresetID=%q, want 310280", cfg.PresetID)
	}
	if !cfg.E911.Enabled || cfg.E911.Provider != "att-ts43" || cfg.E911.Websheet == "" || cfg.E911.EntitlementEndpoint == "" {
		t.Fatalf("E911 config=%+v, want enabled ATT TS.43 preset", cfg.E911)
	}
}

func TestResolveEffectiveCarrierConfigNormalizesTwoDigitMNC(t *testing.T) {
	ClearCarrierOverrides()
	cfg := ResolveEffectiveCarrierConfig(EffectiveCarrierConfigInput{MCC: "310", MNC: "28"})
	if cfg.PresetID != "310028" {
		t.Fatalf("PresetID=%q, want normalized 310028", cfg.PresetID)
	}
	if cfg.E911.Enabled {
		t.Fatalf("E911 enabled for unknown normalized preset: %+v", cfg.E911)
	}
	if cfg.Network.IMSRealm != "ims.mnc028.mcc310.3gppnetwork.org" ||
		cfg.Network.PrivateIdentityRealm != "ims.mnc028.mcc310.3gppnetwork.org" ||
		cfg.Network.NAIRealm != "nai.epc.mnc028.mcc310.3gppnetwork.org" ||
		cfg.Network.PCSCFFQDN != "pcscf.ims.mnc028.mcc310.3gppnetwork.org" ||
		cfg.Network.EPDGFQDN != "epdg.epc.mnc028.mcc310.pub.3gppnetwork.org" ||
		cfg.Network.EmergencyDomain != "ims.mnc028.mcc310.3gppnetwork.org" {
		t.Fatalf("Network=%+v, want derived 3GPP defaults", cfg.Network)
	}
}

func TestTMobileAndUltraPresetsPreferAKAPrime(t *testing.T) {
	ClearCarrierOverrides()
	for _, imsi := range []string{"310240123456789", "310260123456789"} {
		cfg := ResolveEffectiveCarrierConfig(EffectiveCarrierConfigInput{IMSI: imsi})
		if cfg.Network.EAPMethod != "aka" {
			t.Fatalf("IMSI prefix %s EAP method=%q, want aka", imsi[:6], cfg.Network.EAPMethod)
		}
	}
}

func TestEffectiveCarrierUsesIMSIHomePLMNWhenConfiguredMNCMismatches(t *testing.T) {
	ClearCarrierOverrides()
	cfg := ResolveEffectiveCarrierConfig(EffectiveCarrierConfigInput{
		IMSI: "310240123456789",
		MCC:  "310",
		MNC:  "260",
	})
	if cfg.MCC != "310" || cfg.MNC != "240" || cfg.Network.EPDGFQDN != "epdg.epc.mnc240.mcc310.pub.3gppnetwork.org" {
		t.Fatalf("effective carrier=%+v, want SIM HPLMN 310/240", cfg)
	}
}

func TestNormalizeSubscriberProfileDerivesRealmsAndNAI(t *testing.T) {
	profile := NormalizeSubscriberProfile(SubscriberProfileInput{IMSI: "001010123456789"})
	if profile.MCC != "001" || profile.MNC != "010" || profile.PresetID != "001010" {
		t.Fatalf("profile PLMN=(%q,%q) PresetID=%q, want 001010", profile.MCC, profile.MNC, profile.PresetID)
	}
	if profile.Network.IMSRealm != "ims.mnc010.mcc001.3gppnetwork.org" ||
		profile.Network.PrivateIdentityRealm != "ims.mnc010.mcc001.3gppnetwork.org" ||
		profile.Network.NAIRealm != "nai.epc.mnc010.mcc001.3gppnetwork.org" ||
		profile.Network.PCSCFFQDN != "pcscf.ims.mnc010.mcc001.3gppnetwork.org" ||
		profile.Network.EPDGFQDN != "epdg.epc.mnc010.mcc001.pub.3gppnetwork.org" ||
		profile.Network.EmergencyDomain != "ims.mnc010.mcc001.3gppnetwork.org" {
		t.Fatalf("Network=%+v, want derived 3GPP defaults", profile.Network)
	}
	if profile.IMSPrivateIdentity != "001010123456789@ims.mnc010.mcc001.3gppnetwork.org" ||
		profile.IMSPublicIdentity != "sip:001010123456789@ims.mnc010.mcc001.3gppnetwork.org" ||
		profile.PermanentNAI != "0001010123456789@nai.epc.mnc010.mcc001.3gppnetwork.org" {
		t.Fatalf("derived identities=%+v", profile)
	}
}

func TestIMSAccessProfileForSubscriberDefaultsRealVoWiFiMetadata(t *testing.T) {
	ClearCarrierOverrides()
	t.Cleanup(ClearCarrierOverrides)

	profile := IMSAccessProfileForSubscriber(IMSAccessProfileInput{IMSI: "001010123456789"})
	if profile.MCC != "001" || profile.MNC != "010" || profile.PresetID != "001010" {
		t.Fatalf("profile PLMN=(%q,%q) PresetID=%q, want 001010", profile.MCC, profile.MNC, profile.PresetID)
	}
	if profile.IMSAPN != "ims" || profile.EmergencyAPN != "sos" {
		t.Fatalf("APNs ims=%q emergency=%q, want ims/sos", profile.IMSAPN, profile.EmergencyAPN)
	}
	if !reflect.DeepEqual(profile.PCSCFFQDNs, []string{"pcscf.ims.mnc010.mcc001.3gppnetwork.org"}) {
		t.Fatalf("PCSCFFQDNs=%+v, want derived P-CSCF", profile.PCSCFFQDNs)
	}
	if !reflect.DeepEqual(profile.EmergencyServiceURNs, []string{"urn:service:sos"}) {
		t.Fatalf("EmergencyServiceURNs=%+v, want sos default", profile.EmergencyServiceURNs)
	}
	if profile.IMSPrivateIdentity != "001010123456789@ims.mnc010.mcc001.3gppnetwork.org" ||
		profile.IMSPublicIdentity != "sip:001010123456789@ims.mnc010.mcc001.3gppnetwork.org" ||
		profile.PermanentNAI != "0001010123456789@nai.epc.mnc010.mcc001.3gppnetwork.org" {
		t.Fatalf("identities=%+v", profile)
	}
}

func TestResolveEffectiveCarrierConfigDerivesPLMNFromIMSI(t *testing.T) {
	ClearCarrierOverrides()
	cfg := ResolveEffectiveCarrierConfig(EffectiveCarrierConfigInput{IMSI: "310280000000002"})
	if cfg.MCC != "310" || cfg.MNC != "280" || cfg.PresetID != "310280" {
		t.Fatalf("config PLMN=(%q,%q) PresetID=%q, want 310280", cfg.MCC, cfg.MNC, cfg.PresetID)
	}
	if !cfg.E911.Enabled || cfg.Network.IMSRealm != "ims.mnc280.mcc310.3gppnetwork.org" {
		t.Fatalf("config=%+v, want ATT preset with normalized network", cfg)
	}
}

func TestLoadCarrierOverrides(t *testing.T) {
	path := filepath.Join(t.TempDir(), "carriers.json")
	if err := os.WriteFile(path, []byte(`{
		"001001": {
			"mcc": "001",
			"mnc": "001",
			"e911": {
				"enabled": true,
				"provider": "ts43",
				"websheet": "https://example.test/e911",
				"entitlement_endpoint": "https://example.test/entitlement"
			}
		}
	}`), 0600); err != nil {
		t.Fatal(err)
	}
	res, err := LoadCarrierOverrides(path)
	if err != nil {
		t.Fatalf("LoadCarrierOverrides() error = %v", err)
	}
	if res.Missing || res.Count != 1 {
		t.Fatalf("LoadResult=%+v, want one loaded override", res)
	}
	cfg := ResolveEffectiveCarrierConfig(EffectiveCarrierConfigInput{MCC: "001", MNC: "001"})
	if !cfg.E911.Enabled || cfg.E911.Provider != "ts43" || cfg.E911.Websheet != "https://example.test/e911" {
		t.Fatalf("override config=%+v", cfg)
	}
	ClearCarrierOverrides()
}

func TestLoadCarrierOverridesNormalizesShortKeyAndNetworkPolicy(t *testing.T) {
	path := filepath.Join(t.TempDir(), "carriers.json")
	if err := os.WriteFile(path, []byte(`{
		"31028": {
			"network": {
				"ims_realm": " IMS.OVERRIDE.EXAMPLE. ",
				"private_identity_realm": " Private.OVERRIDE.EXAMPLE. ",
				"pcscf_fqdn": " PCSCF.OVERRIDE.EXAMPLE. ",
				"epdg_fqdn": " EPDG.OVERRIDE.EXAMPLE. ",
				"emergency_domain": " SOS.OVERRIDE.EXAMPLE. "
			}
		}
	}`), 0600); err != nil {
		t.Fatal(err)
	}
	res, err := LoadCarrierOverrides(path)
	if err != nil {
		t.Fatalf("LoadCarrierOverrides() error = %v", err)
	}
	if res.Missing || res.Count != 1 {
		t.Fatalf("LoadResult=%+v, want one loaded override", res)
	}
	cfg := ResolveEffectiveCarrierConfig(EffectiveCarrierConfigInput{MCC: "310", MNC: "28"})
	if cfg.MCC != "310" || cfg.MNC != "028" || cfg.PresetID != "310028" {
		t.Fatalf("PLMN=(%q,%q) PresetID=%q, want normalized 310028", cfg.MCC, cfg.MNC, cfg.PresetID)
	}
	if cfg.Network.IMSRealm != "ims.override.example" ||
		cfg.Network.PrivateIdentityRealm != "private.override.example" ||
		cfg.Network.NAIRealm != "nai.epc.mnc028.mcc310.3gppnetwork.org" ||
		cfg.Network.PCSCFFQDN != "pcscf.override.example" ||
		cfg.Network.EPDGFQDN != "epdg.override.example" ||
		cfg.Network.EmergencyDomain != "sos.override.example" {
		t.Fatalf("Network=%+v, want override plus fallback defaults", cfg.Network)
	}
	ClearCarrierOverrides()
}

func TestLoadCarrierOverridesNormalizesPCSCFCandidates(t *testing.T) {
	ClearCarrierOverrides()
	t.Cleanup(ClearCarrierOverrides)

	path := filepath.Join(t.TempDir(), "carriers.json")
	if err := os.WriteFile(path, []byte(`{
		"001010": {
			"mcc": "001",
			"mnc": "010",
			"network": {
				"pcscf_fqdn": " PCSCF-A.EXAMPLE.TEST. ",
				"pcscf_fqdns": ["pcscf-b.example.test.", "pcscf-a.example.test"],
				"pcscf_fqdn_list": "pcscf-c.example.test, pcscf-b.example.test",
				"pcscf": "pcscf-d.example.test"
			}
		}
	}`), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := LoadCarrierOverrides(path); err != nil {
		t.Fatalf("LoadCarrierOverrides() error = %v", err)
	}
	cfg := ResolveEffectiveCarrierConfig(EffectiveCarrierConfigInput{MCC: "001", MNC: "010"})
	want := []string{
		"pcscf-a.example.test",
		"pcscf-b.example.test",
		"pcscf-c.example.test",
		"pcscf-d.example.test",
	}
	if cfg.Network.PCSCFFQDN != want[0] || !reflect.DeepEqual(cfg.Network.PCSCFFQDNs, want) {
		t.Fatalf("P-CSCF primary/list=%q/%+v, want %+v", cfg.Network.PCSCFFQDN, cfg.Network.PCSCFFQDNs, want)
	}
	got := PCSCFCandidates(NetworkConfig{PCSCFFQDNs: []string{" PCSCF-X.EXAMPLE.TEST. ", "pcscf-x.example.test", "pcscf-y.example.test"}})
	if !reflect.DeepEqual(got, []string{"pcscf-x.example.test", "pcscf-y.example.test"}) {
		t.Fatalf("PCSCFCandidates()=%+v", got)
	}
}

func TestLoadCarrierOverridesIndexesNamedPresetByPLMN(t *testing.T) {
	ClearCarrierOverrides()
	t.Cleanup(ClearCarrierOverrides)

	path := filepath.Join(t.TempDir(), "carriers.json")
	if err := os.WriteFile(path, []byte(`{
		"001013": {
			"mcc": "001",
			"mnc": "013",
			"preset_id": "lab-wifi",
			"network": {
				"ims_realm": " ims.named.example. ",
				"pcscf_fqdn": " pcscf.named.example. "
			}
		}
	}`), 0600); err != nil {
		t.Fatal(err)
	}
	res, err := LoadCarrierOverrides(path)
	if err != nil {
		t.Fatalf("LoadCarrierOverrides() error = %v", err)
	}
	if res.Missing || res.Count != 1 {
		t.Fatalf("LoadResult=%+v, want one loaded override", res)
	}
	cfg := ResolveEffectiveCarrierConfig(EffectiveCarrierConfigInput{MCC: "001", MNC: "013"})
	if cfg.PresetID != "lab-wifi" || cfg.Network.IMSRealm != "ims.named.example" ||
		cfg.Network.PCSCFFQDN != "pcscf.named.example" {
		t.Fatalf("ResolveEffectiveCarrierConfig(named preset)=%+v, want PLMN lookup to find override", cfg)
	}
}

func TestLoadCarrierOverridesAcceptsNetworkAliases(t *testing.T) {
	ClearCarrierOverrides()
	t.Cleanup(ClearCarrierOverrides)

	path := filepath.Join(t.TempDir(), "carriers.json")
	if err := os.WriteFile(path, []byte(`{
		"001010": {
			"mcc": "001",
			"mnc": "010",
			"network": {
				"ims_domain": " IMS.ALIAS.EXAMPLE. ",
				"pcscf_fqdn": " PCSCF-A.ALIAS.EXAMPLE. ",
				"pcscf_list": ["pcscf-b.alias.example.", "pcscf-a.alias.example"],
				"epdg": " EPDG.ALIAS.EXAMPLE. ",
				"emergency_realm": " SOS.ALIAS.EXAMPLE. ",
				"p_access_network_info": " IEEE-802.11;i-wlan-node-id=\"node;1\" ",
				"p_visited_network_id": " visited.alias.example "
			}
		}
	}`), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := LoadCarrierOverrides(path); err != nil {
		t.Fatalf("LoadCarrierOverrides() error = %v", err)
	}
	cfg := ResolveEffectiveCarrierConfig(EffectiveCarrierConfigInput{MCC: "001", MNC: "010"})
	if cfg.Network.IMSRealm != "ims.alias.example" ||
		cfg.Network.PrivateIdentityRealm != "ims.alias.example" ||
		cfg.Network.EPDGFQDN != "epdg.alias.example" ||
		cfg.Network.EmergencyDomain != "sos.alias.example" ||
		cfg.Network.AccessNetworkInfo != `IEEE-802.11;i-wlan-node-id="node;1"` ||
		cfg.Network.VisitedNetworkID != "visited.alias.example" {
		t.Fatalf("Network=%+v, want normalized alias fields", cfg.Network)
	}
	wantPCSCF := []string{"pcscf-a.alias.example", "pcscf-b.alias.example"}
	if cfg.Network.PCSCFFQDN != wantPCSCF[0] || !reflect.DeepEqual(cfg.Network.PCSCFFQDNs, wantPCSCF) {
		t.Fatalf("P-CSCF=%q/%+v, want %+v", cfg.Network.PCSCFFQDN, cfg.Network.PCSCFFQDNs, wantPCSCF)
	}
	raw, err := json.Marshal(cfg.Network)
	if err != nil {
		t.Fatalf("Marshal(Network) error = %v", err)
	}
	if strings.Contains(string(raw), "ims_domain") || strings.Contains(string(raw), "epdg\"") ||
		strings.Contains(string(raw), "p_access_network_info") || strings.Contains(string(raw), "p_visited_network_id") ||
		!strings.Contains(string(raw), "ims_realm") || !strings.Contains(string(raw), "epdg_fqdn") ||
		!strings.Contains(string(raw), "access_network_info") || !strings.Contains(string(raw), "visited_network_id") {
		t.Fatalf("marshaled network JSON=%s, want canonical field names", raw)
	}
}

func TestLoadCarrierOverridesAcceptsTopLevelNetworkAliases(t *testing.T) {
	ClearCarrierOverrides()
	t.Cleanup(ClearCarrierOverrides)

	path := filepath.Join(t.TempDir(), "carriers.json")
	if err := os.WriteFile(path, []byte(`{
		"001011": {
			"mcc": "001",
			"mnc": "011",
			"ims_domain": " IMS.TOP.EXAMPLE. ",
			"pcscf_list": "pcscf-a.top.example, pcscf-b.top.example.",
			"epdg": " EPDG.TOP.EXAMPLE. ",
			"emergency_realm": " SOS.TOP.EXAMPLE. "
		}
	}`), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := LoadCarrierOverrides(path); err != nil {
		t.Fatalf("LoadCarrierOverrides() error = %v", err)
	}
	cfg := ResolveEffectiveCarrierConfig(EffectiveCarrierConfigInput{MCC: "001", MNC: "011"})
	if cfg.Network.IMSRealm != "ims.top.example" ||
		cfg.Network.PCSCFFQDN != "pcscf-a.top.example" ||
		cfg.Network.EPDGFQDN != "epdg.top.example" ||
		cfg.Network.EmergencyDomain != "sos.top.example" {
		t.Fatalf("Network=%+v, want top-level alias fields", cfg.Network)
	}
	if !reflect.DeepEqual(cfg.Network.PCSCFFQDNs, []string{"pcscf-a.top.example", "pcscf-b.top.example"}) {
		t.Fatalf("PCSCFFQDNs=%+v, want split top-level pcscf_list", cfg.Network.PCSCFFQDNs)
	}
}

func TestLoadCarrierOverridesNormalizesAccessProfileMetadata(t *testing.T) {
	ClearCarrierOverrides()
	t.Cleanup(ClearCarrierOverrides)

	path := filepath.Join(t.TempDir(), "carriers.json")
	if err := os.WriteFile(path, []byte(`{
		"001012": {
			"mcc": "001",
			"mnc": "012",
			"network": {
				"apn": " IMS-CUSTOM ",
				"sos_apn": " SOS-CUSTOM ",
				"pcscf_fqdns": ["PCSCF-A.PROFILE.EXAMPLE.", "pcscf-b.profile.example"],
				"service_urns": ["fire", "URN:SERVICE:SOS.POLICE", "911", "fire"],
				"pani": " IEEE-802.11;i-wlan-node-id=\"node;2\" ",
				"visited_network": " visited.profile.example "
			}
		}
	}`), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := LoadCarrierOverrides(path); err != nil {
		t.Fatalf("LoadCarrierOverrides() error = %v", err)
	}
	profile := IMSAccessProfileForSubscriber(IMSAccessProfileInput{IMSI: "001012123456789"})
	if profile.IMSAPN != "ims-custom" || profile.EmergencyAPN != "sos-custom" {
		t.Fatalf("APNs ims=%q emergency=%q, want custom normalized APNs", profile.IMSAPN, profile.EmergencyAPN)
	}
	if !reflect.DeepEqual(profile.PCSCFFQDNs, []string{"pcscf-a.profile.example", "pcscf-b.profile.example"}) {
		t.Fatalf("PCSCFFQDNs=%+v, want normalized candidates", profile.PCSCFFQDNs)
	}
	wantURNs := []string{"urn:service:sos.fire", "urn:service:sos.police", "urn:service:sos"}
	if !reflect.DeepEqual(profile.EmergencyServiceURNs, wantURNs) {
		t.Fatalf("EmergencyServiceURNs=%+v, want %+v", profile.EmergencyServiceURNs, wantURNs)
	}
	if profile.AccessNetworkInfo != `IEEE-802.11;i-wlan-node-id="node;2"` ||
		profile.VisitedNetworkID != "visited.profile.example" {
		t.Fatalf("ANI/visited=%q/%q, want normalized policy metadata", profile.AccessNetworkInfo, profile.VisitedNetworkID)
	}
}

func TestCarrierPolicyForSubscriberSurfacesIMSAndE911Metadata(t *testing.T) {
	ClearCarrierOverrides()
	t.Cleanup(ClearCarrierOverrides)

	path := filepath.Join(t.TempDir(), "carriers.json")
	if err := os.WriteFile(path, []byte(`{
		"001016": {
			"mcc": "001",
			"mnc": "016",
			"preset_id": "matrix-lab",
			"e911": {
				"enabled": true,
				"provider": " Lab-TS43 ",
				"websheet": "https://example.test/lab-e911",
				"entitlement_endpoint": "https://example.test/lab-entitlement"
			},
			"network": {
				"ims_realm": " ims.policy.example. ",
				"private_identity_realm": " private.policy.example. ",
				"pcscf_fqdns": ["pcscf-a.policy.example.", "pcscf-b.policy.example"],
				"pani": " IEEE-802.11;i-wlan-node-id=\"node;16\" ",
				"visited_network": " visited.policy.example ",
				"service_urns": ["police", "URN:SERVICE:SOS.AMBULANCE"]
			}
		}
	}`), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := LoadCarrierOverrides(path); err != nil {
		t.Fatalf("LoadCarrierOverrides() error = %v", err)
	}

	policy := CarrierPolicyForSubscriber(CarrierPolicyInput{IMSI: "001016123456789"})
	if policy.MCC != "001" || policy.MNC != "016" || policy.PresetID != "matrix-lab" {
		t.Fatalf("CarrierPolicy PLMN/Preset=%+v, want named 001/016 policy", policy)
	}
	if !policy.E911.Enabled || policy.E911.Provider != "lab-ts43" ||
		policy.E911.Websheet != "https://example.test/lab-e911" ||
		policy.E911.EntitlementEndpoint != "https://example.test/lab-entitlement" {
		t.Fatalf("CarrierPolicy E911=%+v, want normalized E911 metadata", policy.E911)
	}
	if policy.IMS.IMSPrivateIdentity != "001016123456789@private.policy.example" ||
		policy.IMS.IMSPublicIdentity != "sip:001016123456789@ims.policy.example" ||
		policy.IMS.AccessNetworkInfo != `IEEE-802.11;i-wlan-node-id="node;16"` ||
		policy.IMS.VisitedNetworkID != "visited.policy.example" {
		t.Fatalf("CarrierPolicy IMS=%+v, want normalized IMS metadata", policy.IMS)
	}
	if !reflect.DeepEqual(policy.IMS.PCSCFFQDNs, []string{"pcscf-a.policy.example", "pcscf-b.policy.example"}) {
		t.Fatalf("CarrierPolicy PCSCF=%+v", policy.IMS.PCSCFFQDNs)
	}
	wantURNs := []string{"urn:service:sos.police", "urn:service:sos.ambulance"}
	if !reflect.DeepEqual(policy.IMS.EmergencyServiceURNs, wantURNs) ||
		!reflect.DeepEqual(policy.Network.EmergencyServiceURNs, wantURNs) {
		t.Fatalf("CarrierPolicy service URNs IMS=%+v Network=%+v, want %+v",
			policy.IMS.EmergencyServiceURNs, policy.Network.EmergencyServiceURNs, wantURNs)
	}
}

func TestPlanIMSRegistrationBuildsReadyCarrierSnapshot(t *testing.T) {
	ClearCarrierOverrides()
	t.Cleanup(ClearCarrierOverrides)

	path := filepath.Join(t.TempDir(), "carriers.json")
	if err := os.WriteFile(path, []byte(`{
		"001018": {
			"mcc": "001",
			"mnc": "018",
			"preset_id": "registration-lab",
			"e911": {
				"enabled": true,
				"provider": " TS43 ",
				"entitlement_endpoint": "https://example.test/entitlement"
			},
			"network": {
				"ims_realm": " IMS.REG.EXAMPLE. ",
				"private_identity_realm": " PRIVATE.REG.EXAMPLE. ",
				"nai_realm": " NAI.REG.EXAMPLE. ",
				"pcscf_fqdns": ["pcscf-a.reg.example.", "pcscf-b.reg.example"],
				"epdg_fqdn": " epdg.reg.example. ",
				"pani": " IEEE-802.11;i-wlan-node-id=\"node;18\" ",
				"visited_network": " visited.reg.example ",
				"service_urns": ["fire", "police"]
			}
		}
	}`), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := LoadCarrierOverrides(path); err != nil {
		t.Fatalf("LoadCarrierOverrides() error = %v", err)
	}

	plan := PlanIMSRegistration(IMSRegistrationPlanInput{
		IMSI:        "001018123456789",
		LocalIP:     "fd00::10",
		ContactPort: 6060,
		UserAgent:   "test-agent",
	})
	if !plan.Ready || len(plan.Missing) != 0 {
		t.Fatalf("PlanIMSRegistration() readiness=%v missing=%+v, want ready", plan.Ready, plan.Missing)
	}
	if plan.PresetID != "registration-lab" || plan.RegistrarURI != "sip:ims.reg.example" ||
		plan.ContactURI != "sip:001018123456789@[fd00::10]:6060" ||
		plan.IMPI != "001018123456789@private.reg.example" ||
		plan.IMPU != "sip:001018123456789@ims.reg.example" ||
		plan.PermanentNAI != "0001018123456789@nai.reg.example" {
		t.Fatalf("IMS registration plan=%+v, want normalized identities and URIs", plan)
	}
	if !reflect.DeepEqual(plan.PCSCFFQDNs, []string{"pcscf-a.reg.example", "pcscf-b.reg.example"}) ||
		plan.EPDGFQDN != "epdg.reg.example" ||
		plan.IMSAPN != "ims" || plan.EmergencyAPN != "sos" {
		t.Fatalf("IMS network plan=%+v", plan)
	}
	if got := plan.Headers["P-Access-Network-Info"]; got != `IEEE-802.11;i-wlan-node-id="node;18"` {
		t.Fatalf("P-Access-Network-Info=%q", got)
	}
	if got := plan.Headers["P-Visited-Network-ID"]; got != `"visited.reg.example"` {
		t.Fatalf("P-Visited-Network-ID=%q", got)
	}
	if !plan.E911.Enabled || plan.E911.Provider != "ts43" ||
		!reflect.DeepEqual(plan.EmergencyServiceURNs, []string{"urn:service:sos.fire", "urn:service:sos.police"}) {
		t.Fatalf("emergency policy in plan=%+v serviceURNs=%+v", plan.E911, plan.EmergencyServiceURNs)
	}
}

func TestPlanIMSRegistrationReportsMissingContactAddress(t *testing.T) {
	ClearCarrierOverrides()
	t.Cleanup(ClearCarrierOverrides)

	plan := PlanIMSRegistration(IMSRegistrationPlanInput{IMSI: "001010123456789"})
	if plan.Ready {
		t.Fatalf("PlanIMSRegistration() Ready=true, want false without contact address")
	}
	for _, field := range []string{"contact_host", "contact_uri"} {
		if !registrationPlanMissingContains(plan.Missing, field) {
			t.Fatalf("Missing=%+v, want %q", plan.Missing, field)
		}
	}
	if plan.RegistrarURI != "sip:ims.mnc010.mcc001.3gppnetwork.org" ||
		plan.ContactURI != "" ||
		plan.ContactPort != 5060 {
		t.Fatalf("plan=%+v, want registrar/default port but no contact URI", plan)
	}
}

func TestPlanIMSRegistrationForPolicyPreservesExplicitIdentities(t *testing.T) {
	policy := CarrierPolicy{
		MCC:      "001",
		MNC:      "019",
		PresetID: "manual-policy",
		Network: NetworkConfig{
			IMSRealm:             "ims.manual.example",
			PrivateIdentityRealm: "private.manual.example",
			NAIRealm:             "nai.manual.example",
			PCSCFFQDNs:           []string{"pcscf.manual.example"},
			EPDGFQDN:             "epdg.manual.example",
			VisitedNetworkID:     `"quoted.manual.example"`,
		},
		IMS: IMSAccessProfile{
			IMSPrivateIdentity: "manual-impi@private.manual.example",
			IMSPublicIdentity:  "sip:manual-user@ims.manual.example",
			PermanentNAI:       "manual-nai@nai.manual.example",
		},
	}
	plan := PlanIMSRegistrationForPolicy(policy, IMSRegistrationPlanInput{ContactHost: "192.0.2.9"})
	if !plan.Ready {
		t.Fatalf("PlanIMSRegistrationForPolicy() missing=%+v, want ready", plan.Missing)
	}
	if plan.IMPI != "manual-impi@private.manual.example" ||
		plan.IMPU != "sip:manual-user@ims.manual.example" ||
		plan.PermanentNAI != "manual-nai@nai.manual.example" ||
		plan.ContactURI != "sip:manual-user@192.0.2.9:5060" {
		t.Fatalf("plan=%+v, want explicit identities preserved", plan)
	}
	if got := plan.Headers["P-Visited-Network-ID"]; got != `"quoted.manual.example"` {
		t.Fatalf("P-Visited-Network-ID=%q", got)
	}
}

func TestIMSIdentityDomainCandidatesNormalizeAndDeriveDefaults(t *testing.T) {
	candidates := IMSIdentityDomainCandidates(NetworkConfig{
		IMSRealm:             " IMS.EXAMPLE.TEST. ",
		PrivateIdentityRealm: " PRIVATE.EXAMPLE.TEST. ",
		EmergencyDomain:      " IMS.EXAMPLE.TEST. ",
	}, "", "")
	want := []IMSIdentityDomainCandidate{
		{Domain: "ims.example.test", Role: IMSIdentityDomainRoleIMSRealm},
		{Domain: "private.example.test", Role: IMSIdentityDomainRolePrivateIdentityRealm},
	}
	if !reflect.DeepEqual(candidates, want) {
		t.Fatalf("IMSIdentityDomainCandidates(custom)=%+v, want %+v", candidates, want)
	}

	candidates = IMSIdentityDomainCandidates(NetworkConfig{}, "001", "10")
	want = []IMSIdentityDomainCandidate{
		{Domain: "ims.mnc010.mcc001.3gppnetwork.org", Role: IMSIdentityDomainRoleIMSRealm},
	}
	if !reflect.DeepEqual(candidates, want) {
		t.Fatalf("IMSIdentityDomainCandidates(defaults)=%+v, want %+v", candidates, want)
	}
}

func TestDeriveIdentitiesUsePrivateIdentityRealm(t *testing.T) {
	network := NetworkConfig{
		IMSRealm:             " IMS.EXAMPLE.TEST. ",
		PrivateIdentityRealm: " Private.EXAMPLE.TEST. ",
		NAIRealm:             " NAI.EXAMPLE.TEST. ",
	}
	if got := DeriveIMSPrivateIdentityForNetwork("001010123456789", network); got != "001010123456789@private.example.test" {
		t.Fatalf("DeriveIMSPrivateIdentityForNetwork()=%q", got)
	}
	if got := DeriveIMSPublicIdentityForNetwork("001010123456789", network); got != "sip:001010123456789@ims.example.test" {
		t.Fatalf("DeriveIMSPublicIdentityForNetwork()=%q", got)
	}
	if got := DerivePermanentNAIForNetwork("001010123456789", network); got != "0001010123456789@nai.example.test" {
		t.Fatalf("DerivePermanentNAIForNetwork()=%q", got)
	}

	network.PrivateIdentityRealm = ""
	if got := DeriveIMSPrivateIdentityForNetwork("001010123456789", network); got != "001010123456789@ims.example.test" {
		t.Fatalf("DeriveIMSPrivateIdentityForNetwork(fallback)=%q", got)
	}
}

func TestDeriveIdentitiesRejectInvalidSubscriberData(t *testing.T) {
	if got := DeriveIMSPrivateIdentity("001010123456789", "001", "01"); got != "001010123456789@ims.mnc001.mcc001.3gppnetwork.org" {
		t.Fatalf("DeriveIMSPrivateIdentity()=%q", got)
	}
	if got := DeriveIMSPublicIdentity("001010123456789", "001", "001"); got != "sip:001010123456789@ims.mnc001.mcc001.3gppnetwork.org" {
		t.Fatalf("DeriveIMSPublicIdentity()=%q", got)
	}
	if got := DerivePermanentNAI("001010123456789", "001", "001"); got != "0001010123456789@nai.epc.mnc001.mcc001.3gppnetwork.org" {
		t.Fatalf("DerivePermanentNAI()=%q", got)
	}
	if got := DeriveIMSPrivateIdentity("imsi", "001", "001"); got != "" {
		t.Fatalf("DeriveIMSPrivateIdentity(invalid IMSI)=%q, want empty", got)
	}
	if got := DefaultIMSRealm("31x", "001"); got != "" {
		t.Fatalf("DefaultIMSRealm(invalid MCC)=%q, want empty", got)
	}
}

func registrationPlanMissingContains(values []string, want string) bool {
	for _, value := range values {
		if value == want {
			return true
		}
	}
	return false
}
