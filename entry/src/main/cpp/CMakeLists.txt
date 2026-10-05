cmake_minimum_required(VERSION 3.5.0)
project(DiPlayVideo)
set(CMAKE_CXX_STANDARD 17)
add_library(diplayvideo SHARED video_bridge.cpp audio_bridge.cpp mdns_bridge.cpp)
target_link_libraries(diplayvideo PUBLIC libace_napi.z.so libnative_media_codecbase.so
  libnative_media_vdec.so libnative_media_acodec.so libnative_media_core.so libnative_window.so libhilog_ndk.z.so)
