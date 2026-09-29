package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/pion/rtp"
	"github.com/pion/webrtc/v4"
)

const browserProbePage = `<!doctype html><meta charset="utf-8"><body><pre id="result"></pre><script>
(async () => {
  const result = document.querySelector('#result');
  try {
    const pc = new RTCPeerConnection({iceServers: []});
    const audio = document.createElement('audio');
    audio.autoplay = true;
    audio.volume = 0.01;
    document.body.append(audio);
    pc.ontrack = async event => {
      audio.srcObject = event.streams[0] || new MediaStream([event.track]);
      await audio.play();
    };
    pc.addTransceiver('audio', {direction: 'recvonly'});
    await pc.setLocalDescription(await pc.createOffer());
    await new Promise(resolve => pc.iceGatheringState === 'complete' ? resolve() :
      pc.addEventListener('icegatheringstatechange', () => pc.iceGatheringState === 'complete' && resolve()));
    const offerSdp = pc.localDescription.sdp;
    const response = await fetch('/answer', {method: 'POST', headers: {'content-type':'application/json'},
      body: JSON.stringify(pc.localDescription)});
    if (!response.ok) throw new Error(await response.text());
    const answer = await response.json();
    await pc.setRemoteDescription(answer);
    await new Promise(resolve => setTimeout(resolve, 8500));
    const report = await pc.getStats();
    let inbound = null, codec = null;
    for (const stat of report.values()) {
      if (stat.type === 'inbound-rtp' && stat.kind === 'audio') inbound = stat;
    }
    if (inbound && inbound.codecId) codec = report.get(inbound.codecId);
    const pick = (object, keys) => Object.fromEntries(keys.filter(k => object && object[k] !== undefined).map(k => [k, object[k]]));
    result.textContent = JSON.stringify({
      offerSdp, answerSdp: answer.sdp,
      connectionState: pc.connectionState,
      audio: {paused: audio.paused, currentTime: audio.currentTime},
      codec: pick(codec, ['mimeType','clockRate','channels','sdpFmtpLine']),
      inbound: pick(inbound, ['packetsReceived','packetsLost','bytesReceived','jitter','jitterBufferDelay',
        'jitterBufferEmittedCount','concealedSamples','silentConcealedSamples','concealmentEvents',
        'insertedSamplesForDeceleration','removedSamplesForAcceleration','totalSamplesReceived',
        'totalSamplesDuration','totalAudioEnergy','audioLevel'])
    });
    pc.close();
  } catch (error) {
    result.textContent = JSON.stringify({error: String(error), stack: error && error.stack});
  } finally {
    document.body.dataset.done = 'true';
  }
})();
</script>`

type browserProbeResult struct {
	Error           string         `json:"error"`
	OfferSDP        string         `json:"offerSdp"`
	AnswerSDP       string         `json:"answerSdp"`
	ConnectionState string         `json:"connectionState"`
	Audio           map[string]any `json:"audio"`
	Codec           map[string]any `json:"codec"`
	Inbound         map[string]any `json:"inbound"`
}

type browserProbePacketEvidence struct {
	FixtureIndex int    `json:"fixtureIndex"`
	Sequence     uint16 `json:"sequence"`
	Timestamp    uint32 `json:"timestamp"`
	PayloadSHA   string `json:"payloadSha256"`
	Dropped      bool   `json:"dropped"`
}

type browserProbeEvidence struct {
	Profile       string                       `json:"profile"`
	FixturePath   string                       `json:"fixturePath"`
	FixtureSHA256 string                       `json:"fixtureSha256"`
	Packets       []browserProbePacketEvidence `json:"sourcePackets"`
	Browser       browserProbeResult           `json:"browser"`
}

type browserProbeSender struct {
	packets [][]byte
	drop10  bool
	mu      sync.Mutex
	pc      *webrtc.PeerConnection
}

func (s *browserProbeSender) close() {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.pc != nil {
		_ = s.pc.Close()
	}
}

