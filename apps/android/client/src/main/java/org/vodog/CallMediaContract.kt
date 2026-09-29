package org.vodog

import org.json.JSONObject

enum class CallMediaTransport(val wireValue: String, val label: String) {
    UDP("udp", "UDP"),
    TLS("tls", "TLS"),
}

data class CallMediaIceServer(
    val url: String,
    val username: String,
    val credential: String,
    /** S72b: IP 形式的中转 TURN URL 的 TLS SNI / 证书校验名（libwebrtc IceServer.hostname）。 */
    val hostname: String? = null,
)

data class CallMediaOptions(
    val iceServer: CallMediaIceServer,
    val iceTransportPolicy: String,
    /** S73b: Control returned the cellular relay TURN (only for TLS requests on the relay node); absent = false. */
    val relay: Boolean = false,
) {
    companion object {
        fun parse(json: JSONObject, transport: CallMediaTransport): CallMediaOptions {
            require(json.getString("iceTransportPolicy") == "relay") { "服务器未要求中继连接" }
            val servers = json.getJSONArray("iceServers")
            require(servers.length() == 1) { "服务器必须只返回一个 TURN 服务" }
            val server = servers.getJSONObject(0)
            val urls = server.getJSONArray("urls")
            require(urls.length() == 1) { "每次媒体连接必须只使用一个 TURN URL" }
            val url = urls.getString(0)
            val lower = url.lowercase()
            val valid = when (transport) {
                CallMediaTransport.UDP -> lower.startsWith("turn:") && "transport=udp" in lower
                CallMediaTransport.TLS -> lower.startsWith("turns:") && "transport=tcp" in lower
            }
            require(valid) { "TURN URL 与所选传输不匹配" }
            val username = server.getString("username")
            val credential = server.getString("credential")
            require(username.isNotBlank() && credential.isNotBlank()) { "TURN 凭据无效" }
            val hostname = server.optString("hostname").takeIf(String::isNotBlank)
            require(hostname == null || (transport == CallMediaTransport.TLS && TURN_HOSTNAME.matches(hostname))) { "TURN 主机名无效" }
            return CallMediaOptions(CallMediaIceServer(url, username, credential, hostname), "relay", json.opt("relay") == true)
        }
    }
}

private val TURN_HOSTNAME = Regex("^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\\.)+[a-z]{2,63}$", RegexOption.IGNORE_CASE)

data class CallMediaDescription(val type: String, val sdp: String)

/**
 * S20 D1: the one Opus bitrate for every client, kept as its own constant so a bitrate rollback and
 * the DTX removal stay independently revertable. 32 kbps equals libwebrtc's own fullband mono
 * default, so this is a raise for Android (was 16 kbps) and a no-op for iOS.
 */
internal const val OPUS_MAX_AVERAGE_BITRATE = 32000

/** S70: both gateways decode at ≤16 kHz, so cap the encoder at wideband; separate so it rolls back alone (S20 invariant 5). */
internal const val OPUS_WIDEBAND_LIMIT = "maxplaybackrate=16000;sprop-maxcapturerate=16000"

internal fun opusOnlyVoiceSdp(sdp: String): String {
    val lines = sdp.split("\r\n")
    val opusPayload = lines.firstNotNullOfOrNull { line ->
        Regex("^a=rtpmap:(\\d+) opus/48000(?:/2)?$", RegexOption.IGNORE_CASE)
            .matchEntire(line)?.groupValues?.get(1)
    } ?: error("当前设备未提供 Opus 音频能力")
    var foundAudio = false
    val filtered = lines.filterNot { line ->
        if (line.startsWith("m=audio ")) {
            foundAudio = true
            false
        } else {
            val payload = Regex("^a=(?:rtpmap|fmtp|rtcp-fb):(\\d+)").find(line)?.groupValues?.get(1)
            payload != null && payload != opusPayload
        }
    }.map { line ->
        if (!line.startsWith("m=audio ")) line
        else line.split(' ').take(3).plus(opusPayload).joinToString(" ")
    }.filterNot { it.startsWith("a=fmtp:$opusPayload ") }.toMutableList()
    check(foundAudio) { "音频协商缺少音轨" }
    val rtpIndex = filtered.indexOfFirst { it.startsWith("a=rtpmap:$opusPayload ", ignoreCase = true) }
    check(rtpIndex >= 0) { "音频协商缺少 Opus" }
    filtered.add(
        rtpIndex + 1,
        // No `usedtx=1`: DTX silence gaps exceed the Pixel playout buffer's 200 ms resync threshold
        // and reset its decoder roughly every 400 ms of silence (S20 D1).
        "a=fmtp:$opusPayload minptime=10;useinbandfec=1;stereo=0;sprop-stereo=0;maxaveragebitrate=$OPUS_MAX_AVERAGE_BITRATE;$OPUS_WIDEBAND_LIMIT",
    )
    return filtered.joinToString("\r\n")
}

