package org.vodog.gateway

import android.telecom.PhoneAccountHandle

data class EnableRequirements(
    val paired: Boolean,
    val phonePermission: Boolean,
    val notificationPermission: Boolean,
    val privilegedTelephony: Boolean = false,
    val actionRuntimePermissions: Boolean = false,
)

sealed interface EnableDecision {
    data object Allowed : EnableDecision
    data class Blocked(val reason: String) : EnableDecision
}

object GatewayEnablePolicy {
    fun evaluate(requirements: EnableRequirements): EnableDecision = when {
        !requirements.paired -> EnableDecision.Blocked("请先置入管理员发放的设备凭据")
        !requirements.phonePermission -> EnableDecision.Blocked("需要电话状态权限才能读取真实 SIM")
        !requirements.privilegedTelephony -> EnableDecision.Blocked("设备尚未安装并授予审核过的电话特权模块")
        !requirements.actionRuntimePermissions -> EnableDecision.Blocked("需要电话、短信和音频运行时权限")
        !requirements.notificationPermission -> EnableDecision.Blocked("需要通知权限才能安全运行前台服务")
        else -> EnableDecision.Allowed
    }
}

enum class ServerConnection(val label: String) {
    DISABLED("总控已关闭"),
    UNPAIRED("未配对"),
    CONNECTING("正在连接"),
    ONLINE("已连接"),
    /** A single lost heartbeat is a retry, not a disconnection. Only sustained silence becomes OFFLINE. */
    DEGRADED("连接不稳定"),
    OFFLINE("连接失败"),
}

enum class SimIdentityKind(val wire: String) {
    ICCID("iccid"),
    CARD_ID("cardId"),
    FALLBACK("fallback"),
}

data class SimSnapshot(
    val slotIndex: Int,
    val subscriptionId: Int,
    val carrierName: String,
    val displayName: String,
    val phoneAccountHandle: PhoneAccountHandle?,
    val protectedPhoneAccountHandle: String?,
    val iccidFingerprint: String?,
    val countryIso: String? = null,
    val embedded: Boolean? = null,
    val identityKind: SimIdentityKind? = null,
    /** S65 transition: pre-S65 device HMAC of the same ICCID, ICCID kind only. */
    val legacyIccidFingerprint: String? = null,
    val phoneNumber: String? = null,
) {
    val hasPhoneAccountMapping: Boolean get() = phoneAccountHandle != null
}
