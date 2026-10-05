# Attribution

DiPlay Harmony uses iAP2 wire constants and the frame layout from DiPlay 0.2.12,
by shihabal3amri and contributors:

https://github.com/shihabal3amri/DiPlay

Referenced file: shared/src/main/java/com/shilapi/xcertplay/transport/Iap2LinkEngine.kt.

DiPlay credits the original xcertplay project by shilapi (GPL-3.0):
https://github.com/shilapi/xcertplay

The ArkTS probe, link state machine, CSM/TLV codec and identification fields are
adapted from Iap2LinkEngine.kt, Iap2CsmFramer.kt and Iap2IdentificationClient.kt.
Experimental authentication follows LocalMfiAuthenticationClient.kt and
Iap2MfiAuthenticationClient.kt. This is a native HarmonyOS port with video and touch support;
audio and several other receiver features remain incomplete. This project is
distributed under GPL-3.0-only; the upstream license text is included as LICENSE.

Project configuration and default launch assets began from the local DevEco
Empty Ability template. Developer signing keys and profiles, Android executable
files and locally imported APK authentication material are excluded from the
source archive. Local development may import experimental identity separately.
No identity assets or personally signed HAP are distributed in this repository.

Wireless bootstrap and receiver pairing follow Iap2WifiCarPlayClient.kt,
PairSetup.kt, Srp6a.kt, Tlv8Codec.kt, PairVerify.kt, ControlCipher.kt,
AirPlayCrypto.kt and MfiSapAuthSetup.kt from the same GPL-3.0-only source.
SRP, pairing state machines, bounded control records and native cryptographic
adapters are implemented in ArkTS/TypeScript. Tests use an independent Node/
OpenSSL controller to check protocol cryptography and reject invalid inputs.

Binary plist, receiver declarations, timing and screen protocol handling follow
BplistCodec.kt, AirPlayInfoPlist.kt, AirPlayHid.kt, NtpClock.kt and ScreenStream.kt.
The C++ decoder bridge targets HarmonyOS native AVCodec and ArkUI surfaces;
Android decoder executables are not reused.

PCM audio packet handling and format negotiation follow AudioStream.kt and
CarPlayMediaEngine.kt. The timestamp buffer, replay window and HarmonyOS
AudioRenderer adapter are implemented in TypeScript/ArkTS; no Android audio
runtime is bundled.
AAC access-unit framing also follows MediaCodecSupport.kt. The C++ AAC adapter
uses HarmonyOS OH_AudioCodec and returns decoded PCM through a bounded queue.
AirPlay service publication and the phone control-connect request follow
CarPlayBonjour.kt, with HarmonyOS mDNS APIs and authenticated-peer filtering.


Native HarmonyOS platform and product adaptations: DiPlay Harmony contributors.
UI implemented independently with ArkUI. See docs/UPSTREAM.md for the source map.
Presentation Material Symbols: Google, Apache-2.0; full license in docs/presentation.
