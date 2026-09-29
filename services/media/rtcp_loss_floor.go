package main

import (
	"errors"
	"strconv"

	"github.com/pion/interceptor"
	"github.com/pion/logging"
	"github.com/pion/rtcp"
	"github.com/pion/webrtc/v4"
)

// S70: the RTP senders (Web/iOS/Android/Voice) only see the loss of their own
// leg to the bridge, never the DataChannel leg to the gateway, so their Opus
// encoders never write LBRR. A loss floor in the bridge's outbound RR/SR report
// blocks makes them do so. 10% and above is refused: libwebrtc's sender bandwidth
// estimate lowers the bitrate at >=10% loss.
func configuredRRLossFloorPct(raw string) (uint8, error) {
	if raw == "" {
		return 0, nil
	}
	value, err := strconv.Atoi(raw)
	if err != nil || value < 0 || value > 9 {
		return 0, errors.New("CC_MEDIA_RR_LOSS_FLOOR_PCT must be unset or an integer 0-9")
	}
	return uint8(value), nil
}

// configuredTestDropEveryN is the S70 acceptance knob. 1 would drop every packet,
// so only 0 (off) and 2 or more are accepted.
func configuredTestDropEveryN(raw string) (uint64, error) {
	if raw == "" {
		return 0, nil
	}
	value, err := strconv.ParseUint(raw, 10, 32)
	if err != nil || value == 1 {
		return 0, errors.New("CC_MEDIA_TEST_DROP_EVERY_N must be unset, 0 or an integer >= 2")
	}
	return value, nil
}

// lossFloorFraction is the RTCP 8-bit fraction for a percentage (5% -> 12).
func lossFloorFraction(pct uint8) uint8 { return uint8(uint16(pct) * 256 / 100) }

// newMediaPeerConnection keeps the bare sctpTuning path (and so today's exact
// behaviour) when the floor is 0. Otherwise it rebuilds what webrtc.NewAPI does
// by default (default codecs, default interceptors with the setting engine's
// logger) with the floor added first in the chain: Chain.BindRTCPWriter hands
// each interceptor the writer wrapped by the ones before it, so only a writer
// registered ahead of the report interceptor sees its RR/SR.
func newMediaPeerConnection(tuning sctpTuning, lossFloorPct uint8, configuration webrtc.Configuration) (*webrtc.PeerConnection, error) {
	if lossFloorPct == 0 {
		return tuning.newPeerConnection(configuration)
	}
	engine := tuning.settingEngine()
	engine.LoggerFactory = logging.NewDefaultLoggerFactory()
	media := &webrtc.MediaEngine{}
	if err := media.RegisterDefaultCodecs(); err != nil {
		return nil, err
	}
	registry := &interceptor.Registry{}
	registry.Add(rtcpLossFloorFactory{fraction: lossFloorFraction(lossFloorPct)})
	if err := webrtc.RegisterDefaultInterceptorsWithOptions(media, registry, webrtc.WithInterceptorLoggerFactory(engine.LoggerFactory)); err != nil {
		return nil, err
	}
	return webrtc.NewAPI(webrtc.WithSettingEngine(engine), webrtc.WithMediaEngine(media), webrtc.WithInterceptorRegistry(registry)).NewPeerConnection(configuration)
}

type rtcpLossFloorFactory struct{ fraction uint8 }

func (f rtcpLossFloorFactory) NewInterceptor(string) (interceptor.Interceptor, error) {
	return &rtcpLossFloor{fraction: f.fraction}, nil
}

type rtcpLossFloor struct {
	interceptor.NoOp
	fraction uint8
}

func (i *rtcpLossFloor) BindRTCPWriter(writer interceptor.RTCPWriter) interceptor.RTCPWriter {
	return interceptor.RTCPWriterFunc(func(pkts []rtcp.Packet, attributes interceptor.Attributes) (int, error) {
		raiseFractionLost(pkts, i.fraction)
		return writer.Write(pkts, attributes)
	})
}

// raiseFractionLost sets every report block's FractionLost to max(actual, floor).
// The packets are built fresh by the report interceptor for each write.
func raiseFractionLost(pkts []rtcp.Packet, floor uint8) {
	for _, packet := range pkts {
		var reports []rtcp.ReceptionReport
		switch p := packet.(type) {
		case *rtcp.ReceiverReport:
			reports = p.Reports
		case *rtcp.SenderReport:
			reports = p.Reports
		case *rtcp.CompoundPacket:
			raiseFractionLost(*p, floor)
		}
		for index := range reports {
			if reports[index].FractionLost < floor {
				reports[index].FractionLost = floor
			}
		}
	}
}
