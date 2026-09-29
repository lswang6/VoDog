package voiceclient

import (
	"testing"
	"time"
)

func TestAdvanceSIPClientTransactionInviteResponseFlow(t *testing.T) {
	cfg := SIPTransactionTimerConfig{
		T1: 100 * time.Millisecond,
		T2: 400 * time.Millisecond,
		T4: 900 * time.Millisecond,
	}
	provisional := AdvanceSIPClientTransaction(SIPClientTransactionInput{
		Method: "invite",
		Event:  SIPClientTransactionEventResponse,
		Response: SIPResponse{
			StatusCode: 183,
			Reason:     "Session Progress",
		},
		TimerConfig: cfg,
	})
	if provisional.Method != "INVITE" ||
		!provisional.Invite ||
		provisional.State != SIPClientTransactionStateCalling ||
		provisional.NextState != SIPClientTransactionStateProceeding ||
		provisional.Action != SIPClientTransactionActionDeliverProvisional ||
		!provisional.DeliverResponse ||
		!provisional.Provisional ||
		provisional.Final ||
		provisional.RetransmitRequest {
		t.Fatalf("INVITE provisional step=%+v", provisional)
	}

	success := AdvanceSIPClientTransaction(SIPClientTransactionInput{
		Method:      "INVITE",
		State:       SIPClientTransactionStateProceeding,
		Event:       SIPClientTransactionEventResponse,
		Response:    SIPResponse{StatusCode: 200, Reason: "OK"},
		TimerConfig: cfg,
	})
	if success.NextState != SIPClientTransactionStateTerminated ||
		success.Action != SIPClientTransactionActionDeliverFinal ||
		!success.DeliverResponse ||
		!success.Success ||
		!success.Final ||
		!success.Terminated ||
		success.SendAck ||
		success.CleanupAfter != 0 {
		t.Fatalf("INVITE 2xx step=%+v", success)
	}

	failure := AdvanceSIPClientTransaction(SIPClientTransactionInput{
		Method:      "INVITE",
		State:       SIPClientTransactionStateProceeding,
		Event:       SIPClientTransactionEventResponse,
		Response:    SIPResponse{StatusCode: 486, Reason: "Busy Here"},
		TimerConfig: cfg,
	})
	if failure.NextState != SIPClientTransactionStateCompleted ||
		failure.Action != SIPClientTransactionActionDeliverFinal ||
		!failure.DeliverResponse ||
		!failure.Failure ||
		!failure.SendAck ||
		failure.CleanupAfter != 6400*time.Millisecond ||
		failure.Terminated {
		t.Fatalf("INVITE failure step=%+v", failure)
	}

	duplicateFailure := AdvanceSIPClientTransaction(SIPClientTransactionInput{
		Method:      "INVITE",
		State:       SIPClientTransactionStateCompleted,
		Event:       SIPClientTransactionEventResponse,
		Response:    SIPResponse{StatusCode: 486, Reason: "Busy Here"},
		TimerConfig: cfg,
	})
	if duplicateFailure.NextState != SIPClientTransactionStateCompleted ||
		duplicateFailure.Action != SIPClientTransactionActionDeliverFinal ||
		!duplicateFailure.SendAck ||
		duplicateFailure.DeliverResponse {
		t.Fatalf("duplicate INVITE failure step=%+v", duplicateFailure)
	}

	cleanup := AdvanceSIPClientTransaction(SIPClientTransactionInput{
		Method:      "INVITE",
		State:       SIPClientTransactionStateCompleted,
		Event:       SIPClientTransactionEventCleanupTimer,
		TimerConfig: cfg,
	})
	if cleanup.NextState != SIPClientTransactionStateTerminated ||
		cleanup.Action != SIPClientTransactionActionTerminate ||
		cleanup.TimerName != "D" ||
		!cleanup.Terminated {
		t.Fatalf("INVITE cleanup step=%+v", cleanup)
	}
}

