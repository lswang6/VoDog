import java.net.URI

plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.compose.compiler)
    alias(libs.plugins.google.services) apply false
}

if (file("google-services.json").isFile) {
    apply(plugin = "com.google.gms.google-services")
}
val productionApiBaseUrl = providers.gradleProperty("vodogApiBaseUrl")
    .orElse("https://control.example.com/api/v1").get()
val s33UiTestProperty = providers.gradleProperty("s33UiTest").orNull
val s33UiTest = s33UiTestProperty?.toBooleanStrictOrNull()
    ?: if (s33UiTestProperty == null) false else error("-Ps33UiTest must be true or false")
val s33ApiBaseUrlProperty = providers.gradleProperty("s33ApiBaseUrl").orNull
if (!s33UiTest && s33ApiBaseUrlProperty != null) {
    error("-Ps33ApiBaseUrl is accepted only together with -Ps33UiTest=true")
}
val s33ApiBaseUrl = s33ApiBaseUrlProperty ?: "http://127.0.0.1:16880/api/v1"
if (s33UiTest) {
    val endpoint = URI(s33ApiBaseUrl)
    require(
        endpoint.scheme == "http" &&
            endpoint.host in setOf("127.0.0.1", "localhost") &&
            endpoint.port == 16880 &&
            endpoint.rawUserInfo == null
    ) {
        "S33 UI acceptance endpoint must be cleartext HTTP on loopback port 16880 without user info"
    }
    require(endpoint.rawQuery == null && endpoint.rawFragment == null && endpoint.rawPath == "/api/v1") {
        "S33 UI acceptance endpoint path must be exactly /api/v1 without query or fragment data"
    }
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

android {
    namespace = "org.vodog"
    compileSdk = 36

    defaultConfig {
        applicationId = "org.vodog"
        minSdk = 29
        targetSdk = 36
        versionCode = 72
        versionName = "0.72.0-s95b-signal-ui"
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
        buildConfigField("String", "API_BASE_URL", endpointLiteral(productionApiBaseUrl))
        // S72b（同 S71 网关）：默认网络是蜂窝时走 relay-node 国内中转。
        buildConfigField("String", "RELAY_API_BASE_URL", endpointLiteral(vodogRelayApiBaseUrl))
        buildConfigField("boolean", "S33_UI_TEST", "false")
    }

    buildTypes {
        debug {
            if (s33UiTest) {
                applicationIdSuffix = ".s33"
                buildConfigField("String", "API_BASE_URL", "\"$s33ApiBaseUrl\"")
                buildConfigField("String", "RELAY_API_BASE_URL", "\"$s33ApiBaseUrl\"")
                buildConfigField("boolean", "S33_UI_TEST", "true")
            }
        }
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
    packaging.resources.excludes += "/META-INF/{AL2.0,LGPL2.1}"

    if (s33UiTest) {
        sourceSets.getByName("debug").apply {
            manifest.srcFile("src/s33UiTest/AndroidManifest.xml")
            res.directories.add("src/s33UiTest/res")
        }
    }
}

// The .s33 application id deliberately has no Firebase project registration. Its local-only
// acceptance build disables push auto-init and uses checked-in placeholder resources instead of
// copying production google-services credentials into a second package.
if (s33UiTest) {
    tasks.matching { it.name == "processDebugGoogleServices" }.configureEach {
        // Keep the plugin's existing place in the resource task graph, but replace generation with
        // a scrub so a non-clean S33 build cannot package stale production Firebase resources.
        actions.clear()
        outputs.upToDateWhen { false }
        doLast { outputs.files.forEach { it.deleteRecursively() } }
    }
}

kotlin { jvmToolchain(17) }

dependencies {
    val composeBom = platform(libs.androidx.compose.bom)
    implementation(composeBom)
    implementation(libs.androidx.activity.compose)
    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.lifecycle.runtime.ktx)
    implementation(libs.androidx.lifecycle.runtime.compose)
    implementation(libs.androidx.lifecycle.viewmodel.ktx)
    implementation(libs.androidx.lifecycle.viewmodel.compose)
    implementation(libs.androidx.compose.ui)
    implementation(libs.androidx.compose.ui.tooling.preview)
    implementation(libs.androidx.compose.material3)
    implementation(libs.androidx.compose.material.icons.extended)
    implementation(libs.kotlinx.coroutines.android)
    implementation(libs.stream.webrtc.android)
    implementation(libs.androidx.credentials)
    implementation(libs.androidx.credentials.play.services.auth)
    implementation(libs.androidx.core.telecom)
    implementation(platform(libs.firebase.bom))
    implementation(libs.firebase.messaging)
    implementation(libs.okhttp)
    debugImplementation(libs.androidx.compose.ui.tooling)
    debugImplementation(libs.androidx.compose.ui.test.manifest)
    testImplementation(libs.junit)
    testImplementation("org.json:json:20240303")
    testImplementation(libs.okhttp.mockwebserver)
    androidTestImplementation(composeBom)
    androidTestImplementation(libs.androidx.test.runner)
    androidTestImplementation(libs.androidx.test.ext.junit)
    androidTestImplementation(libs.androidx.test.espresso.core)
    androidTestImplementation(libs.androidx.test.uiautomator)
    androidTestImplementation(libs.androidx.compose.ui.test.junit4)
}
