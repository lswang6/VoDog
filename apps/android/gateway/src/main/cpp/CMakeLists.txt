cmake_minimum_required(VERSION 3.22)
project(vodog_opus LANGUAGES C CXX)

include(FetchContent)

set(OPUS_BUILD_SHARED_LIBRARY OFF CACHE BOOL "" FORCE)
set(OPUS_BUILD_TESTING OFF CACHE BOOL "" FORCE)
set(OPUS_BUILD_PROGRAMS OFF CACHE BOOL "" FORCE)
set(OPUS_INSTALL_PKG_CONFIG_MODULE OFF CACHE BOOL "" FORCE)
set(OPUS_INSTALL_CMAKE_CONFIG_MODULE OFF CACHE BOOL "" FORCE)
set(OPUS_DRED OFF CACHE BOOL "" FORCE)
set(OPUS_OSCE OFF CACHE BOOL "" FORCE)
# S70: deep PLC, selected at runtime by decoder complexity >= 5 (complexity 0 is bit-identical to a
# classic build; harness: lower NRMSE and log-spectral distance at 5/10/20% loss). DRED/OSCE stay off.
set(OPUS_DEEP_PLC ON CACHE BOOL "" FORCE)

FetchContent_Declare(
    opus
    URL https://downloads.xiph.org/releases/opus/opus-1.6.1.tar.gz
    URL_HASH SHA256=6ffcb593207be92584df15b32466ed64bbec99109f007c82205f0194572411a1
)
FetchContent_MakeAvailable(opus)
# S70: the gateway ships the debug variant (-O0); deep PLC and complexity-10 encoding must not run
# unoptimized on the telephony playback thread.
target_compile_options(opus PRIVATE -O2)

if(ANDROID)
    add_library(vodog_opus SHARED libopus_jni.cpp)
    target_compile_features(vodog_opus PRIVATE cxx_std_17)
    target_compile_options(vodog_opus PRIVATE -Wall -Wextra -Werror)
    target_link_libraries(vodog_opus PRIVATE opus)
    target_include_directories(vodog_opus PRIVATE ${opus_SOURCE_DIR}/include)
else()
    add_executable(opus_loss_harness opus_loss_harness.cpp)
    target_compile_features(opus_loss_harness PRIVATE cxx_std_17)
    target_compile_options(opus_loss_harness PRIVATE -Wall -Wextra -Werror)
    target_link_libraries(opus_loss_harness PRIVATE opus)
    target_include_directories(opus_loss_harness PRIVATE ${opus_SOURCE_DIR}/include)
endif()
