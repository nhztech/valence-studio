package tech.nhz.nhzterm.daemon

import java.io.File
import java.security.MessageDigest
import java.security.SecureRandom

/**
 * run/auth.token (§8, §13).
 *
 * Generated once on first daemon start, reused thereafter so a restarted
 * daemon does not invalidate every client's stored token.
 *
 * The token is defense-in-depth: app-private storage is already unreadable by
 * other apps, and the service is signature-permission guarded. This exists for
 * the cross-app case (Valence Studio) and to keep a compromised-but-unprivileged
 * local process from driving sessions.
 */
object AuthToken {

    private const val TOKEN_BYTES = 32

    /** Loads the existing token, or generates and persists a new one. */
    fun loadOrCreate(file: File): String {
        if (file.isFile) {
            val existing = runCatching { file.readText().trim() }.getOrDefault("")
            // A truncated/empty token file (e.g. killed mid-write) must be
            // regenerated rather than accepted as a weak credential.
            if (existing.length >= TOKEN_BYTES * 2) return existing
        }
        return generate().also { persist(file, it) }
    }

    private fun generate(): String {
        val raw = ByteArray(TOKEN_BYTES)
        SecureRandom().nextBytes(raw)
        return raw.joinToString("") { "%02x".format(it) }
    }

    private fun persist(file: File, token: String) {
        file.parentFile?.mkdirs()
        // Create empty, lock down, THEN write — never leave a readable window
        // where the secret is on disk with default permissions.
        if (!file.exists()) file.createNewFile()
        file.setReadable(false, false)
        file.setWritable(false, false)
        file.setExecutable(false, false)
        file.setReadable(true, true)
        file.setWritable(true, true)
        file.writeText(token)
    }

    /**
     * Constant-time comparison. A naive == leaks length and prefix via timing;
     * cheap to avoid, so avoid it.
     */
    fun matches(expected: String, provided: String?): Boolean {
        if (provided == null) return false
        val a = expected.toByteArray(Charsets.UTF_8)
        val b = provided.toByteArray(Charsets.UTF_8)
        // Hash both sides first so unequal lengths don't short-circuit.
        val da = MessageDigest.getInstance("SHA-256").digest(a)
        val db = MessageDigest.getInstance("SHA-256").digest(b)
        var diff = 0
        for (i in da.indices) diff = diff or (da[i].toInt() xor db[i].toInt())
        return diff == 0
    }
}