func (s *browserProbeSender) handler(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodGet && r.URL.Path == "/" {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		_, _ = w.Write([]byte(browserProbePage))
		return
	}
	if r.Method != http.MethodPost || r.URL.Path != "/answer" {
		http.NotFound(w, r)
		return
	}
	var offer webrtc.SessionDescription
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20)).Decode(&offer); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	pc, err := webrtc.NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	track, err := webrtc.NewTrackLocalStaticRTP(webrtc.RTPCodecCapability{
		MimeType: webrtc.MimeTypeOpus, ClockRate: 48000, Channels: 2,
		SDPFmtpLine: "minptime=10;useinbandfec=1;stereo=0;sprop-stereo=0",
	}, "cellular", "browser-fec-probe")
	if err == nil {
		_, err = pc.AddTrack(track)
	}
	if err == nil {
		err = pc.SetRemoteDescription(offer)
	}
	if err != nil {
		_ = pc.Close()
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	answer, err := pc.CreateAnswer(nil)
	if err == nil {
		gather := webrtc.GatheringCompletePromise(pc)
		err = pc.SetLocalDescription(answer)
		if err == nil {
			select {
			case <-gather:
			case <-time.After(5 * time.Second):
				err = errors.New("ICE gathering timeout")
			}
		}
	}
	if err != nil {
		_ = pc.Close()
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	s.mu.Lock()
	s.pc = pc
	s.mu.Unlock()
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(pc.LocalDescription())
	go s.stream(pc, track)
}

func (s *browserProbeSender) stream(pc *webrtc.PeerConnection, track *webrtc.TrackLocalStaticRTP) {
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) && pc.ConnectionState() != webrtc.PeerConnectionStateConnected {
		time.Sleep(10 * time.Millisecond)
	}
	ticker := time.NewTicker(20 * time.Millisecond)
	defer ticker.Stop()
	const packetCount = 350
	for i := 0; i < packetCount; i++ {
		seq := uint16(1000 + i)
		timestamp := uint32(48000 + i*960)
		// Fixed isolated loss: the following packet retains its original sequence
		// and timestamp so Chromium observes a real one-packet RTP gap.
		if !s.drop10 || (i+1)%10 != 0 {
			_ = track.WriteRTP(&rtp.Packet{Header: rtp.Header{Version: 2, PayloadType: 111,
				SequenceNumber: seq, Timestamp: timestamp, SSRC: 0xCCFEC001}, Payload: s.packets[i%len(s.packets)]})
		}
		<-ticker.C
	}
}

func TestChromiumOpusDecodeProfiles(t *testing.T) {
	if os.Getenv("CC_BROWSER_FEC_PROBE") != "1" {
		t.Skip("run infra/probe-browser-opus-fec.sh for the bounded local Chromium probe")
	}
	fixture := os.Getenv("CC_BROWSER_FEC_OPUS_FIXTURE")
	packets, err := loadBrowserProbePackets(fixture)
	if err != nil {
		t.Fatal(err)
	}
	fixtureRaw, err := os.ReadFile(fixture)
	if err != nil {
		t.Fatal(err)
	}
	fixtureDigest := sha256.Sum256(fixtureRaw)
	fixtureSHA := hex.EncodeToString(fixtureDigest[:])
	profiles := []struct {
		name   string
		drop10 bool
	}{{"none", false}, {"isolated10", true}}
	results := make(map[string]browserProbeResult, len(profiles))
	evidence := make([]browserProbeEvidence, 0, len(profiles))
	for _, profile := range profiles {
		profile := profile
		t.Run(profile.name, func(t *testing.T) {
			sender := &browserProbeSender{packets: packets, drop10: profile.drop10}
			server := httptest.NewServer(http.HandlerFunc(sender.handler))
			defer server.Close()
			defer sender.close()
			ctx, cancel := context.WithTimeout(context.Background(), 18*time.Second)
			defer cancel()
			_, here, _, _ := runtime.Caller(0)
			script := filepath.Join(filepath.Dir(here), "..", "..", "infra", "probe-browser-opus-fec.mjs")
			cmd := exec.CommandContext(ctx, "node", script, server.URL)
			output, runErr := cmd.CombinedOutput()
			if runErr != nil {
				t.Fatalf("Chromium runner: %v: %s", runErr, output)
			}
			var got browserProbeResult
			if err := json.Unmarshal(output, &got); err != nil {
				t.Fatalf("invalid Chromium result: %v: %s", err, output)
			}
			if got.Error != "" {
				t.Fatal(got.Error)
			}
			assertBrowserDecodedOpus(t, got)
			results[profile.name] = got
			evidence = append(evidence, browserProbeEvidence{
				Profile:       profile.name,
				FixturePath:   fixture,
				FixtureSHA256: fixtureSHA,
				Packets:       browserProbePacketManifest(packets, profile.drop10),
				Browser:       got,
			})
			t.Logf("Chromium %s codec=%v inbound=%v audio=%v", profile.name, got.Codec, got.Inbound, got.Audio)
		})
	}
	if !t.Failed() {
		base := results["none"].Inbound
		loss := results["isolated10"].Inbound
		if statNumber(loss, "packetsLost") < 20 {
			t.Errorf("isolated10 did not register controlled RTP loss: %v", loss)
		}
		if statNumber(loss, "concealedSamples") == statNumber(base, "concealedSamples") &&
			statNumber(loss, "concealmentEvents") == statNumber(base, "concealmentEvents") {
			t.Errorf("isolated loss did not change Chromium concealment sample: none=%v isolated10=%v", base, loss)
		}
	}
	if path := os.Getenv("CC_BROWSER_FEC_EVIDENCE_JSON"); path != "" {
		encoded, err := json.MarshalIndent(evidence, "", "  ")
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, append(encoded, '\n'), 0600); err != nil {
			t.Fatal(err)
		}
		t.Logf("browser FEC evidence JSON: %s", path)
	}
}

