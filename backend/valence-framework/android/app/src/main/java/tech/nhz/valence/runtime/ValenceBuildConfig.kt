package tech.nhz.valence.runtime

/** Defaults used by the framework template; the CLI overwrites this in generated apps. */
object ValenceBuildConfig {
    const val NETWORK_ENABLED: Boolean = false
    const val GOOGLE_WEB_CLIENT_ID: String = ""
    val ALLOWED_HOSTS: Set<String> = emptySet()
    val CAPABILITIES: Set<String> = setOf("filesystem", "database", "dialogs")
    val DECLARED_PERMISSIONS: Set<String> = emptySet()
}
