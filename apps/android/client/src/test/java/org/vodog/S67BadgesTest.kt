package org.vodog

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.assertNull
import org.junit.Test

class S67BadgesTest {
    private val badges = ClientBadges(calls = 3, sms = 5)

    @Test fun iconValueFollowsPrefs() {
        assertEquals(8, iconBadgeValue(badges, BadgePrefs()))
        assertEquals(3, iconBadgeValue(badges, BadgePrefs(sms = false)))
        assertEquals(5, iconBadgeValue(badges, BadgePrefs(calls = false)))
        assertEquals(0, iconBadgeValue(badges, BadgePrefs(enabled = false)))
        assertEquals(0 to 0, iconBadgeCounts(3, 5, BadgePrefs(enabled = false)))
    }

    @Test fun labelHidesZeroAndCapsAt99() {
        assertNull(badgeLabel(0))
        assertNull(badgeLabel(-1))
        assertEquals("7", badgeLabel(7))
        assertEquals("99", badgeLabel(99))
        assertEquals("99+", badgeLabel(100))
    }

    @Test fun notificationTextOmitsZeroParts() {
        assertEquals("2 个待查看通话 · 1 条未读短信", badgeNotificationText(2, 1))
        assertEquals("2 个待查看通话", badgeNotificationText(2, 0))
        assertEquals("1 条未读短信", badgeNotificationText(0, 1))
    }

    @Test fun parsesBadgesResponse() {
        val parsed = parseBadges(JSONObject("""{"calls":2,"sms":4,"sims":[{"simId":"s1","calls":2,"sms":1},{"simId":"","calls":9,"sms":9}]}"""))
        assertEquals(2, parsed.calls)
        assertEquals(4, parsed.sms)
        assertEquals(mapOf("s1" to 2), parsed.simCalls())
        assertEquals(mapOf("s1" to 1), parsed.simSms())
        assertEquals(mapOf("s1" to 3), parsed.simTotal())
    }

    @Test fun parsesBadgePushAndRejectsOthers() {
        val data = mapOf(
            "version" to "1", "event" to "badge.update", "notificationId" to "5b9d8d2e-1f0c-4c38-9a53-6c1b2f7a0e11",
            "badge" to "4", "calls" to "3", "sms" to "1",
        )
        assertEquals(BadgePush(4, 3, 1), parseBadgePush(data))
        assertEquals(BadgePush(0, 0, 0), parseBadgePush(mapOf("version" to "1", "event" to "badge.update", "badge" to "0")))
        assertNull(parseBadgePush(data + ("badge" to "x")))
        assertNull(parseBadgePush(data + ("badge" to "-1")))
        assertNull(parseBadgePush(data + ("version" to "2")))
        assertNull(parseBadgePush(data + ("event" to "call.incoming")))
        // The incoming-call parser still rejects badge pushes, so routing order matters.
        assertNull(parseIncomingPush(data))
    }

    @Test fun rowDotsFollowServerFlagsAndLocalMarks() {
        val unseen = JSONObject("""{"id":"c1","unseen":true}""")
        assertTrue(callShowsUnseenDot(unseen, emptySet()))
        assertFalse(callShowsUnseenDot(unseen, setOf("c1")))
        assertFalse(callShowsUnseenDot(JSONObject("""{"id":"c2"}"""), emptySet())) // old Control: no field
        val messages = listOf(
            JSONObject("""{"id":"m1","direction":"incoming","unread":false}""").toClientSmsMessage(),
            JSONObject("""{"id":"m2","direction":"incoming","unread":true}""").toClientSmsMessage(),
        )
        assertTrue(conversationShowsUnreadDot(messages, emptySet()))
        assertFalse(conversationShowsUnreadDot(messages, setOf("m2")))
    }

    @Test fun pruneKeepsOnlyIdsTheServerStillFlags() {
        val items = listOf(JSONObject("""{"id":"a","unseen":false}"""), JSONObject("""{"id":"b","unseen":true}"""))
        assertEquals(setOf("b", "z"), pruneLocallyCleared(setOf("a", "b", "z"), items, "unseen"))
        assertEquals(setOf("a"), prunedLocalIds(setOf("a"), RemoteList.Failed("x"), "unseen"))
    }
}