func TestAdvanceSIPClientTransactionRetransmitAndTimeout(t *testing.T) {
	cfg := SIPTransactionTimerConfig{
		T1: 100 * time.Millisecond,
		T2: 400 * time.Millisecond,
	}
	inviteRetransmit := AdvanceSIPClientTransaction(SIPClientTransactionInput{
		Method:                   "INVITE",
		State:                    SIPClientTransactionStateCalling,
		Event:                    SIPClientTransactionEventRetransmitTimer,
		LastRetransmitInterval:   200 * time.Millisecond,
		MaxRetransmits:           3,
		CompletedRetransmissions: 1,
		TimerConfig:              cfg,
	})
	if inviteRetransmit.Action != SIPClientTransactionActionRetransmitRequest ||
		!inviteRetransmit.RetransmitRequest ||
		inviteRetransmit.NextRetransmitInterval != 400*time.Millisecond ||
		inviteRetransmit.TimerName != "A" {
		t.Fatalf("INVITE retransmit step=%+v", inviteRetransmit)
	}

	noRetransmitAfterProceeding := AdvanceSIPClientTransaction(SIPClientTransactionInput{
		Method:      "INVITE",
		State:       SIPClientTransactionStateProceeding,
		Event:       SIPClientTransactionEventRetransmitTimer,
		TimerConfig: cfg,
	})
	if noRetransmitAfterProceeding.Action != SIPClientTransactionActionWait ||
		noRetransmitAfterProceeding.RetransmitRequest {
		t.Fatalf("INVITE proceeding retransmit step=%+v", noRetransmitAfterProceeding)
	}

	reliableRetransmit := AdvanceSIPClientTransaction(SIPClientTransactionInput{
		Method:            "INVITE",
		Event:             SIPClientTransactionEventRetransmitTimer,
		ReliableTransport: true,
		TimerConfig:       cfg,
	})
	if reliableRetransmit.Action != SIPClientTransactionActionWait ||
		reliableRetransmit.RetransmitRequest {
		t.Fatalf("reliable INVITE retransmit step=%+v", reliableRetransmit)
	}

	timeout := AdvanceSIPClientTransaction(SIPClientTransactionInput{
		Method:      "INVITE",
		State:       SIPClientTransactionStateCalling,
		Event:       SIPClientTransactionEventTimeoutTimer,
		TimerConfig: cfg,
	})
	if timeout.NextState != SIPClientTransactionStateTerminated ||
		timeout.Action != SIPClientTransactionActionTimeout ||
		timeout.TimerName != "B" ||
		!timeout.TimedOut ||
		!timeout.Terminated {
		t.Fatalf("INVITE timeout step=%+v", timeout)
	}
}

func TestAdvanceSIPClientTransactionNormalizesInitialState(t *testing.T) {
	invite := AdvanceSIPClientTransaction(SIPClientTransactionInput{
		Method: "INVITE",
		State:  SIPClientTransactionStateTrying,
		Event:  SIPClientTransactionEventResponse,
	})
	if invite.State != SIPClientTransactionStateCalling ||
		invite.NextState != SIPClientTransactionStateCalling ||
		invite.Action != SIPClientTransactionActionWait {
		t.Fatalf("normalized INVITE state step=%+v", invite)
	}

	message := AdvanceSIPClientTransaction(SIPClientTransactionInput{
		Method: "MESSAGE",
		State:  SIPClientTransactionStateCalling,
		Event:  SIPClientTransactionEventResponse,
	})
	if message.State != SIPClientTransactionStateTrying ||
		message.NextState != SIPClientTransactionStateTrying ||
		message.Action != SIPClientTransactionActionWait {
		t.Fatalf("normalized MESSAGE state step=%+v", message)
	}
}

