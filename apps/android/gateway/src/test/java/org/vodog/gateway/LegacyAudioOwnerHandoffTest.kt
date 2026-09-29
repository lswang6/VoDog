package org.vodog.gateway

import android.content.pm.PackageManager
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class LegacyAudioOwnerHandoffTest {
    @Test fun absentOptionalBcpCanAcquireReleaseAndRecoverWithoutComponentMutation() {
        val journal = MemoryHandoffJournal()
        val backend = FakeComponents().apply { states.remove(LegacyAudioOwnerHandoff.BCP) }
        val handoff = LegacyAudioOwnerHandoff(journal, backend, FakeCleanup(backend.events)) { true }
        repeat(2) { attempt ->
            assertEquals(AudioHandoffResult.Acquired, handoff.acquire())
            assertTrue(journal.record.originals.isEmpty())
            backend.events.clear()
            assertEquals(AudioHandoffResult.Restored,
                if (attempt == 0) handoff.release() else handoff.recoverAfterProcessStart())
            assertEquals(listOf("stop", "restore-mute"), backend.events)
            assertEquals(AudioHandoffPhase.IDLE, journal.record.phase)
        }
    }

    @Test fun acquireRequiresNoCallBeforeAndAfterDisabling() {
        val journal = MemoryHandoffJournal(); val backend = FakeComponents(); val cleanup = FakeCleanup()
        val callChecks = ArrayDeque(listOf(true, false))
        val result = LegacyAudioOwnerHandoff(journal, backend, cleanup) { callChecks.removeFirst() }.acquire()
        assertEquals(AudioHandoffResult.Failed("active_call_during_handoff"), result)
        assertEquals(AudioHandoffPhase.IDLE, journal.record.phase)
        assertEquals(PackageManager.COMPONENT_ENABLED_STATE_DEFAULT, backend.states[LegacyAudioOwnerHandoff.BCP])
        assertEquals(PackageManager.COMPONENT_ENABLED_STATE_DEFAULT, backend.states[LegacyAudioOwnerHandoff.BCR])
    }

    @Test fun releaseStopsAudioRestoresMuteThenRestoresComponentsInReverseOrder() {
        val journal = MemoryHandoffJournal(); val backend = FakeComponents(); val cleanup = FakeCleanup(backend.events)
        backend.states[LegacyAudioOwnerHandoff.BCP] = PackageManager.COMPONENT_ENABLED_STATE_DISABLED_USER
        backend.states[LegacyAudioOwnerHandoff.BCR] = PackageManager.COMPONENT_ENABLED_STATE_ENABLED
        val handoff = LegacyAudioOwnerHandoff(journal, backend, cleanup) { true }
        assertEquals(AudioHandoffResult.Acquired, handoff.acquire())
        backend.events.clear()
        assertEquals(AudioHandoffResult.Restored, handoff.release())
        // S41 §决策1: BCR is never disabled and never restored by a record this build wrote.
        assertEquals(listOf("stop", "restore-mute", "set:bcp:3"), backend.events)
        assertEquals(PackageManager.COMPONENT_ENABLED_STATE_ENABLED, backend.states[LegacyAudioOwnerHandoff.BCR])
        assertEquals(AudioHandoffPhase.IDLE, journal.record.phase)
    }

    @Test fun partialDisableFailureRollsBackEveryOriginalState() {
        val journal = MemoryHandoffJournal(); val backend = FakeComponents(failDisableKey = LegacyAudioOwnerHandoff.BCP)
        backend.states[LegacyAudioOwnerHandoff.BCP] = PackageManager.COMPONENT_ENABLED_STATE_ENABLED
        backend.states[LegacyAudioOwnerHandoff.BCR] = PackageManager.COMPONENT_ENABLED_STATE_DISABLED_USER
        val result = LegacyAudioOwnerHandoff(journal, backend, FakeCleanup()) { true }.acquire()
        assertTrue(result is AudioHandoffResult.Failed)
        assertEquals(PackageManager.COMPONENT_ENABLED_STATE_ENABLED, backend.states[LegacyAudioOwnerHandoff.BCP])
        assertEquals(PackageManager.COMPONENT_ENABLED_STATE_DISABLED_USER, backend.states[LegacyAudioOwnerHandoff.BCR])
        assertEquals(AudioHandoffPhase.IDLE, journal.record.phase)
    }

    /** S41 §决策1 upgrade path: the pre-upgrade record still owns BCR, so process start re-enables it. */
    @Test fun preUpgradeAcquiredRecordRestoresBcrAndTheNextAcquireOnlyTakesBcp() {
        val journal = MemoryHandoffJournal(AudioHandoffRecord(
            AudioHandoffPhase.ACQUIRED,
            listOf(
                SavedComponentState(LegacyAudioOwnerHandoff.BCP, PackageManager.COMPONENT_ENABLED_STATE_DEFAULT),
                SavedComponentState(LegacyAudioOwnerHandoff.BCR, PackageManager.COMPONENT_ENABLED_STATE_DEFAULT),
            ),
        ))
        val backend = FakeComponents().apply {
            states.keys.forEach { states[it] = PackageManager.COMPONENT_ENABLED_STATE_DISABLED }
        }
        val handoff = LegacyAudioOwnerHandoff(journal, backend, FakeCleanup(backend.events)) { true }
        assertEquals(AudioHandoffResult.Restored, handoff.recoverAfterProcessStart())
        assertEquals(PackageManager.COMPONENT_ENABLED_STATE_DEFAULT, backend.states[LegacyAudioOwnerHandoff.BCR])
        assertEquals(AudioHandoffPhase.IDLE, journal.record.phase)
        assertEquals(AudioHandoffResult.Acquired, handoff.acquire())
        assertEquals(PackageManager.COMPONENT_ENABLED_STATE_DISABLED, backend.states[LegacyAudioOwnerHandoff.BCP])
        assertEquals(PackageManager.COMPONENT_ENABLED_STATE_DEFAULT, backend.states[LegacyAudioOwnerHandoff.BCR])
        assertEquals(listOf(LegacyAudioOwnerHandoff.BCP), journal.record.originals.map(SavedComponentState::key))
    }

    @Test fun acquiredStateAfterProcessRestartIsAlwaysRestored() {
        val journal = MemoryHandoffJournal(AudioHandoffRecord(
            AudioHandoffPhase.ACQUIRED,
            listOf(
                SavedComponentState(LegacyAudioOwnerHandoff.BCP, PackageManager.COMPONENT_ENABLED_STATE_DEFAULT),
                SavedComponentState(LegacyAudioOwnerHandoff.BCR, PackageManager.COMPONENT_ENABLED_STATE_ENABLED),
            ),
        ))
        val backend = FakeComponents().apply {
            states.keys.forEach { states[it] = PackageManager.COMPONENT_ENABLED_STATE_DISABLED }
        }
        val cleanup = FakeCleanup(backend.events)
        assertEquals(AudioHandoffResult.Restored,
            LegacyAudioOwnerHandoff(journal, backend, cleanup) { true }.recoverAfterProcessStart())
        assertEquals("stop", backend.events.first())
        assertEquals(AudioHandoffPhase.IDLE, journal.record.phase)
    }

    @Test fun cleanupFailureDoesNotSkipComponentRestoreAndRemainsRecoverable() {
        val journal = MemoryHandoffJournal(AudioHandoffRecord(
            AudioHandoffPhase.ACQUIRED,
            LegacyAudioOwnerHandoff.LEGACY_KEYS.map { SavedComponentState(it, PackageManager.COMPONENT_ENABLED_STATE_DEFAULT) },
        ))
        val backend = FakeComponents().apply { states.keys.forEach { states[it] = PackageManager.COMPONENT_ENABLED_STATE_DISABLED } }
        val result = LegacyAudioOwnerHandoff(journal, backend, FakeCleanup(stopOk = false)) { true }.release()
        assertTrue(result is AudioHandoffResult.Failed)
        assertEquals(PackageManager.COMPONENT_ENABLED_STATE_DEFAULT, backend.states[LegacyAudioOwnerHandoff.BCP])
        assertEquals(PackageManager.COMPONENT_ENABLED_STATE_DISABLED, backend.states[LegacyAudioOwnerHandoff.BCR])
        assertEquals(AudioHandoffPhase.RESTORE_FAILED, journal.record.phase)
    }

    @Test fun cleanupExceptionsAreBoundedAndTheAcquiredComponentStillRestores() {
        val journal = MemoryHandoffJournal(AudioHandoffRecord(
            AudioHandoffPhase.ACQUIRED,
            LegacyAudioOwnerHandoff.LEGACY_KEYS.map {
                SavedComponentState(it, PackageManager.COMPONENT_ENABLED_STATE_DEFAULT)
            },
        ))
        val backend = FakeComponents().apply {
            states.keys.forEach { states[it] = PackageManager.COMPONENT_ENABLED_STATE_DISABLED }
        }
        val result = LegacyAudioOwnerHandoff(
            journal, backend, FakeCleanup(throwStop = true, throwMute = true),
        ) { true }.release()
        assertTrue(result is AudioHandoffResult.Failed)
        assertEquals(PackageManager.COMPONENT_ENABLED_STATE_DEFAULT, backend.states[LegacyAudioOwnerHandoff.BCP])
        assertEquals(PackageManager.COMPONENT_ENABLED_STATE_DISABLED, backend.states[LegacyAudioOwnerHandoff.BCR])
        assertEquals(AudioHandoffPhase.RESTORE_FAILED, journal.record.phase)
        assertTrue(journal.record.failureCode.orEmpty().contains("audio_stop_exception"))
        assertTrue(journal.record.failureCode.orEmpty().contains("mute_restore_exception"))
    }

    @Test fun journalWriteFailureCannotPreventPhysicalCleanupAndComponentRestore() {
        val journal = MemoryHandoffJournal(AudioHandoffRecord(
            AudioHandoffPhase.ACQUIRED,
            LegacyAudioOwnerHandoff.LEGACY_KEYS.map {
                SavedComponentState(it, PackageManager.COMPONENT_ENABLED_STATE_DEFAULT)
            },
        ), failWrites = true)
        val backend = FakeComponents().apply {
            states.keys.forEach { states[it] = PackageManager.COMPONENT_ENABLED_STATE_DISABLED }
        }
        val result = LegacyAudioOwnerHandoff(journal, backend, FakeCleanup(backend.events)) { true }.release()
        assertTrue(result is AudioHandoffResult.Failed)
        assertTrue((result as AudioHandoffResult.Failed).code.contains("journal_write_failed"))
        assertEquals(listOf("stop", "restore-mute", "set:bcp:0"), backend.events)
        assertEquals(PackageManager.COMPONENT_ENABLED_STATE_DEFAULT, backend.states[LegacyAudioOwnerHandoff.BCP])
        assertEquals(PackageManager.COMPONENT_ENABLED_STATE_DISABLED, backend.states[LegacyAudioOwnerHandoff.BCR])
    }
}

