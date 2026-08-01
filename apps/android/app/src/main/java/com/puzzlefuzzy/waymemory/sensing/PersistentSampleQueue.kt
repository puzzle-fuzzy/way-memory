package com.puzzlefuzzy.waymemory.sensing

import java.io.BufferedInputStream
import java.io.BufferedOutputStream
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.nio.charset.StandardCharsets
import java.nio.file.Files
import java.nio.file.StandardCopyOption

/**
 * A bounded, append-only write-ahead queue for samples waiting for the server.
 *
 * The queue is intentionally app-private and capped. A process crash may cause
 * a small number of unacknowledged samples to be sent again, which is safer than
 * losing a route segment; the server's bounded replay model remains unchanged.
 */
internal class PersistentSampleQueue(
    private val directory: File,
    private val maxSamples: Int = DEFAULT_MAX_SAMPLES,
    private val maxBytes: Long = DEFAULT_MAX_BYTES,
    private val codec: SampleCodec = CollectedSampleCodec,
) : AutoCloseable {
    private data class Record(val sample: CollectedSample, val bytes: Int)

    private val queue = ArrayDeque<Record>()
    private val spoolFile = File(directory, SPOOL_FILE_NAME)
    private val cursorFile = File(directory, CURSOR_FILE_NAME)
    private var acknowledgedBytes = 0L
    private var fileBytes = 0L
    private var pendingBytes = 0L
    private var output: FileOutputStream? = null
    private var bufferedOutput: BufferedOutputStream? = null
    private var lastFlushMs = 0L
    private var lastSyncMs = 0L

    init {
        require(maxSamples > 0)
        require(maxBytes > 0)
        load()
    }

    @Synchronized
    fun add(sample: CollectedSample): Int {
        val encoded = codec.encode(sample) + "\n"
        val bytes = encoded.toByteArray(StandardCharsets.UTF_8)
        append(bytes)
        queue.addLast(Record(sample, bytes.size))
        fileBytes += bytes.size
        pendingBytes += bytes.size

        var dropped = 0
        while (queue.size > maxSamples || pendingBytes > maxBytes) {
            val removed = queue.removeFirstOrNull() ?: break
            acknowledgedBytes += removed.bytes
            pendingBytes -= removed.bytes
            dropped += 1
        }
        compactIfNeeded()
        return dropped
    }

    @Synchronized
    fun peek(limit: Int): List<CollectedSample> = queue.take(limit.coerceAtLeast(0)).map { it.sample }

    @Synchronized
    fun acknowledge(count: Int) {
        repeat(count.coerceIn(0, queue.size)) {
            val removed = queue.removeFirst()
            acknowledgedBytes += removed.bytes
            pendingBytes -= removed.bytes
        }
        persistCursor()
        compactIfNeeded()
    }

    @Synchronized
    fun size(): Int = queue.size

    /** Explicit user action only; never call this during automatic recovery. */
    @Synchronized
    fun clear() {
        closeOutput()
        queue.clear()
        acknowledgedBytes = 0L
        fileBytes = 0L
        pendingBytes = 0L
        spoolFile.delete()
        cursorFile.delete()
    }

    @Synchronized
    override fun close() {
        flushAndSync()
        persistCursor()
        compactIfNeeded(force = true)
        closeOutput()
    }

    private fun load() {
        directory.mkdirs()
        if (!spoolFile.exists()) return
        val fileLength = spoolFile.length()
        acknowledgedBytes = cursorFile.readText(StandardCharsets.UTF_8).trim().toLongOrNull()?.coerceIn(0L, fileLength) ?: 0L
        fileBytes = fileLength
        if (acknowledgedBytes >= fileLength) {
            compactIfNeeded(force = true)
            return
        }

        FileInputStream(spoolFile).use { input ->
            skipFully(input, acknowledgedBytes)
            val data = BufferedInputStream(input).readBytes()
            val text = data.toString(StandardCharsets.UTF_8)
            var parsedBytes = acknowledgedBytes
            text.split('\n').forEach { line ->
                if (line.isBlank()) {
                    parsedBytes += 1
                    return@forEach
                }
                val sample = codec.decode(line) ?: return@forEach
                val recordBytes = line.toByteArray(StandardCharsets.UTF_8).size + 1
                queue.addLast(Record(sample, recordBytes))
                pendingBytes += recordBytes
                parsedBytes += recordBytes
            }
            if (parsedBytes < fileLength) {
                // Ignore a torn final line after a process kill; a later append
                // and compaction will remove it without affecting valid records.
                fileBytes = parsedBytes
            }
        }
        while (queue.size > maxSamples || pendingBytes > maxBytes) {
            val removed = queue.removeFirstOrNull() ?: break
            acknowledgedBytes += removed.bytes
            pendingBytes -= removed.bytes
        }
        compactIfNeeded()
    }

    private fun append(bytes: ByteArray) {
        if (bufferedOutput == null) {
            output = FileOutputStream(spoolFile, true)
            bufferedOutput = BufferedOutputStream(output, BUFFER_SIZE)
        }
        bufferedOutput!!.write(bytes)
        val now = System.currentTimeMillis()
        if (now - lastFlushMs >= FLUSH_INTERVAL_MS) flushAndSync()
    }

    private fun flushAndSync() {
        bufferedOutput?.flush()
        val now = System.currentTimeMillis()
        if (bufferedOutput != null && now - lastSyncMs >= SYNC_INTERVAL_MS) {
            output?.fd?.sync()
            lastSyncMs = now
        }
        lastFlushMs = now
    }

    private fun persistCursor() {
        flushAndSync()
        directory.mkdirs()
        val temp = File(directory, "$CURSOR_FILE_NAME.tmp")
        temp.writeText(acknowledgedBytes.toString(), StandardCharsets.UTF_8)
        replaceFile(temp, cursorFile)
    }

    private fun compactIfNeeded(force: Boolean = false) {
        if (!force && (acknowledgedBytes < COMPACTION_THRESHOLD_BYTES || acknowledgedBytes * 2 < fileBytes)) return
        flushAndSync()
        closeOutput()
        val remaining = queue.joinToString(separator = "") { codec.encode(it.sample) + "\n" }
        val temp = File(directory, "$SPOOL_FILE_NAME.tmp")
        temp.writeText(remaining, StandardCharsets.UTF_8)
        replaceFile(temp, spoolFile)
        acknowledgedBytes = 0L
        fileBytes = spoolFile.length()
        persistCursor()
    }

    private fun closeOutput() {
        bufferedOutput?.close()
        bufferedOutput = null
        output = null
    }

    private fun replaceFile(temp: File, target: File) {
        runCatching {
            Files.move(
                temp.toPath(),
                target.toPath(),
                StandardCopyOption.REPLACE_EXISTING,
                StandardCopyOption.ATOMIC_MOVE,
            )
        }.recoverCatching {
            Files.move(temp.toPath(), target.toPath(), StandardCopyOption.REPLACE_EXISTING)
        }.getOrThrow()
    }

    private fun skipFully(input: FileInputStream, bytes: Long) {
        var remaining = bytes
        while (remaining > 0) {
            val skipped = input.skip(remaining)
            if (skipped <= 0) throw IllegalStateException("Unable to seek the sample spool cursor")
            remaining -= skipped
        }
    }

    companion object {
        private const val SPOOL_FILE_NAME = "pending-samples.ndjson"
        private const val CURSOR_FILE_NAME = "pending-samples.cursor"
        private const val BUFFER_SIZE = 64 * 1024
        private const val FLUSH_INTERVAL_MS = 250L
        private const val SYNC_INTERVAL_MS = 1_000L
        private const val COMPACTION_THRESHOLD_BYTES = 1L * 1024L * 1024L
        const val DEFAULT_MAX_SAMPLES = 4_096
        const val DEFAULT_MAX_BYTES = 8L * 1024L * 1024L
    }
}