func TestSIPClientTransactionRetransmitTimerActive(t *testing.T) {
	tests := []struct {
		name   string
		method string
		state  SIPClientTransactionState
		want   bool
	}{
		{name: "invite calling", method: "INVITE", state: SIPClientTransactionStateCalling, want: true},
		{name: "invite proceeding", method: "INVITE", state: SIPClientTransactionStateProceeding},
		{name: "invite completed", method: "INVITE", state: SIPClientTransactionStateCompleted},
		{name: "message trying", method: "MESSAGE", state: SIPClientTransactionStateTrying, want: true},
		{name: "message proceeding", method: "MESSAGE", state: SIPClientTransactionStateProceeding, want: true},
		{name: "message completed", method: "MESSAGE", state: SIPClientTransactionStateCompleted},
	}
	for _, tc := range tests {
		if got := sipClientTransactionRetransmitTimerActive(tc.method, tc.state); got != tc.want {
			t.Fatalf("%s active=%t, want %t", tc.name, got, tc.want)
		}
	}
}

func TestAdvanceSIPClientTransactionNonInviteFlow(t *testing.T) {
	cfg := SIPTransactionTimerConfig{
		T1: 100 * time.Millisecond,
		T2: 400 * time.Millisecond,
		T4: 900 * time.Millisecond,
	}
	provisional := AdvanceSIPClientTransaction(SIPClientTransactionInput{
		Method:      "MESSAGE",
		Event:       SIPClientTransactionEventResponse,
		Response:    SIPResponse{StatusCode: 100, Reason: "Trying"},
		TimerConfig: cfg,
	})
	if provisional.Invite ||
		provisional.State != SIPClientTransactionStateTrying ||
		provisional.NextState != SIPClientTransactionStateProceeding ||
		provisional.Action != SIPClientTransactionActionDeliverProvisional ||
		!provisional.DeliverResponse {
		t.Fatalf("non-INVITE provisional step=%+v", provisional)
	}

	retransmitProceeding := AdvanceSIPClientTransaction(SIPClientTransactionInput{
		Method:                   "MESSAGE",
		State:                    SIPClientTransactionStateProceeding,
		Event:                    SIPClientTransactionEventRetransmitTimer,
		LastRetransmitInterval:   100 * time.Millisecond,
		TimerConfig:              cfg,
		CompletedRetransmissions: 1,
	})
	if retransmitProceeding.Action != SIPClientTransactionActionRetransmitRequest ||
		!retransmitProceeding.RetransmitRequest ||
		retransmitProceeding.TimerName != "E" ||
		retransmitProceeding.NextRetransmitInterval != 400*time.Millisecond {
		t.Fatalf("non-INVITE proceeding retransmit step=%+v", retransmitProceeding)
	}

	final := AdvanceSIPClientTransaction(SIPClientTransactionInput{
		Method:      "MESSAGE",
		State:       SIPClientTransactionStateProceeding,
		Event:       SIPClientTransactionEventResponse,
		Response:    SIPResponse{StatusCode: 202, Reason: "Accepted"},
		TimerConfig: cfg,
	})
	if final.NextState != SIPClientTransactionStateCompleted ||
		final.Action != SIPClientTransactionActionDeliverFinal ||
		!final.DeliverResponse ||
		!final.Success ||
		final.SendAck ||
		final.CleanupAfter != 900*time.Millisecond {
		t.Fatalf("non-INVITE final step=%+v", final)
	}

	duplicateFinal := AdvanceSIPClientTransaction(SIPClientTransactionInput{
		Method:      "MESSAGE",
		State:       SIPClientTransactionStateCompleted,
		Event:       SIPClientTransactionEventResponse,
		Response:    SIPResponse{StatusCode: 202, Reason: "Accepted"},
		TimerConfig: cfg,
	})
	if duplicateFinal.NextState != SIPClientTransactionStateCompleted ||
		duplicateFinal.Action != SIPClientTransactionActionWait ||
		duplicateFinal.DeliverResponse ||
		duplicateFinal.Terminated {
		t.Fatalf("non-INVITE duplicate final step=%+v", duplicateFinal)
	}

	reliableFinal := AdvanceSIPClientTransaction(SIPClientTransactionInput{
		Method:            "MESSAGE",
		State:             SIPClientTransactionStateProceeding,
		Event:             SIPClientTransactionEventResponse,
		Response:          SIPResponse{StatusCode: 503, Reason: "Service Unavailable"},
		ReliableTransport: true,
		TimerConfig:       cfg,
	})
	if reliableFinal.NextState != SIPClientTransactionStateTerminated ||
		!reliableFinal.Terminated ||
		reliableFinal.CleanupAfter != 0 {
		t.Fatalf("reliable non-INVITE final step=%+v", reliableFinal)
	}

	cleanup := AdvanceSIPClientTransaction(SIPClientTransactionInput{
		Method:      "MESSAGE",
		State:       SIPClientTransactionStateCompleted,
		Event:       SIPClientTransactionEventCleanupTimer,
		TimerConfig: cfg,
	})
	if cleanup.NextState != SIPClientTransactionStateTerminated ||
		cleanup.Action != SIPClientTransactionActionTerminate ||
		cleanup.TimerName != "K" ||
		!cleanup.Terminated {
		t.Fatalf("non-INVITE cleanup step=%+v", cleanup)
	}
}

