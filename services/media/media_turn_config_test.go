package main

import "testing"

func TestConfiguredMediaTurnUDPURLRequiresPerNodeRoute(t *testing.T) {
	tests := []struct {
		name, node, raw, want string
		wantError             bool
	}{
		{"relay-primary explicit", "relay-primary", "turn:vodog.example.com:16801?transport=udp", "turn:vodog.example.com:16801?transport=udp", false},
		{"gz explicit", "relay-secondary", secondaryTurnUDPURL, secondaryTurnUDPURL, false},
		{"legacy gz only", "relay-secondary", "", secondaryTurnUDPURL, false},
		{"relay-primary cannot silently use gz fallback", "relay-primary", "", "", true},
		{"unknown cannot use fallback", "other", "", "", true},
		{"tls not bridge udp", "relay-primary", "turns:vodog.example.com:16802?transport=tcp", "", true},
		{"missing transport", "relay-primary", "turn:vodog.example.com:16801", "", true},
		{"credentials rejected", "relay-primary", "turn:user@vodog.example.com:16801?transport=udp", "", true},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			got, err := configuredMediaTurnUDPURL(test.node, test.raw)
			if (err != nil) != test.wantError || got != test.want {
				t.Fatalf("got=%q err=%v", got, err)
			}
		})
	}
}

func TestBridgeICEUsesItsConfiguredNodeTURN(t *testing.T) {
	b := &bridge{turnSecret: "test-turn-secret", turnUDPURL: "turn:vodog.example.com:16801?transport=udp"}
	config := b.config()
	if len(config.ICEServers) != 1 || len(config.ICEServers[0].URLs) != 1 || config.ICEServers[0].URLs[0] != b.turnUDPURL {
		t.Fatalf("unexpected ICE config: %+v", config.ICEServers)
	}
	if config.ICETransportPolicy.String() != "relay" {
		t.Fatalf("policy=%s", config.ICETransportPolicy.String())
	}
}
