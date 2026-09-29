package org.vodog

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import org.json.JSONObject

/**
 * 设置 → SIM 与接听模式 →「应用状态」的全部判断。
 *
 * 背景：`PUT /sims/{id}/settings` 只把新的 `version` 写进去，`appliedVersion` 按设计仍是旧值
 * （services/control/test/control.test.ts:312），要等网关几秒后 ack，Control 才更新 `applied_version`。
 * 保存后立刻刷新一次拿到的必然是「还没确认」的快照，所以以前那一次刷新只会稳定地印出
 * [UNCONFIRMED_TEXT]。这里把「保存后短暂等待」变成显式状态：保存成功时进入 [SettingsApplyState.Applying]，
 * 每 [POLL_INTERVAL_MS] 安静地重读一次 `/sims`，确认到就是 [SettingsApplyState.Applied]，
 * [TIMEOUT_MS] 还没确认就是 [SettingsApplyState.TimedOut]（文案退回原来的警告，一个字没改）。
 */
sealed interface SettingsApplyState {
    /** 没有保存过，或者上一次的等待已经收尾；只按快照本身判断。 */
    data object Idle : SettingsApplyState

    /** 刚保存成功，正在等网关 ack。[targetVersion] 是 PUT 返回的新 `settings.version`。 */
    data class Applying(val startedAt: Long, val simId: String, val targetVersion: Long) : SettingsApplyState

    /** 网关已经确认到 [targetVersion]；保留目标，以便随后识别另一端覆盖。 */
    data class Applied(val targetVersion: Long) : SettingsApplyState

    data class Superseded(val targetVersion: Long) : SettingsApplyState

    /** 等满 [SettingsApplyPolicy.TIMEOUT_MS] 仍未确认；不代表失败，只是不再等下去。 */
    data object TimedOut : SettingsApplyState
}

/** 状态行的语气。颜色在 UI 层取主题色，这里只说“哪一种”。 */
enum class SettingsApplyTone { NONE, PENDING, SUCCESS, WARNING }

data class SettingsApplyLabel(val text: String, val tone: SettingsApplyTone)

/** `settings.version` / `settings.appliedVersion`：列表项和 PUT 返回体是同一个结构，共用一份解析。 */
internal data class SimSettingsVersions(val version: Long, val appliedVersion: Long?)

internal fun JSONObject.simSettingsVersions(): SimSettingsVersions {
    val settings = optJSONObject("settings") ?: JSONObject()
    return SimSettingsVersions(
        version = settings.optLong("version", 0),
        // 缺字段和显式 null 都表示“网关一次都没确认过”，不能读成 0。
        appliedVersion = if (!settings.has("appliedVersion") || settings.isNull("appliedVersion")) null
        else settings.optLong("appliedVersion"),
    )
}

internal object SettingsApplyPolicy {
    /** 等待期间重读 `/sims` 的间隔。 */
    const val POLL_INTERVAL_MS = 2_000L

    /** 等待上限；网关正常在几秒内 ack，30 秒还没确认就不再占着一个转圈。 */
    const val TIMEOUT_MS = 30_000L

    const val APPLYING_TEXT = "正在应用中…"
    const val APPLIED_TEXT = "应用成功"
    const val SUPERSEDED_TEXT = "设置已被另一端更新"

    /** 原文案，一字不改：超时和「快照本身就没确认」都用它。 */
    const val UNCONFIRMED_TEXT = "设置已保存，但设备尚未确认应用。"

    const val CONFIRMED_SUBTITLE = "网关已确认"
    const val PENDING_SUBTITLE = "等待网关确认"

    fun applying(simId: String, targetVersion: Long, nowMs: Long): SettingsApplyState.Applying =
        SettingsApplyState.Applying(startedAt = nowMs, simId = simId, targetVersion = targetVersion)

    /**
     * PUT 返回体里的新版本号。服务器按设计会回 `settings.version`（旧 `appliedVersion`）；
     * 万一某个旧服务器不回，就退回 `expectedVersion + 1`——CAS 的下一格。
     */
    fun targetVersion(response: JSONObject, expectedVersion: Long): Long =
        response.simSettingsVersions().version.takeIf { it > expectedVersion } ?: (expectedVersion + 1)