func TestAdvanceSIPClientTransactionInviteReliableFailureCleanup(t *testing.T) {
	cfg := SIPTransactionTimerConfig{T1: 100 * time.Millisecond}
	failure := AdvanceSIPClientTransaction(SIPClientTransactionInput{
		Method:            "INVITE",
		State:             SIPClientTransactionStateProceeding,
		Event:             SIPClientTransactionEventResponse,
		Response:          SIPResponse{StatusCode: 486, Reason: "Busy Here"},
		ReliableTransport: true,
		TimerConfig:       cfg,
	})
	if failure.NextState != SIPClientTransactionStateTerminated ||
		failure.Action != SIPClientTransactionActionDeliverFinal ||
		!failure.DeliverResponse ||
		!failure.SendAck ||
		!failure.Terminated ||
		failure.CleanupAfter != 0 {
		t.Fatalf("reliable INVITE failure step=%+v", failure)
	}
}

func TestAdvanceSIPClientTransactionNonInviteTimeoutAndRetransmitLimit(t *testing.T) {
	cfg := SIPTransactionTimerConfig{T1: 100 * time.Millisecond, T2: 400 * time.Millisecond}
	noRetransmit := AdvanceSIPClientTransaction(SIPClientTransactionInput{
		Method:                   "REGISTER",
		State:                    SIPClientTransactionStateTrying,
		Event:                    SIPClientTransactionEventRetransmitTimer,
		MaxRetransmits:           2,
		CompletedRetransmissions: 2,
		TimerConfig:              cfg,
	})
	if noRetransmit.Action != SIPClientTransactionActionWait ||
		noRetransmit.RetransmitRequest {
		t.Fatalf("non-INVITE retransmit limit step=%+v", noRetransmit)
	}

	timeout := AdvanceSIPClientTransaction(SIPClientTransactionInput{
		Method:      "REGISTER",
		State:       SIPClientTransactionStateProceeding,
		Event:       SIPClientTransactionEventTimeoutTimer,
		TimerConfig: cfg,
	})
	if timeout.NextState != SIPClientTransactionStateTerminated ||
		timeout.Action != SIPClientTransactionActionTimeout ||
		timeout.TimerName != "F" ||
		!timeout.TimedOut ||
		!timeout.Terminated {
		t.Fatalf("non-INVITE timeout step=%+v", timeout)
	}
}

