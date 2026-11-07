plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.kotlin.compose)
}

val appVersionCode = providers.gradleProperty("dxn.versionCode").get().toInt()
val appVersionName = providers.gradleProperty("dxn.versionName").get()
val apiBaseUrl = providers.gradleProperty("dxn.apiBaseUrl").get()

android {
    namespace = "com.dxn.stockpoint"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.dxn.stockpoint"
        minSdk = 26
        targetSdk = 35
        versionCode = appVersionCode
        versionName = appVersionName
        buildConfigField("String", "API_BASE_URL", "\"$apiBaseUrl\"")
        buildConfigField("String", "APP_ROLE", "\"owner\"")
    }

    // The release keystore comes from CI (env vars) or a local
    // android/DXNStockpoint/release.keystore. Without a password the release
    // APK/AAB is left unsigned instead of failing the build.
    signingConfigs {
        create("release") {
            val storePath = System.getenv("DXN_KEYSTORE")
                ?: project.rootProject.file("release.keystore")
                    .takeIf { it.exists() }?.absolutePath
                ?: ""
            val storePasswordValue = System.getenv("DXN_KEYSTORE_PASSWORD") ?: ""
            if (storePath.isNotEmpty() && storePasswordValue.isNotEmpty() && file(storePath).exists()) {
                storeFile = file(storePath)
                storePassword = storePasswordValue
                keyAlias = System.getenv("DXN_KEY_ALIAS") ?: "dxn"
                keyPassword = System.getenv("DXN_KEY_PASSWORD") ?: storePasswordValue
            }
        }
    }

    buildTypes {
        debug {
            applicationIdSuffix = ".debug"
            versionNameSuffix = "-debug"
        }
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            val releaseConfig = signingConfigs.getByName("release")
            if (releaseConfig.storeFile != null) {
                signingConfig = releaseConfig
            }
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro"
            )
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
        freeCompilerArgs += listOf(
            "-opt-in=androidx.compose.material3.ExperimentalMaterial3Api"
        )
    }

    buildFeatures {
        compose = true
        buildConfig = true
    }

    packaging {
        resources.excludes += setOf(
            "/META-INF/{AL2.0,LGPL2.1}",
            "/META-INF/DEPENDENCIES"
        )
    }
}

dependencies {
    implementation(project(":core"))

    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.lifecycle.runtime.ktx)
    implementation(libs.androidx.activity.compose)

    implementation(platform(libs.androidx.compose.bom))
    implementation(libs.androidx.ui)
    implementation(libs.androidx.ui.graphics)
    implementation(libs.androidx.ui.tooling.preview)
    implementation(libs.androidx.material3)
    implementation(libs.androidx.material.icons.extended)
    implementation(libs.androidx.lifecycle.viewmodel.compose)
    implementation(libs.androidx.lifecycle.runtime.compose)

    debugImplementation(libs.androidx.ui.tooling)
    debugImplementation(libs.androidx.ui.test.manifest)
}