func browserProbePacketManifest(packets [][]byte, drop10 bool) []browserProbePacketEvidence {
	const packetCount = 350
	evidence := make([]browserProbePacketEvidence, 0, packetCount)
	for i := 0; i < packetCount; i++ {
		digest := sha256.Sum256(packets[i%len(packets)])
		evidence = append(evidence, browserProbePacketEvidence{
			FixtureIndex: i % len(packets),
			Sequence:     uint16(1000 + i),
			Timestamp:    uint32(48000 + i*960),
			PayloadSHA:   hex.EncodeToString(digest[:]),
			Dropped:      drop10 && (i+1)%10 == 0,
		})
	}
	return evidence
}

func assertBrowserDecodedOpus(t *testing.T, got browserProbeResult) {
	t.Helper()
	for side, sdp := range map[string]string{"offer": got.OfferSDP, "answer": got.AnswerSDP} {
		if !strings.Contains(strings.ToLower(sdp), "useinbandfec=1") {
			t.Errorf("%s SDP did not negotiate Opus in-band FEC", side)
		}
	}
	if !strings.EqualFold(fmt.Sprint(got.Codec["mimeType"]), "audio/opus") {
		t.Errorf("Chromium selected non-Opus codec: %v", got.Codec)
	}
	if statNumber(got.Inbound, "packetsReceived") < 200 || statNumber(got.Inbound, "totalSamplesReceived") < 48000 || statNumber(got.Inbound, "totalAudioEnergy") <= 0 {
		t.Errorf("Chromium did not prove decoded non-silent Opus samples: %v", got.Inbound)
	}
	if got.ConnectionState != "connected" {
		t.Errorf("Chromium peer state=%q", got.ConnectionState)
	}
}

func statNumber(stats map[string]any, name string) float64 {
	value, _ := stats[name].(float64)
	return value
}

