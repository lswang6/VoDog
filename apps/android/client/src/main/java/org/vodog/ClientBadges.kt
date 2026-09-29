package org.vodog

import android.annotation.SuppressLint
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import org.json.JSONObject

/** S67 `GET /badges`: 待查看通话 + 未读短信, total and per SIM (only non-zero SIMs are listed). */
data class SimBadge(val calls: Int, val sms: Int)

data class ClientBadges(
    val calls: Int = 0,
    val sms: Int = 0,
    val sims: Map<String, SimBadge> = emptyMap(),
) {
    fun simCalls(): Map<String, Int> = sims.mapValues { it.value.calls }
    fun simSms(): Map<String, Int> = sims.mapValues { it.value.sms }
    /** S67 rule 3: pages other than 通话 / 短信 show calls + SMS per SIM. */
    fun simTotal(): Map<String, Int> = sims.mapValues { it.value.calls + it.value.sms }
}

internal fun parseBadges(json: JSONObject): ClientBadges {
    val sims = buildMap {
        val array = json.optJSONArray("sims")
        for (index in 0 until (array?.length() ?: 0)) {
            val row = array?.optJSONObject(index) ?: continue
            val id = row.optString("simId").takeIf(String::isNotBlank) ?: continue
            put(id, SimBadge(row.optInt("calls").coerceAtLeast(0), row.optInt("sms").coerceAtLeast(0)))
        }
    }
    return ClientBadges(json.optInt("calls").coerceAtLeast(0), json.optInt("sms").coerceAtLeast(0), sims)
}

/** 0 shows nothing, above 99 shows `99+`. */
internal fun badgeLabel(count: Int): String? = when {
    count <= 0 -> null
    count > 99 -> "99+"
    else -> count.toString()
}

/**
 * S67c row dots. Control sends `unseen` on calls and `unread` on SMS (missing = false); ids the user
 * just opened are hidden locally until the server agrees.
 */
internal fun callShowsUnseenDot(call: JSONObject, seenLocally: Set<String>): Boolean =
    call.optBoolean("unseen") && call.optString("id") !in seenLocally

internal fun reportShowsUnseenDot(item: CallReportItem, seenLocally: Set<String>): Boolean =
    item.unseen && item.callId !in seenLocally

internal fun conversationShowsUnreadDot(messages: List<ClientSmsMessage>, readLocally: Set<String>): Boolean =
    messages.any { it.raw.optBoolean("unread") && it.id !in readLocally }

/** Drops local ids the server already reports as cleared, so the set only covers in-flight marks. */
internal fun pruneLocallyCleared(local: Set<String>, items: List<JSONObject>, flag: String): Set<String> {
    if (local.isEmpty()) return local
    val cleared = items.filter { !it.optBoolean(flag) }.mapTo(HashSet()) { it.optString("id") }
    return local - cleared
}

/** 设置 →「角标」. Only the app-icon badge follows these; in-app badges always show. */
data class BadgePrefs(val enabled: Boolean = true, val calls: Boolean = true, val sms: Boolean = true) {
    val pushCalls: Boolean get() = enabled && calls
    val pushSms: Boolean get() = enabled && sms
}

internal fun iconBadgeCounts(calls: Int, sms: Int, prefs: BadgePrefs): Pair<Int, Int> =
    (if (prefs.pushCalls) calls.coerceAtLeast(0) else 0) to (if (prefs.pushSms) sms.coerceAtLeast(0) else 0)

internal fun iconBadgeValue(badges: ClientBadges, prefs: BadgePrefs): Int =
    iconBadgeCounts(badges.calls, badges.sms, prefs).let { it.first + it.second }

/** 「N 个待查看通话 · M 条未读短信」, zero parts omitted. */
internal fun badgeNotificationText(calls: Int, sms: Int): String = listOfNotNull(
    "$calls 个待查看通话".takeIf { calls > 0 },
    "$sms 条未读短信".takeIf { sms > 0 },
).joinToString(" · ")

internal data class BadgePush(val badge: Int, val calls: Int, val sms: Int)

/** FCM `badge.update` data message; everything arrives as strings. */
internal fun parseBadgePush(data: Map<String, String>): BadgePush? {
    if (data["event"] != "badge.update" || data["version"] != "1") return null
    val badge = data["badge"]?.toIntOrNull()?.takeIf { it >= 0 } ?: return null
    return BadgePush(
        badge,
        data["calls"]?.toIntOrNull()?.coerceAtLeast(0) ?: 0,
        data["sms"]?.toIntOrNull()?.coerceAtLeast(0) ?: 0,
    )
}

internal class BadgePrefsStore(context: Context) {
    private val prefs = context.applicationContext.getSharedPreferences(NAME, Context.MODE_PRIVATE)

    fun read() = BadgePrefs(
        prefs.getBoolean(KEY_ENABLED, true),
        prefs.getBoolean(KEY_CALLS, true),
        prefs.getBoolean(KEY_SMS, true),
    )

    fun write(value: BadgePrefs) {
        prefs.edit().putBoolean(KEY_ENABLED, value.enabled).putBoolean(KEY_CALLS, value.calls)
            .putBoolean(KEY_SMS, value.sms).apply()
    }

    private companion object {
        const val NAME = "badge_settings"
        const val KEY_ENABLED = "badge.enabled"
        const val KEY_CALLS = "badge.calls"
        const val KEY_SMS = "badge.sms"
    }
}

/**
 * The launcher badge rides on one silent notification (channel `badge`, IMPORTANCE_LOW so Pixel
 * still draws the dot). [calls]/[sms] are already filtered by [BadgePrefs].
 */
internal object BadgeNotifier {
    private const val CHANNEL = "badge"
    private const val NOTIFICATION_ID = 6700

    @SuppressLint("MissingPermission") // canShowCallNotification checks POST_NOTIFICATIONS
    fun show(context: Context, calls: Int, sms: Int) {
        val value = calls + sms
        val manager = NotificationManagerCompat.from(context)
        if (value <= 0 || !BadgePrefsStore(context).read().enabled) {
            manager.cancel(NOTIFICATION_ID)
            return
        }
        if (!canShowCallNotification(context)) return
        val channel = NotificationChannel(CHANNEL, "未读角标", NotificationManager.IMPORTANCE_LOW).apply {
            setShowBadge(true)
            setSound(null, null)
            enableVibration(false)
        }
        context.getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
        val open = PendingIntent.getActivity(
            context,
            NOTIFICATION_ID,
            Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val notification = NotificationCompat.Builder(context, CHANNEL)
            .setSmallIcon(R.drawable.ic_launcher_foreground)
            .setContentTitle("VoDog")
            .setContentText(badgeNotificationText(calls, sms))
            .setNumber(value)
            .setBadgeIconType(NotificationCompat.BADGE_ICON_SMALL)
            .setContentIntent(open)
            .setOnlyAlertOnce(true)
            .setSilent(true)
            .build()
        runCatching { manager.notify(NOTIFICATION_ID, notification) }.onFailure { error ->
            // S69：角标通知发不出去（权限被收回、渠道被删等）要能在诊断里看到。
            ClientDiag.log(
                "app.error",
                mapOf("site" to "badge.notify", "type" to error.javaClass.simpleName, "message" to error.message?.take(200)),
                level = "warn",
            )
        }
    }

    fun cancel(context: Context) = NotificationManagerCompat.from(context).cancel(NOTIFICATION_ID)
}
