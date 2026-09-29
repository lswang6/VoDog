package org.vodog

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** S81: 通话 DTO 的 `simLabel`（被叫 SIM 显示名）驱动响铃副标题与内部通话本卡名。 */
class S81CalledSimLabelTest {
    @Test fun readsDtoSimLabelAndTreatsEmptyAsAbsent() {
        assertEquals("Demo SIM B", calledSimLabel(JSONObject().put("simLabel", "Demo SIM B")))
        assertNull(calledSimLabel(JSONObject()))
        assertNull(calledSimLabel(JSONObject().put("simLabel", "")))
        assertNull(calledSimLabel(JSONObject().put("simLabel", JSONObject.NULL)))
    }

    @Test fun internalTitleFallsBackToDtoSimLabelWithoutMergedSim() {
        val call = JSONObject().put("internal", true).put("direction", "incoming")
            .put("peerSimLabel", "Demo SIM A").put("simLabel", "Demo SIM B")
        assertEquals("内部通话 Demo SIM A → Demo SIM B", internalCallTitle(call))
        // 合并进来的 sim 对象仍优先。
        call.put("sim", JSONObject().put("phoneLabel", "133 0000"))
        assertEquals("内部通话 Demo SIM A → 133 0000", internalCallTitle(call))
    }
}