func TestAdvanceSIPServerTransactionInviteFlow(t *testing.T) {
	cfg := SIPTransactionTimerConfig{
		T1: 100 * time.Millisecond,
		T2: 400 * time.Millisecond,
		T4: 900 * time.Millisecond,
	}
	request := AdvanceSIPServerTransaction(SIPServerTransactionInput{
		Method:      "invite",
		Event:       SIPServerTransactionEventRequest,
		TimerConfig: cfg,
	})
	if request.Method != "INVITE" ||
		!request.Invite ||
		request.State != SIPServerTransactionStateProceeding ||
		request.NextState != SIPServerTransactionStateProceeding ||
		request.Action != SIPServerTransactionActionPassRequest ||
		!request.PassRequest {
		t.Fatalf("INVITE request step=%+v", request)
	}

	provisional := AdvanceSIPServerTransaction(SIPServerTransactionInput{
		Method:      "INVITE",
		State:       SIPServerTransactionStateProceeding,
		Event:       SIPServerTransactionEventResponse,
		Response:    SIPResponse{StatusCode: 183, Reason: "Session Progress"},
		TimerConfig: cfg,
	})
	if provisional.NextState != SIPServerTransactionStateProceeding ||
		provisional.Action != SIPServerTransactionActionSendResponse ||
		!provisional.SendResponse ||
		!provisional.Provisional ||
		provisional.Final {
		t.Fatalf("INVITE provisional response step=%+v", provisional)
	}

	failure := AdvanceSIPServerTransaction(SIPServerTransactionInput{
		Method:      "INVITE",
		State:       SIPServerTransactionStateProceeding,
		Event:       SIPServerTransactionEventResponse,
		Response:    SIPResponse{StatusCode: 486, Reason: "Busy Here"},
		TimerConfig: cfg,
	})
	if failure.NextState != SIPServerTransactionStateCompleted ||
		failure.Action != SIPServerTransactionActionSendResponse ||
		!failure.SendResponse ||
		!failure.Failure ||
		failure.TimerName != "G" ||
		failure.NextRetransmitInterval != 100*time.Millisecond ||
		failure.TimeoutAfter != 6400*time.Millisecond ||
		failure.Terminated {
		t.Fatalf("INVITE failure response step=%+v", failure)
	}

	retransmitTimer := AdvanceSIPServerTransaction(SIPServerTransactionInput{
		Method:                 "INVITE",
		State:                  SIPServerTransactionStateCompleted,
		Event:                  SIPServerTransactionEventRetransmitTimer,
		Response:               SIPResponse{StatusCode: 486, Reason: "Busy Here"},
		LastRetransmitInterval: 200 * time.Millisecond,
		TimerConfig:            cfg,
	})
	if retransmitTimer.NextState != SIPServerTransactionStateCompleted ||
		retransmitTimer.Action != SIPServerTransactionActionRetransmitResponse ||
		!retransmitTimer.RetransmitResponse ||
		retransmitTimer.TimerName != "G" ||
		retransmitTimer.NextRetransmitInterval != 400*time.Millisecond {
		t.Fatalf("INVITE retransmit timer step=%+v", retransmitTimer)
	}

	requestRetransmit := AdvanceSIPServerTransaction(SIPServerTransactionInput{
		Method:                "INVITE",
		State:                 SIPServerTransactionStateCompleted,
		Event:                 SIPServerTransactionEventRequest,
		RequestRetransmission: true,
		Response:              SIPResponse{StatusCode: 486, Reason: "Busy Here"},
		TimerConfig:           cfg,
	})
	if requestRetransmit.Action != SIPServerTransactionActionRetransmitResponse ||
		!requestRetransmit.RetransmitResponse ||
		requestRetransmit.StatusCode != 486 {
		t.Fatalf("INVITE request retransmission step=%+v", requestRetransmit)
	}

	ack := AdvanceSIPServerTransaction(SIPServerTransactionInput{
		Method:      "INVITE",
		State:       SIPServerTransactionStateCompleted,
		Event:       SIPServerTransactionEventACK,
		TimerConfig: cfg,
	})
	if ack.NextState != SIPServerTransactionStateConfirmed ||
		ack.Action != SIPServerTransactionActionDeliverACK ||
		!ack.DeliverACK ||
		ack.TimerName != "I" ||
		ack.CleanupAfter != 900*time.Millisecond ||
		ack.Terminated {
		t.Fatalf("INVITE ACK step=%+v", ack)
	}

	cleanup := AdvanceSIPServerTransaction(SIPServerTransactionInput{
		Method:      "INVITE",
		State:       SIPServerTransactionStateConfirmed,
		Event:       SIPServerTransactionEventCleanupTimer,
		TimerConfig: cfg,
	})
	if cleanup.NextState != SIPServerTransactionStateTerminated ||
		cleanup.Action != SIPServerTransactionActionTerminate ||
		cleanup.TimerName != "I" ||
		!cleanup.Terminated {
		t.Fatalf("INVITE server cleanup step=%+v", cleanup)
	}
}

