package org.vodog

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.runBlocking
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class S32ConsistencyPolicyTest {
    @Test fun cancelledListReadDoesNotBecomeAVisibleFailure() = runBlocking {
        val cancelled = runCatching {
            loadRemoteList { throw CancellationException("superseded") }
        }.exceptionOrNull()
        assertTrue(cancelled is CancellationException)

        val unavailable = loadRemoteList {
            throw ApiError(503, "HTTP_503", "fixture unavailable")
        }
        assertEquals(RemoteList.Failed("fixture unavailable"), unavailable)
        val snapshot = RemoteList.Loaded(listOf(JSONObject().put("id", "contact-1")))
        assertTrue(remoteListAfterRefresh(snapshot, unavailable) === snapshot)
    }

    @Test fun contactConflictCarriesLatestVersionAndSurvivesMessageDismissal() {
        val conflict = ApiError(
            409,
            "CONTACT_VERSION_CONFLICT",
            "stale",
            JSONObject().put("currentVersion", 8),
        )
        assertTrue(conflict.isContactVersionConflict())
        assertEquals(8L, conflict.contactConflictVersion())

        val latched = ClientUiState(
            contactMessage = conflict.contactMutationUserMessage(),
            contactConflicts = mapOf("contact-1" to conflict.contactConflictVersion()),
        )
        val dismissed = latched.copy(contactMessage = "")
        assertEquals(mapOf("contact-1" to 8L), dismissed.contactConflicts)
        assertEquals("", dismissed.contactMessage)
    }

    @Test fun unrelatedContactErrorsDoNotLatchAConflict() {
        val unavailable = ApiError(503, "HTTP_503", "offline")
        assertFalse(unavailable.isContactVersionConflict())
        assertEquals("offline", unavailable.contactMutationUserMessage())
    }

    @Test fun blocklistLookupCanRecoverAnIdMissingFromACachedRecord() {
        val rows = listOf(
            JSONObject().put("id", "block-1").put("remoteNumber", "+86 138-0000-0000"),
        )
        assertEquals("block-1", blocklistEntryIdForNumber(rows, "+8613800000000"))
        assertEquals(null, blocklistEntryIdForNumber(rows, "+8613900000000"))
    }

    @Test fun failedForegroundRefreshKeepsTheLastSuccessfulSnapshot() {
        val contacts = RemoteList.Loaded(listOf(JSONObject().put("id", "contact-1")))
        assertTrue(remoteListDuringRefresh(contacts) === contacts)
        assertTrue(remoteListAfterRefresh(contacts, RemoteList.Failed("offline")) === contacts)

        val providers = RemoteResource.Loaded(ClientVoiceProviderList(emptyList(), "xai", configVersion = 4))
        assertTrue(remoteResourceDuringRefresh(providers) === providers)
        assertTrue(remoteResourceAfterRefresh(providers, RemoteResource.Failed("offline")) === providers)
    }

    @Test fun settingsRefreshKeepsSnapshotAndExposesTheFailureUntilSuccess() {
        val snapshot = RemoteList.Loaded(listOf(JSONObject().put("id", "row-1")))
        val failed = visibleRemoteListAfterRefresh(snapshot, RemoteList.Failed("timeout"))
        assertTrue(failed.value === snapshot)
        assertEquals("timeout", failed.error)

        val recoveredRows = RemoteList.Loaded(listOf(JSONObject().put("id", "row-2")))
        val recovered = visibleRemoteListAfterRefresh(failed.value, recoveredRows)
        assertTrue(recovered.value === recoveredRows)
        assertEquals("", recovered.error)

        val initialFailure = RemoteList.Failed("offline")
        val initial = visibleRemoteListAfterRefresh(RemoteList.NotLoaded, initialFailure)
        assertTrue(initial.value === initialFailure)
        assertEquals("offline", initial.error)
    }

    @Test fun accountRolesUseTheSharedLocalizedLabels() {
        assertEquals("管理员", roleDisplayLabel("admin"))
        assertEquals("用户", roleDisplayLabel("user"))
        assertEquals("暂不可用", roleDisplayLabel(""))
        assertEquals("暂不可用", roleDisplayLabel("owner"))
        assertEquals("暂不可用", roleDisplayLabel("auditor"))
    }

    @Test fun acceptedSettingsMessagesDoNotLookLikeErrors() {
        val base = ClientUiState()
        assertEquals(WorkspaceMessageKind.CONFIRMATION, workspaceMessageKind(base.withInfo("号码备注已保存")))
        assertEquals(WorkspaceMessageKind.CONFIRMATION, workspaceMessageKind(base.withInfo("短信已提交，正在等待发送")))

        assertEquals(WorkspaceMessageKind.ERROR, workspaceMessageKind(base.copy(message = "名称不能为空")))
        assertEquals(
            WorkspaceMessageKind.ERROR,
            workspaceMessageKind(base.copy(message = "保存成功字样来自不可信错误响应")),
        )
        // 先有确认、后被错误覆盖：旧的 infoMessage 不会把错误染成确认样式。
        assertEquals(
            WorkspaceMessageKind.ERROR,
            workspaceMessageKind(base.withInfo("号码备注已保存").copy(message = "名称不能为空")),
        )
    }

    @Test fun confirmationsClearThemselvesButErrorsDialingAndProgressDoNot() {
        val base = ClientUiState()
        assertEquals("短信已提交，正在等待发送", base.withInfo("短信已提交，正在等待发送").autoDismissInfo())
        assertEquals(null, base.copy(message = "名称不能为空").autoDismissInfo())
        assertEquals(null, base.withInfo(DIALING_ACKNOWLEDGEMENT).autoDismissInfo())
        assertEquals(null, base.withInfo("正在准备 Passkey…").autoDismissInfo())
        assertEquals(null, base.autoDismissInfo())
    }

    @Test fun acceptedGatewayIntentImmediatelySupersedesTheMatchingSnapshotRow() {
        val oldPrimary = JSONObject().put("gatewayId", "primary").put("desiredPower", JSONObject.NULL)
        val secondary = JSONObject().put("gatewayId", "secondary").put("online", true)
        val accepted = JSONObject().put("gatewayId", "primary").put("desiredPower", "off")

        val result = gatewayPowerAfterAcceptedItem(RemoteList.Loaded(listOf(oldPrimary, secondary)), accepted)
        val rows = (result as RemoteList.Loaded).items

        assertEquals(listOf("primary", "secondary"), rows.map { it.getString("gatewayId") })
        assertEquals("off", rows.first().getString("desiredPower"))
        assertTrue(rows[1] === secondary)
        assertTrue(gatewayPowerHasPendingIntent(result, "primary"))
        assertFalse(gatewayPowerHasPendingIntent(result, "secondary"))
    }

    @Test fun acceptedMutationRejectsReadsFromBeforeAndDuringThePostThenAllowsFreshReconciliation() {
        val reads = AsyncRequestGuard()
        val beforePost = reads.next(sessionEpoch = 9, key = "list")
        reads.invalidate() // mutation begins
        val slippedInDuringPost = reads.next(sessionEpoch = 9, key = "list")
        reads.invalidate() // accepted response arrives and owns the visible state
        val afterAccepted = reads.next(sessionEpoch = 9, key = "list")

        assertFalse(reads.accepts(beforePost, currentSessionEpoch = 9, currentKey = "list"))
        assertFalse(reads.accepts(slippedInDuringPost, currentSessionEpoch = 9, currentKey = "list"))
        assertTrue(reads.accepts(afterAccepted, currentSessionEpoch = 9, currentKey = "list"))
        assertFalse(reads.accepts(afterAccepted, currentSessionEpoch = 10, currentKey = "list"))
    }

    @Test fun acceptedPasskeyMutationsCannotBeUndoneByAFailedReconciliationSnapshot() {
        val mac = PasskeyItem(id = "mac", createdAt = "old", label = "旧名称")
        val phone = PasskeyItem(id = "phone", createdAt = "old", label = "随身手机")
        val acceptedMac = mac.copy(label = "办公 MacBook")

        val renamed = passkeysAfterAcceptedMutation(
            listOf(mac, phone),
            AcceptedPasskeyMutation.Renamed(acceptedMac),
        )
        assertEquals(listOf("办公 MacBook", "随身手机"), renamed.map { it.label })

        val deleted = passkeysAfterAcceptedMutation(renamed, AcceptedPasskeyMutation.Deleted("phone"))
        assertEquals(listOf("mac"), deleted.map { it.id })
        assertEquals("办公 MacBook", deleted.single().label)

        val reconciliationFailed = ClientUiState(
            passkeys = deleted,
            passkeysLoaded = true,
            passkeyStatus = "通行密钥已删除",
            passkeyError = "网络不可用",
        )
        assertEquals(listOf("mac"), reconciliationFailed.passkeys.map { it.id })
        assertEquals("通行密钥已删除", reconciliationFailed.passkeyStatus)
        assertEquals("网络不可用", reconciliationFailed.passkeyError)

        assertFalse(
            passkeyRegistrationAllowed(
                reconciliationFailed.copy(passkeyRegistrationRefreshPending = true),
            ),
        )
        assertTrue(passkeyRegistrationAllowed(reconciliationFailed))
    }
}
