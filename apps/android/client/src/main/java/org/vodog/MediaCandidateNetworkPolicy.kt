package org.vodog

import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import org.webrtc.PeerConnection

/**
 * S70 port of iOS S45 `MediaCandidateNetworkPolicy`: `LOW_COST` drops every high-cost adapter once a
 * lower-cost one exists, and the IMS `ipsec*`/tunnel interfaces count as low cost — on a cellular-only
 * phone that can strip the only interface that works. So LOW_COST only while Wi-Fi or Ethernet
 * carries the active network; otherwise gather on everything (more allocations, never zero).
 */
internal enum class MediaCandidateNetworkPolicy(val label: String, val webrtc: PeerConnection.CandidateNetworkPolicy) {
    LOW_COST("lowCost", PeerConnection.CandidateNetworkPolicy.LOW_COST),
    ALL("all", PeerConnection.CandidateNetworkPolicy.ALL),
    ;

    companion object {
        /** "Uses" (the active network), not "has available": a joined Wi-Fi not carrying traffic must not win. */
        fun choice(isSatisfied: Boolean, usesWiFi: Boolean, usesWiredEthernet: Boolean): MediaCandidateNetworkPolicy =
            if (isSatisfied && (usesWiFi || usesWiredEthernet)) LOW_COST else ALL

        fun current(connectivity: ConnectivityManager?): MediaCandidateNetworkPolicy {
            val caps = runCatching { connectivity?.getNetworkCapabilities(connectivity.activeNetwork) }.getOrNull()
                ?: return ALL
            return choice(
                isSatisfied = caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET),
                usesWiFi = caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI),
                usesWiredEthernet = caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET),
            )
        }
    }
}