func TestAdvanceSIPServerTransactionInviteSuccessAndTimeout(t *testing.T) {
	cfg := SIPTransactionTimerConfig{T1: 100 * time.Millisecond, T4: 900 * time.Millisecond}
	success := AdvanceSIPServerTransaction(SIPServerTransactionInput{
		Method:      "INVITE",
		State:       SIPServerTransactionStateProceeding,
		Event:       SIPServerTransactionEventResponse,
		Response:    SIPResponse{StatusCode: 200, Reason: "OK"},
		TimerConfig: cfg,
	})
	if success.NextState != SIPServerTransactionStateTerminated ||
		success.Action != SIPServerTransactionActionSendResponse ||
		!success.SendResponse ||
		!success.Success ||
		!success.Terminated {
		t.Fatalf("INVITE 2xx server step=%+v", success)
	}

	reliableFailure := AdvanceSIPServerTransaction(SIPServerTransactionInput{
		Method:            "INVITE",
		State:             SIPServerTransactionStateProceeding,
		Event:             SIPServerTransactionEventResponse,
		Response:          SIPResponse{StatusCode: 488, Reason: "Not Acceptable Here"},
		ReliableTransport: true,
		TimerConfig:       cfg,
	})
	if reliableFailure.NextState != SIPServerTransactionStateCompleted ||
		reliableFailure.NextRetransmitInterval != 0 ||
		reliableFailure.TimeoutAfter != 6400*time.Millisecond ||
		reliableFailure.Terminated {
		t.Fatalf("reliable INVITE failure server step=%+v", reliableFailure)
	}

	reliableACK := AdvanceSIPServerTransaction(SIPServerTransactionInput{
		Method:            "INVITE",
		State:             SIPServerTransactionStateCompleted,
		Event:             SIPServerTransactionEventACK,
		ReliableTransport: true,
		TimerConfig:       cfg,
	})
	if reliableACK.NextState != SIPServerTransactionStateTerminated ||
		!reliableACK.DeliverACK ||
		!reliableACK.Terminated ||
		reliableACK.CleanupAfter != 0 {
		t.Fatalf("reliable INVITE ACK step=%+v", reliableACK)
	}

	timeout := AdvanceSIPServerTransaction(SIPServerTransactionInput{
		Method:      "INVITE",
		State:       SIPServerTransactionStateCompleted,
		Event:       SIPServerTransactionEventTimeoutTimer,
		TimerConfig: cfg,
	})
	if timeout.NextState != SIPServerTransactionStateTerminated ||
		timeout.Action != SIPServerTransactionActionTimeout ||
		timeout.TimerName != "H" ||
		!timeout.TimedOut ||
		!timeout.Terminated {
		t.Fatalf("INVITE server timeout step=%+v", timeout)
	}
}