/**
 * S70: the receive/send quality counters every client adds to its end-of-call media summary, from
 * the audio `inbound-rtp` / `outbound-rtp` stats. Input is `type` plus members so it tests without
 * libwebrtc; uint64 members arrive as BigInteger, hence [Number].
 */
internal fun mediaRxTx(stats: Collection<Pair<String, Map<String, Any?>>>): Map<String, Map<String, Number>> {
    val rx = linkedMapOf<String, Number>()
    val tx = linkedMapOf<String, Number>()
    fun Map<String, Any?>.num(key: String): Double? = (this[key] as? Number)?.toDouble()?.takeIf { it.isFinite() }
    fun Double.tenths(): Double = Math.round(this * 10) / 10.0
    for ((type, members) in stats) {
        if (members["kind"] != "audio") continue
        when (type) {
            "inbound-rtp" -> {
                for (key in listOf(
                    "packetsReceived", "packetsLost", "concealedSamples", "totalSamplesReceived", "concealmentEvents",
                    "insertedSamplesForDeceleration", "removedSamplesForAcceleration",
                )) members.num(key)?.let { rx[key] = it.toLong() }
                members.num("jitter")?.let { rx["jitterMs"] = (it * 1000).tenths() }
                val delay = members.num("jitterBufferDelay")
                val emitted = members.num("jitterBufferEmittedCount")
                if (delay != null && emitted != null && emitted > 0) {
                    rx["jitterBufferMs"] = (delay / emitted * 1000).tenths()
                    // Same average for NetEq's target (as iOS): jitterBufferMs well above it = backlog.
                    members.num("jitterBufferTargetDelay")?.let { rx["jitterBufferTargetMs"] = (it / emitted * 1000).tenths() }
                }
            }
            "outbound-rtp" -> for (key in listOf("packetsSent", "bytesSent")) members.num(key)?.let { tx[key] = it.toLong() }
        }
    }
    return mapOf("rx" to rx, "tx" to tx)
}

/**
 * S70 (iOS `MediaRtpWindow`): the NetEq counters `media.stats` averages over the interval since the
 * previous row of the same PeerConnection. [rtpWindowSample] reads the raw counters; [rtpWindow]
 * diffs two of them. A new PC starts with `before == null` (no window on its first row).
 */
internal fun rtpWindowSample(stats: Collection<Pair<String, Map<String, Any?>>>): Map<String, Double>? {
    val members = stats.firstOrNull { (type, m) -> type == "inbound-rtp" && m["kind"] == "audio" }?.second ?: return null
    return listOf(
        "jitterBufferDelay", "jitterBufferTargetDelay", "jitterBufferEmittedCount",
        "concealmentEvents", "removedSamplesForAcceleration", "packetsReceived",
    ).mapNotNull { key -> (members[key] as? Number)?.toDouble()?.takeIf { it.isFinite() }?.let { key to it } }.toMap()
}

internal fun rtpWindow(before: Map<String, Double>?, now: Map<String, Double>?): Map<String, Number> {
    if (before == null || now == null) return emptyMap()
    fun delta(key: String): Double? { return (now[key] ?: return null) - (before[key] ?: return null) }
    val out = linkedMapOf<String, Number>()
    for ((key, name) in listOf(
        "concealmentEvents" to "concealmentEventsWin",
        "removedSamplesForAcceleration" to "removedSamplesForAccelerationWin",
        "packetsReceived" to "packetsReceivedWin",
    )) delta(key)?.let { out[name] = it.toLong() }
    val emitted = delta("jitterBufferEmittedCount")
    if (emitted != null && emitted > 0) {
        delta("jitterBufferDelay")?.let { out["jitterBufferWinMs"] = Math.round(it / emitted * 10_000) / 10.0 }
        delta("jitterBufferTargetDelay")?.let { out["jitterBufferTargetWinMs"] = Math.round(it / emitted * 10_000) / 10.0 }
    }
    return out
}