func loadBrowserProbePackets(path string) ([][]byte, error) {
	if path == "" {
		return nil, errors.New("CC_BROWSER_FEC_OPUS_FIXTURE is required")
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	if bytes.HasPrefix(raw, []byte("OggS")) {
		packets, _, err := loadOpusFixturePackets([]string{path})
		return packets, err
	}
	packets := make([][]byte, 0, 256)
	for offset := 0; offset < len(raw); {
		if offset+4 > len(raw) {
			return nil, errors.New("truncated Opus packet length")
		}
		size := int(binary.BigEndian.Uint32(raw[offset : offset+4]))
		offset += 4
		if size < 1 || size > 1024 || offset+size > len(raw) {
			return nil, fmt.Errorf("invalid Opus packet length %d", size)
		}
		packet := append([]byte(nil), raw[offset:offset+size]...)
		offset += size
		duration, durationErr := opusDurationMS(packet)
		if durationErr != nil || duration != 20 {
			return nil, fmt.Errorf("fixture packet %d is not 20ms Opus: duration=%d err=%v", len(packets), duration, durationErr)
		}
		packets = append(packets, packet)
	}
	if len(packets) < 100 {
		return nil, fmt.Errorf("need at least 100 Opus packets, got %d", len(packets))
	}
	return packets, nil
}

// S70: Chromium as the RTP sender. The page sends a synthetic voiced signal; the
// Go side answers through newMediaPeerConnection with the RR loss floor, so the
// only difference between the runs is the FractionLost Chromium reads.
const browserSendProbePage = `<!doctype html><meta charset="utf-8"><body><pre id="result"></pre><script>
(async () => {
  const result = document.querySelector('#result');
  try {
    const ctx = new AudioContext({sampleRate: 48000});
    await ctx.resume();
    const dest = ctx.createMediaStreamDestination();
    // Real speech when the Go side serves a fixture: decoded with WebCodecs, looped.
    const fixture = await (await fetch('/fixture')).json();
    if (fixture && fixture.length) {
      const chunks = [];
      const decoder = new AudioDecoder({error: e => { throw e; }, output: data => {
        const pcm = new Float32Array(data.numberOfFrames);
        data.copyTo(pcm, {planeIndex: 0, format: 'f32-planar'});
        chunks.push(pcm); data.close();
      }});
      decoder.configure({codec: 'opus', sampleRate: 48000, numberOfChannels: 1});
      fixture.forEach((b64, i) => decoder.decode(new EncodedAudioChunk({type: 'key', timestamp: i * 20000,
        data: Uint8Array.from(atob(b64), c => c.charCodeAt(0))})));
      await decoder.flush();
      const total = chunks.reduce((n, c) => n + c.length, 0);
      const buffer = ctx.createBuffer(1, total, 48000);
      let offset = 0;
      for (const c of chunks) { buffer.copyToChannel(c, 0, offset); offset += c.length; }
      const speech = ctx.createBufferSource(); speech.buffer = buffer; speech.loop = true;
      speech.connect(dest); speech.start();
    } else {
    // Glottal-like pulse train through formants, gated into syllables, plus breath
    // noise. Chromium's Opus still classifies it as music (CELT, no LBRR).
    const voice = ctx.createOscillator(); voice.type = 'sawtooth'; voice.frequency.value = 120;
    const vibrato = ctx.createOscillator(); vibrato.frequency.value = 5;
    const vibratoDepth = ctx.createGain(); vibratoDepth.gain.value = 15;
    vibrato.connect(vibratoDepth).connect(voice.frequency);
    const noise = ctx.createBufferSource();
    const noiseBuffer = ctx.createBuffer(1, 48000, 48000);
    const samples = noiseBuffer.getChannelData(0);
    for (let i = 0; i < samples.length; i++) samples[i] = (Math.random() * 2 - 1) * 0.05;
    noise.buffer = noiseBuffer; noise.loop = true;
    const syllables = ctx.createGain(); syllables.gain.value = 0;
    for (const [frequency, q] of [[700, 5], [1200, 6], [2600, 8]]) {
      const formant = ctx.createBiquadFilter(); formant.type = 'bandpass';
      formant.frequency.value = frequency; formant.Q.value = q;
      voice.connect(formant); noise.connect(formant); formant.connect(syllables);
    }
    syllables.connect(dest);
    const now = ctx.currentTime;
    for (let t = 0; t < 20; t += 0.25) {
      syllables.gain.setValueAtTime(0, now + t);
      syllables.gain.linearRampToValueAtTime(1.5, now + t + 0.04);
      syllables.gain.setValueAtTime(1.5, now + t + 0.16);
      syllables.gain.linearRampToValueAtTime(0, now + t + 0.2);
    }
    voice.start(); vibrato.start(); noise.start();
    }
    const pc = new RTCPeerConnection({iceServers: []});
    pc.addTransceiver(dest.stream.getAudioTracks()[0], {direction: 'sendonly', streams: [dest.stream]});
    // The S70 client fmtp line; pion echoes it, so Chromium's encoder is capped at wideband.
    const offer = await pc.createOffer();
    const opusPt = (offer.sdp.match(/a=rtpmap:(\d+) opus\/48000\/2/i) || [])[1];
    if (!opusPt) throw new Error('no Opus in offer');
    offer.sdp = offer.sdp.replace(new RegExp('a=fmtp:' + opusPt + ' [^\\r\\n]*'),
      'a=fmtp:' + opusPt + ' minptime=10;useinbandfec=1;stereo=0;sprop-stereo=0;maxaveragebitrate=32000;maxplaybackrate=16000;sprop-maxcapturerate=16000');
    await pc.setLocalDescription(offer);
    await new Promise(resolve => pc.iceGatheringState === 'complete' ? resolve() :
      pc.addEventListener('icegatheringstatechange', () => pc.iceGatheringState === 'complete' && resolve()));
    const response = await fetch('/answer', {method: 'POST', headers: {'content-type':'application/json'},
      body: JSON.stringify(pc.localDescription)});
    if (!response.ok) throw new Error(await response.text());
    await pc.setRemoteDescription(await response.json());
    await new Promise(resolve => setTimeout(resolve, 12000));
    const report = await pc.getStats();
    let outbound = null, remoteInbound = null;
    for (const stat of report.values()) {
      if (stat.type === 'outbound-rtp' && stat.kind === 'audio') outbound = stat;
      if (stat.type === 'remote-inbound-rtp' && stat.kind === 'audio') remoteInbound = stat;
    }
    const pick = (object, keys) => Object.fromEntries(keys.filter(k => object && object[k] !== undefined).map(k => [k, object[k]]));
    result.textContent = JSON.stringify({connectionState: pc.connectionState,
      outbound: pick(outbound, ['packetsSent','bytesSent','targetBitrate']),
      remoteInbound: pick(remoteInbound, ['fractionLost','packetsLost'])});
    pc.close();
  } catch (error) {
    result.textContent = JSON.stringify({error: String(error), stack: error && error.stack});
  } finally {
    document.body.dataset.done = 'true';
  }
})();
</script>`

type browserSendProbeResult struct {
	Error           string         `json:"error"`
	ConnectionState string         `json:"connectionState"`
	Outbound        map[string]any `json:"outbound"`
	RemoteInbound   map[string]any `json:"remoteInbound"`
}

// browserSendProbeReceiver counts Opus payload bytes after a warm-up, so the
// average reflects the encoder after it has read a few RRs.
type browserSendProbeReceiver struct {
	floor               uint8
	fixture             [][]byte
	mu                  sync.Mutex
	pc                  *webrtc.PeerConnection
	started             time.Time
	packets, bytes, lbr uint64
	modes               [3]uint64 // SILK, hybrid, CELT (Opus TOC config)
	configs             map[byte]uint64
}

const browserSendProbeWarmup = 4 * time.Second

func (s *browserSendProbeReceiver) handler(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodGet && r.URL.Path == "/" {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		_, _ = w.Write([]byte(browserSendProbePage))
		return
	}
	if r.Method == http.MethodGet && r.URL.Path == "/fixture" {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(s.fixture) // [][]byte encodes as base64 strings
		return
	}
	if r.Method != http.MethodPost || r.URL.Path != "/answer" {
		http.NotFound(w, r)
		return
	}
	var offer webrtc.SessionDescription
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20)).Decode(&offer); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	pc, err := newMediaPeerConnection(sctpTuning{}, s.floor, webrtc.Configuration{})
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	pc.OnTrack(func(track *webrtc.TrackRemote, _ *webrtc.RTPReceiver) {
		for {
			packet, _, err := track.ReadRTP()
			if err != nil {
				return
			}
			s.mu.Lock()
			if s.started.IsZero() {
				s.started = time.Now()
			}
			if time.Since(s.started) >= browserSendProbeWarmup && len(packet.Payload) > 1 {
				s.packets++
				s.bytes += uint64(len(packet.Payload))
				if s.configs == nil {
					s.configs = map[byte]uint64{}
				}
				s.configs[packet.Payload[0]>>3]++
				switch config := packet.Payload[0] >> 3; {
				case config < 12:
					s.modes[0]++
				case config < 16:
					s.modes[1]++
				default:
					s.modes[2]++
				}
				// Code-0 SILK/hybrid 20 ms: VAD bit then LBRR bit at the top of byte 1.
				if toc := packet.Payload[0]; toc>>3 < 16 && toc&3 == 0 && packet.Payload[1]&0x40 != 0 {
					s.lbr++
				}
			}
			s.mu.Unlock()
		}
	})
	err = pc.SetRemoteDescription(offer)
	var answer webrtc.SessionDescription
	if err == nil {
		answer, err = pc.CreateAnswer(nil)
	}
	if err == nil {
		gather := webrtc.GatheringCompletePromise(pc)
		if err = pc.SetLocalDescription(answer); err == nil {
			<-gather
		}
	}
	if err != nil {
		_ = pc.Close()
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	s.mu.Lock()
	s.pc = pc
	s.mu.Unlock()
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(pc.LocalDescription())
}

