package ikev2

import (
	"context"
	"errors"
	"fmt"
	"io"
)

var ErrInvalidInformational = errors.New("invalid ikev2 informational exchange")

type InformationalConfig struct {
	Transport     InitTransport
	Init          InitResult
	Keys          IKEKeys
	MessageID     uint32
	FromResponder bool
	Payloads      []Payload
	Random        io.Reader
	IV            []byte
}

type InformationalResult struct {
	RequestBytes  []byte
	ResponseBytes []byte
	ResponseInner []Payload
	Response      InformationalContent
	NextMessageID uint32
}

type InformationalContent struct {
	Payloads      []Payload
	Notifies      []Notify
	NotifyActions []NotifyAction
	Deletes       []Delete
	NotifyError   error
}

func RunInformationalExchange(ctx context.Context, cfg InformationalConfig) (InformationalResult, error) {
	if cfg.Transport == nil {
		return InformationalResult{}, fmt.Errorf("%w: transport is nil", ErrInvalidInformational)
	}
	keys := cfg.Keys
	if keys.Profile.RequiredLength() == 0 {
		keys = cfg.Init.Keys
	}
	if err := validateKeySet(keys); err != nil {
		return InformationalResult{}, err
	}
	if cfg.Init.InitiatorSPI == 0 || cfg.Init.ResponderSPI == 0 {
		return InformationalResult{}, fmt.Errorf("%w: missing IKE SPIs", ErrInvalidInformational)
	}
	iv, err := informationalIV(cfg.Random, keys.Profile, cfg.IV)
	if err != nil {
		return InformationalResult{}, err
	}
	requestFromInitiator := !cfg.FromResponder
	_, reqBytes, err := BuildInformationalRequestFrom(cfg.Init, keys, cfg.MessageID, requestFromInitiator, cfg.Payloads, iv)
	if err != nil {
		return InformationalResult{}, err
	}
	respBytes, err := cfg.Transport.ExchangeIKE(ctx, reqBytes)
	if err != nil {
		return InformationalResult{}, err
	}
	_, response, err := ParseInformationalResponseContentFrom(respBytes, cfg.Init, keys, cfg.MessageID, !requestFromInitiator)
	if err != nil {
		return InformationalResult{}, err
	}
	return InformationalResult{
		RequestBytes:  append([]byte(nil), reqBytes...),
		ResponseBytes: append([]byte(nil), respBytes...),
		ResponseInner: clonePayloads(response.Payloads),
		Response:      cloneInformationalContent(response),
		NextMessageID: cfg.MessageID + 1,
	}, nil
}

func RunLivenessCheck(ctx context.Context, cfg InformationalConfig) (InformationalResult, error) {
	cfg.Payloads = nil
	return RunInformationalExchange(ctx, cfg)
}

func BuildInformationalRequest(init InitResult, keys IKEKeys, messageID uint32, inner []Payload, iv []byte) (Message, []byte, error) {
	return BuildInformationalRequestFrom(init, keys, messageID, true, inner, iv)
}

func BuildInformationalResponse(init InitResult, keys IKEKeys, messageID uint32, inner []Payload, iv []byte) (Message, []byte, error) {
	return BuildInformationalResponseFrom(init, keys, messageID, false, inner, iv)
}

func BuildInformationalRequestFrom(init InitResult, keys IKEKeys, messageID uint32, fromInitiator bool, inner []Payload, iv []byte) (Message, []byte, error) {
	return ProtectMessage(informationalHeader(init, messageID, fromInitiator, false), keys, fromInitiator, inner, iv)
}

func BuildInformationalResponseFrom(init InitResult, keys IKEKeys, messageID uint32, fromInitiator bool, inner []Payload, iv []byte) (Message, []byte, error) {
	return ProtectMessage(informationalHeader(init, messageID, fromInitiator, true), keys, fromInitiator, inner, iv)
}

func ParseInformationalRequest(raw []byte, init InitResult, keys IKEKeys, messageID uint32) (Message, []Payload, error) {
	return ParseInformationalRequestFrom(raw, init, keys, messageID, true)
}

func ParseInformationalResponse(raw []byte, init InitResult, keys IKEKeys, messageID uint32) (Message, []Payload, error) {
	return ParseInformationalResponseFrom(raw, init, keys, messageID, false)
}

func ParseInformationalRequestFrom(raw []byte, init InitResult, keys IKEKeys, messageID uint32, fromInitiator bool) (Message, []Payload, error) {
	msg, content, err := ParseInformationalRequestContentFrom(raw, init, keys, messageID, fromInitiator)
	if err != nil {
		return Message{}, nil, err
	}
	return msg, content.Payloads, nil
}

func ParseInformationalResponseFrom(raw []byte, init InitResult, keys IKEKeys, messageID uint32, fromInitiator bool) (Message, []Payload, error) {
	msg, content, err := ParseInformationalResponseContentFrom(raw, init, keys, messageID, fromInitiator)
	if err != nil {
		return Message{}, nil, err
	}
	return msg, content.Payloads, nil
}

func ParseInformationalRequestContent(raw []byte, init InitResult, keys IKEKeys, messageID uint32) (Message, InformationalContent, error) {
	return ParseInformationalRequestContentFrom(raw, init, keys, messageID, true)
}

func ParseInformationalResponseContent(raw []byte, init InitResult, keys IKEKeys, messageID uint32) (Message, InformationalContent, error) {
	return ParseInformationalResponseContentFrom(raw, init, keys, messageID, false)
}

