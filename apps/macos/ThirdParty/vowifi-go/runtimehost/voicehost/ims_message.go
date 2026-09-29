package voicehost

import "context"

type IMSMessageRequest struct {
	URI         string
	FromURI     string
	ToURI       string
	CallID      string
	CSeq        int
	ContentType string
	Body        []byte
	Headers     map[string][]string
}

type IMSMessageResult struct {
	StatusCode  int
	Reason      string
	ContentType string
	Body        []byte
	Headers     map[string]string
}

type IMSMessageHandler interface {
	HandleIMSMessage(context.Context, IMSMessageRequest) (IMSMessageResult, error)
}

type IMSMessageHandlerFunc func(context.Context, IMSMessageRequest) (IMSMessageResult, error)

func (f IMSMessageHandlerFunc) HandleIMSMessage(ctx context.Context, req IMSMessageRequest) (IMSMessageResult, error) {
	return f(ctx, req)
}

type IMSInfoRequest struct {
	URI         string
	FromURI     string
	ToURI       string
	CallID      string
	CSeq        int
	ContentType string
	InfoPackage string
	Body        []byte
	Headers     map[string][]string
}

type IMSInfoResult struct {
	Handled     bool
	StatusCode  int
	Reason      string
	ContentType string
	Body        []byte
	Headers     map[string]string
}

type IMSInfoHandler interface {
	HandleIMSInfo(context.Context, IMSInfoRequest) (IMSInfoResult, error)
}

type IMSInfoHandlerFunc func(context.Context, IMSInfoRequest) (IMSInfoResult, error)

func (f IMSInfoHandlerFunc) HandleIMSInfo(ctx context.Context, req IMSInfoRequest) (IMSInfoResult, error) {
	return f(ctx, req)
}

type IMSByeRequest struct {
	URI         string
	FromURI     string
	ToURI       string
	CallID      string
	CSeq        int
	ContentType string
	Body        []byte
	Headers     map[string][]string
}

type IMSByeResult struct {
	Handled     bool
	StatusCode  int
	Reason      string
	ContentType string
	Body        []byte
	Headers     map[string]string
}

type IMSByeHandler interface {
	HandleIMSBye(context.Context, IMSByeRequest) (IMSByeResult, error)
}

type IMSByeHandlerFunc func(context.Context, IMSByeRequest) (IMSByeResult, error)

func (f IMSByeHandlerFunc) HandleIMSBye(ctx context.Context, req IMSByeRequest) (IMSByeResult, error) {
	return f(ctx, req)
}