func TestChromiumOutboundOpusBytesWithLossFloor(t *testing.T) {
	if os.Getenv("CC_BROWSER_FEC_PROBE") != "1" {
		t.Skip("set CC_BROWSER_FEC_PROBE=1 (Chrome + playwright, see infra/probe-browser-opus-fec.sh) for the S70 loss-floor probe")
	}
	// With CC_BROWSER_FEC_OPUS_FIXTURE (speech) Chromium encodes SILK/hybrid and
	// LBRR is observable; the synthetic fallback only exercises the plumbing.
	var fixture [][]byte
	if path := os.Getenv("CC_BROWSER_FEC_OPUS_FIXTURE"); path != "" {
		var err error
		if fixture, err = loadBrowserProbePackets(path); err != nil {
			t.Fatal(err)
		}
	}
	average := map[uint8]float64{}
	for _, floor := range []uint8{0, 5} {
		receiver := &browserSendProbeReceiver{floor: floor, fixture: fixture}
		server := httptest.NewServer(http.HandlerFunc(receiver.handler))
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		_, here, _, _ := runtime.Caller(0)
		script := filepath.Join(filepath.Dir(here), "..", "..", "infra", "probe-browser-opus-fec.mjs")
		output, runErr := exec.CommandContext(ctx, "node", script, server.URL).CombinedOutput()
		cancel()
		server.Close()
		receiver.mu.Lock()
		if receiver.pc != nil {
			_ = receiver.pc.Close()
		}
		packets, payloadBytes, lbrr, modes, configs := receiver.packets, receiver.bytes, receiver.lbr, receiver.modes, receiver.configs
		receiver.mu.Unlock()
		if runErr != nil {
			t.Fatalf("floor %d: Chromium runner: %v: %s", floor, runErr, output)
		}
		var got browserSendProbeResult
		if err := json.Unmarshal(output, &got); err != nil || got.Error != "" || got.ConnectionState != "connected" {
			t.Fatalf("floor %d: Chromium result %v: %s", floor, err, output)
		}
		if packets < 200 {
			t.Fatalf("floor %d: only %d packets after warm-up", floor, packets)
		}
		average[floor] = float64(payloadBytes) / float64(packets)
		t.Logf("floor=%d%% packets=%d avgPayloadBytes=%.1f lbrrPackets=%d (%.0f%%) silk/hybrid/celt=%v tocConfigs=%v outbound=%v remoteInbound=%v", floor, packets, average[floor], lbrr, 100*float64(lbrr)/float64(packets), modes, configs, got.Outbound, got.RemoteInbound)
	}
	if average[5] <= average[0] {
		t.Errorf("floor 5%% did not raise Chromium's average Opus payload: floor0=%.1f floor5=%.1f", average[0], average[5])
	}
}
