import java.util.Properties

plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.compose)
}

val localProperties = Properties()
val localPropertiesFile = rootProject.file("local.properties")
if (localPropertiesFile.exists()) {
    localPropertiesFile.inputStream().use { localProperties.load(it) }
}
val configuredApiBaseUrl = providers.gradleProperty("wayMemoryApiUrl").orNull
    ?: localProperties.getProperty("wayMemoryApiUrl", "http://10.0.2.2:8787")
val buildingRelease = gradle.startParameter.taskNames.any { it.contains("release", ignoreCase = true) }
if (buildingRelease && !configuredApiBaseUrl.startsWith("https://")) {
    throw GradleException("Release builds require an HTTPS wayMemoryApiUrl")
}
val releaseKeystore = System.getenv("WAY_MEMORY_RELEASE_KEYSTORE")?.trim()?.takeIf(String::isNotEmpty)
val releaseStorePassword = System.getenv("WAY_MEMORY_RELEASE_STORE_PASSWORD")?.takeIf(String::isNotEmpty)
val releaseKeyAlias = System.getenv("WAY_MEMORY_RELEASE_KEY_ALIAS")?.trim()?.takeIf(String::isNotEmpty)
val releaseKeyPassword = System.getenv("WAY_MEMORY_RELEASE_KEY_PASSWORD")?.takeIf(String::isNotEmpty)
val releaseSigningValues = listOf(releaseKeystore, releaseStorePassword, releaseKeyAlias, releaseKeyPassword)
val releaseSigningConfigured = releaseSigningValues.all { it != null }
if (releaseSigningValues.any { it != null } && !releaseSigningConfigured) {
    throw GradleException("Release signing variables must be supplied together")
}
val apiBaseUrl = configuredApiBaseUrl
    .replace("\\", "\\\\")
    .replace("\"", "\\\"")

android {
    namespace = "com.puzzlefuzzy.waymemory"
    compileSdk {
        version = release(37)
    }

    defaultConfig {
        applicationId = "com.puzzlefuzzy.waymemory"
        minSdk = 26
        targetSdk = 37
        versionCode = 1
        versionName = "1.0"
        buildConfigField("String", "API_BASE_URL", "\"$apiBaseUrl\"")

        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }

    signingConfigs {
        if (releaseSigningConfigured) {
            create("wayMemoryRelease") {
                storeFile = file(releaseKeystore ?: error("missing release keystore"))
                storePassword = releaseStorePassword
                keyAlias = releaseKeyAlias
                keyPassword = releaseKeyPassword
            }
        }
    }
    buildTypes {
        release {
            optimization {
                enable = false
            }
            if (releaseSigningConfigured) {
                signingConfig = signingConfigs.getByName("wayMemoryRelease")
            }
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
}

dependencies {
    implementation(platform(libs.androidx.compose.bom))
    implementation(libs.androidx.activity.compose)
    implementation(libs.androidx.compose.material3)
    implementation(libs.androidx.compose.ui)
    implementation(libs.androidx.compose.ui.graphics)
    implementation(libs.androidx.compose.ui.tooling.preview)
    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.lifecycle.runtime.ktx)
    implementation(libs.okhttp)
    implementation(libs.arcore)
    testImplementation(libs.junit)
    androidTestImplementation(platform(libs.androidx.compose.bom))
    androidTestImplementation(libs.androidx.compose.ui.test.junit4)
    androidTestImplementation(libs.androidx.espresso.core)
    androidTestImplementation(libs.androidx.junit)
    debugImplementation(libs.androidx.compose.ui.test.manifest)
    debugImplementation(libs.androidx.compose.ui.tooling)
}
