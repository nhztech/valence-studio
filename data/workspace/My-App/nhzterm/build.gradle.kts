// nhzterm — root build file
// Toolchain note (build plan Part 1 Phase 0.2):
// Gradle + Android SDK setup are ALREADY solved by the Valence Framework.
// This project deliberately contains NO SDK-detection, SDK-install or
// Gradle-bootstrap logic. It expects:
//   * SDK platform 34 + build-tools 34 in ~/.valence/android-sdk
//   * the android.aapt2FromMavenOverride property already set
//     (Valence's setup-termux-android.sh writes it)
// See gradle.properties and local.properties.template.

plugins {
    id("com.android.application") version "8.5.2" apply false
    id("com.android.library") version "8.5.2" apply false
    id("org.jetbrains.kotlin.android") version "1.9.24" apply false
    id("org.jetbrains.kotlin.jvm") version "1.9.24" apply false
}

tasks.register<Delete>("clean") {
    delete(rootProject.layout.buildDirectory)
}
