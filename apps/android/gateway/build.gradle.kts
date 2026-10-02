import java.net.URI

plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.compose.compiler)
}

// Explicit opt-in for a reviewed, attended cellular acceptance candidate only.
val cellularAcceptance = providers.gradleProperty("vodogCellularAcceptance").orElse("false").get()
require(cellularAcceptance in setOf("true", "false")) { "vodogCellularAcceptance must be true or false" }
val recordingArchive = providers.gradleProperty("vodogRecordingArchive").orElse("false").get()
require(recordingArchive in setOf("true", "false")) { "vodogRecordingArchive must be true or false" }
val recordingArchiveMinFreeBytes = providers.gradleProperty("vodogRecordingArchiveMinFreeBytes")
    .orElse((1024L * 1024 * 1024).toString()).get().toLong()
require(recordingArchiveMinFreeBytes >= 256L * 1024 * 1024) {
    "vodogRecordingArchiveMinFreeBytes must reserve at least 256 MiB"
}
// Isolated codec experiment. Production remains on MediaCodec unless explicitly opted in.
val libopusFec = providers.gradleProperty("vodogLibopusFec").orElse("false").get()
require(libopusFec in setOf("true", "false")) { "vodogLibopusFec must be true or false" }
val libopusFecEnabled = libopusFec == "true"
val receiveRecovery = providers.gradleProperty("vodogReceiveRecovery").orElse("false").get()
require(receiveRecovery in setOf("true", "false")) { "vodogReceiveRecovery must be true or false" }
require(receiveRecovery != "true" || libopusFecEnabled) { "receive recovery requires native libopus" }
val commandReplayHorizon = providers.gradleProperty("vodogCommandReplayHorizon").orElse("false").get()
require(commandReplayHorizon in setOf("true", "false")) {
    "vodogCommandReplayHorizon must be true or false"
}

val vodogRelayApiBaseUrl = providers.gradleProperty("vodogRelayApiBaseUrl")
    .orElse(providers.gradleProperty("vodogApiBaseUrl"))
    .orElse("https://relay.example.com:16800/api/v1").get()
fun endpointLiteral(value: String): String {
    val uri = URI(value)
    require(uri.scheme == "https" && !uri.host.isNullOrBlank() && uri.rawUserInfo == null &&
        uri.rawQuery == null && uri.rawFragment == null &&
        uri.rawPath in setOf("", "/", "/api/v1", "/api/v1/")) {
        "VoDog endpoints must be HTTPS origins or /api/v1 URLs without credentials, query or fragment"
    }
    return "\"" + uri.resolve("/api/v1").toASCIIString() + "\""
}

val vodogApiBaseUrl = providers.gradleProperty("vodogApiBaseUrl")
    .orElse("https://control.example.com/api/v1").get()

android {
    namespace = "org.vodog.gateway"
    compileSdk = 36

    defaultConfig {
        applicationId = "org.vodog.gateway"
        minSdk = 29
        targetSdk = 36
        versionCode = 33
        versionName = if (cellularAcceptance == "true") "0.10.0-s94-cellular-acceptance"
        else "0.10.0-s94"
        buildConfigField("boolean", "CELLULAR_ACCEPTANCE_ENABLED", cellularAcceptance)
        buildConfigField("boolean", "RECORDING_ARCHIVE_ENABLED", recordingArchive)
        buildConfigField("long", "RECORDING_ARCHIVE_MIN_FREE_BYTES", "${recordingArchiveMinFreeBytes}L")
        buildConfigField("boolean", "LIBOPUS_FEC_ENABLED", libopusFec)
        buildConfigField("boolean", "RECEIVE_RECOVERY_ENABLED", receiveRecovery)
        buildConfigField("boolean", "COMMAND_REPLAY_HORIZON_ENABLED", commandReplayHorizon)
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
        buildConfigField("String", "API_BASE_URL", endpointLiteral(vodogApiBaseUrl))
        // S71: relay-node nginx :16800 relay to control-node Control, used while the default network is cellular.
        buildConfigField("String", "RELAY_API_BASE_URL", endpointLiteral(vodogRelayApiBaseUrl))
        if (libopusFecEnabled) {
            // The attended candidate is intentionally limited to the Pixel's ABI.
            ndk { abiFilters += "arm64-v8a" }
            externalNativeBuild {
                cmake {
                    cppFlags += "-std=c++17"
                }
            }
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
    buildFeatures {
        compose = true
        buildConfig = true
    }
    if (libopusFecEnabled) {
        externalNativeBuild {
            cmake {
                path = file("src/main/cpp/CMakeLists.txt")
                version = "3.22.1"
            }
        }
    }
    packaging.resources.excludes += "/META-INF/{AL2.0,LGPL2.1}"
}

kotlin { jvmToolchain(17) }

dependencies {
    val composeBom = platform(libs.androidx.compose.bom)
    implementation(composeBom)
    implementation(libs.androidx.activity.compose)
    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.lifecycle.runtime.ktx)
    implementation(libs.androidx.lifecycle.runtime.compose)
    implementation(libs.androidx.lifecycle.viewmodel.compose)
    implementation(libs.androidx.compose.ui)
    implementation(libs.androidx.compose.ui.tooling.preview)
    implementation(libs.androidx.compose.material3)
    implementation(libs.androidx.compose.material.icons.extended)
    implementation(libs.kotlinx.coroutines.android)
    implementation(libs.stream.webrtc.android)
    implementation(libs.okhttp)
    debugImplementation(libs.androidx.compose.ui.tooling)
    testImplementation(libs.junit)
    testImplementation(libs.okhttp.mockwebserver)
    testImplementation("org.json:json:20240303")
    androidTestImplementation(libs.androidx.test.runner)
    androidTestImplementation(libs.androidx.test.ext.junit)
}
