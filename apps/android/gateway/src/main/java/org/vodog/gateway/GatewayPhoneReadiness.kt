package org.vodog.gateway

/** Default builds keep telephony closed; only a reviewed acceptance build explicitly opts in. */
object GatewayPhoneFeatureApproval { const val APPROVED = BuildConfig.CELLULAR_ACCEPTANCE_ENABLED }

data class GatewayPhoneCapabilities(val telephonyReady: Boolean, val mediaReady: Boolean)

internal object GatewayPhoneReadinessPolicy {
    fun capabilities(
        approved: Boolean,
        controlEnabled: Boolean,
        handoffPrepared: Boolean,
        mediaReachable: Boolean = true,
    ): GatewayPhoneCapabilities {
        // Prepared handoff includes startup recovery, privileged permissions and legacy owners.
        // An active call is not a reason to withdraw capabilities needed to finish that call.
        val ready = approved && controlEnabled && handoffPrepared
        return GatewayPhoneCapabilities(ready, ready && mediaReachable)
    }
}
