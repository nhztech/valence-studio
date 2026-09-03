package tech.nhz.nhzterm.session

/**
 * Bounded scrollback (§8: ~5,000 lines/session, ring buffer).
 *
 * Stores LINES, not bytes, because the spec is expressed in lines and because
 * a byte-capped buffer would replay a torn escape sequence on attach and
 * corrupt the client's renderer.
 *
 * A terminal emits partial lines constantly (a shell prompt has no trailing
 * newline), so the tail is held separately until its newline arrives.
 *
 * Thread-safety: every method synchronizes. The PTY reader thread appends
 * while an attaching client snapshots.
 */
class ScrollbackBuffer(private val maxLines: Int) {

    private val lines = ArrayDeque<String>(minOf(maxLines, 1024))
    private val partial = StringBuilder()

    /** Total bytes retained, so the daemon can log memory pressure. */
    @Volatile
    var approximateBytes: Int = 0
        private set

    fun append(data: String) {
        if (data.isEmpty()) return
        synchronized(this) {
            var start = 0
            while (true) {
                val nl = data.indexOf('\n', start)
                if (nl < 0) {
                    // No newline: the remainder is an unterminated line (prompt,
                    // progress bar, partial TUI frame). Hold it.
                    partial.append(data, start, data.length)
                    break
                }
                partial.append(data, start, nl + 1)
                pushLine(partial.toString())
                partial.setLength(0)
                start = nl + 1
            }
            // A TUI redrawing in place never emits a newline. Without this
            // guard, `htop` would grow `partial` without bound.
            if (partial.length > MAX_PARTIAL) {
                pushLine(partial.toString())
                partial.setLength(0)
            }
        }
    }

    private fun pushLine(line: String) {
        lines.addLast(line)
        approximateBytes += line.length
        while (lines.size > maxLines) {
            approximateBytes -= lines.removeFirst().length
        }
    }

    /** Everything retained, including the unterminated tail. Replayed on attach. */
    fun snapshot(): String = synchronized(this) {
        val sb = StringBuilder(approximateBytes + partial.length)
        lines.forEach { sb.append(it) }
        sb.append(partial)
        sb.toString()
    }

    fun lineCount(): Int = synchronized(this) { lines.size }

    fun clear() = synchronized(this) {
        lines.clear()
        partial.setLength(0)
        approximateBytes = 0
    }

    private companion object {
        /** Flush an unterminated line beyond this length. 64 KiB of no newline
         *  is a redraw, not a line. */
        const val MAX_PARTIAL = 64 * 1024
    }
}