func TestAdvanceSIPServerTransactionNonInviteFlow(t *testing.T) {
	cfg := SIPTransactionTimerConfig{
		T1: 100 * time.Millisecond,
		T2: 400 * time.Millisecond,
		T4: 900 * time.Millisecond,
	}
	request := AdvanceSIPServerTransaction(SIPServerTransactionInput{
		Method:      "MESSAGE",
		Event:       SIPServerTransactionEventRequest,
		TimerConfig: cfg,
	})
	if request.Invite ||
		request.State != SIPServerTransactionStateTrying ||
		request.NextState != SIPServerTransactionStateTrying ||
		request.Action != SIPServerTransactionActionPassRequest ||
		!request.PassRequest {
		t.Fatalf("non-INVITE request step=%+v", request)
	}

	provisional := AdvanceSIPServerTransaction(SIPServerTransactionInput{
		Method:      "MESSAGE",
		State:       SIPServerTransactionStateTrying,
		Event:       SIPServerTransactionEventResponse,
		Response:    SIPResponse{StatusCode: 100, Reason: "Trying"},
		TimerConfig: cfg,
	})
	if provisional.NextState != SIPServerTransactionStateProceeding ||
		provisional.Action != SIPServerTransactionActionSendResponse ||
		!provisional.SendResponse ||
		!provisional.Provisional {
		t.Fatalf("non-INVITE provisional server step=%+v", provisional)
	}

	final := AdvanceSIPServerTransaction(SIPServerTransactionInput{
		Method:      "MESSAGE",
		State:       SIPServerTransactionStateProceeding,
		Event:       SIPServerTransactionEventResponse,
		Response:    SIPResponse{StatusCode: 202, Reason: "Accepted"},
		TimerConfig: cfg,
	})
	if final.NextState != SIPServerTransactionStateCompleted ||
		final.Action != SIPServerTransactionActionSendResponse ||
		!final.SendResponse ||
		!final.Success ||
		final.TimerName != "J" ||
		final.CleanupAfter != 6400*time.Millisecond ||
		final.Terminated {
		t.Fatalf("non-INVITE final server step=%+v", final)
	}

	requestRetransmit := AdvanceSIPServerTransaction(SIPServerTransactionInput{
		Method:                "MESSAGE",
		State:                 SIPServerTransactionStateCompleted,
		Event:                 SIPServerTransactionEventRequest,
		RequestRetransmission: true,
		Response:              SIPResponse{StatusCode: 202, Reason: "Accepted"},
		TimerConfig:           cfg,
	})
	if requestRetransmit.Action != SIPServerTransactionActionRetransmitResponse ||
		!requestRetransmit.RetransmitResponse ||
		requestRetransmit.StatusCode != 202 {
		t.Fatalf("non-INVITE request retransmission step=%+v", requestRetransmit)
	}

	cleanup := AdvanceSIPServerTransaction(SIPServerTransactionInput{
		Method:      "MESSAGE",
		State:       SIPServerTransactionStateCompleted,
		Event:       SIPServerTransactionEventCleanupTimer,
		TimerConfig: cfg,
	})
	if cleanup.NextState != SIPServerTransactionStateTerminated ||
		cleanup.Action != SIPServerTransactionActionTerminate ||
		cleanup.TimerName != "J" ||
		!cleanup.Terminated {
		t.Fatalf("non-INVITE server cleanup step=%+v", cleanup)
	}
}

func TestAdvanceSIPServerTransactionNonInviteReliableAndStateNormalization(t *testing.T) {
	cfg := SIPTransactionTimerConfig{T1: 100 * time.Millisecond, T4: 900 * time.Millisecond}
	reliableFinal := AdvanceSIPServerTransaction(SIPServerTransactionInput{
		Method:            "UPDATE",
		State:             SIPServerTransactionStateProceeding,
		Event:             SIPServerTransactionEventResponse,
		Response:          SIPResponse{StatusCode: 500, Reason: "Server Internal Error"},
		ReliableTransport: true,
		TimerConfig:       cfg,
	})
	if reliableFinal.NextState != SIPServerTransactionStateTerminated ||
		!reliableFinal.SendResponse ||
		!reliableFinal.Failure ||
		!reliableFinal.Terminated ||
		reliableFinal.CleanupAfter != 0 {
		t.Fatalf("reliable non-INVITE final server step=%+v", reliableFinal)
	}

	normalizedInvite := AdvanceSIPServerTransaction(SIPServerTransactionInput{
		Method: "INVITE",
		State:  SIPServerTransactionStateTrying,
		Event:  SIPServerTransactionEventRequest,
	})
	if normalizedInvite.State != SIPServerTransactionStateProceeding ||
		normalizedInvite.NextState != SIPServerTransactionStateProceeding {
		t.Fatalf("normalized server INVITE step=%+v", normalizedInvite)
	}

	normalizedMessage := AdvanceSIPServerTransaction(SIPServerTransactionInput{
		Method: "MESSAGE",
		State:  SIPServerTransactionStateConfirmed,
		Event:  SIPServerTransactionEventRequest,
	})
	if normalizedMessage.State != SIPServerTransactionStateTrying ||
		normalizedMessage.NextState != SIPServerTransactionStateTrying {
		t.Fatalf("normalized server MESSAGE step=%+v", normalizedMessage)
	}
}
