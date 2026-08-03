# AE Llama Hub -- AEGP plugin build (Windows x64).
# Requires the Adobe After Effects SDK; set AE_SDK_ROOT (env or -D) to the
# folder containing Examples/.
cmake_minimum_required(VERSION 3.21)
project(AELlamaHub CXX)

if(NOT DEFINED AE_SDK_ROOT)
    set(AE_SDK_ROOT "$ENV{AE_SDK_ROOT}")
endif()
if(NOT AE_SDK_ROOT OR NOT EXISTS "${AE_SDK_ROOT}/Examples/Headers")
    message(FATAL_ERROR
        "AE_SDK_ROOT not set (or wrong): expected <AE_SDK_ROOT>/Examples/Headers. "
        "Download the After Effects SDK from https://developer.adobe.com/after-effects/")
endif()

set(AE_HEADERS   "${AE_SDK_ROOT}/Examples/Headers")
set(AE_UTIL      "${AE_SDK_ROOT}/Examples/Util")
set(AE_RESOURCES "${AE_SDK_ROOT}/Examples/Resources")

add_library(AELlamaHub SHARED
    src/AELlamaHub.cpp
    "${AE_UTIL}/AEGP_SuiteHandler.cpp"
    "${AE_UTIL}/MissingSuiteError.cpp"
)

target_include_directories(AELlamaHub PRIVATE
    src
    "${AE_HEADERS}"
    "${AE_HEADERS}/SP"
    "${AE_UTIL}"
    "${AE_RESOURCES}"
)

target_compile_definitions(AELlamaHub PRIVATE MSWindows WIN32 _WINDOWS)
set_target_properties(AELlamaHub PROPERTIES SUFFIX ".aex" PREFIX "")

# ---- PiPL: .r -> preprocess -> PiPLtool -> .rc (mirrors the SDK samples) ----
set(PIPL_R   "${CMAKE_CURRENT_SOURCE_DIR}/src/AELlamaHub.r")
set(PIPL_TMP "${CMAKE_CURRENT_BINARY_DIR}/AELlamaHub.rr")
set(PIPL_RC  "${CMAKE_CURRENT_BINARY_DIR}/AELlamaHub.rc")

add_custom_command(
    OUTPUT "${PIPL_RC}"
    COMMAND cl /I "${AE_HEADERS}" /EP /DMSWindows "${PIPL_R}" > "${PIPL_TMP}"
    COMMAND "${AE_RESOURCES}/PiPLtool.exe" "${PIPL_TMP}" "${PIPL_RC}"
    DEPENDS "${PIPL_R}"
    COMMENT "Compiling PiPL resource"
    VERBATIM
)
target_sources(AELlamaHub PRIVATE "${PIPL_RC}")
