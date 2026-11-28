# Shared model classes are (de)serialised by Gson with @SerializedName.
-keepattributes Signature, InnerClasses, EnclosingMethod
-keepattributes *Annotation*
-keep class com.dxn.stockpoint.data.model.** { *; }
-keepclassmembers,allowobfuscation class * {
    @com.google.gson.annotations.SerializedName <fields>;
}
# Retrofit reads the generic signatures of suspend functions through reflection.
# Keep the service interface and its methods verbatim; obfuscating or shrinking
# the Continuation type argument makes getGenericParameterTypes() return a raw
# Class and Retrofit throws ClassCastException before the network is reached.
-keep interface com.dxn.stockpoint.data.api.ApiService { *; }
-keep class com.dxn.stockpoint.data.api.ApiService$** { *; }
-keep class kotlin.coroutines.Continuation
# Gson anonymous TypeTokens rely on their generic superclass signature.
-keep class com.google.gson.reflect.TypeToken { *; }
-keep class * extends com.google.gson.reflect.TypeToken { *; }
-dontwarn okhttp3.**
-dontwarn okio.**
-dontwarn retrofit2.**
-dontwarn javax.annotation.**