private class MemoryHandoffJournal(
    var record: AudioHandoffRecord = AudioHandoffRecord(AudioHandoffPhase.IDLE, emptyList()),
    private val failWrites: Boolean = false,
) : AudioHandoffJournal {
    override fun read() = record
    override fun write(record: AudioHandoffRecord) {
        if (failWrites) error("journal unavailable")
        this.record = record
    }
}

private class FakeComponents(private val failDisableKey: String? = null) : LegacyComponentBackend {
    // Both audited components exist on the device even though only BCP is still acquired.
    val states = listOf(LegacyAudioOwnerHandoff.BCP, LegacyAudioOwnerHandoff.BCR).associateWith {
        PackageManager.COMPONENT_ENABLED_STATE_DEFAULT
    }.toMutableMap()
    val events = mutableListOf<String>()
    override fun canChangeComponents() = true
    override fun currentState(key: String) = states[key]
    override fun setState(key: String, state: Int) {
        if (key == failDisableKey && state == PackageManager.COMPONENT_ENABLED_STATE_DISABLED) error("blocked")
        states[key] = state; events += "set:$key:$state"
    }
}

private class FakeCleanup(
    private val events: MutableList<String> = mutableListOf(),
    private val stopOk: Boolean = true,
    private val muteOk: Boolean = true,
    private val throwStop: Boolean = false,
    private val throwMute: Boolean = false,
) : GatewayAudioSessionCleanup {
    override fun stopAndRelease(): Boolean {
        events += "stop"
        if (throwStop) error("stop exploded")
        return stopOk
    }
    override fun restorePreSessionMuteState(): Boolean {
        events += "restore-mute"
        if (throwMute) error("mute exploded")
        return muteOk
    }
}