func ParseInformationalRequestContentFrom(raw []byte, init InitResult, keys IKEKeys, messageID uint32, fromInitiator bool) (Message, InformationalContent, error) {
	msg, inner, err := UnprotectMessage(raw, keys, fromInitiator)
	if err != nil {
		return Message{}, InformationalContent{}, err
	}
	if err := validateInformationalHeader(msg.Header, init, messageID, fromInitiator, false); err != nil {
		return Message{}, InformationalContent{}, err
	}
	content, err := ParseInformationalContent(inner)
	if err != nil {
		return Message{}, InformationalContent{}, err
	}
	return msg, content, nil
}

func ParseInformationalResponseContentFrom(raw []byte, init InitResult, keys IKEKeys, messageID uint32, fromInitiator bool) (Message, InformationalContent, error) {
	msg, inner, err := UnprotectMessage(raw, keys, fromInitiator)
	if err != nil {
		return Message{}, InformationalContent{}, err
	}
	if err := validateInformationalHeader(msg.Header, init, messageID, fromInitiator, true); err != nil {
		return Message{}, InformationalContent{}, err
	}
	content, err := ParseInformationalContent(inner)
	if err != nil {
		return Message{}, InformationalContent{}, err
	}
	return msg, content, nil
}

func ParseInformationalContent(payloads []Payload) (InformationalContent, error) {
	content := InformationalContent{Payloads: clonePayloads(payloads)}
	for _, payload := range payloads {
		switch payload.Type {
		case PayloadNotify:
			notify, err := ParseNotify(payload.Body)
			if err != nil {
				return InformationalContent{}, fmt.Errorf("%w: %w", ErrInvalidInformational, err)
			}
			content.Notifies = append(content.Notifies, cloneNotify(notify))
			if action := ClassifyNotifyAction(notify); action.Kind != NotifyActionNone {
				content.NotifyActions = append(content.NotifyActions, action)
			}
			if content.NotifyError == nil {
				content.NotifyError = NotifyErrorFor(notify)
			}
		case PayloadDelete:
			deletePayload, err := ParseDelete(payload.Body)
			if err != nil {
				return InformationalContent{}, fmt.Errorf("%w: %w", ErrInvalidInformational, err)
			}
			content.Deletes = append(content.Deletes, cloneDelete(deletePayload))
		}
	}
	return content, nil
}

func informationalHeader(init InitResult, messageID uint32, fromInitiator bool, response bool) Header {
	flags := uint8(0)
	if fromInitiator {
		flags |= FlagInitiator
	}
	if response {
		flags |= FlagResponse
	}
	return Header{
		InitiatorSPI: init.InitiatorSPI,
		ResponderSPI: init.ResponderSPI,
		ExchangeType: ExchangeINFORMATIONAL,
		Flags:        flags,
		MessageID:    messageID,
	}
}

func validateInformationalHeader(h Header, init InitResult, messageID uint32, fromInitiator bool, response bool) error {
	if h.InitiatorSPI != init.InitiatorSPI || h.ResponderSPI != init.ResponderSPI ||
		h.ExchangeType != ExchangeINFORMATIONAL || h.MessageID != messageID {
		return fmt.Errorf("%w: unexpected header", ErrInvalidInformational)
	}
	expectedFlags := uint8(0)
	if fromInitiator {
		expectedFlags |= FlagInitiator
	}
	if response {
		expectedFlags |= FlagResponse
	}
	if h.Flags&(FlagInitiator|FlagResponse) != expectedFlags {
		return fmt.Errorf("%w: unexpected flags", ErrInvalidInformational)
	}
	return nil
}

func informationalIV(random io.Reader, profile KeyMaterialProfile, override []byte) ([]byte, error) {
	if len(override) > 0 {
		if len(override) != profile.EncryptionBlockSize {
			return nil, fmt.Errorf("%w: IV length %d != %d", ErrInvalidInformational, len(override), profile.EncryptionBlockSize)
		}
		return append([]byte(nil), override...), nil
	}
	return RandomIV(random, profile)
}

func cloneInformationalContent(in InformationalContent) InformationalContent {
	return InformationalContent{
		Payloads:      clonePayloads(in.Payloads),
		Notifies:      cloneNotifies(in.Notifies),
		NotifyActions: cloneNotifyActions(in.NotifyActions),
		Deletes:       cloneDeletes(in.Deletes),
		NotifyError:   cloneNotifyError(in.NotifyError),
	}
}

func cloneNotifies(in []Notify) []Notify {
	out := make([]Notify, len(in))
	for i, notify := range in {
		out[i] = cloneNotify(notify)
	}
	return out
}

func cloneNotifyActions(in []NotifyAction) []NotifyAction {
	out := make([]NotifyAction, len(in))
	for i, action := range in {
		out[i] = cloneNotifyAction(action)
	}
	return out
}

func cloneNotifyAction(in NotifyAction) NotifyAction {
	in.Notify = cloneNotify(in.Notify)
	return in
}

func cloneDeletes(in []Delete) []Delete {
	out := make([]Delete, len(in))
	for i, deletePayload := range in {
		out[i] = cloneDelete(deletePayload)
	}
	return out
}

func cloneDelete(in Delete) Delete {
	return Delete{
		ProtocolID: in.ProtocolID,
		SPIs:       cloneByteSlices(in.SPIs),
	}
}

func cloneNotifyError(err error) error {
	if err == nil {
		return nil
	}
	var notifyErr *NotifyError
	if errors.As(err, &notifyErr) {
		return NotifyErrorFor(notifyErr.Notify)
	}
	return err
}
