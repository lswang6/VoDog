package e911

import "strings"

type EmergencyServiceClassification struct {
	Emergency  bool
	ServiceURN string
	Category   EmergencyServiceCategory
}

type emergencyServiceURNDescriptor struct {
	urn      string
	category EmergencyServiceCategory
	aliases  []string
}

var emergencyServiceURNDescriptors = []emergencyServiceURNDescriptor{
	{
		urn:     DefaultEmergencyServiceURN,
		aliases: []string{"911", "112", "sos", "emergency", "e911"},
	},
	{
		urn:      "urn:service:sos.police",
		category: EmergencyServiceCategoryPolice,
		aliases:  []string{"police"},
	},
	{
		urn:      "urn:service:sos.ambulance",
		category: EmergencyServiceCategoryAmbulance,
		aliases:  []string{"ambulance", "medical", "ems"},
	},
	{
		urn:      "urn:service:sos.fire",
		category: EmergencyServiceCategoryFire,
		aliases:  []string{"fire"},
	},
	{
		urn:     "urn:service:sos.animal-control",
		aliases: []string{"animal-control", "animalcontrol"},
	},
	{
		urn:     "urn:service:sos.gas",
		aliases: []string{"gas"},
	},
	{
		urn:      "urn:service:sos.marine",
		category: EmergencyServiceCategoryMarine,
		aliases:  []string{"marine"},
	},
	{
		urn:      "urn:service:sos.mountain",
		category: EmergencyServiceCategoryMountain,
		aliases:  []string{"mountain"},
	},
	{
		urn:     "urn:service:sos.physician",
		aliases: []string{"physician"},
	},
	{
		urn:     "urn:service:sos.poison",
		aliases: []string{"poison"},
	},
	{
		urn:      "urn:service:sos.ecall.manual",
		category: EmergencyServiceCategoryManualECall,
		aliases:  []string{"ecall", "manual-ecall", "ecall-manual"},
	},
	{
		urn:      "urn:service:sos.ecall.automatic",
		category: EmergencyServiceCategoryAutomaticECall,
		aliases:  []string{"automatic-ecall", "ecall-automatic"},
	},
}

func ClassifyEmergencyService(value string) EmergencyServiceClassification {
	urn := normalizeEmergencyServiceURN(value)
	if urn == "" {
		return EmergencyServiceClassification{}
	}
	return EmergencyServiceClassification{
		Emergency:  true,
		ServiceURN: urn,
		Category:   emergencyServiceCategoryForNormalizedURN(urn),
	}
}

func IsEmergencyService(value string) bool {
	return ClassifyEmergencyService(value).Emergency
}

func EmergencyServiceCategoryForURN(value string) EmergencyServiceCategory {
	return ClassifyEmergencyService(value).Category
}

func normalizeEmergencyServiceURNValue(value string) string {
	value = strings.ToLower(strings.TrimSpace(value))
	if value == "" {
		return ""
	}
	if candidate, ok := emergencyServiceWrappedCandidate(value); ok {
		if urn := normalizeEmergencyServiceURNValue(candidate); urn != "" {
			return urn
		}
	}
	value = normalizeEmergencyServiceURNPathForm(value)
	value = strings.TrimPrefix(value, "service:")
	if strings.HasPrefix(value, "sos.") {
		value = "urn:service:" + value
	}
	if isEmergencyServiceURN(value) {
		return value
	}
	for _, descriptor := range emergencyServiceURNDescriptors {
		for _, alias := range descriptor.aliases {
			if value == alias {
				return descriptor.urn
			}
		}
	}
	return ""
}

func emergencyServiceWrappedCandidate(value string) (string, bool) {
	if uri, ok := emergencyServiceAngleURI(value); ok {
		return uri, true
	}
	switch {
	case strings.HasPrefix(value, "sip:"):
		return emergencyServiceSIPURIUser(value[len("sip:"):])
	case strings.HasPrefix(value, "sips:"):
		return emergencyServiceSIPURIUser(value[len("sips:"):])
	case strings.HasPrefix(value, "tel:"):
		return emergencyServiceURIUser(value[len("tel:"):])
	default:
		return "", false
	}
}

func emergencyServiceAngleURI(value string) (string, bool) {
	start := strings.IndexByte(value, '<')
	if start < 0 {
		return "", false
	}
	end := strings.IndexByte(value[start+1:], '>')
	if end < 0 {
		return "", false
	}
	uri := strings.TrimSpace(value[start+1 : start+1+end])
	return uri, uri != ""
}

func emergencyServiceSIPURIUser(value string) (string, bool) {
	value = strings.TrimSpace(value)
	if user, _, ok := strings.Cut(value, "@"); ok {
		return emergencyServiceURIUser(user)
	}
	return emergencyServiceURIUser(value)
}

func emergencyServiceURIUser(value string) (string, bool) {
	value = strings.TrimSpace(value)
	if idx := strings.IndexAny(value, ";?"); idx >= 0 {
		value = strings.TrimSpace(value[:idx])
	}
	return value, value != ""
}

func normalizeEmergencyServiceURNPathForm(value string) string {
	for _, prefix := range []string{"urn/service/", "urn:service/"} {
		if strings.HasPrefix(value, prefix) {
			suffix := strings.Trim(strings.TrimPrefix(value, prefix), "/")
			if suffix == "" {
				return value
			}
			return "urn:service:" + strings.ReplaceAll(suffix, "/", ".")
		}
	}
	return value
}

func isEmergencyServiceURN(value string) bool {
	return value == DefaultEmergencyServiceURN || strings.HasPrefix(value, DefaultEmergencyServiceURN+".")
}

func emergencyServiceCategoryForNormalizedURN(urn string) EmergencyServiceCategory {
	for _, descriptor := range emergencyServiceURNDescriptors {
		if urn == descriptor.urn {
			return descriptor.category
		}
	}
	return 0
}
