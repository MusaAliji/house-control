plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.housecontrol"
    compileSdk = 36
    defaultConfig {
        applicationId = "com.housecontrol"
        minSdk = 26
        targetSdk = 36
        versionCode = 3
        versionName = "0.1.0"
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
    buildFeatures { buildConfig = true }
    buildTypes {
        release { isMinifyEnabled = false }
    }
    sourceSets.getByName("main").assets.srcDir(layout.buildDirectory.dir("generated/webAssets"))
}

// Both Android Studio and CLI builds bundle the same Vite UI as iOS. Install
// web dependencies first (npm ci); no development server is used by the APK.
val buildWeb by tasks.registering(Exec::class) {
    workingDir(rootProject.file("../web"))
    inputs.dir(rootProject.file("../web/src"))
    inputs.files(rootProject.file("../web/index.html"), rootProject.file("../web/package-lock.json"), rootProject.file("../web/vite.config.js"))
    outputs.dir(rootProject.file("../web/dist"))
    if (System.getProperty("os.name").startsWith("Windows")) commandLine("cmd", "/c", "npm", "run", "build")
    else commandLine("npm", "run", "build")
}
val bundleWeb by tasks.registering(Sync::class) {
    dependsOn(buildWeb)
    from(rootProject.file("../web/dist"))
    into(layout.buildDirectory.dir("generated/webAssets/dist"))
}
tasks.named("preBuild") { dependsOn(bundleWeb) }

dependencies {
    implementation("androidx.core:core:1.17.0")
    implementation("androidx.webkit:webkit:1.14.0")
    implementation("com.journeyapps:zxing-android-embedded:4.3.0")
    implementation("org.bouncycastle:bctls-jdk18on:1.83")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    testImplementation("junit:junit:4.13.2")
    testImplementation("org.json:json:20250517")
    androidTestImplementation("androidx.test:runner:1.7.0")
    androidTestImplementation("androidx.test.ext:junit:1.3.0")
}
