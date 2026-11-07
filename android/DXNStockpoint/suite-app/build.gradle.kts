plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
}

val appVersionCode = providers.gradleProperty("dxn.versionCode").get().toInt()
val appVersionName = providers.gradleProperty("dxn.versionName").get()

android {
    namespace = "com.dxn.stockpoint.suite"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.dxn.stockpoint.suite"
        minSdk = 26
        targetSdk = 35
        versionCode = appVersionCode
        versionName = appVersionName
        buildConfigField(
            "String",
            "SUITE_URL",
            "\"https://deskamarx.github.io/dxn-stockpoint/suite.html\""
        )
    }

    signingConfigs {
        create("release") {
            val storePath = System.getenv("DXN_SUITE_KEYSTORE")
                ?: project.rootProject.file("suite-release.keystore")
                    .takeIf { it.exists() }?.absolutePath
                ?: ""
            val storePasswordValue = System.getenv("DXN_SUITE_KEYSTORE_PASSWORD") ?: ""
            if (storePath.isNotEmpty() && storePasswordValue.isNotEmpty() && file(storePath).exists()) {
                storeFile = file(storePath)
                storePassword = storePasswordValue
                keyAlias = System.getenv("DXN_SUITE_KEY_ALIAS") ?: "dxn-suite"
                keyPassword = System.getenv("DXN_SUITE_KEY_PASSWORD") ?: storePasswordValue
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
    }

    buildFeatures {
        buildConfig = true
    }
}
