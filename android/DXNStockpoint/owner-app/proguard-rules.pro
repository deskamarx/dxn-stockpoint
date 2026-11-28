# Retrofit/Gson keeps come from :core/consumer-rules.pro. They are repeated
# here because the owner APK is the release variant most often sideloaded.
-keepattributes Signature, InnerClasses, EnclosingMethod
-keepattributes *Annotation*
-keep class com.dxn.stockpoint.data.model.** { *; }
-keep interface com.dxn.stockpoint.data.api.ApiService { *; }
-keep class retrofit2.** { *; }
-keep class okhttp3.** { *; }