    /**
     * 用一份新快照推进状态。只有 [SettingsApplyState.Applying] 会变：确认到目标版本就成功，
     * 超时就收尾，其余保持不动（[SettingsApplyState.Applied] 一直留到下一次保存）。
     *
     * 只有当前设置仍是提交目标，且网关 ack 已到目标版本，才算这次保存成功。当前设置版本更高说明
     * 另一端已经改过，必须显示“已被另一端更新”，不能把对方的新版本误认成我们的旧选择已应用。
     */
    fun next(
        state: SettingsApplyState,
        nowMs: Long,
        appliedVersion: Long?,
        version: Long,
    ): SettingsApplyState {
        return when (state) {
            is SettingsApplyState.Applying -> when {
                version > state.targetVersion -> SettingsApplyState.Superseded(state.targetVersion)
                version == state.targetVersion && appliedVersion != null && appliedVersion >= state.targetVersion ->
                    SettingsApplyState.Applied(state.targetVersion)
                nowMs - state.startedAt >= TIMEOUT_MS -> SettingsApplyState.TimedOut
                else -> state
            }
            is SettingsApplyState.Applied ->
                if (version > state.targetVersion) SettingsApplyState.Superseded(state.targetVersion) else state
            else -> state
        }
    }

    /**
     * 「应用状态」那一行的文字和语气。`应用成功` 只在当前快照真的 `appliedVersion == version` 时出现，
     * 所以离开页面后被冻结在 [SettingsApplyState.Applying] 的状态回来也能自愈成正确的一行。
     */
    fun label(
        state: SettingsApplyState,
        appliedVersion: Long?,
        version: Long,
    ): SettingsApplyLabel {
        val targetVersion = when (state) {
            is SettingsApplyState.Applying -> state.targetVersion
            is SettingsApplyState.Applied -> state.targetVersion
            is SettingsApplyState.Superseded -> state.targetVersion
            else -> null
        }
        val superseded = state is SettingsApplyState.Superseded ||
            (targetVersion != null && version > targetVersion)
        val confirmed = when {
            targetVersion != null -> version == targetVersion && appliedVersion != null && appliedVersion >= targetVersion
            else -> appliedVersion != null && appliedVersion == version
        } && !superseded
        return when {
            superseded -> SettingsApplyLabel(SUPERSEDED_TEXT, SettingsApplyTone.WARNING)
            state is SettingsApplyState.Applying && !confirmed ->
                SettingsApplyLabel(APPLYING_TEXT, SettingsApplyTone.PENDING)
            confirmed -> SettingsApplyLabel(APPLIED_TEXT, SettingsApplyTone.SUCCESS)
            // 连 settings 都没有的 SIM（旧服务器、字段缺失）没有“已保存”这回事，不报警告。
            version == 0L && appliedVersion == null -> SettingsApplyLabel("", SettingsApplyTone.NONE)
            else -> SettingsApplyLabel(UNCONFIRMED_TEXT, SettingsApplyTone.WARNING)
        }
    }

    /** 卡片副标题里的确认词，和 [label] 同源，等待期间也跟着变。 */
    fun subtitle(state: SettingsApplyState, appliedVersion: Long?, version: Long): String =
        when (label(state, appliedVersion, version).tone) {
            SettingsApplyTone.PENDING -> APPLYING_TEXT
            SettingsApplyTone.SUCCESS -> CONFIRMED_SUBTITLE
            SettingsApplyTone.WARNING, SettingsApplyTone.NONE -> PENDING_SUBTITLE
        }
}

/**
 * 保存后的有界轮询：每 [SettingsApplyPolicy.POLL_INTERVAL_MS] 安静地重读一次 `/sims`
 * （[refresh]），再用 [evaluate] 拿新快照推进状态；[evaluate] 返回 false（都不再是
 * [SettingsApplyState.Applying]）就自己收工。和 [ClientRefreshLoop] 一样，[sleep] 可注入，
 * 所以节奏可以在没有真实时钟的情况下单测。
 */
internal class SettingsApplyWatch(
    private val scope: CoroutineScope,
    private val refresh: suspend () -> Unit,
    private val evaluate: () -> Boolean,
    private val sleep: suspend (Long) -> Unit = { delay(it) },
) {
    private var job: Job? = null

    val running: Boolean get() = job?.isActive == true

    /** 新的一次保存替换掉上一次的等待，而不是叠第二个 ticker。 */
    fun start() {
        stop()
        job = scope.launch {
            while (isActive) {
                sleep(SettingsApplyPolicy.POLL_INTERVAL_MS)
                refresh()
                if (!evaluate()) return@launch
            }
        }
    }

    /** 设置页重新回到前台：还没确认的继续等（[SettingsApplyState.Applying.startedAt] 不变，超时上限也就不变）。 */
    fun resume() {
        if (!running) start()
    }

    fun stop() {
        job?.cancel()
        job = null
    }
}
