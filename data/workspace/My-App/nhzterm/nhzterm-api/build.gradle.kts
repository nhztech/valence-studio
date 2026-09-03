plugins {
    id("com.android.library")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "tech.nhz.nhzterm.api"
    compileSdk = 34

    defaultConfig {
        minSdk = 24
        consumerProguardFiles("consumer-rules.pro")
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }

    testOptions {
        unitTests.isReturnDefaultValues = true
    }
}

dependencies {
    // org.json is part of the Android platform — no runtime dependency needed.
    // The Maven artifact is pulled in for JVM unit tests only, because the
    // android.jar stub throws on every org.json call.
    testImplementation("junit:junit:4.13.2")
    testImplementation("org.json:json:20240303")
}
