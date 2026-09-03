plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "tech.nhz.nhzterm"
    compileSdk = 34

    defaultConfig {
        applicationId = "tech.nhz.nhzterm"
        minSdk = 24
        targetSdk = 34
        versionCode = 1
        versionName = "0.1.0"

        externalNativeBuild {
            cmake {
                arguments += listOf("-DANDROID_STL=none")
                cFlags += listOf("-Wall", "-Wextra")
            }
        }

        ndk {
            // §12.1 / Phase 8: arm64-v8a is the deploy-blocking minimum
            // (primary phone target). x86_64 is emulator-only.
            abiFilters += listOf("arm64-v8a", "armeabi-v7a", "x86_64")
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }

    buildFeatures {
        buildConfig = true
    }

    externalNativeBuild {
        cmake {
            path = file("src/main/cpp/CMakeLists.txt")
            version = "3.22.1"
        }
    }

    packaging {
        jniLibs {
            // libnhzsh.so / libptyhelper.so must stay real files in the
            // native library dir — that dir is exec-permitted, which is what
            // sidesteps the Android 10+ W^X restriction (§12.1).
            useLegacyPackaging = true
        }
    }
}

dependencies {
    implementation(project(":nhzterm-api"))
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.8.1")
    testImplementation("junit:junit:4.13.2")
}
