# Shared Gson/Retrofit keeps come from :core/consumer-rules.pro.
-keepattributes Signature, InnerClasses, EnclosingMethod
-keepattributes *Annotation*
-keep interface com.dxn.stockpoint.data.api.ApiService { *; }
-dontwarn okhttp3.**
-dontwarn okio.**
-dontwarn retrofit2.**
-dontwarn javax.annotation.**
